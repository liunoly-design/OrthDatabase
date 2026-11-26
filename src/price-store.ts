import type { Pool } from "pg";
import type { PublicPrice } from "../miniprogram/pages/price/contract.d.ts";

export interface OriginalRow {
  number: number;
  cells: string[];
}

type PriceFacts = Omit<PublicPrice, "currency" | "unit" | "price_type">;

export type Candidate = PriceFacts & {
  original_rows: OriginalRow[];
};

type ReviewStatus = "待复核" | "已复核" | "已发布";

export type ReviewCandidate = PublicPrice & Pick<Candidate, "original_rows"> & {
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
  const result = await pool.query<{ price_id: string }>(`
    INSERT INTO import_candidate AS c
      (price_id, amount, product_system, applicant, region, effective_from,
       service_fee_basis, source, original_rows)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (price_id) DO UPDATE SET price_id = EXCLUDED.price_id
      WHERE (c.amount, c.product_system, c.applicant, c.region, c.effective_from,
             c.service_fee_basis, c.source, c.original_rows)
          = (EXCLUDED.amount, EXCLUDED.product_system, EXCLUDED.applicant, EXCLUDED.region,
             EXCLUDED.effective_from, EXCLUDED.service_fee_basis, EXCLUDED.source, EXCLUDED.original_rows)
    RETURNING price_id
  `, [price_id, amount, product_system, applicant, region, effective_from,
    service_fee_basis, source, JSON.stringify(original_rows)]);
  if (!result.rowCount) throw new Error("已存在同一来源与位置的候选，但导入内容有冲突");
}

export async function getPublicPrice(pool: Pool, priceId: string) {
  const { rows } = await pool.query<PublicPrice>(`
    SELECT ${priceColumns}
    FROM price_record AS c
    WHERE c.price_id = $1
  `, [priceId]);
  return rows[0];
}

export async function listCandidates(pool: Pool) {
  const { rows } = await pool.query<CandidateSummary>(`
    SELECT c.price_id, c.product_system, c.applicant, ${statusColumn}
    FROM import_candidate AS c LEFT JOIN price_record AS published USING (price_id)
    ORDER BY c.imported_at DESC, c.price_id
  `);
  return rows;
}

export async function getCandidate(pool: Pool, priceId: string) {
  const { rows } = await pool.query<ReviewCandidate>(`
    SELECT ${priceColumns}, c.original_rows, ${statusColumn}
    FROM import_candidate AS c LEFT JOIN price_record AS published USING (price_id)
    WHERE c.price_id = $1
  `, [priceId]);
  return rows[0];
}

export async function reviewCandidate(pool: Pool, priceId: string, user: string) {
  await pool.query(`
    UPDATE import_candidate SET reviewed_at = now(), reviewed_by = $2
    WHERE price_id = $1 AND reviewed_at IS NULL
  `, [priceId, user]);
}

export async function publishCandidate(pool: Pool, priceId: string, user: string) {
  await pool.query(`
    INSERT INTO price_record
      (price_id, amount, product_system, applicant, region, effective_from,
       service_fee_basis, source, published_by)
    SELECT price_id, amount, product_system, applicant, region, effective_from,
           service_fee_basis, source, $2
    FROM import_candidate
    WHERE price_id = $1 AND reviewed_at IS NOT NULL
    ON CONFLICT (price_id) DO NOTHING
  `, [priceId, user]);
  return Boolean(await getPublicPrice(pool, priceId));
}
