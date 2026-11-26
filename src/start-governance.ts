import { attachmentRoot, connect } from "./database.ts";
import { createGovernanceApi } from "./governance-api.ts";
import { serve } from "./serve.ts";

const user = process.env.ORTH_OPERATOR_USER;
const password = process.env.ORTH_OPERATOR_PASSWORD;
if (!user || user.includes(":") || !password) {
  throw new Error("Set ORTH_OPERATOR_USER (without a colon) and ORTH_OPERATOR_PASSWORD");
}
const pool = connect("ORTH_GOVERNANCE_DATABASE_URL");
const publisherPool = connect("ORTH_PUBLISHER_DATABASE_URL");
const close = () => Promise.all([pool.end(), publisherPool.end()]);
try {
  await Promise.all([pool.query("SELECT 1"), publisherPool.query("SELECT 1")]);
} catch (error) {
  await close();
  throw error;
}
await serve(createGovernanceApi({ pool, publisherPool, dataDir: attachmentRoot(), operator: { user, password } }), 3001, close);
