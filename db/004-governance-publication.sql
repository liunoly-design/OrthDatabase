ALTER TABLE orth_governance.import_candidate
    ALTER COLUMN effective_from DROP NOT NULL,
    ADD COLUMN governance jsonb,
    ADD COLUMN change_request jsonb,
    ADD COLUMN source_price_id text CHECK (source_price_id ~ '^aj_[a-f0-9]{32}$'),
    ADD CHECK (change_request IS NULL OR source_price_id IS NOT NULL);
CREATE INDEX import_candidate_subject ON orth_governance.import_candidate
    (product_system, applicant, region, service_fee_basis, effective_from);
CREATE INDEX import_candidate_source_position ON orth_governance.import_candidate
    ((source->>'notice_url'), (source->>'attachment_url'), (source->>'sheet_name'), (source->>'row_number'));
GRANT SELECT (governance, change_request, imported_at, source_price_id), INSERT (governance, change_request, source_price_id)
    ON orth_governance.import_candidate TO orth_worker;

ALTER TABLE orth_governance.collection_task
    ADD COLUMN skill_version text,
    ADD COLUMN parser_version text,
    ADD COLUMN supply_manifest jsonb,
    ADD COLUMN conflict jsonb CHECK (conflict IS NULL OR status = 'failed');
GRANT INSERT (skill_version, parser_version, supply_manifest), UPDATE (conflict) ON orth_governance.collection_task TO orth_worker;

ALTER TABLE orth_catalog.price_record
    ALTER COLUMN effective_from DROP NOT NULL,
    ADD COLUMN record_version integer NOT NULL DEFAULT 1 CHECK (record_version > 0),
    ADD COLUMN supersedes_price_id text UNIQUE REFERENCES orth_catalog.price_record (price_id),
    ADD COLUMN origin_candidate_id text UNIQUE REFERENCES orth_governance.import_candidate (price_id);
UPDATE orth_catalog.price_record SET origin_candidate_id = price_id;
ALTER TABLE orth_catalog.price_record
    DROP CONSTRAINT price_record_price_id_fkey,
    ALTER COLUMN origin_candidate_id SET NOT NULL;

CREATE INDEX price_record_subject ON orth_catalog.price_record
    (product_system, applicant, region, service_fee_basis, effective_from);

CREATE OR REPLACE VIEW orth_catalog.price_v1 AS
SELECT 1 AS contract_version, price_id, record_version, 'published'::text AS record_status,
       supersedes_price_id, 'GH-HD2024-1'::text AS round_id,
       amount::text AS amount, 'CNY'::text AS currency, '元/套'::text AS unit,
       '正式中选价'::text AS price_type, 'kit_category'::text AS subject_kind,
       product_system, applicant, NULL::text AS product_spec_id, NULL::text AS kit_version_id,
       NULL::integer AS pack_quantity, region, NULL::text AS hospital_id,
       to_char(effective_from, 'YYYY-MM-DD') AS effective_from, NULL::text AS effective_to,
       service_fee_basis, source,
       to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at
FROM orth_catalog.price_record;

CREATE TABLE orth_catalog.publication_revision (
    price_id text NOT NULL REFERENCES orth_catalog.price_record (price_id),
    record_version integer NOT NULL CHECK (record_version > 0),
    candidate_id text NOT NULL UNIQUE REFERENCES orth_governance.import_candidate (price_id),
    operation text NOT NULL CHECK (operation IN ('initial', 'additional_evidence', 'official_correction', 'platform_correction')),
    reason text,
    source jsonb NOT NULL,
    governance jsonb,
    price jsonb NOT NULL,
    published_at timestamptz NOT NULL,
    published_by text NOT NULL,
    PRIMARY KEY (price_id, record_version)
);

INSERT INTO orth_catalog.publication_revision
    (price_id, record_version, candidate_id, operation, source, price, published_at, published_by)
SELECT p.price_id, p.record_version, p.price_id, 'initial', p.source,
       to_jsonb(p) - 'published_at', r.published_at, r.published_by
FROM orth_catalog.price_v1 AS p JOIN orth_catalog.price_record AS r USING (price_id);

CREATE VIEW orth_catalog.price_evidence_v1 AS
SELECT 1 AS contract_version, p.price_id, replacement.price_id AS superseded_by_price_id,
       history.current_governance, history.revisions
