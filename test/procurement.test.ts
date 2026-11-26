import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import type { ProcurementResponse } from "../contracts/procurement-v1.d.ts";
import { createApplicationApp } from "../src/application/app.ts";
import { sha256 } from "../src/attachments.ts";
import { createGovernanceApi, governanceApiPath } from "../src/governance-api.ts";
import { testDatabase } from "./postgres.ts";

test("按地区和日期查询人工关节政策，保留国家与地方各自出处", async (t) => {
  const database = await testDatabase(t);
  await database.migrate();
  const application = await database.login("orth_application");
  const app = await listen(t, createApplicationApp(application.pool));
  const base = app + "/api/v1/procurement";

  const response = await fetch(`${base}?${new URLSearchParams({
    category: "人工关节", region: "湖南省", round_id: "GH-HD2024-1", date: "2024-10-15"
  })}`);
  assert.equal(response.status, 200);
  const { events, prices }: ProcurementResponse = await response.json();
  assert.deepEqual(events.map(({ event_type }) => event_type),
    ["local_execution", "official_award", "submission"]);
  assert.equal(events[0].region, "湖南省");
  assert.equal(events[0].effective_from, "2024-10-15");
  assert.match(events[0].source.url, /ybj\.hunan\.gov\.cn/);
  assert.equal(events[1].region, null);
  assert.equal(events[1].announced_on, "2024-05-24");
  assert.deepEqual(prices, []);
  const renewal = await fetch(`${base}?${new URLSearchParams({ region: "西藏自治区", date: "2026-08-26" })}`);
  const { events: [renewalEvent] }: ProcurementResponse = await renewal.json();
  assert.equal(renewalEvent.event_type, "annual_renewal");
  assert.equal(renewalEvent.round_id, "GH-HD2024-1");
  assert.equal(renewalEvent.effective_from, "2026-01-01");
  assert.equal(renewalEvent.effective_to, "2027-01-01");
  assert.match(renewalEvent.source.url, /xizang\.gov\.cn/);
  assert.equal(renewalEvent.price_disclosure, "not_stated");

  const progress = async (date: string) => {
    const response = await fetch(`${base}?${new URLSearchParams({ category: "运动医学", date })}`);
    assert.equal(response.status, 200);
    return response.json() as Promise<ProcurementResponse>;
  };
  assert.deepEqual((await progress("2026-04-29")).events, []);
  const [maintenance] = (await progress("2026-04-30")).events;
  assert.equal(maintenance.event_type, "product_information_maintenance");
  assert.match(maintenance.source.url, /show14522\.html$/);
  const [confirmation] = (await progress("2026-11-09")).events;
  assert.equal(confirmation.event_type, "product_information_confirmation");
  assert.match(confirmation.source.url, /show14566\.html$/);
  const inFlight = await progress("2026-11-26");
  assert.deepEqual(inFlight.prices, []);
  assert.equal(inFlight.events.length, 3);
  assert.equal(inFlight.events[0].event_type, "product_information_notice");
  assert.equal(inFlight.events[0].price_disclosure, "not_disclosed");
  assert.match(inFlight.events[0].source.url, /show14567\.html$/);

  for (const query of ["date=2024-02-30", "date=2024-02-01&date=2024-02-02", "region=%00"]) {
    assert.equal((await fetch(`${base}?${query}`)).status, 400);
  }
  const page = await fetch(`${app}/procurement?${new URLSearchParams({ category: "骨科脊柱", date: "2026-11-26" })}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /产品信息公示/);
  assert.match(html, /当期公告未披露正式中选价/);
  assert.match(html, /show14567\.html"/);
});

const exec = promisify(execFile);
const authorization = "Basic " + Buffer.from("reviewer:test-secret").toString("base64");
const officialHunanNotice = "https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/t20240919_33458275.html";
const officialFujianNotice = "https://ybj.fj.gov.cn/zfxxgkzl/fdzdgknr/qtyzdgkzfxx/202409/t20240918_6523431.htm";
const officialNationalAward = "https://hc.tjmpc.cn:10128/public/show14438.html";

async function listen(t: TestContext, app: ReturnType<typeof createApplicationApp>) {
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("两地金额由真实原件导入、复核和发布，各自按执行日和来源公开查询", async (t) => {
  const database = await testDatabase(t);
  await database.migrate();
  const dataDir = await mkdtemp(join(tmpdir(), "orth-regional-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const [worker, governance, publisher, application] = await Promise.all([
    database.login("orth_worker"), database.login("orth_governance"), database.login("orth_publisher"),
    database.login("orth_application")
  ]);
  const base = await listen(t, createApplicationApp(application.pool));
  const governanceBase = await listen(t, createGovernanceApi({
    pool: governance.pool, publisherPool: publisher.pool, dataDir,
    operator: { user: "reviewer", password: "test-secret" }
  })) + governanceApiPath;
  const round = { category: "人工关节", round_id: "GH-HD2024-1" };

  async function query(filters: Record<string, string>): Promise<ProcurementResponse> {
    const response = await fetch(`${base}/api/v1/procurement?${new URLSearchParams({ ...round, ...filters })}`);
    assert.equal(response.status, 200);
    return response.json();
  }

  const originalHtml = gunzipSync(await readFile("samples/national-joint-results.html.gz"));
  const htmlPath = join(dataDir, "national-award.html");
  await writeFile(htmlPath, originalHtml);
  const importPrice = async (manifest: string, file?: string) => {
    const { stdout } = await exec(process.execPath, ["src/start-worker.ts", manifest, ...(file ? [file] : [])], {
      env: { ...process.env, ORTH_WORKER_DATABASE_URL: worker.url, ORTH_DATA_DIR: dataDir }
    });
    return JSON.parse(stdout) as { price_id: string; candidate_id?: string };
  };
  const { price_id: hunanId } = await importPrice("samples/hunan-joint-results.json", "samples/hunan-joint-results.xls");
  const { price_id: fujianId } = await importPrice("samples/fujian-joint-results.json",
    process.env.ORTH_TEST_LIVE_FUJIAN === "1" ? undefined : htmlPath);
  assert.notEqual(hunanId, fujianId);
  const manifest = JSON.parse(await readFile("samples/fujian-joint-results.json", "utf8"));
  const manifestWithPage = join(dataDir, "fujian-manifest-with-page.json");
  manifest.local_award_reference.url += "#page=1";
  await writeFile(manifestWithPage, JSON.stringify(manifest));
  assert.equal((await importPrice(manifestWithPage, htmlPath)).price_id, fujianId);
  const candidate = (id: string, subpath: string) => `${governanceBase}/candidates/${id}/${subpath}`;
  const action = (id: string, subpath: string) => fetch(candidate(id, subpath), {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}"
  });
  const archivedHtml = await fetch(candidate(fujianId, "attachment"), { headers: { authorization } });
  assert.equal(archivedHtml.status, 200);
  assert.match(archivedHtml.headers.get("content-disposition") ?? "", /^attachment/i);
  assert.deepEqual(Buffer.from(await archivedHtml.arrayBuffer()), originalHtml);

  assert.deepEqual((await query({ date: "2024-10-15" })).prices, []);
  for (const id of [hunanId, fujianId]) assert.equal((await action(id, "review")).status, 204);
  assert.deepEqual((await query({ date: "2024-10-15" })).prices, []);
  for (const id of [hunanId, fujianId]) assert.equal((await action(id, "publish")).status, 204);

  assert.deepEqual((await query({ date: "2024-10-11" })).prices, []);
  const { prices: [fujian, ...rest], events: fujianEvents } = await query({ date: "2024-10-12" });
  assert.ok(fujian);
  assert.deepEqual(rest, []);
  assert.equal(fujian.price_id, fujianId);
  assert.equal(fujian.region, "福建省");
  assert.equal(fujian.effective_from, "2024-10-12");
  assert.equal(fujian.source.notice_url, officialFujianNotice);
  assert.equal(fujian.source.attachment_url, officialNationalAward);
  assert.equal(fujian.source.price_cell, "G2");
  assert.equal(fujian.execution.price_disclosure, "referenced");
  const award = fujianEvents.find(({ event_id }) => event_id === fujian.execution.evidence.referenced_award_event_id);
  assert.equal(award?.event_type, "official_award");
  assert.equal(award?.source.url, fujian.source.attachment_url);
  assert.match(fujian.execution.evidence.attachments?.[0].location ?? "", /附件 PDF 中选清单/);
  assert.equal(fujian.source.local_award_reference?.page, 1);
  assert.equal(fujian.source.local_award_reference?.serial_number, 1);
  assert.equal(fujian.source.local_award_reference?.applicant, fujian.applicant);
  assert.equal(fujian.execution.evidence.execution_date_location, "第二节中选结果及执行时间");

  const { prices: [hunan] } = await query({ date: "2024-10-15", region: "湖南省" });
  assert.ok(hunan);
  assert.equal(hunan.price_id, hunanId);
  assert.equal(hunan.source.notice_url, officialHunanNotice);
  assert.equal(hunan.source.price_cell, "G5");
  assert.equal(hunan.effective_from, "2024-10-15");
  assert.equal(hunan.execution.price_disclosure, "disclosed");
  assert.equal(hunan.execution.evidence.execution_date_location, "第二节采购周期与协议采购量");

  for (const price of [fujian, hunan]) {
    assert.deepEqual([price.product_system, price.applicant, price.amount, price.unit, price.service_fee_basis,
      price.published_group], ["合金-聚乙烯类髋关节产品系统", "天津正天医疗器械有限公司", "5896.00", "元/套",
      "含伴随服务费", "A"]);
    const detail = await fetch(`${base}/api/v1/prices/${price.price_id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual((await detail.json()).source, price.source);
  }
  assert.deepEqual((await query({ date: "2024-10-15" })).prices.map(({ price_id }) => price_id).sort(),
    [fujianId, hunanId].sort());
  assert.deepEqual((await query({ region: "西藏自治区" })).prices, []);
  assert.equal(fujian.applicable_to, "2027-10-12");
  assert.equal(hunan.applicable_to, "2027-10-15");
  assert.deepEqual((await query({ date: "2027-10-12" })).prices.map(({ price_id }) => price_id), [hunanId]);
  assert.deepEqual((await query({ date: "2027-10-15" })).prices, []);

  const page = await fetch(`${base}/procurement?${new URLSearchParams({ ...round, region: "福建省", date: "2024-10-12" })}`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /5896\.00 元\/套/);
  assert.match(html, /PDF第1页序号1/);
  assert.match(html, /P020240918628974592265\.pdf#page=1"/);
  assert.doesNotMatch(html, /#page=1#/);
  assert.match(html, /show14438\.html/);
  assert.doesNotMatch(html, /湖南省医疗保障局/);

  await t.test("正式更正仍可按所属地区的执行政策回查，保留新旧价各自的有效日期", async () => {
    const manifest = JSON.parse(await readFile("samples/fujian-joint-results.json", "utf8"));
    async function publishCorrection(target: string, amount: string, effectiveFrom: string, notice: string) {
      const updated = Buffer.from(originalHtml.toString("utf8").replace(">5896<", `>${amount}<`));
      assert.notDeepEqual(updated, originalHtml);
      const tablePath = join(dataDir, `correction-${effectiveFrom}.html`);
      const manifestPath = join(dataDir, `correction-${effectiveFrom}.json`);
      await writeFile(tablePath, updated);
      await writeFile(manifestPath, JSON.stringify({
        ...manifest, notice_url: notice, sha256: sha256(updated), effective_from: effectiveFrom,
        change: {
          operation: "official_correction", target_price_id: target, target_record_version: 1,
          reason: "隔离测试数据库中的正式更正演练"
        }
      }));
      const { price_id, candidate_id } = await importPrice(manifestPath, tablePath);
      assert.ok(candidate_id);
      assert.equal((await action(candidate_id, "review")).status, 204);
      assert.equal((await action(candidate_id, "publish")).status, 204);
      return price_id;
    }

    const correctedId = await publishCorrection(fujianId, "5900", "2025-03-01", "https://example.test/official-correction");
    const fujianQuery = { region: "福建省" };
    const [original] = (await query({ ...fujianQuery, date: "2025-02-28" })).prices;
    const [corrected] = (await query({ ...fujianQuery, date: "2025-03-01" })).prices;
    assert.deepEqual([original?.price_id, original?.applicable_to, original?.superseded_by_price_id],
      [fujianId, "2025-03-01", correctedId]);
    assert.deepEqual([corrected?.price_id, corrected?.amount, corrected?.effective_from],
      [correctedId, "5900.00", "2025-03-01"]);
    assert.equal(corrected.source.notice_url, "https://example.test/official-correction");
    assert.equal(corrected.execution.source.url, officialFujianNotice);

    const backdatedId = await publishCorrection(correctedId, "5920", "2025-02-01", "https://example.test/backdated-correction");
    const { prices: [preceding] } = await query({ ...fujianQuery, date: "2025-01-31" });
    assert.equal(preceding.price_id, fujianId);
    assert.equal(preceding.applicable_to, "2025-02-01");
    assert.equal(preceding.superseded_by_price_id, correctedId);
    for (const date of ["2025-02-01", "2025-03-01"]) {
      const { prices } = await query({ ...fujianQuery, date });
      assert.deepEqual(prices.map((price) => [price.price_id, price.amount]), [[backdatedId, "5920.00"]]);
    }
  });

  await t.test("追溯生效的已发布价格按执行窗口查，政策节点仍按公开日期查", async () => {
    const region = "隔离测试地区";
    const noticeUrl = "https://example.test/retroactive-execution";
    const manifest = JSON.parse(await readFile("samples/hunan-joint-results.json", "utf8"));
    await database.owner.query(`
      INSERT INTO orth_catalog.procurement_event
        (event_id, round_id, region, event_type, announced_on, effective_from, summary, price_disclosure,
         publisher, notice_title, notice_url, notice_location, evidence)
      VALUES
        ('test-award-with-attachment', 'GH-HD2024-1', NULL, 'official_award', '2024-05-24', NULL,
         '隔离测试中的正式结果', 'disclosed', '测试发布单位', '测试公告',
         'https://example.test/official-award', '测试小节', $3::jsonb),
        ('test-retroactive-execution', 'GH-HD2024-1', $1, 'local_execution', '2024-10-20', '2024-10-01',
         '隔离测试中的追溯执行', 'referenced', '测试发布单位', '测试公告', $2,
         '测试小节', '{"referenced_award_event_id":"test-award-with-attachment"}')
    `, [region, noticeUrl, {
      attachments: [{ url: manifest.attachment_url, title: manifest.attachment_title, location: "Sheet1" }]
    }]);
    const retroactiveManifest = join(dataDir, "retroactive.json");
    await writeFile(retroactiveManifest, JSON.stringify({
      ...manifest, region, notice_url: noticeUrl, effective_from: "2024-10-01"
    }));
    const { price_id } = await importPrice(retroactiveManifest, "samples/hunan-joint-results.xls");
    assert.equal((await action(price_id, "review")).status, 204);
    assert.equal((await action(price_id, "publish")).status, 204);
    assert.deepEqual((await query({ region, date: "2024-09-30" })).prices, []);
    const result = await query({ region, date: "2024-10-01" });
    assert.equal(result.events.some((event) => event.region === region), false);
    assert.deepEqual(result.prices.map((price) => price.price_id), [price_id]);
    assert.equal(result.prices[0].execution.announced_on, "2024-10-20");
  });
});
