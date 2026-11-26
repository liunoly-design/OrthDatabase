import express from "express";
import type { ErrorRequestHandler } from "express";

export function createHttpApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });
  return app;
}

export const handleHttpError: ErrorRequestHandler = (error, _req, res, next) => {
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

export function escapeHtml(text: string | number) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
