import { connect } from "../database.ts";
import { serve } from "../serve.ts";
import { createApplicationApp } from "./app.ts";

const pool = connect("ORTH_APPLICATION_DATABASE_URL");
pool.on("error", (error) => console.error("Application PostgreSQL connection lost", error));

try {
  await pool.query("SELECT 1");
} catch (error) {
  await pool.end();
  throw error;
}
await serve(createApplicationApp(pool), 3000, () => pool.end());
