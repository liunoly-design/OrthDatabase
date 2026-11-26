import type { Pool, PoolClient } from "pg";
import type { GovernanceEvidence, PublicPrice, PublishedPriceSnapshot } from "../contracts/price-v1.d.ts";
import type { ChangeRequest } from "./governance-input.ts";

export interface OriginalRow {
  number: number;
  cells: string[];
}

type PriceFacts = Pick<PublishedPriceSnapshot,
  "price_id" | "amount" | "product_system" | "applicant" | "region" |
  "service_fee_basis" | "source">;

export type Candidate = PriceFacts & {
  effective_from: string | null;
  source_price_id: string;
  original_rows: OriginalRow[];
  governance: GovernanceEvidence | null;
  change: ChangeRequest | null;
};

export type ReviewStatus = "待复核" | "已复核" | "已发布";

export type ReviewCandidate = Candidate & Pick<PublicPrice, "currency" | "unit" | "price_type"> & {
  status: ReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  target_candidate_id: string | null;
  published_by: string | null;
};

export function publishedPriceId({ source_price_id, change }: Pick<Candidate, "source_price_id" | "change">) {
  return change && change.operation !== "official_correction" ? change.target_price_id : source_price_id;
}

export type CandidateSummary = Pick<ReviewCandidate, "price_id" | "product_system" | "applicant" | "status">;

const priceColumns = `
  c.price_id, c.amount::text, 'CNY' AS currency, '元/套' AS unit,
  '正式中选价' AS price_type, c.product_system, c.applicant, c.region,
  to_char(c.effective_from, 'YYYY-MM-DD') AS effective_from, c.service_fee_basis, c.source`;

export const candidateStatusColumn = `
  CASE WHEN c.price_id IS NULL THEN NULL
       WHEN published.candidate_id IS NOT NULL THEN '已发布'
       WHEN c.reviewed_at IS NOT NULL THEN '已复核'
       ELSE '待复核' END`;

export interface ImportConflictDetails {
  existing_price_id: string;
  existing_candidate_id: string;
  existing_amount: string;
  existing_source: Candidate["source"];
  proposed_amount: string;
  proposed_source: Candidate["source"];
}

export class ImportConflict extends Error {
  readonly details: ImportConflictDetails;

  constructor(message: string, details: ImportConflictDetails) {
    super(message);
    this.details = details;
  }
}

export async function addCandidate(client: PoolClient, candidate: Candidate) {
  const { price_id, amount, product_system, applicant, region, effective_from,
    service_fee_basis, source, original_rows, governance, change, source_price_id } = candidate;
  const proposalValues = [price_id, amount, product_system, applicant, region, effective_from,
    service_fee_basis, source, JSON.stringify(original_rows), governance, change];
  // These locks are held until the candidate and its collection task commit together.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [price_id]);
  if (!change) {
    await client.query(`
      SELECT pg_advisory_xact_lock(hashtextextended(json_build_array($1::text, $2::text, $3::text, $4::integer)::text, 2))
    `, [source.notice_url, source.attachment_url, source.sheet_name, source.row_number]);
    await client.query(`
      SELECT pg_advisory_xact_lock(hashtextextended(json_build_array($1::text, $2::text, $3::text, $4::text, $5::text)::text, 0))
    `, [product_system, applicant, region, effective_from, service_fee_basis]);
  }
  const { rows: [existing] } = await client.query<{
    candidate_id: string; price_id: string; amount: string; source: Candidate["source"]; replay: boolean | null;
  }>(`
    SELECT price_id AS candidate_id, CASE WHEN change_request->>'operation' IN ('additional_evidence', 'platform_correction')
             THEN change_request->>'target_price_id' ELSE coalesce(source_price_id, price_id) END AS price_id,
           amount::text, source,
           price_id = $1 AND
           (amount, product_system, applicant, region, effective_from, service_fee_basis, source, original_rows)
             IS NOT DISTINCT FROM ($2, $3, $4, $5, $6, $7, $8, $9) AND
           ($10::jsonb IS NULL OR governance = $10) AND change_request IS NOT DISTINCT FROM $11 AS replay
    FROM orth_governance.import_candidate
    WHERE price_id = $1 OR ($11::jsonb IS NULL AND
      (change_request IS NULL OR change_request->>'operation' = 'official_correction') AND (
        (product_system, applicant, region, service_fee_basis) = ($3, $4, $5, $7) AND effective_from IS NOT DISTINCT FROM $6
        OR (source->>'notice_url', source->>'attachment_url', source->>'sheet_name', source->>'row_number')
         = ($8->>'notice_url', $8->>'attachment_url', $8->>'sheet_name', $8->>'row_number')
      ))
    ORDER BY (price_id = $1) DESC, imported_at DESC, candidate_id
    LIMIT 1
  `, proposalValues);
  if (existing?.replay) return;
  if (existing) {
    const message = existing.amount !== amount ? "金额冲突，需核对官方来源"
      : existing.candidate_id === price_id ? "同一来源位置的导入内容有冲突"
        : "同一计价口径已有候选，核对后提交追加证据或更正";
    throw new ImportConflict(message, {
      existing_price_id: existing.price_id, existing_candidate_id: existing.candidate_id,
      existing_amount: existing.amount, existing_source: existing.source,
      proposed_amount: amount, proposed_source: source
    });
  }
  await client.query(`
    INSERT INTO orth_governance.import_candidate
      (price_id, amount, product_system, applicant, region, effective_from,
       service_fee_basis, source, original_rows, governance, change_request, source_price_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  `, [...proposalValues, source_price_id]);
}

export async function listCandidates(pool: Pool) {
  const { rows } = await pool.query<CandidateSummary>(`
    SELECT c.price_id, c.product_system, c.applicant, ${candidateStatusColumn} AS status
    FROM orth_governance.import_candidate AS c LEFT JOIN orth_catalog.publication_revision AS published ON published.candidate_id = c.price_id
    ORDER BY c.imported_at DESC, c.price_id
  `);
  return rows;
}

export async function getCandidate(pool: Pool, priceId: string) {
  const { rows } = await pool.query<ReviewCandidate>(`
    SELECT ${priceColumns}, coalesce(c.source_price_id, c.price_id) AS source_price_id, c.original_rows, c.governance, c.change_request AS change,
           c.reviewed_by, to_char(c.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reviewed_at,
           published.published_by, target.candidate_id AS target_candidate_id, ${candidateStatusColumn} AS status
    FROM orth_governance.import_candidate AS c LEFT JOIN orth_catalog.publication_revision AS published ON published.candidate_id = c.price_id
    LEFT JOIN orth_catalog.publication_revision AS target ON target.price_id = c.change_request->>'target_price_id'
      AND target.record_version = (c.change_request->>'target_record_version')::integer
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
