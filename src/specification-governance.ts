import { createHash } from "node:crypto";
import express from "express";
import type { Pool } from "pg";
import { parseSpecificationProposal } from "./specification-input.ts";

export function createSpecificationGovernanceRouter(pool: Pool, publisher: Pool, operator: string) {
  const router = express.Router();
  router.get("/", async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT candidate_id, proposal->>'kind' AS kind, submitted_at, reviewed_at, published_at
      FROM orth_governance.specification_candidate ORDER BY submitted_at DESC, candidate_id LIMIT 100
    `);
    res.json(rows);
  });
  router.get("/:candidateId", async (req, res) => {
    const { rows: [candidate] } = await pool.query(`
      SELECT * FROM orth_governance.specification_candidate WHERE candidate_id = $1
    `, [req.params.candidateId]);
    if (candidate) res.json(candidate);
    else res.status(404).json({ error: "candidate_not_found" });
  });
  router.post("/", express.json({ limit: "256kb" }), async (req, res) => {
    let proposal: string;
    try {
      proposal = JSON.stringify(parseSpecificationProposal(req.body));
    } catch (error) {
      res.status(400).json({ error: "invalid_specification_proposal",
        detail: error instanceof Error ? error.message : "候选无效" });
      return;
    }
    const candidateId = createHash("sha256").update(proposal).digest("hex");
    await pool.query(`
      INSERT INTO orth_governance.specification_candidate (candidate_id, proposal, submitted_by)
      VALUES ($1, $2, $3) ON CONFLICT (candidate_id) DO NOTHING
    `, [candidateId, proposal, operator]);
    res.json({ candidate_id: candidateId });
  });
  router.post("/:candidateId/review", async (req, res) => {
    const { rowCount } = await pool.query(`
      UPDATE orth_governance.specification_candidate
      SET reviewed_at = coalesce(reviewed_at, clock_timestamp()), reviewed_by = coalesce(reviewed_by, $2)
      WHERE candidate_id = $1
    `, [req.params.candidateId, operator]);
    if (rowCount) res.sendStatus(204);
    else res.status(404).json({ error: "candidate_not_found" });
  });
  router.post("/:candidateId/publish", async (req, res) => {
    const { rows: [candidate] } = await pool.query(`
      SELECT reviewed_at FROM orth_governance.specification_candidate WHERE candidate_id = $1
    `, [req.params.candidateId]);
    if (!candidate) {
      res.status(404).json({ error: "candidate_not_found" });
      return;
    }
    const { rows: [{ published }] } = await publisher.query<{ published: boolean }>(
      "SELECT orth_catalog.publish_specification($1, $2) AS published", [req.params.candidateId, operator]
    );
    if (published) res.sendStatus(204);
    else res.status(409).json({ error: candidate.reviewed_at ? "publication_conflict" : "review_required" });
  });
  return router;
}
