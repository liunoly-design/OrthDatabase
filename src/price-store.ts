import type { Pool } from "pg";
import type { PublicPrice, PublishedPriceSnapshot } from "../contracts/price-v1.d.ts";

export interface OriginalRow {
  number: number;
  cells: string[];
}

type PriceFacts = Pick<PublishedPriceSnapshot,
  "price_id" | "amount" | "product_system" | "applicant" | "region" |
  "service_fee_basis" | "source">;

export type Candidate = PriceFacts & {
  effective_from: string;
  original_rows: OriginalRow[];
};

type ReviewStatus = "待复核" | "已复核" | "已发布";

export type ReviewCandidate = Candidate & Pick<PublicPrice, "currency" | "unit" | "price_type"> & {
  status: ReviewStatus;
};

export type CandidateSummary = Pick<ReviewCandidate, "price_id" | "product_system" | "applicant" | "status">;

const priceColumns = `
  c.price_id, c.amount::text, 'CNY' AS currency, '元/套' AS unit,
  '正式中选价' AS price_type, c.product_system, c.applicant, c.region,
  to_char(c.effective_from, 'YYYY-MM-DD') AS effective_from, c.service_fee_basis, c.source`;

const statusColumn = `
  CASE WHEN published.price_id IS NOT NULL THEN '已发布'
       WHEN c.reviewed_at IS NOT NULL THEN '已复核'
       ELSE '待复核' END AS status`;

export async function addCandidate(pool: Pool, candidate: Candidate) {
  const { price_id, amount, product_system, applicant, region, effective_from,
    service_fee_basis, source, original_rows } = candidate;
  const values = [price_id, amount, product_system, applicant, region, effective_from,
    service_fee_basis, source, JSON.stringify(original_rows)];
  const inserted = await pool.query(`
    INSERT INTO orth_governance.import_candidate
      (price_id, amount, product_system, applicant, region, effective_from,
       service_fee_basis, source, original_rows)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (price_id) DO NOTHING
  `, values);
  if (inserted.rowCount) return;

  const existing = await pool.query(`
    SELECT 1
    FROM orth_governance.import_candidate
    WHERE price_id = $1
      AND (amount, product_system, applicant, region, effective_from, service_fee_basis, source, original_rows)
        = ($2, $3, $4, $5, $6, $7, $8, $9)
  `, values);
  if (!existing.rowCount) throw new Error("已存在同一来源与位置的候选，但导入内容有冲突");
}

export async function getPublicPrice(pool: Pool, priceId: string) {
  const { rows } = await pool.query<PublicPrice>(`
    SELECT * FROM orth_catalog.price_v1 WHERE price_id = $1
  `, [priceId]);
  return rows[0];
}

export async function listCandidates(pool: Pool) {
  const { rows } = await pool.query<CandidateSummary>(`
    SELECT c.price_id, c.product_system, c.applicant, ${statusColumn}
    FROM orth_governance.import_candidate AS c LEFT JOIN orth_catalog.price_record AS published USING (price_id)
    ORDER BY c.imported_at DESC, c.price_id
  `);
  return rows;
}

export async function getCandidate(pool: Pool, priceId: string) {
  const { rows } = await pool.query<ReviewCandidate>(`
    SELECT ${priceColumns}, c.original_rows, ${statusColumn}
    FROM orth_governance.import_candidate AS c LEFT JOIN orth_catalog.price_record AS published USING (price_id)
    WHERE c.price_id = $1
  `, [priceId]);
  return rows[0];
}

export async function reviewCandidate(pool: Pool, priceId: string, user: string) {
  await pool.query(`
    UPDATE orth_governance.import_candidate SET reviewed_at = now(), reviewed_by = $2
    WHERE price_id = $1 AND reviewed_at IS NULL
  `, [priceId, user]);
}

export async function publishCandidate(pool: Pool, priceId: string, user: string) {
  const { rows } = await pool.query<{ published: boolean }>(
    "SELECT orth_catalog.publish_price($1, $2) AS published", [priceId, user]
  );
  return rows[0].published;
}
