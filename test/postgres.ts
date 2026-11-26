import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { Pool } from "pg";

const exec = promisify(execFile);

export async function testDatabase(t: TestContext) {
  assert.ok(process.env.TEST_DATABASE_URL, "Set TEST_DATABASE_URL to a PostgreSQL test database");
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const suffix = randomUUID().replaceAll("-", "");
  const name = "orth_test_" + suffix;
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = "/" + name;
  const owner = new Pool({ connectionString: url.href });
  const logins: { name: string; pool: Pool }[] = [];
  t.after(async () => {
    try {
      await Promise.all([owner.end(), ...logins.map(({ pool }) => pool.end())]);
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      for (const login of logins) await admin.query(`DROP ROLE ${login.name}`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE DATABASE ${name}`);

  async function login(role?: "orth_application" | "orth_governance" | "orth_publisher") {
    const name = `test_${role ?? "legacy"}_${suffix}`;
    const password = randomBytes(24).toString("hex");
    const membership = role ? ` IN ROLE ${role}` : "";
    await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'${membership}`);
    const loginUrl = new URL(url);
    loginUrl.username = name;
    loginUrl.password = password;
    const pool = new Pool({ connectionString: loginUrl.href });
    logins.push({ name, pool });
    return { name, pool, url: loginUrl.href };
  }

  function migrate() {
    return exec(process.execPath, ["src/migrate.ts"], { env: { ...process.env, DATABASE_URL: url.href } });
  }

  return { owner, login, migrate };
}
