import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { promisify } from "node:util";
import { createApp } from "../src/app.ts";
import { checkMiniPricePage } from "./mini-preview.ts";
import { testDatabase } from "./postgres.ts";
import { checkWebPricePage } from "./web-price-preview.ts";

const exec = promisify(execFile);

function startApplication(databaseUrl: string) {
  return spawn(process.execPath, ["src/application/start.ts"], {
    env: { ORTH_APPLICATION_DATABASE_URL: databaseUrl, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"]
  });
}

test("复核湖南正式中选原表并发布后，才可用 price_id 查到套价与证据", async (t) => {
  let applicationProcess: ReturnType<typeof startApplication> | undefined;
  t.after(async () => {
    if (!applicationProcess || applicationProcess.exitCode !== null || applicationProcess.signalCode !== null) return;
    const exited = once(applicationProcess, "exit");
    applicationProcess.kill();
    await exited;
  });
  const database = await testDatabase(t);
  const dataDir = await mkdtemp(join(tmpdir(), "orth-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await database.migrate();
  const application = await database.login("orth_application");
  const governance = await database.login("orth_governance");
  const publisher = await database.login("orth_publisher");
  applicationProcess = startApplication(application.url);
  const output = createInterface({ input: applicationProcess.stdout });
  let applicationBase: string;
  try {
    const [line] = await once(output, "line", { signal: AbortSignal.timeout(5_000) });
    const address = String(line).match(/http:\/\/127\.0\.0\.1:[1-9]\d*/);
    assert.ok(address, "应用进程应报告实际监听地址");
    applicationBase = address[0];
  } finally {
    output.close();
  }
  const manifestPath = "samples/hunan-joint-results.json";
  const importSample = (manifest = manifestPath) => exec(process.execPath, [
    "src/import-price.ts", manifest, "samples/hunan-joint-results.xls"
  ], { env: { ...process.env, ORTH_GOVERNANCE_DATABASE_URL: governance.url, ORTH_DATA_DIR: dataDir } });
  const { stdout } = await importSample();

  const server = createApp({
    applicationPool: application.pool,
    governance: {
      pool: governance.pool, publisherPool: publisher.pool, dataDir,
      operator: { user: "reviewer", password: "test-secret" }
    }
  }).listen(0, "127.0.0.1");
  t.after(() => {
    if (server.listening) return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const { price_id } = JSON.parse(stdout);
  const expected = JSON.parse(await readFile("samples/hunan-joint-results.published.json", "utf8"));
  assert.equal(price_id, expected.price_id);

  await t.test("导入与 PostgreSQL 拒绝超出契约范围的执行日期", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const invalidManifest = join(dataDir, "invalid-date.json");
    await writeFile(invalidManifest, JSON.stringify({ ...manifest, row_number: 6, effective_from: "infinity" }));
    await Promise.all([
      assert.rejects(importSample(invalidManifest), { stderr: /effective_from/ }),
      assert.rejects(governance.pool.query(`
        INSERT INTO orth_governance.import_candidate
          (price_id, amount, product_system, applicant, region, effective_from, service_fee_basis, source, original_rows)
        SELECT 'aj_00000000000000000000000000000000', amount, product_system, applicant, region,
               'infinity'::date, service_fee_basis, source, original_rows
        FROM orth_governance.import_candidate WHERE price_id = $1
      `, [price_id]), { code: "23514" })
    ]);
  });

  const price = () => fetch(`${applicationBase}/api/v1/prices/${price_id}`);
  const readPublishedPrice = () => application.pool.query(
    "SELECT * FROM orth_catalog.price_v1 WHERE price_id = $1", [price_id]
  );
  const operator = `${base}/ops/candidates/${price_id}`;
  const authorization = "Basic " + Buffer.from("reviewer:test-secret").toString("base64");
  const action = (name: string) => fetch(`${operator}/${name}`, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}"
  });

  const beforePublication = await price();
  assert.equal(beforePublication.status, 404);
  assert.deepEqual(await beforePublication.json(), { error: "price_not_found" });
  assert.equal((await readPublishedPrice()).rowCount, 0);
  assert.equal((await fetch(operator)).status, 401);
  const queue = await fetch(`${base}/ops`, { headers: { authorization } });
  assert.equal(queue.status, 200);
  assert.match(await queue.text(), new RegExp(price_id));
  const before = await fetch(operator, { headers: { authorization } });
  assert.equal(before.status, 200);
  const html = await before.text();
  assert.match(html, /Sheet1/);
  assert.match(html, /G5/);
  assert.match(html, /中选价格/);
  assert.match(html, /待复核/);
  const workbook = await fetch(`${operator}/attachment`, { headers: { authorization } });
  assert.equal(workbook.status, 200);
  assert.deepEqual(Buffer.from(await workbook.arrayBuffer()), await readFile("samples/hunan-joint-results.xls"));

  assert.equal((await action("publish")).status, 409);
  assert.equal((await action("review")).status, 204);
  assert.equal((await price()).status, 404);
  const attempts = await Promise.all([action("publish"), action("publish")]);
  assert.deepEqual(attempts.map(({ status }) => status), [204, 204]);
  const published = await price();
  assert.equal(published.status, 200);
  const { published_at, ...snapshot } = await published.json();
  assert.match(published_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(snapshot, expected);
  const { rows } = await readPublishedPrice();
  assert.deepEqual(rows, [{ ...expected, published_at }]);

  await t.test("重复导入复用 price_id，已发布记录保持可查", async () => {
    const { stdout } = await importSample();
    assert.deepEqual(JSON.parse(stdout), { price_id });
    const response = await price();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...expected, published_at });
  });

  await t.test("治理服务停止后，独立应用 API 与小程序仍可打开最后发布的价格", async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const response = await price();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...expected, published_at });
    assert.equal((await fetch(`${applicationBase}/ops`)).status, 404);
    await checkMiniPricePage(applicationBase, price_id);
  });

  await t.test("治理服务停止后，访客可在 Web 查价并打开公告与原表", () =>
    checkWebPricePage(applicationBase, expected));
});
