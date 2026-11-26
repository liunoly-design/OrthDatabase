import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { read, write } from "xlsx";

import { createApp } from "../src/app.ts";
import { checkMiniPricePage, checkMiniPriceSearch } from "./mini-preview.ts";
import { testDatabase } from "./postgres.ts";
import { checkWebPricePage } from "./web-price-preview.ts";

const operator = { ORTH_OPERATOR_USER: "reviewer", ORTH_OPERATOR_PASSWORD: "test-secret" };
const authorization = "Basic " + Buffer.from("reviewer:test-secret").toString("base64");

async function start(entry: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [entry], {
    env: { HOST: "127.0.0.1", PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = once(child, "exit");
  const stop = async () => {
    child.kill("SIGTERM");
    await exited;
  };

  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  try {
    const url = await Promise.race([
      (async () => {
        let stdout = "";
        for await (const chunk of child.stdout.setEncoding("utf8")) {
          stdout += chunk;
          const match = /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(stdout);
          if (match) return match[1];
        }
        throw new Error(`${entry} did not start: ${stderr}`);
      })(),
      exited.then(() => { throw new Error(`${entry} exited: ${stderr}`); })
    ]);
    return { url, stop, [Symbol.asyncDispose]: stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test("独立治理 API 使用运营身份，并拒绝应用身份与公开查询路由", { timeout: 15_000 }, async (t) => {
  const database = await testDatabase(t);
  await database.migrate();
  const governance = await database.login("orth_governance");
  const publisher = await database.login("orth_publisher");
  const application = await database.login("orth_application");
  await using api = await start("src/start-governance.ts", {
    ...operator,
    ORTH_GOVERNANCE_DATABASE_URL: governance.url,
    ORTH_PUBLISHER_DATABASE_URL: publisher.url
  });

  const endpoint = api.url + "/api/governance/v1/candidates";
  assert.equal((await fetch(endpoint)).status, 401);
  const appCredentials = Buffer.from(`${application.name}:${new URL(application.url).password}`).toString("base64");
  assert.equal((await fetch(endpoint, { headers: { authorization: "Basic " + appCredentials } })).status, 401);
  const response = await fetch(endpoint, { headers: { authorization } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.equal((await fetch(api.url + "/api/v1/prices/test")).status, 404);
});

const exec = promisify(execFile);
const manifest = "samples/hunan-joint-results.json";
const workbook = "samples/hunan-joint-results.xls";
const priceId = "aj_8ccf6bc8657afcaaa14a3a3e901056fc";
const apiPath = "/api/governance/v1";
const workRoot = ".orth-data";

async function workspace(t: import("node:test").TestContext) {
  await mkdir(workRoot, { recursive: true });
  const dir = await mkdtemp(join(workRoot, "governance-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("采集 Worker 留下真实信源及任务记录，只有发布后的候选进入 v1 查询", { timeout: 20_000 }, async (t) => {
  const database = await testDatabase(t);
  const dataDir = await workspace(t);
  await database.migrate();
  const worker = await database.login("orth_worker");
  const governance = await database.login("orth_governance");
  const publisher = await database.login("orth_publisher");
  const application = await database.login("orth_application");
  const runWorker = (attachment = workbook) => exec(process.execPath, ["src/start-worker.ts", manifest, attachment], {
    env: { ORTH_WORKER_DATABASE_URL: worker.url, ORTH_DATA_DIR: dataDir }
  });

  const { stdout } = await runWorker();
  const first = JSON.parse(stdout);
  assert.equal(first.price_id, priceId);
  const replay = JSON.parse((await runWorker()).stdout);
  assert.equal(replay.price_id, priceId);
  assert.notEqual(replay.task_id, first.task_id);

  const invalid = join(dataDir, "different.xls");
  await writeFile(invalid, "different workbook bytes");
  await assert.rejects(runWorker(invalid), { stderr: /SHA-256/ });

  await using api = await start("src/start-governance.ts", {
    ...operator, ORTH_GOVERNANCE_DATABASE_URL: governance.url,
    ORTH_PUBLISHER_DATABASE_URL: publisher.url, ORTH_DATA_DIR: dataDir
  });
  await using app = createApp({ applicationPool: application.pool }).listen(0, "127.0.0.1");
  await once(app, "listening");
  const address = app.address();
  assert.ok(address && typeof address === "object");
  const applicationUrl = `http://127.0.0.1:${address.port}`;
  const get = (path: string) => fetch(api.url + apiPath + path, { headers: { authorization } });
  const action = (name: string) => fetch(api.url + apiPath + "/candidates/" + priceId + "/" + name, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}"
  });
  const price = () => fetch(applicationUrl + "/api/v1/prices/" + priceId);

  const sources = await (await get("/sources")).json();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].publisher, "湖南省医疗保障局");
  assert.equal(sources[0].notice_url, "https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/t20240919_33458275.html");
  assert.ok(sources[0].last_success_at);
  const tasks = await (await get("/tasks")).json();
  assert.deepEqual(tasks.map(({ status }: { status: string }) => status), ["failed", "imported", "imported"]);
  assert.match(tasks[0].error, /SHA-256/);
  assert.equal(tasks.find(({ task_id }: { task_id: string }) => task_id === first.task_id).candidate_status, "待复核");
  const candidates = await (await get("/candidates")).json();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].price_id, priceId);

  assert.equal((await price()).status, 404);
  assert.equal((await action("publish")).status, 409);
  assert.equal((await action("review")).status, 204);
  assert.equal((await price()).status, 404);
  assert.equal((await action("publish")).status, 204);
  await api.stop();
  const response = await price();
  assert.equal(response.status, 200);
  const { published_at, ...snapshot } = await response.json();
  assert.ok(published_at);
  assert.deepEqual(snapshot, JSON.parse(await readFile("samples/hunan-joint-results.published.json", "utf8")));
});

test("独立 Worker 使用专属登录导入候选、留档和记录任务", { timeout: 15_000 }, async (t) => {
  const database = await testDatabase(t);
  const dataDir = await workspace(t);
  await database.migrate();
  const worker = await database.login("orth_worker");
  const env = { ORTH_WORKER_DATABASE_URL: worker.url, ORTH_DATA_DIR: dataDir };
  const { stdout } = await exec(process.execPath, ["src/start-worker.ts", manifest, workbook], { env });
  const result = JSON.parse(stdout);
  assert.equal(result.price_id, priceId);
  const { rows: [task] } = await worker.pool.query(`
    SELECT candidate_id, status, sha256 FROM orth_governance.collection_task WHERE task_id = $1
  `, [result.task_id]);
  assert.equal(task.status, "imported");
  assert.equal(task.candidate_id, priceId);
  const expected = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(task.sha256, expected.sha256);
  assert.deepEqual(await readFile(join(dataDir, task.sha256 + ".xls")), await readFile(workbook));
});

test("运行中的采集可见，强制停止后标记中断且手工入口可重新导入", { timeout: 22_000 }, async (t) => {
  const database = await testDatabase(t);
  const dataDir = await workspace(t);
  await database.migrate();
  const worker = await database.login("orth_worker");
  const governance = await database.login("orth_governance");
  const publisher = await database.login("orth_publisher");
  await using api = await start("src/start-governance.ts", {
    ...operator, ORTH_GOVERNANCE_DATABASE_URL: governance.url,
    ORTH_PUBLISHER_DATABASE_URL: publisher.url, ORTH_DATA_DIR: dataDir
  });

  async function getTasks() {
    const response = await fetch(api.url + apiPath + "/tasks", { headers: { authorization } });
    assert.equal(response.status, 200);
    return await response.json() as Array<{ task_id: string; status: string; candidate_id: string | null }>;
  }

  const blocker = await database.owner.connect();
  try {
    await blocker.query("BEGIN");
    // Readers can still see the task while candidate insertion is blocked.
    await blocker.query("LOCK TABLE orth_governance.import_candidate IN SHARE MODE");
    const child = spawn(process.execPath, ["src/start-worker.ts", manifest, workbook], {
      env: { ORTH_WORKER_DATABASE_URL: worker.url, ORTH_DATA_DIR: dataDir },
      stdio: "ignore"
    });
    const exited = once(child, "exit");
    try {
      let tasks = await getTasks();
      for (let attempt = 0; !tasks.length && attempt < 100; attempt++) {
        await wait(30);
        tasks = await getTasks();
      }
      assert.deepEqual(tasks.map(({ status }) => status), ["running"]);
      const session = "orth-worker:" + tasks[0].task_id;
      let blocked = false;
      for (let attempt = 0; !blocked && attempt < 100; attempt++) {
        const { rowCount } = await database.owner.query(`
          SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'
        `, [session]);
        blocked = rowCount === 1;
        if (!blocked) await wait(30);
      }
      assert.ok(blocked, "Worker must be blocked in PostgreSQL before stopping it");
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
    let interrupted = await getTasks();
    for (let attempt = 0; interrupted[0]?.status === "running" && attempt < 120; attempt++) {
      await wait(100);
      interrupted = await getTasks();
    }
    assert.deepEqual(interrupted.map(({ status }) => status), ["interrupted"]);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }

  const manual = await exec(process.execPath, ["src/import-price.ts", manifest, workbook], {
    env: { ORTH_GOVERNANCE_DATABASE_URL: governance.url, ORTH_DATA_DIR: dataDir }
  });
  assert.deepEqual(JSON.parse(manual.stdout), { price_id: priceId });
  const tasks = await getTasks();
  assert.deepEqual(tasks.map(({ status, candidate_id }) => [status, candidate_id]), [
    ["imported", priceId], ["interrupted", null]
  ]);
});

test("独立 Worker、运营 Web 和小程序用同一原表完成发布、查价与分享", { timeout: 45_000 }, async (t) => {
  const database = await testDatabase(t);
  const dataDir = await workspace(t);
  await database.migrate();
  const governance = await database.login("orth_governance");
  const publisher = await database.login("orth_publisher");
  const worker = await database.login("orth_worker");
  const application = await database.login("orth_application");
  const { supply, ...governed } = JSON.parse(await readFile("samples/hunan-joint-governance.json", "utf8"));
  const supplyPath = process.env.ORTH_TEST_SUPPLY_WORKBOOK;
  const liveDownload = process.env.ORTH_TEST_LIVE_HUNAN === "1" && !supplyPath;
  const governedManifest = join(dataDir, "governed.json");
  await writeFile(governedManifest, JSON.stringify(supplyPath ? { ...governed, supply } : governed));
  const run = async (file: string, ...attachments: string[]) => JSON.parse((await exec(process.execPath,
    ["src/start-worker.ts", file, ...attachments],
    { env: { ORTH_WORKER_DATABASE_URL: worker.url, ORTH_DATA_DIR: dataDir } })).stdout);
  if (supplyPath) await assert.rejects(run(governedManifest, workbook, workbook), /供应清单与 SHA-256 不一致/);
  const attachments = liveDownload ? [] : [workbook];
  if (supplyPath) attachments.push(supplyPath);
  const primary = await run(governedManifest, ...attachments);
  assert.equal(primary.price_id, priceId);
  const baseManifest = JSON.parse(await readFile(manifest, "utf8"));
  const companionPrices: string[] = [];
  for (const row of [6, 17]) {
    const rowManifest = join(dataDir, `row-${row}.json`);
    await writeFile(rowManifest, JSON.stringify({ ...baseManifest, row_number: row }));
    companionPrices.push((await run(rowManifest, workbook)).price_id);
  }

  await using api = await start("src/start-governance.ts", {
    ...operator, ORTH_GOVERNANCE_DATABASE_URL: governance.url,
    ORTH_PUBLISHER_DATABASE_URL: publisher.url, ORTH_DATA_DIR: dataDir
  });
  await using app = await start("src/application/start.ts", { ORTH_APPLICATION_DATABASE_URL: application.url });
  await using web = await start("src/start-operations.ts", {
    ORTH_GOVERNANCE_API_URL: api.url + apiPath,
    ORTH_APPLICATION_API_ORIGIN: app.url
  });
  const price = () => fetch(`${app.url}/api/v1/prices/${priceId}`);
  const evidence = () => fetch(`${app.url}/api/v1/prices/${priceId}/evidence`);
  const search = async () => (await fetch(`${app.url}/api/v1/prices?published_group=A`)).json();

  assert.equal((await fetch(web.url + "/ops")).status, 401);
  const get = (path: string) => fetch(web.url + "/ops" + path, { headers: { authorization } });
  const action = (name: string, contentType = "application/json", id = priceId) =>
    fetch(web.url + "/ops/candidates/" + id + "/" + name, {
      method: "POST", headers: { authorization, "content-type": contentType }, body: "{}"
    });

  assert.match(await (await get("/sources")).text(), /湖南省医疗保障局/);
  const head = await fetch(web.url + "/ops", { method: "HEAD", headers: { authorization } });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const queue = await (await get("")).text();
  assert.match(queue, /价格复核/);
  assert.match(queue, new RegExp(priceId));
  const tasks = await (await get("/tasks")).text();
  assert.match(tasks, /已导入/);
  if (supplyPath) {
    assert.match(tasks, /供应清单与 SHA-256 不一致/);
    const { supply_manifest } = (await (await fetch(api.url + apiPath + "/tasks", { headers: { authorization } }))
      .json()).find((task: { status: string }) => task.status === "failed");
    assert.deepEqual(supply_manifest, supply);
  }
  const candidateRoute = "/candidates/" + priceId;
  assert.ok(tasks.includes(`href="/ops${candidateRoute}"`));
  const detail = await (await get(candidateRoute)).text();
  assert.match(detail, /<mark>5896<\/mark>/);
  assert.match(detail, /价格格 G5/);
  assert.match(detail, /ybj\.hunan\.gov\.cn/);
  assert.match(detail, /股骨柄/);
  assert.match(detail, /一（二）1、三（四）/);
  const downloaded = await get(candidateRoute + "/attachment");
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), await readFile(workbook));

  assert.equal((await action("review", "text/plain")).status, 415);
  assert.equal((await price()).status, 404);
  assert.equal((await evidence()).status, 404);
  assert.deepEqual((await search()).prices, []);
  assert.equal((await action("review")).status, 204);
  assert.match(await (await get(candidateRoute)).text(), /已复核/);
  assert.equal((await price()).status, 404);
  assert.equal((await evidence()).status, 404);
  assert.deepEqual((await search()).filters.published_group, []);
  assert.equal((await action("publish")).status, 204);
  assert.match(await (await get("/tasks")).text(), /已发布/);
  const published = await price();
  assert.equal(published.status, 200);
  const { published_at, ...snapshot } = await published.json();
  const expected = JSON.parse(await readFile("samples/hunan-joint-results.published.json", "utf8"));
  assert.ok(published_at);
  assert.deepEqual(snapshot, expected);
  assert.deepEqual((await search()).prices.map(({ price_id, published_group }: {
    price_id: string; published_group: string
  }) => [price_id, published_group]), [[priceId, "A"]]);
  const response = await evidence();
  assert.equal(response.status, 200);
  const publishedEvidence = await response.json();
  assert.equal(publishedEvidence.price_id, priceId);
  const [revision] = publishedEvidence.revisions;
  assert.equal(revision.source.price_cell, "G5");
  assert.deepEqual(revision.governance.category_composition.members, [
    { name: "股骨柄", quantity: 1, unit: "件" }, { name: "股骨头", quantity: 1, unit: "件" },
    { name: "髋臼内衬", quantity: 1, unit: "件" }, { name: "髋臼杯", quantity: 1, unit: "件" }
  ]);
  assert.equal(revision.governance.category_composition.evidence[0].section, "一（二）1、三（四）");
  assert.match(revision.governance.unresolved[1], /UDI-DI/);
  if (supplyPath) {
    assert.match(detail, /Glory柄XPE金聚全髋.*GH0101003129/);
    assert.match(detail, /国械注准20173130995/);
    const related = revision.governance.related_system;
    assert.equal(related.system_code, "GH0101003129");
    assert.deepEqual(related.members.filter((member: { accessory: boolean }) => !member.accessory)
      .map((member: { role: string }) => member.role), ["股骨柄", "股骨头", "髋臼杯", "髋臼内衬"]);
    const stem = revision.governance.identifier_links.find(
      (link: { scheme: string; value: string }) => link.scheme === "registration_number" && link.value === "国械注准20173130995"
    );
    assert.equal(stem.system_code, "GH0101003129");
    assert.equal(stem.component, "cc20e421-0a13-11ea-99e3-fa163e0a8baf");
    assert.equal(stem.evidence[0].sheet_name, "系统表");
    assert.equal(stem.evidence[0].row_number, 9734);
    assert.ok(stem.evidence[0].cells.includes("Q9734"));
    assert.equal(stem.evidence[0].sha256, supply.sha256);
    assert.ok(revision.governance.identifier_links.some(
      (link: { scheme: string; value: string; evidence: { cells: string[] }[] }) =>
        link.scheme === "former_registration_number" && link.value === "国械注准20173460995" &&
        link.evidence[0].cells.includes("R9734")
    ));
    const candidate = await (await fetch(api.url + apiPath + candidateRoute, { headers: { authorization } })).json();
    assert.deepEqual(revision.governance, candidate.governance);
    assert.equal(candidate.reviewed_by, "reviewer");
    assert.equal(candidate.published_by, "reviewer");
    const supporting = await get(candidateRoute + "/supply");
    assert.equal(supporting.status, 200);
    assert.equal(createHash("sha256").update(Buffer.from(await supporting.arrayBuffer())).digest("hex"), supply.sha256);
  }

  for (const id of companionPrices) {
    assert.equal((await action("review", "application/json", id)).status, 204);
    assert.equal((await action("publish", "application/json", id)).status, 204);
  }
  await web.stop();
  await api.stop();
  const afterShutdown = await price();
  assert.equal(afterShutdown.status, 200);
  assert.deepEqual(await afterShutdown.json(), { ...expected, published_at });
  assert.deepEqual(await (await evidence()).json(), publishedEvidence);
  await checkWebPricePage(app.url, expected);
  await checkMiniPricePage(app.url, priceId);
  await checkMiniPriceSearch(app.url, priceId);
});

test("治理 Skill 重跑、追加证据、金额冲突及两种更正可沿公开版本回查", { timeout: 25_000 }, async (t) => {
  const database = await testDatabase(t);
  const dataDir = await workspace(t);
  await database.migrate();
  const worker = await database.login("orth_worker");
  const governance = await database.login("orth_governance");
  const publisher = await database.login("orth_publisher");
  const application = await database.login("orth_application");
  await using api = await start("src/start-governance.ts", {
    ...operator, ORTH_GOVERNANCE_DATABASE_URL: governance.url,
    ORTH_PUBLISHER_DATABASE_URL: publisher.url, ORTH_DATA_DIR: dataDir
  });
  await using app = await start("src/application/start.ts", { ORTH_APPLICATION_DATABASE_URL: application.url });
  await using web = await start("src/start-operations.ts", { ORTH_GOVERNANCE_API_URL: api.url + apiPath });
  const base = JSON.parse(await readFile(manifest, "utf8"));
  const { supply: _supply, ...enriched } = JSON.parse(await readFile("samples/hunan-joint-governance.json", "utf8"));
  const run = async (file: string, attachment = workbook) => JSON.parse((await exec(process.execPath,
    ["src/start-worker.ts", file, attachment], { env: { ORTH_WORKER_DATABASE_URL: worker.url, ORTH_DATA_DIR: dataDir } }
  )).stdout);
  const prepare = async (name: string, data: object) => {
    const file = join(dataDir, name + ".json");
    await writeFile(file, JSON.stringify(data));
    return file;
  };
  const action = (id: string, name: string) => fetch(`${web.url}/ops/candidates/${id}/${name}`, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}"
  });
  const publish = async (id: string) => {
    assert.equal((await action(id, "publish")).status, 409);
    assert.equal((await action(id, "review")).status, 204);
    assert.equal((await action(id, "publish")).status, 204);
    assert.equal((await action(id, "publish")).status, 204);
  };
  const get = (id: string, path = "") => fetch(`${app.url}/api/v1/prices/${id}${path}`);
  const change = (operation: string, target_price_id: string, target_record_version: number, reason: string) =>
    ({ operation, target_price_id, target_record_version, reason });

  const [first, replay] = await Promise.all([run(manifest), run(manifest)]);
  assert.equal(first.price_id, priceId);
  assert.equal(replay.price_id, priceId);
  assert.notEqual(first.task_id, replay.task_id);
  assert.equal((await get(priceId, "/evidence")).status, 404);
  await publish(priceId);

  const evidenceManifest = await prepare("more-evidence", {
    ...enriched, change: change("additional_evidence", priceId, 1, "核对湖南执行通知的类别组成")
  });
  const extra = await run(evidenceManifest);
  assert.equal(extra.price_id, priceId);
  assert.notEqual(extra.candidate_id, priceId);
  assert.equal((await (await get(priceId)).json()).record_version, 1);
  const staleManifest = await prepare("stale-evidence", {
    ...enriched, governance: { ...enriched.governance, unresolved: ["本轮复核保留包装待核实项"] },
    change: change("additional_evidence", priceId, 1, "并发复核的证据")
  });
  const stale = await run(staleManifest);
  assert.equal((await action(stale.candidate_id, "review")).status, 204);
  await publish(extra.candidate_id);
  assert.equal((await action(stale.candidate_id, "publish")).status, 409);
  assert.equal((await run(evidenceManifest)).candidate_id, extra.candidate_id);
  assert.equal((await (await fetch(api.url + apiPath + "/candidates/" + extra.candidate_id,
    { headers: { authorization } })).json()).status, "已发布");
  assert.equal((await (await get(priceId)).json()).record_version, 2);
  assert.deepEqual((await (await get(priceId, "/evidence")).json()).revisions.map(
    ({ operation, source }: { operation: string; source: { price_cell: string } }) => [operation, source.price_cell]
  ), [["additional_evidence", "G5"], ["initial", "G5"]]);

  // The official-correction branch is exercised in an isolated database with a deliberately modified test copy.
  const revisedBook = read(await readFile(workbook));
  revisedBook.Sheets.Sheet1.G5.v = 5901;
  const revisedBytes = write(revisedBook, { bookType: "xlsx", type: "buffer" }) as Buffer;
  const revisedPath = join(dataDir, "simulated-correction.xls");
  await writeFile(revisedPath, revisedBytes);
  const revised = { ...base, sha256: createHash("sha256").update(revisedBytes).digest("hex") };
  const conflictManifest = await prepare("conflict", revised);
  await assert.rejects(run(conflictManifest, revisedPath), /金额冲突/);
  const tasks = await (await fetch(api.url + apiPath + "/tasks", { headers: { authorization } })).json();
  const failed = tasks.find((task: { status: string }) => task.status === "failed");
  assert.equal(failed.conflict.existing_price_id, priceId);
  assert.equal(failed.conflict.existing_amount, "5896.00");
  assert.equal(failed.conflict.proposed_amount, "5901.00");
  assert.equal(failed.conflict.proposed_source.price_cell, "G5");
  assert.equal(failed.conflict.proposed_source.sha256, revised.sha256);
  assert.equal(failed.skill_version, "orth-price-governance/1");
  assert.equal(failed.parser_version, "joint-results-xls/1");
  assert.equal((await (await get(priceId)).json()).amount, "5896.00");

  const otherFeeManifest = await prepare("distinct-fee-basis", {
    ...revised, notice_url: "https://test.invalid/distinct-fee",
    attachment_url: "https://test.invalid/distinct-fee.xls", service_fee_basis: "不含伴随服务费"
  });
  const otherFee = await run(otherFeeManifest, revisedPath);
  await publish(otherFee.price_id);
  assert.equal((await (await get(otherFee.price_id)).json()).service_fee_basis, "不含伴随服务费");
  assert.equal((await (await get(priceId)).json()).service_fee_basis, "含伴随服务费");

  const repeatedEvidence = await run(await prepare("repeated-evidence", {
    ...enriched, governance: { ...enriched.governance, unresolved: ["文案更新，原据未变"] },
    change: change("additional_evidence", priceId, 2, "重新提交同一证据")
  }));
  assert.equal((await action(repeatedEvidence.candidate_id, "review")).status, 204);
  assert.equal((await action(repeatedEvidence.candidate_id, "publish")).status, 409);

  const officialInput = { ...revised, notice_url: "https://test.invalid/official-correction",
    service_fee_basis: "测试误录", governance: enriched.governance };
  const staleOfficial = await run(await prepare("stale-official-correction", {
    ...officialInput, change: change("official_correction", priceId, 1, "测试：模拟官方更正")
  }), revisedPath);
  assert.equal((await action(staleOfficial.candidate_id, "review")).status, 204);
  assert.equal((await action(staleOfficial.candidate_id, "publish")).status, 409);
  const correctionManifest = await prepare("official-correction", {
    ...officialInput, change: change("official_correction", priceId, 2, "测试：模拟官方更正")
  });
  const official = await run(correctionManifest, revisedPath);
  assert.notEqual(official.price_id, priceId);
  assert.equal(official.price_id, staleOfficial.price_id);
  assert.notEqual(official.candidate_id, staleOfficial.candidate_id);
  assert.equal((await get(official.price_id)).status, 404);
  await publish(official.candidate_id);
  const corrected = await (await get(official.price_id)).json();
  assert.equal(corrected.supersedes_price_id, priceId);
  assert.equal(corrected.amount, "5901.00");
  assert.equal((await (await get(priceId)).json()).amount, "5896.00");
  assert.equal((await (await get(priceId, "/evidence")).json()).superseded_by_price_id, official.price_id);

  const platformManifest = await prepare("platform-correction", {
    ...revised, notice_url: "https://test.invalid/official-correction",
    change: change("platform_correction", official.price_id, 1, "测试：修复伴随服务费口径误录")
  });
  const platform = await run(platformManifest, revisedPath);
  assert.equal(platform.price_id, official.price_id);
  await publish(platform.candidate_id);
  assert.equal((await run(platformManifest, revisedPath)).candidate_id, platform.candidate_id);
  assert.deepEqual(await (await get(platform.price_id)).json(), {
    ...corrected, record_version: 2, service_fee_basis: "含伴随服务费"
  });
  const history = (await (await get(platform.price_id, "/evidence")).json()).revisions;
  assert.deepEqual(history.map((revision: { operation: string; price: { service_fee_basis: string } }) =>
    [revision.operation, revision.price.service_fee_basis]),
  [["platform_correction", "含伴随服务费"], ["official_correction", "测试误录"]]);

  const scopeCorrection = await run(await prepare("scope-correction-without-evidence", {
    ...revised, notice_url: "https://test.invalid/official-correction", region: "测试地区",
    change: change("platform_correction", official.price_id, 2, "测试：更正地区需重新核对原治理证据")
  }), revisedPath);
  assert.equal((await action(scopeCorrection.candidate_id, "review")).status, 204);
  assert.equal((await action(scopeCorrection.candidate_id, "publish")).status, 409);

  const governanceCorrection = await run(await prepare("correct-governance-only", {
    ...revised, notice_url: "https://test.invalid/official-correction",
    governance: { unresolved: ["测试：原组成关联已撤销，重新核对中"] },
    change: change("platform_correction", official.price_id, 2, "测试：撤销误录的类别组成")
  }), revisedPath);
  await publish(governanceCorrection.candidate_id);
  const governanceHistory = await (await get(official.price_id, "/evidence")).json();
  assert.equal(governanceHistory.current_governance[0].category_composition, null);
  assert.ok(governanceHistory.revisions[2].governance.category_composition);
});