FROM orth_catalog.price_record AS p
LEFT JOIN orth_catalog.price_record AS replacement ON replacement.supersedes_price_id = p.price_id
CROSS JOIN LATERAL (
    SELECT coalesce(jsonb_agg(r.governance ORDER BY r.record_version DESC) FILTER (
               WHERE r.governance IS NOT NULL AND r.record_version >= coalesce(r.governance_reset_version, 1)
           ), '[]'::jsonb) AS current_governance,
           jsonb_agg(jsonb_build_object(
             'record_version', r.record_version, 'operation', r.operation, 'reason', r.reason, 'source', r.source,
             'governance', r.governance, 'price', r.price,
             'published_at', to_char(r.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           ) ORDER BY r.record_version DESC) AS revisions
    FROM (
        SELECT revision.*, max(record_version) FILTER (
                   WHERE operation = 'platform_correction' AND governance IS NOT NULL
               ) OVER () AS governance_reset_version
        FROM orth_catalog.publication_revision AS revision WHERE revision.price_id = p.price_id
    ) AS r
) AS history;

GRANT SELECT ON orth_catalog.price_evidence_v1 TO orth_application;
GRANT SELECT (candidate_id, price_id, record_version, published_by) ON orth_catalog.publication_revision TO orth_governance;

-- Compare cited locations independently of descriptive text or the order of cited cells.
CREATE FUNCTION orth_catalog.governance_locations(packet jsonb)
RETURNS SETOF jsonb
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT jsonb_build_array(ref->>'url', ref->>'sha256', ref->>'section', ref->>'page',
        ref->>'sheet_name', ref->>'row_number',
        (SELECT jsonb_agg(cell ORDER BY cell) FROM jsonb_array_elements(ref->'cells') AS cells(cell)))
    FROM jsonb_path_query(packet, 'lax $.**.evidence') AS evidence(value)
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(value) = 'array' THEN value ELSE jsonb_build_array(value) END
    ) AS refs(ref)
    WHERE ref ? 'url'
