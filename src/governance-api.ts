import { createHash, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import express from "express";
import type { ErrorRequestHandler } from "express";
import type { Pool } from "pg";
import { attachmentPath, candidateAttachment } from "./attachments.ts";
import { listSources, listTasks } from "./collection-store.ts";
import { getCandidate, listCandidates, publishCandidate, reviewCandidate } from "./price-store.ts";

interface GovernanceOptions {
  pool: Pool;
  publisherPool: Pool;
  dataDir: string;
  operator: { user: string; password: string };
}

export const governanceApiPath = "/api/governance/v1";

export function createGovernanceApi({ pool, publisherPool, dataDir, operator }: GovernanceOptions) {
  const app = express();
  const router = express.Router();
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const credential = digest(Buffer.from(`${operator.user}:${operator.password}`).toString("base64"));

  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });

  router.use((req, res, next) => {
    const token = /^Basic (\S+)$/i.exec(req.get("authorization") ?? "")?.[1] ?? "";
    if (!timingSafeEqual(digest(token), credential)) {
      res.set("WWW-Authenticate", 'Basic realm="OrthDatabase Operations", charset="UTF-8"')
        .status(401).json({ error: "operator_required" });
      return;
    }
    // Browsers need a same-origin JSON request to invoke an operation.
    if (req.method === "POST" && !req.is("application/json")) {
      res.status(415).json({ error: "json_required" });
      return;
    }
    next();
  });
  router.get("/sources", async (_req, res) => {
    res.json(await listSources(pool));
  });
  router.get("/tasks", async (_req, res) => {
    res.json(await listTasks(pool));
  });
  router.get("/candidates", async (_req, res) => {
    res.json(await listCandidates(pool));
  });
  router.get("/candidates/:priceId", async (req, res) => {
    const candidate = await getCandidate(pool, req.params.priceId);
    if (candidate) res.json(candidate);
    else res.status(404).json({ error: "candidate_not_found" });
  });
  router.get("/candidates/:priceId/:document", async (req, res) => {
    const candidate = await getCandidate(pool, req.params.priceId);
    if (!candidate) {
      res.status(404).json({ error: "candidate_not_found" });
      return;
    }
    const file = candidateAttachment(candidate, req.params.document);
    if (!file) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.download(attachmentPath(".", file.digest, file.format), file.title + "." + file.format, {
      root: resolve(dataDir)
    });
  });
  router.post("/candidates/:priceId/review", async (req, res) => {
    const { priceId } = req.params;
    if (!await getCandidate(pool, priceId)) {
      res.status(404).json({ error: "candidate_not_found" });
      return;
    }
    await reviewCandidate(pool, priceId, operator.user);
    res.sendStatus(204);
  });
  router.post("/candidates/:priceId/publish", async (req, res) => {
    const { priceId } = req.params;
    const candidate = await getCandidate(pool, priceId);
    if (!candidate) {
      res.status(404).json({ error: "candidate_not_found" });
      return;
    }
    const published = await publishCandidate(publisherPool, priceId, operator.user);
    if (published) res.sendStatus(204);
    else res.status(409).json({ error: candidate.status === "待复核" ? "review_required" : "publication_conflict" });
  });

  app.use(governanceApiPath, router);
  const handleError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error.status === 400 || error.status === 404) {
      res.status(error.status).json({ error: error.status === 404 ? "not_found" : "invalid_request" });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  };
  app.use(handleError);
  return app;
}
