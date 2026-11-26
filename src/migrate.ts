import { readFile } from "node:fs/promises";
import { connect } from "./database.ts";

const pool = connect("DATABASE_URL");
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL search_path = pg_catalog, pg_temp");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('orthdatabase.migrate', 0))");
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS orth_migrations;
    CREATE TABLE IF NOT EXISTS orth_migrations.applied (filename text PRIMARY KEY)
  `);
  const { rows } = await client.query<{ filename: string }>("SELECT filename FROM orth_migrations.applied");
  const applied = new Set(rows.map(({ filename }) => filename));
  for (const filename of ["001-price-publication.sql", "002-publication-permissions.sql"]) {
    if (applied.has(filename)) continue;
    const sql = await readFile(new URL(`../db/${filename}`, import.meta.url), "utf8");
    await client.query(sql);
    await client.query("INSERT INTO orth_migrations.applied (filename) VALUES ($1)", [filename]);
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