$$;
REVOKE ALL ON FUNCTION orth_catalog.governance_locations(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION orth_catalog.publish_price(candidate_id text, operator_name text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    proposal orth_governance.import_candidate%ROWTYPE;
    target orth_catalog.price_record%ROWTYPE;
    action text;
    published_id text;
    target_governance jsonb;
    revision_at timestamptz;
BEGIN
    SELECT * INTO proposal FROM orth_governance.import_candidate WHERE price_id = candidate_id FOR UPDATE;
    IF NOT FOUND OR proposal.reviewed_at IS NULL THEN
        RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM orth_catalog.publication_revision AS r WHERE r.candidate_id = proposal.price_id) THEN
        RETURN true;
    END IF;

    action := coalesce(proposal.change_request->>'operation', 'initial');
    published_id := coalesce(proposal.source_price_id, proposal.price_id);

    IF action IN ('initial', 'official_correction') THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(published_id, 3));
        IF EXISTS (SELECT 1 FROM orth_catalog.price_record WHERE price_id = published_id) THEN
            RETURN false;
        END IF;
    END IF;

    IF action <> 'additional_evidence' THEN
        -- Use the same scope key as the Worker, including the published service-fee basis.
        PERFORM pg_advisory_xact_lock(hashtextextended(json_build_array(proposal.product_system,
            proposal.applicant, proposal.region, to_char(proposal.effective_from, 'YYYY-MM-DD'),
            proposal.service_fee_basis)::text, 0));
        IF EXISTS (
            SELECT 1 FROM orth_catalog.price_record AS p
            WHERE (p.product_system, p.applicant, p.region, p.service_fee_basis) =
                  (proposal.product_system, proposal.applicant, proposal.region, proposal.service_fee_basis)
              AND p.effective_from IS NOT DISTINCT FROM proposal.effective_from
              AND p.price_id IS DISTINCT FROM (proposal.change_request->>'target_price_id')
              AND NOT EXISTS (SELECT 1 FROM orth_catalog.price_record WHERE supersedes_price_id = p.price_id)
        ) THEN
            RETURN false;
        END IF;
    END IF;

    IF action <> 'initial' THEN
        SELECT * INTO target FROM orth_catalog.price_record
        WHERE price_id = proposal.change_request->>'target_price_id' FOR UPDATE;
        IF NOT FOUND OR target.record_version <> (proposal.change_request->>'target_record_version')::integer
            OR EXISTS (SELECT 1 FROM orth_catalog.price_record WHERE supersedes_price_id = target.price_id) THEN
            RETURN false;
        END IF;

        CASE action
        WHEN 'additional_evidence' THEN
            IF (proposal.amount, proposal.product_system, proposal.applicant, proposal.region,
                    proposal.effective_from, proposal.service_fee_basis) IS DISTINCT FROM
               (target.amount, target.product_system, target.applicant, target.region,
                    target.effective_from, target.service_fee_basis)
               OR (
                   EXISTS (SELECT 1 FROM orth_catalog.publication_revision AS r WHERE r.price_id = target.price_id
                       AND (r.source->>'notice_url', r.source->>'attachment_url', r.source->>'sha256',
                            r.source->>'sheet_name', r.source->>'row_number') =
                           (proposal.source->>'notice_url', proposal.source->>'attachment_url', proposal.source->>'sha256',
                            proposal.source->>'sheet_name', proposal.source->>'row_number'))
                   AND NOT EXISTS (
                       SELECT location FROM orth_catalog.governance_locations(proposal.governance) AS next(location)
                       EXCEPT
                       SELECT location FROM orth_catalog.publication_revision AS r
                       CROSS JOIN LATERAL orth_catalog.governance_locations(r.governance) AS previous(location)
                       WHERE r.price_id = target.price_id
                   )
               ) THEN
                RETURN false;
            END IF;
            UPDATE orth_catalog.price_record SET record_version = record_version + 1 WHERE price_id = target.price_id;
            published_id := target.price_id;
        WHEN 'official_correction' THEN
            IF (proposal.product_system, proposal.applicant, proposal.region) IS DISTINCT FROM
               (target.product_system, target.applicant, target.region)
               OR (proposal.source->>'notice_url', proposal.source->>'sha256') IS NOT DISTINCT FROM
                  (target.source->>'notice_url', target.source->>'sha256')
               OR (proposal.amount, proposal.effective_from, proposal.service_fee_basis) IS NOT DISTINCT FROM
                  (target.amount, target.effective_from, target.service_fee_basis) THEN
                RETURN false;
            END IF;
        WHEN 'platform_correction' THEN
            SELECT current_governance INTO target_governance
            FROM orth_catalog.price_evidence_v1 WHERE price_id = target.price_id;

            -- A correction that changes what evidence applies needs a reviewed replacement or withdrawal.
            IF proposal.governance IS NULL AND target_governance <> '[]'::jsonb AND (
                (proposal.product_system, proposal.applicant, proposal.region, proposal.effective_from) IS DISTINCT FROM
                (target.product_system, target.applicant, target.region, target.effective_from)
                OR (proposal.amount <> target.amount AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(target_governance) AS evidence(packet)
                    WHERE jsonb_typeof(packet->'related_system') = 'object'
                ))
            ) THEN
                RETURN false;
            END IF;

            IF (proposal.source->>'attachment_url', proposal.source->>'sha256', proposal.source->>'sheet_name',
                proposal.source->>'row_number') IS DISTINCT FROM
               (target.source->>'attachment_url', target.source->>'sha256', target.source->>'sheet_name',
                target.source->>'row_number')
               OR (
                   (proposal.amount, proposal.product_system, proposal.applicant, proposal.region,
                    proposal.effective_from, proposal.service_fee_basis, proposal.source) IS NOT DISTINCT FROM
                   (target.amount, target.product_system, target.applicant, target.region,
                    target.effective_from, target.service_fee_basis, target.source)
                   AND (proposal.governance IS NULL OR jsonb_build_array(proposal.governance) = target_governance)
               ) THEN
                RETURN false;
            END IF;
            UPDATE orth_catalog.price_record
            SET amount = proposal.amount, product_system = proposal.product_system, applicant = proposal.applicant,
                region = proposal.region, effective_from = proposal.effective_from,
                service_fee_basis = proposal.service_fee_basis, source = proposal.source, record_version = record_version + 1
            WHERE price_id = target.price_id;
            published_id := target.price_id;
        ELSE
            RETURN false;
        END CASE;
    END IF;

    IF action IN ('initial', 'official_correction') THEN
        INSERT INTO orth_catalog.price_record
            (price_id, amount, product_system, applicant, region, effective_from,
             service_fee_basis, source, published_by, supersedes_price_id, origin_candidate_id)
        VALUES (published_id, proposal.amount, proposal.product_system, proposal.applicant, proposal.region,
                proposal.effective_from, proposal.service_fee_basis, proposal.source, operator_name, target.price_id, proposal.price_id)
        RETURNING published_at INTO revision_at;
    END IF;

    INSERT INTO orth_catalog.publication_revision
        (price_id, record_version, candidate_id, operation, reason, source, governance, price, published_at, published_by)
    SELECT p.price_id, p.record_version, proposal.price_id, action, proposal.change_request->>'reason', proposal.source,
           proposal.governance, to_jsonb(p) - 'published_at', coalesce(revision_at, clock_timestamp()), operator_name
    FROM orth_catalog.price_v1 AS p
    WHERE p.price_id = published_id;
    RETURN true;
END;
$$;
