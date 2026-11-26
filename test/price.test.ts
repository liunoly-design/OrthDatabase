import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Pool } from "pg";
import { createApp } from "../src/app.ts";
import { checkMiniPricePage } from "./mini-preview.ts";

const exec = promisify(execFile);

test("复核湖南正式中选原表并发布后，才可用 price_id 查到套价与证据", async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL, "Set TEST_DATABASE_URL to a PostgreSQL test database");
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "orth_test_" + randomUUID().replaceAll("-", "");
  const dataDir = await mkdtemp(join(tmpdir(), "orth-test-"));
  t.after(async () => {
    await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await root.end();
    await rm(dataDir, { recursive: true, force: true });
  });
  await root.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const env = { ...process.env, DATABASE_URL: url.href, ORTH_DATA_DIR: dataDir };
  await exec(process.execPath, ["src/migrate.ts"], { env });
  const pool = new Pool({ connectionString: url.href });
  const server = createApp(pool, dataDir, { user: "reviewer", password: "test-secret" })
    .listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const importSample = () => exec(process.execPath, [
    "src/import-price.ts", "samples/hunan-joint-results.json", "samples/hunan-joint-results.xls"
  ], { env });
  const { stdout } = await importSample();
  const { price_id } = JSON.parse(stdout);
  assert.match(price_id, /^aj_[a-f0-9]{32}$/);

  const price = () => fetch(`${base}/api/v1/prices/${price_id}`);
  const operator = `${base}/ops/candidates/${price_id}`;
  const authorization = "Basic " + Buffer.from("reviewer:test-secret").toString("base64");
  const action = (name: string) => fetch(`${operator}/${name}`, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}"
  });

  assert.equal((await price()).status, 404);
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
  assert.equal((await action("publish")).status, 204);
  const published = await price();
  assert.equal(published.status, 200);
  assert.deepEqual(await published.json(), {
    price_id,
    amount: "5896.00",
    currency: "CNY",
    unit: "元/套",
    price_type: "正式中选价",
    product_system: "合金-聚乙烯类髋关节产品系统",
    applicant: "天津正天医疗器械有限公司",
    region: "湖南省",
    effective_from: "2024-10-15",
    service_fee_basis: "含伴随服务费",
    source: {
      publisher: "湖南省医疗保障局",
      notice_title: "湖南省医疗保障局关于做好人工关节集中带量采购协议期满接续中选结果执行工作的通知",
      notice_url: "https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/t20240919_33458275.html",
      attachment_title: "附件1 国家组织人工关节集中带量采购协议期满接续中选结果",
      attachment_url: "https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/33458275/files/0ac80457057341528553dae98aee88b0.xls",
      sha256: "b6af63a9ad50d50b05025319225a000065c1b2ffc05505d49fa9e361a87bd7f5",
      sheet_name: "Sheet1",
      row_number: 5,
      price_cell: "G5"
    }
  });
  await t.test("小程序页面按 price_id 打开并定位官方公告与原表", () => checkMiniPricePage(base, price_id));

  await t.test("重复导入复用 price_id，已发布记录保持可查", async () => {
    const { stdout } = await importSample();
    assert.deepEqual(JSON.parse(stdout), { price_id });
    const response = await price();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).amount, "5896.00");
  });
});
