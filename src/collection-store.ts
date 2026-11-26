import type { Pool } from "pg";
import type { ReviewStatus } from "./price-store.ts";
import { candidateStatusColumn } from "./price-store.ts";

export interface CollectionSource {
  notice_url: string;
  notice_title: string;
  publisher: string;
  last_started_at: string | null;
  last_success_at: string | null;
}

export interface CollectionTask {
  task_id: string;
  notice_url: string;
  notice_title: string;
  attachment_url: string;
  sha256: string;
  sheet_name: string;
  row_number: number;
  status: "running" | "imported" | "failed" | "interrupted";
  started_at: string;
  finished_at: string | null;
  candidate_id: string | null;
  candidate_status: ReviewStatus | null;
  error: string | null;
}

export async function listSources(pool: Pool) {
  const { rows } = await pool.query<CollectionSource>(`
    SELECT s.*, history.last_started_at, history.last_success_at
    FROM orth_governance.collection_source AS s
    LEFT JOIN LATERAL (
      SELECT max(started_at) AS last_started_at,
             max(finished_at) FILTER (WHERE status = 'imported') AS last_success_at
      FROM orth_governance.collection_task WHERE notice_url = s.notice_url
    ) AS history ON true
    ORDER BY history.last_started_at DESC NULLS LAST, s.notice_url
  `);
  return rows;
}

export async function listTasks(pool: Pool) {
  const { rows } = await pool.query<CollectionTask>(`
    SELECT task.task_id, task.notice_url, task.attachment_url, task.sha256,
           task.sheet_name, task.row_number, task.started_at, task.finished_at, task.candidate_id, task.error,
           CASE WHEN task.status = 'running' AND NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_stat_activity AS session
               WHERE session.datname = current_database()
                 AND session.application_name = 'orth-worker:' || task.task_id::text
           ) THEN 'interrupted' ELSE task.status END AS status,
           s.notice_title, ${candidateStatusColumn} AS candidate_status
    FROM orth_governance.collection_task AS task
    JOIN orth_governance.collection_source AS s USING (notice_url)
    LEFT JOIN orth_governance.import_candidate AS c ON c.price_id = task.candidate_id
    LEFT JOIN orth_catalog.price_record AS published ON published.price_id = c.price_id
    ORDER BY task.started_at DESC, task.task_id
  `);
  return rows;
}
