import { once } from "node:events";
import { connect } from "../database.ts";
import { createApplicationApp } from "./app.ts";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const pool = connect("ORTH_APPLICATION_DATABASE_URL");
pool.on("error", (error) => console.error("Application PostgreSQL connection lost", error));

try {
  await pool.query("SELECT 1");
  const server = createApplicationApp(pool).listen(port, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("应用 HTTP 服务未绑定 TCP 端口");
  console.log(`OrthDatabase application listening on http://${host}:${address.port}`);
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => {
      void pool.end().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  await pool.end();
  throw error;
}
