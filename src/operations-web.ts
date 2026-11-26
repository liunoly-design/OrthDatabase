import { pipeline } from "node:stream/promises";
import express from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import { publishedPriceId, type ReviewCandidate } from "./price-store.ts";
import { candidatePage, queuePage, sourcesPage, tasksPage, workbenchScript } from "./workbench.ts";

export function createOperationsWeb(api: URL, applicationOrigin?: URL) {
  const app = express();
  const router = express.Router();

  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff"
    });
    next();
  });
  app.get("/", (_req, res) => { res.redirect("/ops"); });
  router.get("/workbench.js", (_req, res) => {
    res.type("js").send(workbenchScript);
  });

  async function requestApi(req: Request, res: Response, path: string) {
    const headers = new Headers();
    const authorization = req.get("authorization");
    if (authorization) headers.set("authorization", authorization);
    if (req.method === "POST") {
      if (!req.is("application/json")) {
        res.sendStatus(415);
        return;
      }
      headers.set("content-type", "application/json");
    }

    const response = await fetch(new URL(path, api), {
      headers,
      method: req.method === "HEAD" ? "GET" : req.method,
      body: req.method === "POST" ? "{}" : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      const challenge = response.headers.get("www-authenticate");
      if (challenge && response.status === 401) res.set("WWW-Authenticate", challenge);
      await response.body?.cancel();
      res.sendStatus(response.status);
      return;
    }
    return response;
  }

  router.get("/", async (req, res) => {
    const response = await requestApi(req, res, "candidates");
    if (response) res.type("html").send(queuePage(await response.json(), true));
  });
  router.get("/sources", async (req, res) => {
    const response = await requestApi(req, res, "sources");
    if (response) res.type("html").send(sourcesPage(await response.json()));
  });
  router.get("/tasks", async (req, res) => {
    const response = await requestApi(req, res, "tasks");
    if (response) res.type("html").send(tasksPage(await response.json()));
  });
  router.param("priceId", (_req, res, next, id: string) => {
    if (/^aj_[a-f0-9]{32}$/.test(id)) next();
    else res.sendStatus(404);
  });
  router.get("/candidates/:priceId", async (req, res) => {
    const { priceId } = req.params;
    const response = await requestApi(req, res, `candidates/${priceId}`);
    if (!response) return;
    const candidate: ReviewCandidate = await response.json();
    const publishedId = publishedPriceId(candidate);
    const publicPriceUrl = applicationOrigin ? new URL(`/api/v1/prices/${publishedId}`, applicationOrigin).href : null;
    res.type("html").send(candidatePage(candidate, publicPriceUrl));
  });
  router.get("/candidates/:priceId/:document", async (req, res) => {
    const { priceId, document } = req.params;
    if (document !== "attachment" && document !== "supply") {
      res.sendStatus(404);
      return;
    }
    const response = await requestApi(req, res, `candidates/${priceId}/${document}`);
    if (!response) return;
    for (const name of ["content-type", "content-disposition"]) {
      const value = response.headers.get(name);
      if (value) res.set(name, value);
    }
    if (response.body && req.method !== "HEAD") await pipeline(response.body, res);
    else {
      await response.body?.cancel();
      res.end();
    }
  });
  for (const action of ["review", "publish"]) {
    router.post(`/candidates/:priceId/${action}`, async (req, res) => {
      const response = await requestApi(req, res, `candidates/${req.params.priceId}/${action}`);
      if (response) res.sendStatus(response.status);
    });
  }
  app.use("/ops", router);

  const handleError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error.status === 400) {
      res.sendStatus(400);
      return;
    }
    console.error(error);
    res.status(502).type("text").send("治理 API 暂时不可用，请稍后重试。");
  };
  app.use(handleError);
  return app;
}
