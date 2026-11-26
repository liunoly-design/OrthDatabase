import express from "express";
import type { Pool } from "pg";
import type {
  ComponentPrice, SpecificationIdentifier, SpecificationLookupResponse, SpecificationPrice,
  SpecificationPriceTrace, SpecificationTrace, TracePriceDetail
} from "../../contracts/specification-v1.d.ts";
import { parseIdentifierKey } from "../specification-input.ts";

interface TraceRow extends Omit<SpecificationTrace, "prices"> {
  prices: SpecificationPrice[];
  match_kind: 1 | 2 | 3;
}

const pageSize = 30;

function presentPrice(price: SpecificationPrice, identifiers: SpecificationIdentifier[],
  direct: SpecificationIdentifier[] = []): SpecificationPriceTrace {
  const { original_identifier_ids, ...facts } = price;
  const originalIds = new Set(original_identifier_ids);
  const original_identifiers = identifiers.filter(({ id }) => originalIds.has(id));
  const matched_original_identifier = direct.some(({ id }) => originalIds.has(id));
  const diMatches = direct.filter((identifier) => identifier.scheme === "udi_di");
  const otherQuantity = price.pack_quantity != null && diMatches.every(({ packaging }) =>
    packaging.quantity != null && packaging.quantity !== price.pack_quantity);
  const packaging_match = diMatches.length === 0 ? null :
    matched_original_identifier ? "matched" : otherQuantity ? "other" : "unverified";
  return { ...facts, original_identifiers, matched_original_identifier, packaging_match };
}

