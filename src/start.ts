import { createApp } from "./app.ts";
import { attachmentRoot, connect } from "./database.ts";

const user = process.env.ORTH_OPERATOR_USER;
const password = process.env.ORTH_OPERATOR_PASSWORD;
if (!user || user.includes(":") || !password) {
  throw new Error("Set ORTH_OPERATOR_USER (without a colon) and ORTH_OPERATOR_PASSWORD");
}
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const pool = connect();
await pool.query("SELECT 1");
const server = createApp(pool, attachmentRoot(), { user, password }).listen(port, host, () => {
  console.log(`OrthDatabase listening on http://${host}:${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => { void pool.end(); });
  });
}
