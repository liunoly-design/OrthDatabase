import { createApp } from "./app.ts";
import { attachmentRoot, connect } from "./database.ts";

const [mode, ...extra] = process.argv.slice(2);
if (extra.length || (mode !== undefined && mode !== "app")) {
  throw new Error("Usage: npm start [-- app]");
}

function configureGovernance() {
  const user = process.env.ORTH_OPERATOR_USER;
  const password = process.env.ORTH_OPERATOR_PASSWORD;
  if (!user || user.includes(":") || !password) {
    throw new Error("Set ORTH_OPERATOR_USER (without a colon) and ORTH_OPERATOR_PASSWORD");
  }
  return {
    pool: connect("ORTH_GOVERNANCE_DATABASE_URL"),
    publisherPool: connect("ORTH_PUBLISHER_DATABASE_URL"),
    dataDir: attachmentRoot(),
    operator: { user, password }
  };
}

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const applicationPool = connect("ORTH_APPLICATION_DATABASE_URL");
const governance = mode === "app" ? undefined : configureGovernance();
const pools = governance ? [applicationPool, governance.pool, governance.publisherPool] : [applicationPool];
const closePools = () => Promise.all(pools.map((pool) => pool.end()));

try {
  await Promise.all(pools.map((pool) => pool.query("SELECT 1")));
} catch (error) {
  await closePools();
  throw error;
}
const server = createApp({ applicationPool, governance }).listen(port, host, () => {
  console.log(`OrthDatabase listening on http://${host}:${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => { void closePools(); });
  });
}
