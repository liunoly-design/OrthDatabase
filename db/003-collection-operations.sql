DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'orth_worker') THEN
        CREATE ROLE orth_worker NOLOGIN;
    END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
    -- Other databases may be migrating on the same instance.
END;
$$;

CREATE TABLE orth_governance.collection_source (
    notice_url text PRIMARY KEY,
    notice_title text NOT NULL,
    publisher text NOT NULL
);

CREATE TABLE orth_governance.collection_task (
    task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    notice_url text NOT NULL REFERENCES orth_governance.collection_source (notice_url),
    attachment_url text NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    sheet_name text NOT NULL,
    row_number integer NOT NULL CHECK (row_number >= 5),
    status text NOT NULL DEFAULT 'running',
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    candidate_id text REFERENCES orth_governance.import_candidate (price_id),
    error text,
    CHECK (
        (status = 'running' AND finished_at IS NULL AND candidate_id IS NULL AND error IS NULL) OR
        (status = 'imported' AND finished_at IS NOT NULL AND candidate_id IS NOT NULL AND error IS NULL) OR
        (status = 'failed' AND finished_at IS NOT NULL AND candidate_id IS NULL AND error IS NOT NULL)
    )
);

CREATE INDEX collection_task_source_time ON orth_governance.collection_task (notice_url, started_at DESC);

-- Existing candidates attest to the source, but their imports did not produce task records.
INSERT INTO orth_governance.collection_source (notice_url, notice_title, publisher)
SELECT DISTINCT ON (source->>'notice_url')
    source->>'notice_url', source->>'notice_title', source->>'publisher'
FROM orth_governance.import_candidate
WHERE source->>'notice_url' IS NOT NULL
  AND source->>'notice_title' IS NOT NULL AND source->>'publisher' IS NOT NULL
ORDER BY source->>'notice_url', imported_at DESC, price_id;

-- The original manual import command still uses the governance login.
GRANT orth_worker TO orth_governance;

GRANT USAGE ON SCHEMA orth_governance TO orth_worker;
GRANT SELECT, INSERT ON orth_governance.collection_source TO orth_worker;
GRANT SELECT ON orth_governance.collection_task TO orth_worker;
GRANT INSERT (task_id, notice_url, attachment_url, sha256, sheet_name, row_number) ON orth_governance.collection_task TO orth_worker;
GRANT UPDATE (status, finished_at, candidate_id, error) ON orth_governance.collection_task TO orth_worker;
GRANT SELECT (price_id, amount, product_system, applicant, region, effective_from,
    service_fee_basis, source, original_rows) ON orth_governance.import_candidate TO orth_worker;
GRANT INSERT (price_id, amount, product_system, applicant, region, effective_from,
    service_fee_basis, source, original_rows) ON orth_governance.import_candidate TO orth_worker;
