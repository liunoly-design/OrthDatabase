import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { read } from "xlsx";
import type { SpecificationProposal } from "../contracts/specification-v1.d.ts";
import test, { type TestContext } from "node:test";
import type { Express } from "express";
import { createApplicationApp } from "../src/application/app.ts";
import { createGovernanceApi } from "../src/governance-api.ts";
import { testDatabase } from "./postgres.ts";

const contractEvidence = [{
  title: "契约演练用证据", url: "https://example.org/contract-only", section: "演练原文"
}];
const oldCertificate = "国械注准20003130001";
const newCertificate = "国械注准20053130001";
const nhsaCode = "C00000000000000000000000001";
const di = "00000000000000";
const old = { id: "spec-old", name: "契约示例股骨柄", registrant: "示例企业", model: "M1", specification: "10 mm",
  evidence: contractEvidence };
const latest = { ...old, id: "spec-new" };
const certificate = (id: string, value: string, valid_from: string, valid_to: string) => ({
  id, scheme: "registration_number", value, evidence: contractEvidence, certificate: { valid_from, valid_to }
});
const oldVersion = certificate("old-v1", oldCertificate, "2000-01-01", "2004-12-31");
const newVersion = certificate("new-v1", newCertificate, "2005-01-01", "2009-12-31");
const renewal = certificate("new-v2", newCertificate, "2010-01-01", "2014-12-31");
const insurance = { id: "nhsa-new", scheme: "nhsa_27", value: nhsaCode, evidence: contractEvidence };
const device = { id: "udi-new", scheme: "udi_di", value: di, evidence: contractEvidence,
  packaging: { description: "最小销售单元", quantity: 1 } };

const oldPrice = {
  price_id: "sp_old", amount: "110.00", price_type: "挂网价", unit: "元/件", pack_quantity: 1,
  region: "甲省", hospital_id: null, round_id: "first", effective_from: "2004-01-01", effective_to: "2004-12-31",
  service_fee_basis: "原文未披露", original_identifier_ids: [oldVersion.id], evidence: contractEvidence
};
const newPrice = { ...oldPrice, price_id: "sp_new", amount: "156.00", region: "乙省", round_id: "second",
  effective_from: "2009-01-01", effective_to: null,
  original_identifier_ids: [newVersion.id, insurance.id, device.id],
  evidence: [{ title: "契约演练：同页刊登单件价及整盒价", url: "https://example.org/contract-only.pdf", page: 5 }] };
const boxPrice = { ...newPrice, price_id: "sp_box", amount: "990.00", unit: "元/盒", pack_quantity: 10,
  original_identifier_ids: [newVersion.id, insurance.id] };

