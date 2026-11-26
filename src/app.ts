import { timingSafeEqual } from "node:crypto";
import express from "express";
import type { ErrorRequestHandler } from "express";
import type { Pool } from "pg";
import { attachmentPath } from "./attachments.ts";
import { getCandidate, getPublicPrice, listCandidates, publishCandidate, reviewCandidate } from "./price-store.ts";
import { candidatePage, queuePage, workbenchScript } from "./workbench.ts";

interface Governance {
  pool: Pool;
  publisherPool: Pool;
  dataDir: string;
  operator: { user: string; password: string };
}

export function createApp({ applicationPool, governance }: { applicationPool: Pool; governance?: Governance }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });

  app.get("/api/v1/prices/:priceId", async (req, res) => {
    const price = await getPublicPrice(applicationPool, req.params.priceId);
    if (!price) {
      res.status(404).json({ error: "price_not_found" });
      return;
    }
    res.json(price);
  });

  if (governance) app.use("/ops", governanceRouter(governance));

  const handleError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error.status === 400 || error.status === 404) {
      res.sendStatus(error.status);
      return;
    }
    console.error(error);
    res.sendStatus(500);
  };
  app.use(handleError);
  return app;
}

function governanceRouter({ pool, publisherPool, dataDir, operator }: Governance) {
  const router = express.Router();
  const credential = Buffer.from("Basic " + Buffer.from(`${operator.user}:${operator.password}`).toString("base64"));
  router.use((req, res, next) => {
    const header = Buffer.from(req.get("authorization") ?? "");
    if (header.length !== credential.length || !timingSafeEqual(header, credential)) {
      res.set("WWW-Authenticate", 'Basic realm="OrthDatabase"').sendStatus(401);
      return;
    }
    res.set("Content-Security-Policy",
      "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    // Cross-origin forms cannot send JSON, and no CORS permissions are granted.
    if (req.method === "POST" && !req.is("application/json")) {
      res.sendStatus(415);
      return;
    }
    next();
  });
  router.get("/", async (_req, res) => {
    res.type("html").send(queuePage(await listCandidates(pool)));
  });
  router.get("/workbench.js", (_req, res) => {
    res.type("js").send(workbenchScript);
  });

  router.get("/candidates/:priceId", async (req, res) => {
    const candidate = await getCandidate(pool, req.params.priceId);
    if (!candidate) {
      res.sendStatus(404);
      return;
    }
    res.type("html").send(candidatePage(candidate));
  });

  router.get("/candidates/:priceId/attachment", async (req, res) => {
    const candidate = await getCandidate(pool, req.params.priceId);
    if (!candidate) {
      res.sendStatus(404);
      return;
    }
    res.download(attachmentPath(dataDir, candidate.source.sha256), candidate.source.attachment_title + ".xls");
  });

  router.post("/candidates/:priceId/review", async (req, res) => {
    if (!await getCandidate(pool, req.params.priceId)) {
      res.sendStatus(404);
      return;
    }
    await reviewCandidate(pool, req.params.priceId, operator.user);
    res.sendStatus(204);
  });

  router.post("/candidates/:priceId/publish", async (req, res) => {
    if (!await getCandidate(pool, req.params.priceId)) {
      res.sendStatus(404);
      return;
    }
    const published = await publishCandidate(publisherPool, req.params.priceId, operator.user);
    res.sendStatus(published ? 204 : 409);
  });

  return router;
}
