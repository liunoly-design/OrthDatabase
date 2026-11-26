import express from "express";
import type { Pool } from "pg";
import type { ProcurementResponse } from "../../contracts/procurement-v1.d.ts";

const pageSize = 30;
const filterNames = ["category", "region", "round_id", "date", "after"] as const;
export type ProcurementFilters = Partial<Record<typeof filterNames[number], string>>;

export function procurementFilters(query: express.Request["query"]): ProcurementFilters | null {
  const filters: ProcurementFilters = {};
  for (const name of filterNames) {
    const input = query[name];
    if (input === undefined || input === "") continue;
    if (typeof input !== "string" || input.length > 200 || input.includes("\0")) return null;
    filters[name] = input;
  }
  const { date } = filters;
  if (date && (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) return null;
  return filters;
}

export async function queryProcurement(
  pool: Pool, { category, region, round_id, date, after }: ProcurementFilters
): Promise<ProcurementResponse> {
  const { rows: [{ events, prices }] } = await pool.query<Pick<ProcurementResponse, "events" | "prices">>(`
    SELECT (
      SELECT COALESCE(jsonb_agg(event ORDER BY announced_on DESC, event_id), '[]')
      FROM orth_catalog.procurement_event_v1 AS event
      WHERE ($1::text IS NULL OR $1 = ANY(categories))
        AND ($2::text IS NULL OR region = $2 OR region IS NULL)
        AND ($3::text IS NULL OR round_id = $3)
        AND ($4::text IS NULL OR announced_on <= $4)
    ) AS events, (
      SELECT COALESCE(jsonb_agg(result ORDER BY price_id), '[]')
      FROM (
        SELECT price_id, result FROM orth_catalog.procurement_price_v1
        WHERE ($1::text IS NULL OR $1 = ANY(categories))
          AND ($2::text IS NULL OR region = $2)
          AND ($3::text IS NULL OR round_id = $3)
          AND ($4::text IS NULL OR effective_from <= $4
               AND (applicable_to IS NULL OR $4 < applicable_to))
          AND ($5::text IS NULL OR price_id > $5)
        ORDER BY price_id
        LIMIT ${pageSize + 1}
      ) AS price
    ) AS prices
  `, [category, region, round_id, date, after]);
  return {
    contract_version: 1, events, prices: prices.slice(0, pageSize),
    next_price_cursor: prices.length > pageSize ? prices[pageSize - 1].price_id : null
  };
}

export function createProcurementQueryRouter(pool: Pool) {
  const router = express.Router();
  router.get("/", async (req, res) => {
    const filters = procurementFilters(req.query);
    if (!filters) {
      res.status(400).json({ error: "invalid_procurement_search" });
      return;
    }
    res.json(await queryProcurement(pool, filters));
  });
  return router;
}
