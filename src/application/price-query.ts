import express from "express";
import type { Pool } from "pg";
import type { PriceSearchFilters, PriceSearchResponse, PublicPrice } from "../../contracts/price-v1.d.ts";

const exactFilters = [
  "round_id", "published_group", "price_type", "unit", "region",
  "product_spec_id", "kit_version_id", "product_system"
] as const;
const pageSize = 30;

function searchConditions(query: express.Request["query"]) {
  const { q = "", pack_quantity, after, ...tags } = query;
  const inputs = [q, pack_quantity, after, ...exactFilters.map((key) => tags[key])];
  if (!inputs.every((value) => value === undefined ||
    (typeof value === "string" && value.length <= 200 && !value.includes("\0")))) return null;
  if (typeof q !== "string") return null;

  const values = [q.trim()];
  const bind = (value: string) => `$${values.push(value)}`;
  const conditions = [`($1 = '' OR price_id = $1 OR strpos(lower(product_system), lower($1)) > 0
    OR strpos(lower(applicant), lower($1)) > 0 OR strpos(lower(product_alias), lower($1)) > 0)`];
  for (const key of exactFilters) {
    const value = tags[key];
    if (typeof value === "string" && value) {
      conditions.push(`${key} = ${bind(value)}`);
      if (key === "product_system") conditions.push("subject_kind = 'kit_category'");
    }
  }
  if (pack_quantity === "unknown") {
    conditions.push("pack_quantity IS NULL");
  } else if (typeof pack_quantity === "string") {
    if (!/^[1-9]\d{0,9}$/.test(pack_quantity) || Number(pack_quantity) > 2147483647) return null;
    conditions.push(`pack_quantity = ${bind(pack_quantity)}::integer`);
  }
  if (typeof after === "string" && after) conditions.push(`price_id > ${bind(after)}`);
  return { values, where: conditions.join(" AND ") };
}

const publishedFilters = [
  "round_id", "published_group", "price_type", "pack_quantity", "unit"
] as const satisfies readonly (keyof PriceSearchFilters)[];

const filterOptions = publishedFilters.map((key) => {
  const aggregate = `array_agg(DISTINCT ${key} ORDER BY ${key})`;
  // An unknown quantity is selectable. Unknown rounds and groups are not official tags.
  return `'${key}', COALESCE(${key === "pack_quantity" ? aggregate : `array_remove(${aggregate}, NULL)`}, '{}')`;
}).join(",\n");

export function createPriceQueryRouter(pool: Pool) {
  const router = express.Router();
  router.get("/", async (req, res) => {
    const search = searchConditions(req.query);
    if (!search) {
      res.status(400).json({ error: "invalid_price_search" });
      return;
    }
    const { rows: [{ prices, filters }] } = await pool.query<Pick<PriceSearchResponse, "prices" | "filters">>(`
      SELECT (
        SELECT COALESCE(jsonb_agg(to_jsonb(result) - 'product_alias' ORDER BY price_id), '[]')
        FROM (
          SELECT * FROM orth_catalog.price_search_v1
          WHERE ${search.where}
          ORDER BY price_id
          LIMIT ${pageSize + 1}
        ) AS result
      ) AS prices, (
        SELECT jsonb_build_object(${filterOptions})
        FROM orth_catalog.price_search_v1
      ) AS filters
    `, search.values);
    res.json({
      prices: prices.slice(0, pageSize), filters,
      next_cursor: prices.length > pageSize ? prices[pageSize - 1].price_id : null
    } satisfies PriceSearchResponse);
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
