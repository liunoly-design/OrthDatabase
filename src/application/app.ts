import { fileURLToPath } from "node:url";
import express from "express";
import { createHttpApp, handleHttpError } from "../http.ts";
import type { Pool } from "pg";
import { createPriceQueryRouter } from "./price-query.ts";
import { procurementPage } from "./procurement-page.ts";
import { createProcurementQueryRouter, procurementFilters, queryProcurement } from "./procurement-query.ts";

const applicationDir = fileURLToPath(new URL("./", import.meta.url));
const assets = fileURLToPath(new URL("./public", import.meta.url));
const pageCsp = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function createApplicationApp(pool: Pool) {
  const app = createHttpApp();

  app.use("/api/v1/prices", createPriceQueryRouter(pool));
  app.use("/api/v1/procurement", createProcurementQueryRouter(pool));

  app.get("/prices", (req, res) => {
    const priceId = typeof req.query.price_id === "string" ? req.query.price_id.trim() : "";
    res.redirect(303, priceId ? `/prices/${encodeURIComponent(priceId)}` : "/");
  });

  app.get(["/", "/prices/:priceId"], (_req, res) => {
    res.set("Content-Security-Policy", pageCsp);
    res.sendFile("price-page.html", { root: applicationDir });
  });
  app.get("/procurement", async (req, res) => {
    const filters = procurementFilters(req.query);
    res.set("Content-Security-Policy", pageCsp);
    if (!filters) {
      res.status(400).send(procurementPage({}, null));
      return;
    }
    res.send(procurementPage(filters, await queryProcurement(pool, filters)));
  });

  app.use("/assets/price-query", express.static(assets, { index: false }));

  app.use(handleHttpError);
  return app;
}
