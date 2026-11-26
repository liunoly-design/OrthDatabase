import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { testDatabase } from "./postgres.ts";

const insufficientPrivilege = { code: "42501" };

test("PostgreSQL 应用、治理和发布登录分别遵循发布区和应用账号区权限", async (t) => {
  const database = await testDatabase(t);
  await database.migrate();
  const { pool: application } = await database.login("orth_application");
  const { pool: governance } = await database.login("orth_governance");
  const { pool: publisher } = await database.login("orth_publisher");

  assert.equal((await application.query("SELECT price_id FROM orth_catalog.price_v1")).rowCount, 0);
  await assert.rejects(application.query("SELECT price_id FROM orth_governance.import_candidate"), insufficientPrivilege);
  await assert.rejects(application.query("UPDATE orth_governance.import_candidate SET reviewed_at = now()"), insufficientPrivilege);
  await assert.rejects(application.query("SELECT published_by FROM orth_catalog.price_record"), insufficientPrivilege);
  await assert.rejects(application.query("INSERT INTO orth_catalog.price_record (price_id) VALUES ('test')"), insufficientPrivilege);
  await assert.rejects(application.query("UPDATE orth_catalog.price_record SET amount = 1"), insufficientPrivilege);
  await assert.rejects(application.query("DELETE FROM orth_catalog.price_record"), insufficientPrivilege);
  await assert.rejects(application.query("UPDATE orth_catalog.price_v1 SET region = '其他地区'"), insufficientPrivilege);
  await assert.rejects(application.query("SELECT orth_catalog.publish_price('test', 'test')"), insufficientPrivilege);

  const { rows: [account] } = await application.query("INSERT INTO orth_app.account DEFAULT VALUES RETURNING account_id");
  assert.equal((await application.query("SELECT account_id FROM orth_app.account")).rows[0].account_id, account.account_id);
  assert.equal((await application.query("DELETE FROM orth_app.account WHERE account_id = $1", [account.account_id])).rowCount, 1);

  assert.equal((await governance.query("SELECT price_id FROM orth_governance.import_candidate")).rowCount, 0);
  await assert.rejects(governance.query("UPDATE orth_governance.import_candidate SET price_id = 'test'"), insufficientPrivilege);
  await assert.rejects(governance.query("SELECT account_id FROM orth_app.account"), insufficientPrivilege);
  await assert.rejects(governance.query("INSERT INTO orth_app.account DEFAULT VALUES"), insufficientPrivilege);
  await assert.rejects(governance.query("SELECT orth_catalog.publish_price('test', 'test')"), insufficientPrivilege);
  await assert.rejects(governance.query("INSERT INTO orth_catalog.price_record (price_id) VALUES ('test')"), insufficientPrivilege);

  assert.deepEqual((await publisher.query("SELECT orth_catalog.publish_price('test', 'test')")).rows, [{ publish_price: false }]);
  await assert.rejects(publisher.query("SELECT price_id FROM orth_governance.import_candidate"), insufficientPrivilege);
  await assert.rejects(publisher.query("INSERT INTO orth_catalog.price_record (price_id) VALUES ('test')"), insufficientPrivilege);
  await assert.rejects(publisher.query("SELECT account_id FROM orth_app.account"), insufficientPrivilege);
});

test("升级 #2 已发布数据后，应用角色仍以原 price_id 读取完整快照", async (t) => {
  const { owner, migrate, login } = await testDatabase(t);
  await owner.query(await readFile("db/001-price-publication.sql", "utf8"));
  const application = await login();
  await owner.query(`GRANT UPDATE (amount), DELETE ON public.price_record TO ${application.name}`);
  const expected = JSON.parse(await readFile("samples/hunan-joint-results.published.json", "utf8"));
  const { price_id, amount, product_system, applicant, region, effective_from, service_fee_basis, source } = expected;
  const publishedAt = "2026-11-26T10:00:00.000Z";
  await owner.query(`
    INSERT INTO public.import_candidate
      (price_id, amount, product_system, applicant, region, effective_from, service_fee_basis,
       source, original_rows, reviewed_at, reviewed_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '[]', $9, 'legacy-reviewer')
  `, [price_id, amount, product_system, applicant, region, effective_from, service_fee_basis, source, publishedAt]);
  await owner.query(`
    INSERT INTO public.price_record
      (price_id, amount, product_system, applicant, region, effective_from, service_fee_basis, source,
       published_at, published_by)
    SELECT price_id, amount, product_system, applicant, region, effective_from, service_fee_basis, source,
           reviewed_at, reviewed_by
    FROM public.import_candidate
  `);

  await Promise.all([migrate(), migrate()]);
  await owner.query(`GRANT orth_application TO ${application.name}`);
  const { rows } = await application.pool.query("SELECT * FROM orth_catalog.price_v1 WHERE price_id = $1", [price_id]);
  assert.deepEqual(rows, [{ ...expected, published_at: publishedAt }]);
  await assert.rejects(application.pool.query("UPDATE orth_catalog.price_record SET amount = 1"), insufficientPrivilege);
  await assert.rejects(application.pool.query("DELETE FROM orth_catalog.price_record"), insufficientPrivilege);
});
