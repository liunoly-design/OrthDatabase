import { readFile } from "node:fs/promises";
import { connect } from "./database.ts";

const pool = connect();
try {
  const sql = await readFile(new URL("../db/001-price-publication.sql", import.meta.url), "utf8");
  await pool.query(sql);
} finally {
  await pool.end();
}
