import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { get } from "node:https";
import { saveAttachment } from "./attachments.ts";
import { attachmentRoot, connect } from "./database.ts";
import { extractCandidate, parseImportManifest } from "./price-import.ts";
import { addCandidate } from "./price-store.ts";

async function downloadWorkbook(url: string, signal: AbortSignal) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    // The Hunan source rejects Node 24's default TLS group list.
    get(url, {
      ecdhCurve: "X25519:P-256:P-384",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    }, resolve).once("error", reject);
  }).catch((cause: unknown) => { throw new Error("无法连接官方原表", { cause }); });
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error(`无法下载官方原表（HTTP ${response.statusCode}）`);
  }

  const maxBytes = 32 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("官方原表超过 32 MiB 下载上限");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function collectPrice(manifestFile: string, workbookFile: string | undefined, databaseVariable: string) {
  const manifest = parseImportManifest(JSON.parse(await readFile(manifestFile, "utf8")));
  const source = manifest.source;
  const taskId = randomUUID();
  const pool = connect(databaseVariable);
  const shutdown = new AbortController();
  const interrupt = () => shutdown.abort(new Error("采集任务因 Worker 停止而中断"));
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);

  try {
    // Keep the identifying database session open for the lifetime of the task.
    const client = await pool.connect();
    client.on("error", () => shutdown.abort(new Error("采集任务的数据库连接中断")));
    try {
      // A blocked SQL statement must release the session even after the Worker disappears.
      await client.query(`
        SELECT set_config('application_name', $1, false), set_config('statement_timeout', '10s', false)
      `, ["orth-worker:" + taskId]);
      await client.query(`
        INSERT INTO orth_governance.collection_source (notice_url, notice_title, publisher)
        VALUES ($1, $2, $3) ON CONFLICT (notice_url) DO NOTHING
      `, [source.notice_url, source.notice_title, source.publisher]);
      await client.query(`
        INSERT INTO orth_governance.collection_task (task_id, notice_url, attachment_url, sha256, sheet_name, row_number)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [taskId, source.notice_url, source.attachment_url, source.sha256, source.sheet_name, source.row_number]);

      try {
        const workbook = workbookFile
          ? await readFile(workbookFile, { signal: shutdown.signal }).catch((cause: unknown) => {
            throw new Error("无法读取本地原表", { cause });
          })
          : await downloadWorkbook(source.attachment_url, shutdown.signal);
        shutdown.signal.throwIfAborted();
        const candidate = extractCandidate(manifest, workbook);
        await saveAttachment(attachmentRoot(), source.sha256, workbook).catch((cause: unknown) => {
          throw new Error("无法保存留档原表", { cause });
        });
        shutdown.signal.throwIfAborted();
        await client.query("BEGIN");
        try {
          await addCandidate(client, candidate);
          shutdown.signal.throwIfAborted();
          await client.query(`
            UPDATE orth_governance.collection_task
            SET status = 'imported', candidate_id = $2, finished_at = clock_timestamp()
            WHERE task_id = $1
          `, [taskId, candidate.price_id]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        return { task_id: taskId, price_id: candidate.price_id };
      } catch (cause) {
        const error = shutdown.signal.aborted ? shutdown.signal.reason : cause;
        const message = error instanceof Error && !("code" in error) ? error.message : "采集任务处理失败";
        try {
          await client.query(`
            UPDATE orth_governance.collection_task SET status = 'failed', error = $2, finished_at = now()
            WHERE task_id = $1 AND status = 'running'
          `, [taskId, message.slice(0, 500)]);
        } catch (recordError) {
          throw new AggregateError([error, recordError], "无法记录采集任务失败");
        }
        throw error;
      }
    } finally {
      client.release();
    }
  } finally {
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
    await pool.end();
  }
}
