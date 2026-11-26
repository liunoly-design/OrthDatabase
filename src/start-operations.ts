import { createOperationsWeb } from "./operations-web.ts";
import { serve } from "./serve.ts";

function httpUrl(value: string, variable: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${variable} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  return url;
}

const api = httpUrl(
  process.env.ORTH_GOVERNANCE_API_URL ?? "http://127.0.0.1:3001/api/governance/v1",
  "ORTH_GOVERNANCE_API_URL"
);
if (!api.pathname.endsWith("/")) api.pathname += "/";
const applicationUrl = process.env.ORTH_APPLICATION_API_ORIGIN;
const applicationOrigin = applicationUrl && httpUrl(applicationUrl, "ORTH_APPLICATION_API_ORIGIN");
await serve(createOperationsWeb(api, applicationOrigin || undefined), 3002);
