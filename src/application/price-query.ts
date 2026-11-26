import express from "express";
import type { Pool } from "pg";
import type { PublicPrice, PublicPriceEvidence } from "../../contracts/price-v1.d.ts";

export function createPriceQueryRouter(pool: Pool) {
  const router = express.Router();
  router.get("/:priceId/evidence", async (req, res) => {
    const { rows: [evidence] } = await pool.query<PublicPriceEvidence>(
      "SELECT * FROM orth_catalog.price_evidence_v1 WHERE price_id = $1", [req.params.priceId]
    );
    if (!evidence) res.status(404).json({ error: "price_not_found" });
    else res.json(evidence);
  });
  router.get("/:priceId", async (req, res) => {
    const { rows: [price] } = await pool.query<PublicPrice>(
      "SELECT * FROM orth_catalog.price_v1 WHERE price_id = $1", [req.params.priceId]
    );
    if (!price) {
      res.status(404).json({ error: "price_not_found" });
      return;
    }
    res.json(price);
  });
  return router;
}
