import { createSpecificationQueryRouter } from "./application/specification-query.ts";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { createHttpApp, handleHttpError } from "./http.ts";
import type { Pool } from "pg";
import { createPriceQueryRouter } from "./application/price-query.ts";
import { attachmentPath, candidateAttachment } from "./attachments.ts";
import { getCandidate, listCandidates, publishCandidate, reviewCandidate } from "./price-store.ts";
import { candidatePage, queuePage, workbenchScript } from "./workbench.ts";

interface Governance {
  pool: Pool;
  publisherPool: Pool;
  dataDir: string;
  operator: { user: string; password: string };
}

export function createApp({ applicationPool, governance }: { applicationPool: Pool; governance?: Governance }) {
  const app = createHttpApp();

  app.use("/api/v1/specifications", createSpecificationQueryRouter(applicationPool));
  app.use("/api/v1/prices", createPriceQueryRouter(applicationPool));

  if (governance) app.use("/ops", governanceRouter(governance));

  app.use(handleHttpError);
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

  router.get("/candidates/:priceId/:document", async (req, res) => {
    const candidate = await getCandidate(pool, req.params.priceId);
    const file = candidate && candidateAttachment(candidate, req.params.document);
    if (!file) {
      res.sendStatus(404);
      return;
    }
    res.download(attachmentPath(dataDir, file.digest, file.format), file.title + "." + file.format);
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