export function createSpecificationQueryRouter(pool: Pool) {
  const router = express.Router();
  router.get("/lookup", async (req, res) => {
    const { scheme, value, namespace, include_related, after } = req.query;
    const cursor = typeof after === "string" ? /^([123]):([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})$/.exec(after) : null;
    let key: ReturnType<typeof parseIdentifierKey>;
    try {
      key = parseIdentifierKey(scheme, value, namespace);
      if ((include_related !== undefined && include_related !== "1") || (after !== undefined && !cursor)) {
        throw new Error("查询参数无效");
      }
    } catch {
      res.status(400).json({ error: "invalid_specification_lookup" });
      return;
    }
    const { rows: [{ status, results }] } = await pool.query<{
      status: SpecificationLookupResponse["status"];
      results: TraceRow[];
    }>(`
      WITH matched AS (
        SELECT spec_id, jsonb_agg(snapshot ORDER BY identifier_id) AS identifiers,
            bool_or(NOT snapshot ? 'via_component') AS direct,
            count(DISTINCT snapshot->'packaging') > 1 AS ambiguous_packaging
        FROM orth_catalog.specification_identifier_v1
        WHERE snapshot->>'scheme' = $1 AND snapshot->>'value' = $2 AND coalesce(snapshot->>'namespace', '') = $3
        GROUP BY spec_id
      ), neighbours AS (
        SELECT relation.right_spec_id AS spec_id, relation.snapshot
        FROM matched JOIN orth_catalog.active_same_physical_specification_v1 AS relation ON left_spec_id = matched.spec_id
        WHERE $4 AND matched.direct
        UNION ALL
        SELECT relation.left_spec_id, relation.snapshot
        FROM matched JOIN orth_catalog.active_same_physical_specification_v1 AS relation ON right_spec_id = matched.spec_id
        WHERE $4 AND matched.direct
      ), related AS (
        SELECT spec_id, jsonb_agg(snapshot ORDER BY snapshot->>'id') AS relations
        FROM neighbours GROUP BY spec_id
      ), ranked AS (
        SELECT coalesce(matched.spec_id, related.spec_id) COLLATE "C" AS spec_id,
            CASE WHEN matched.direct THEN 1 WHEN matched.spec_id IS NOT NULL THEN 2 ELSE 3 END AS match_kind,
            coalesce(matched.identifiers, '[]') AS matched_identifiers,
            coalesce(related.relations, '[]') AS relations
        FROM matched FULL JOIN related USING (spec_id)
      ), page AS (
        SELECT * FROM ranked WHERE (match_kind, spec_id) > ($5, $6)
        ORDER BY match_kind, spec_id LIMIT ${pageSize + 1}
      )
      SELECT CASE WHEN count(*) FILTER (WHERE direct) > 1 OR bool_or(ambiguous_packaging) THEN 'ambiguous'
                  WHEN bool_or(direct) THEN 'matched' WHEN count(*) > 0 THEN 'component_only'
                  ELSE 'unverified' END AS status,
          ARRAY(
            SELECT row_to_json(result) FROM (
              SELECT spec.snapshot AS specification, page.match_kind, page.matched_identifiers, page.relations,
                  ARRAY(SELECT snapshot FROM orth_catalog.specification_identifier_v1
                        WHERE spec_id = page.spec_id ORDER BY identifier_id) AS identifiers,
                  ARRAY(SELECT snapshot FROM orth_catalog.specification_price_v1
                        WHERE spec_id = page.spec_id
                        ORDER BY snapshot->>'effective_from' DESC NULLS LAST, price_id) AS prices,
                  ARRAY(SELECT component.snapshot FROM orth_catalog.component_price_v1 AS component
                        WHERE EXISTS (SELECT 1 FROM orth_catalog.specification_identifier_v1 AS member
                            WHERE member.spec_id = page.spec_id AND member.snapshot->>'scheme' = 'platform_component_code'
                              AND (member.snapshot->>'namespace', member.snapshot->>'value') =
                                  (component.snapshot#>>'{component,namespace}', component.snapshot#>>'{component,value}'))
                        ORDER BY component.snapshot->>'effective_from' DESC NULLS LAST, component.price_id) AS component_prices,
                  ARRAY(SELECT snapshot FROM orth_catalog.published_price_reference_v1
                        WHERE spec_id = page.spec_id ORDER BY price_id) AS published_price_links
              FROM page JOIN orth_catalog.product_specification_v1 AS spec USING (spec_id)
              ORDER BY page.match_kind, page.spec_id
            ) AS result
          ) AS results
      FROM matched
    `, [key.scheme, key.value, key.namespace, include_related === "1", Number(cursor?.[1] ?? 0), cursor?.[2] ?? ""]);

    const matches: SpecificationTrace[] = [];
    const component_matches: SpecificationTrace[] = [];
    const related: SpecificationTrace[] = [];
    const groups = [matches, component_matches, related];
    for (const { prices, match_kind, ...facts } of results.slice(0, pageSize)) {
      const presentedPrices = prices.map((price) => presentPrice(price, facts.identifiers, facts.matched_identifiers));
      presentedPrices.sort((a, b) => Number(b.matched_original_identifier) - Number(a.matched_original_identifier));
      groups[match_kind - 1].push({ ...facts, prices: presentedPrices });
    }
    const last = results[pageSize - 1];
    const next_cursor = results.length > pageSize ? `${last.match_kind}:${last.specification.id}` : null;
    res.json({ contract_version: 1, status, matches, component_matches, related, next_cursor } satisfies SpecificationLookupResponse);
  });
  router.get("/prices/:priceId", async (req, res) => {
    const { rows: [row] } = await pool.query<{
      spec_id: string; price: SpecificationPrice; identifiers: SpecificationIdentifier[];
    }>(`
      SELECT price.spec_id, price.snapshot AS price,
          ARRAY(SELECT snapshot FROM orth_catalog.specification_identifier_v1
                WHERE spec_id = price.spec_id AND (price.snapshot->'original_identifier_ids') ? identifier_id
                ORDER BY identifier_id) AS identifiers
      FROM orth_catalog.specification_price_v1 AS price WHERE price_id = $1
    `, [req.params.priceId]);
    if (row) {
      res.json({ contract_version: 1, subject_kind: "product_spec", product_spec_id: row.spec_id, currency: "CNY",
        ...presentPrice(row.price, row.identifiers) } satisfies TracePriceDetail);
      return;
    }
    const { rows: [component] } = await pool.query<{ snapshot: ComponentPrice }>(
      "SELECT snapshot FROM orth_catalog.component_price_v1 WHERE price_id = $1", [req.params.priceId]
    );
    if (component) {
      res.json({ contract_version: 1, subject_kind: "component", currency: "CNY",
        ...component.snapshot } satisfies TracePriceDetail);
    } else {
      res.status(404).json({ error: "price_not_found" });
    }
  });
  return router;
}