async function listen(t: TestContext, app: Express) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function traceServices(t: TestContext) {
  const database = await testDatabase(t);
  await database.migrate();
  const [application, governance, publisher] = await Promise.all([
    database.login("orth_application"), database.login("orth_governance"), database.login("orth_publisher")
  ]);
  const publicUrl = await listen(t, createApplicationApp(application.pool)) + "/api/v1/specifications";
  const operator = { user: "reviewer", password: "local-contract-test" };
  const governanceUrl = await listen(t, createGovernanceApi({
    pool: governance.pool, publisherPool: publisher.pool, dataDir: ".", operator
  })) + "/api/governance/v1/specification-candidates";
  const authorization = "Basic " + Buffer.from(`${operator.user}:${operator.password}`).toString("base64");
  const post = (path: string, body: object) => fetch(governanceUrl + path, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const submit = async (body: object) => {
    const response = await post("", body);
    assert.equal(response.status, 200);
    return (await response.json()).candidate_id as string;
  };
  const review = (id: string) => post(`/${id}/review`, {});
  const publish = (id: string) => post(`/${id}/publish`, {});
  const approve = async (body: object) => {
    const id = await submit(body);
    assert.equal((await review(id)).status, 204);
    assert.equal((await publish(id)).status, 204);
  };
  const lookup = async (scheme: string, value: string, includeRelated = false) => {
    const params = new URLSearchParams({ scheme, value, ...(includeRelated ? { include_related: "1" } : {}) });
    const response = await fetch(publicUrl + "/lookup?" + params);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { publicUrl, governanceUrl, authorization, submit, post, review, publish, approve, lookup, application, database };
}

test("契约演练：复核发布后按旧证查回原价和来源", async (t) => {
  const api = await traceServices(t);
  const oldCandidate = { kind: "specification", specification: old, identifiers: [oldVersion], prices: [oldPrice] };
  const id = await api.submit(oldCandidate);
  assert.equal(await api.submit(oldCandidate), id);
  assert.equal((await api.publish(id)).status, 409);
  assert.equal((await api.lookup("registration_number", oldCertificate)).status, "unverified");
  assert.equal((await api.review(id)).status, 204);
  assert.equal((await api.lookup("registration_number", oldCertificate)).status, "unverified");
  assert.equal((await api.publish(id)).status, 204);
  assert.equal((await api.publish(id)).status, 204);
  const found = await api.lookup("registration_number", oldCertificate);
  assert.equal(found.status, "matched");
  assert.equal(found.matches[0].specification.id, old.id);
  assert.deepEqual(found.matches[0].prices[0].original_identifiers[0].certificate, oldVersion.certificate);
  assert.deepEqual(found.matches[0].prices[0].evidence, contractEvidence);
  assert.equal(found.matches[0].prices[0].amount, oldPrice.amount);
});

test("契约演练：同证续期保留版本，同医保码保留两种计价包装", async (t) => {
  const api = await traceServices(t);
  await api.approve({ kind: "specification", specification: latest,
    identifiers: [newVersion, insurance, device], prices: [newPrice, boxPrice] });
  await api.approve({ kind: "specification", specification: latest, identifiers: [renewal] });

  const current = await api.lookup("registration_number", newCertificate);
  assert.equal(current.status, "matched");
  assert.deepEqual(current.matches[0].matched_identifiers.map(({ certificate }: typeof renewal) => certificate),
    [{ valid_from: "2005-01-01", valid_to: "2009-12-31" }, { valid_from: "2010-01-01", valid_to: "2014-12-31" }]);
  assert.equal(current.matches[0].prices[0].original_identifiers.find(({ id }: { id: string }) => id === newVersion.id)
    .certificate.valid_to, "2009-12-31");

  const insuranceResult = await api.lookup("nhsa_27", nhsaCode);
  assert.deepEqual(insuranceResult.matches[0].prices.map(({ unit, amount, pack_quantity }: typeof newPrice) =>
    [unit, amount, pack_quantity]), [["元/盒", "990.00", 10], ["元/件", "156.00", 1]]);
  const udi = await api.lookup("udi_di", di);
  assert.deepEqual(udi.matches[0].matched_identifiers[0].packaging, { description: "最小销售单元", quantity: 1 });
  assert.deepEqual(udi.matches[0].prices.map(({ packaging_match }: { packaging_match: string }) => packaging_match),
    ["matched", "other"]);
  assert.equal((await api.lookup("udi_di", "123456789")).status, "unverified");
  assert.equal((await fetch(api.publicUrl + "/lookup?scheme=udi_di&value=(01)" + di)).status, 400);
});

test("契约演练：显式展开及撤销同一实物关联，保留两边证照、原价和适用范围", async (t) => {
  const api = await traceServices(t);
  await api.approve({ kind: "specification", specification: old,
    identifiers: [oldVersion, { ...insurance, id: "nhsa-old" }], prices: [oldPrice] });
  await api.approve({ kind: "specification", specification: latest,
    identifiers: [newVersion, insurance, device], prices: [newPrice] });

  const relation = { id: "same-stem", left_spec_id: old.id, right_spec_id: latest.id,
    reason: "契约演练用复核结论", evidence: contractEvidence };
  const candidate = await api.submit({ kind: "same_physical", relation });
  assert.equal((await api.publish(candidate)).status, 409);
  assert.deepEqual((await api.lookup("registration_number", oldCertificate, true)).related, []);
  assert.equal((await api.review(candidate)).status, 204);
  assert.equal((await api.publish(candidate)).status, 204);
  const oldDirect = await api.lookup("registration_number", oldCertificate);
  assert.deepEqual(oldDirect.related, []);
  const together = await api.lookup("registration_number", oldCertificate, true);
  assert.deepEqual(together.matches, oldDirect.matches);
  assert.equal(together.related[0].specification.id, latest.id);
  assert.deepEqual(together.related[0].relations[0].evidence, contractEvidence);
  assert.equal(together.related[0].prices[0].region, "乙省");
  const sharedCode = await api.lookup("nhsa_27", nhsaCode, true);
  assert.equal(sharedCode.status, "ambiguous");
  assert.deepEqual(sharedCode.related, []);
  assert.deepEqual(sharedCode.matches.map(({ relations }: { relations: { id: string }[] }) =>
    relations.map(({ id }) => id)), [["same-stem"], ["same-stem"]]);

  const before = await (await fetch(api.publicUrl + "/prices/sp_old")).json();
  const revoke = await api.submit({ kind: "revoke", relation_id: relation.id, reason: "契约演练用撤销依据" });
  assert.equal((await api.publish(revoke)).status, 409);
  assert.equal((await api.lookup("registration_number", oldCertificate, true)).related.length, 1);
  assert.equal((await api.review(revoke)).status, 204);
  assert.equal((await api.publish(revoke)).status, 204);
  assert.equal((await api.publish(revoke)).status, 204);
  assert.deepEqual(await api.lookup("registration_number", oldCertificate, true), oldDirect);
  assert.ok((await api.lookup("nhsa_27", nhsaCode, true)).matches.every(
    ({ relations }: { relations: unknown[] }) => relations.length === 0));
  assert.equal((await api.lookup("registration_number", newCertificate, true)).matches[0].prices[0].amount, "156.00");
  assert.deepEqual(await (await fetch(api.publicUrl + "/prices/sp_old")).json(), before);

  const audit = await (await fetch(api.governanceUrl + "/" + revoke, { headers: { authorization: api.authorization } })).json();
  assert.equal(audit.reviewed_by, "reviewer");
  assert.equal(audit.published_by, "reviewer");
  assert.equal(audit.proposal.reason, "契约演练用撤销依据");
});

test("契约演练：冲突的价格依据拒绝整批发布，已审核但未发布的映射保持不可见", async (t) => {
  const api = await traceServices(t);
  const id = await api.submit({ kind: "specification", specification: latest,
    identifiers: [newVersion, insurance, device], prices: [{ ...newPrice, pack_quantity: 4 }] });
  assert.equal((await api.review(id)).status, 204);
  assert.equal((await api.publish(id)).status, 409);
  assert.equal((await api.lookup("nhsa_27", nhsaCode)).status, "unverified");
  assert.equal((await api.lookup("udi_di", di)).status, "unverified");
  assert.equal((await fetch(api.publicUrl + "/prices/sp_new")).status, 404);
  assert.equal((await fetch(api.governanceUrl + "/" + id)).status, 401);
  await assert.rejects(api.application.pool.query("SELECT * FROM orth_governance.specification_candidate"),
    { code: "42501" });
  await assert.rejects(api.application.pool.query("SELECT * FROM orth_catalog.specification_identifier"), { code: "42501" });
  await assert.rejects(api.application.pool.query(
    "UPDATE orth_catalog.specification_identifier_v1 SET snapshot = '{}'::jsonb"), { code: "42501" });
});

test("真实凭据：湖北旧证提供部件线索，现证、医保码及 UDI-DI 核对 GB-6，价格保留部件口径", async (t) => {
  const proposals: SpecificationProposal[] = JSON.parse(await readFile("samples/joint-specification-trace.official.json", "utf8"));
  const api = await traceServices(t);
  for (const proposal of proposals) await api.approve(proposal);

  const former = await api.lookup("registration_number", "国械注准20173460995");
  const current = await api.lookup("registration_number", "国械注准20173130995");
  const component = "cc20e421-0a13-11ea-99e3-fa163e0a8baf";
  const byComponent = await (await fetch(api.publicUrl + "/lookup?" + new URLSearchParams({
    scheme: "platform_component_code", value: component, namespace: "gh-hd2024-1"
  }))).json();
  assert.equal(former.status, "component_only");
  assert.equal(current.status, "ambiguous");
  assert.equal(byComponent.status, "ambiguous");
  assert.deepEqual(former.component_matches.map((match: { specification: { specification: string } }) =>
    match.specification.specification).sort(), ["125mm", "148mm", "150mm", "152mm", "154mm"]);

  const byInsurance = await api.lookup("nhsa_27", "C03440210701011018840000653");
  const byDi = await api.lookup("udi_di", "06921814258644");
  assert.equal(byInsurance.status, "matched");
  assert.equal(byDi.status, "matched");
  const [stem] = byDi.matches;
  const specId = "hb-gh-hd2024-1-7d1c8d5a-da96-11e9-953f-fa163e0a8baf";
  for (const hits of [former.component_matches, current.matches, byComponent.matches, byInsurance.matches, byDi.matches]) {
    assert.ok(hits.some(({ specification }: typeof stem) => specification.id === specId));
  }
  assert.equal(stem.specification.model, "GB-6");
  assert.equal(stem.specification.specification, "125mm");
  assert.equal(stem.specification.registrant, "天津正天医疗器械有限公司");
  assert.equal(stem.matched_identifiers[0].packaging.quantity, 1);
  assert.equal(stem.matched_identifiers[0].evidence[0].url,
    "https://udi.nmpa.gov.cn/showDetailCX.html?deviceRecordKey=13cb40c7-1482-48c6-b89d-fc4d92346250");
  assert.equal((await api.lookup("udi_di", "06921814258675")).status, "unverified");
  assert.deepEqual(stem.prices, []);
  const [historical, award] = stem.component_prices;
  assert.equal(historical.price_id, "cp_sz_gh_hd2021_1_5885");
  assert.equal(historical.amount, "2600.00");
  assert.equal(historical.region, "广东省·深圳市");
  assert.equal(historical.effective_from, "2023-08-01");
  assert.equal(historical.effective_to, "2024-07-31");
  assert.equal(historical.effective_to_basis, "known");
  assert.equal(historical.effective_to_exclusive, "2024-08-01");
  assert.equal(historical.effective_date_text, "2023年8月1日至2024年7月31日");
  assert.deepEqual(historical.source_nhsa_20, { current: "C0344021070101101884", former: "C0344021070100501884" });
  assert.equal(historical.evidence[0].row_number, 5885);
  assert.equal((await api.lookup("nhsa_27", "C03440210701005018840000657")).status, "unverified");
  assert.equal(award.amount, "2600.00");
  assert.equal(award.region, "湖北省");
  assert.equal(award.unit, null);
  assert.equal(award.effective_to_basis, "unknown");
  assert.equal(award.evidence[0].row_number, 9734);
  assert.ok(award.evidence[0].cells.includes("AA9734"));
  assert.deepEqual(award.original_registration_numbers, ["国械注准20173130995", "国械注准20173460995"]);
  const fromOldCertificate = former.component_matches.find(({ specification }: typeof stem) => specification.id === specId);
  assert.deepEqual(fromOldCertificate.component_prices, [historical, award]);
  assert.equal(fromOldCertificate.matched_identifiers[0].via_component, "procurement-component");
  assert.equal(fromOldCertificate.matched_identifiers[0].certificate.valid_to, null);
  const detail = await (await fetch(api.publicUrl + "/prices/cp_hb_gh_hd2024_1_9734")).json();
  assert.equal(detail.subject_kind, "component");
  assert.equal(detail.amount, "2600.00");
});

test("真实原表复验：按摘要与坐标核对部件、证号、型号规格、编码和价格",
  { skip: !process.env.ORTH_TEST_SUPPLY_WORKBOOK }, async () => {
    const bytes = await readFile(process.env.ORTH_TEST_SUPPLY_WORKBOOK!);
    assert.equal(createHash("sha256").update(bytes).digest("hex"),
      "b07e64d985de3b0e4436c3cad9cccaf56ba6adf71a45ffb5a4ab76c98baa3d5a");
    const book = read(bytes, { sheets: ["系统表", "产品表", "规格型号表"], dense: true, sheetRows: 99465 });
    const row = (sheet: string, number: number) => book.Sheets[sheet]["!data"]?.[number - 1].map((cell) => cell?.v);
    const system = row("系统表", 9734);
    const component = row("产品表", 5840);
    const specification = row("规格型号表", 99456);
    assert.ok(system && component && specification);
    assert.equal(system[1], "GH0101003129");
    assert.equal(system[10], "cc20e421-0a13-11ea-99e3-fa163e0a8baf");
    assert.equal(component[2], system[10]);
    assert.equal(specification[1], system[10]);
    assert.deepEqual(system.slice(16, 18), ["国械注准20173130995", "国械注准20173460995"]);
    assert.deepEqual(component.slice(7, 9), system.slice(16, 18));
    assert.equal(system[26], 2600);
    assert.equal(specification[5], "C03440210701011018840000653");
    assert.deepEqual(specification.slice(13, 17), ["125mm", "GB-6", "06921814258644", "国械注准20173130995"]);
  }
);

test("真实凭据：国家药监局同一 DI 的历史版本支持旧证及新证并存，现行详情给出两条 27 位码", async (t) => {
  const api = await traceServices(t);
  const proposal: SpecificationProposal = JSON.parse(await readFile("samples/nmpa-dual-certificate-udi.json", "utf8"));
  await api.approve(proposal);
  const lookups = [
    ["registration_number", "国械注准20163460428"], ["registration_number", "国械注准20163130428"],
    ["nhsa_27", "C03470210900000100520000049"], ["nhsa_27", "C03470210900000100520001618"],
    ["udi_di", "06930416802339"]
  ];
  for (const [scheme, value] of lookups) {
    const result = await api.lookup(scheme, value);
    assert.equal(result.status, "matched");
    assert.deepEqual(result.component_matches, []);
    const [match] = result.matches;
    assert.equal(match.specification.id, "nmpa-udi-06930416802339");
    assert.equal(match.specification.registrant, "山西奥瑞生物材料有限公司");
    assert.equal(match.specification.specification, "粒径0.05-1.0mm／0.25g");
    assert.equal(match.matched_identifiers[0].value, value);
    assert.deepEqual(match.prices, []);
  }
  const former = await api.lookup("registration_number", "国械注准20163460428");
  const newNumber = await api.lookup("registration_number", "国械注准20163130428");
  assert.equal(former.matches[0].matched_identifiers[0].evidence[0].sha256,
    "d4016144044e82daf2a3ecf420830ae0b3b9686409bdb05a4e5f14ffa9d19823");
  assert.equal(newNumber.matches[0].matched_identifiers[0].evidence[0].sha256,
    "a3828518834194d32f82a74a58d5ef535f0be9e2c59463a75b86b2bc05b7cd69");
});

test("真实发布回查：品规保留已发布湖南类别价的原 price_id 和证据",
  { skip: !process.env.ORTH_TEST_SUPPLY_WORKBOOK }, async (t) => {
    const api = await traceServices(t);
    const worker = await api.database.login("orth_worker");
    const dataDir = await mkdtemp(join(tmpdir(), "orth-specification-supply-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const { stdout } = await promisify(execFile)(process.execPath, ["src/start-worker.ts",
      "samples/hunan-joint-governance.json", "samples/hunan-joint-results.xls", process.env.ORTH_TEST_SUPPLY_WORKBOOK!],
    { env: { ...process.env, ORTH_WORKER_DATABASE_URL: worker.url, ORTH_DATA_DIR: dataDir } });
    const { price_id } = JSON.parse(stdout);
    const governancePriceUrl = api.governanceUrl.replace("/specification-candidates", "/candidates/" + price_id);
    for (const action of ["review", "publish"]) {
      const response = await fetch(governancePriceUrl + "/" + action, {
        method: "POST", headers: { authorization: api.authorization, "content-type": "application/json" }, body: "{}"
      });
      assert.equal(response.status, 204);
    }
    const samples: SpecificationProposal[] = JSON.parse(await readFile("samples/joint-specification-trace.official.json", "utf8"));
    const proposal = samples.find((item) =>
      item.kind === "specification" && item.specification.specification === "125mm");
    assert.ok(proposal?.kind === "specification");

    const tooSpecific = await api.submit({ ...proposal, published_price_references: [{ price_id }] });
    assert.equal((await api.review(tooSpecific)).status, 204);
    assert.equal((await api.publish(tooSpecific)).status, 409);
    await api.approve({ ...proposal, published_price_references: [
      { price_id, component_identifier_id: "procurement-component" }
    ] });

    const result = await api.lookup("nhsa_27", "C03440210701011018840000653");
    const [link] = result.matches[0].published_price_links;
    assert.deepEqual(result.matches[0].prices, []);
    assert.equal(link.price_id, "aj_8ccf6bc8657afcaaa14a3a3e901056fc");
    assert.equal(link.relationship, "category_award_example");
    assert.equal(link.system_code, "GH0101003129");
    const response = await fetch(api.publicUrl.replace("/specifications", "/prices/") + link.price_id);
    assert.equal(response.status, 200);
    const price = await response.json();
    assert.equal(price.price_id, link.price_id);
    assert.equal(price.amount, "5896.00");
    assert.equal(price.subject_kind, "kit_category");
    assert.equal(price.region, "湖南省");
  }
);

test("契约演练：同一计价口径拒绝第二价格编号，补充证据复用原编号", async (t) => {
  const api = await traceServices(t);
  const proposal = { kind: "specification", specification: old, identifiers: [oldVersion] };
  await api.approve({ ...proposal, prices: [oldPrice] });
  const overlapping = { ...oldPrice, price_id: "sp_overlapping_scope", amount: "98.00",
    effective_from: "2004-06-01", effective_to: null, effective_to_basis: "open",
    evidence: [{ ...contractEvidence[0], section: "演练原文：另一来源的重叠报价" }] };
  const supplement = { title: "契约演练：补充价表", url: "https://example.org/contract-only.xlsx",
    sha256: "a".repeat(64), sheet_name: "价格明细", row_number: 10, cells: ["B10", "C10"], price_cell: "C10" };
  await api.approve({ ...proposal, prices: [{ ...oldPrice, evidence: [supplement] }] });
  const sameLocation = { ...oldPrice, price_id: "sp_same_location", pack_quantity: 10,
    evidence: [{ ...supplement, cells: ["A10", "C10"] }] };
  for (const price of [overlapping, sameLocation]) {
    const conflict = await api.submit({ ...proposal, prices: [price] });
    assert.equal((await api.review(conflict)).status, 204);
    assert.equal((await api.publish(conflict)).status, 409);
    assert.equal((await fetch(api.publicUrl + "/prices/" + price.price_id)).status, 404);
  }
  const adjacent = { ...overlapping, price_id: "sp_adjacent_scope", effective_from: "2005-01-01",
    original_identifier_ids: [] };
  await api.approve({ ...proposal, prices: [adjacent] });
  const laterPrice = await (await fetch(api.publicUrl + "/prices/sp_adjacent_scope")).json();
  assert.equal(laterPrice.effective_to_basis, "open");
  const [price] = (await api.lookup("registration_number", oldCertificate)).matches[0].prices;
  assert.equal(price.price_id, "sp_old");
  assert.equal(price.amount, "110.00");
  assert.deepEqual(price.evidence, [...contractEvidence, supplement]);
  assert.equal(price.original_identifiers[0].value, oldCertificate);
});

test("契约演练：证号命中按稳定游标分页，末页仍报告跨页歧义", async (t) => {
  const api = await traceServices(t);
  for (let index = 0; index < 31; index++) {
    await api.approve({ kind: "specification",
      specification: { ...old, id: `pagination-${String(index).padStart(2, "0")}`, specification: String(index) },
      identifiers: [oldVersion] });
  }
  const first = await api.lookup("registration_number", oldCertificate);
  assert.equal(first.status, "ambiguous");
  assert.equal(first.matches.length, 30);
  const params = new URLSearchParams({ scheme: "registration_number", value: oldCertificate, after: first.next_cursor });
  const last = await (await fetch(api.publicUrl + "/lookup?" + params)).json();
  assert.equal(last.status, "ambiguous");
  assert.equal(last.next_cursor, null);
  assert.deepEqual(last.matches.map(({ specification }: { specification: { id: string } }) =>
    specification.id), ["pagination-30"]);
});

test("深圳历史原表复验：核对同一部件、品规、原证旧码和部件价格",
  { skip: !process.env.ORTH_TEST_SHENZHEN_WORKBOOK }, async () => {
    const bytes = await readFile(process.env.ORTH_TEST_SHENZHEN_WORKBOOK!);
    assert.equal(createHash("sha256").update(bytes).digest("hex"),
      "e3173a4c0bcf7631c395c7f03aeab827b2da5a87c7ece6687b2b3893efafa41c");
    const catalog = "关节产品目录表（包含初次、翻修、肿瘤用等）";
    const variant = "部件规格型号表";
    const book = read(bytes, { sheets: [catalog, variant], dense: true, sheetRows: 172109 });
    const row = (sheet: string, number: number) => book.Sheets[sheet]["!data"]?.[number - 1].map((cell) => cell?.v);
    const part = row(catalog, 5885);
    const specification = row(variant, 172109);
    const collidingLegacyCode = row(variant, 112940);
    assert.ok(part && specification && collidingLegacyCode);
    assert.equal(part[3], "cc20e421-0a13-11ea-99e3-fa163e0a8baf");
    assert.equal(part[3], specification[1]);
    assert.deepEqual(part.slice(10, 12), ["国械注准20173130995", "国械注准20173460995"]);
    assert.equal(Number(part[18]), 2600);
    assert.equal(specification[0], "7d1c8d5a-da96-11e9-953f-fa163e0a8baf");
    assert.deepEqual(specification.slice(16, 18), ["125mm", "GB-6"]);
    assert.equal(specification[20], "06921814258644");
    assert.equal(specification[22], "国械注准20173130995");
    assert.equal(specification[7], collidingLegacyCode[6]);
    assert.equal(specification[15], collidingLegacyCode[14]);
    assert.notEqual(specification[13], collidingLegacyCode[13]);
  }
);

test("药监局历史原件复验：同一 DI 的第 2 版新增现证并保留旧证",
  { skip: !process.env.ORTH_TEST_NMPA_HISTORY_DIR }, async () => {
    const directory = process.env.ORTH_TEST_NMPA_HISTORY_DIR!;
    const [first, second] = await Promise.all([
      readFile(join(directory, "nmpa-dual-v1.json")), readFile(join(directory, "nmpa-dual-v2.json"))
    ]);
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest(first), "d4016144044e82daf2a3ecf420830ae0b3b9686409bdb05a4e5f14ffa9d19823");
    assert.equal(digest(second), "a3828518834194d32f82a74a58d5ef535f0be9e2c59463a75b86b2bc05b7cd69");
    const v1 = JSON.parse(first.toString("utf8"));
    const v2 = JSON.parse(second.toString("utf8"));
    assert.deepEqual([v1.versionNumber, v2.versionNumber], ["1", "2"]);
    assert.equal(v1.zczbhhzbapzbh, "国械注准20163460428");
    assert.equal(v2.zczbhhzbapzbh, "国械注准20163460428,国械注准20163130428");
    assert.equal(v1.zxxsdycpbs, "06930416802339");
    for (const field of ["zxxsdycpbs", "zxxsdyzsydydsl", "ylqxzcrbarmc", "ggxh", "cpms", "ybbm"]) {
      assert.equal(v1[field], v2[field]);
    }
    assert.equal(v2.ybbm, "C0347021090000010052");
  }
);
