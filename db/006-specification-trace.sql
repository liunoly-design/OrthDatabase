CREATE TABLE orth_governance.specification_candidate (
    candidate_id text PRIMARY KEY CHECK (candidate_id ~ '^[0-9a-f]{64}$'),
    proposal jsonb NOT NULL CHECK (proposal->>'kind' IN ('specification', 'component_price', 'same_physical', 'revoke')),
    submitted_at timestamptz NOT NULL DEFAULT now(),
    submitted_by text NOT NULL,
    reviewed_at timestamptz,
    reviewed_by text,
    published_at timestamptz,
    published_by text,
    CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL)),
    CHECK ((published_at IS NULL) = (published_by IS NULL)),
    CHECK (published_at IS NULL OR reviewed_at IS NOT NULL)
);

CREATE TABLE orth_catalog.product_specification (
    spec_id text PRIMARY KEY,
    snapshot jsonb NOT NULL CHECK (snapshot->>'id' = spec_id)
);

CREATE TABLE orth_catalog.specification_identifier (
    spec_id text NOT NULL REFERENCES orth_catalog.product_specification,
    identifier_id text NOT NULL,
    snapshot jsonb NOT NULL CHECK (snapshot->>'id' = identifier_id),
    PRIMARY KEY (spec_id, identifier_id)
);
CREATE INDEX specification_identifier_lookup ON orth_catalog.specification_identifier
    ((snapshot->>'scheme'), (snapshot->>'value'), (coalesce(snapshot->>'namespace', '')), spec_id);

CREATE TABLE orth_catalog.specification_price (
    price_id text PRIMARY KEY,
    spec_id text NOT NULL REFERENCES orth_catalog.product_specification,
    snapshot jsonb NOT NULL CHECK (snapshot->>'price_id' = price_id),
    amount numeric(12, 2) GENERATED ALWAYS AS ((snapshot->>'amount')::numeric(12, 2)) STORED NOT NULL CHECK (amount > 0)
);
CREATE INDEX specification_price_subject ON orth_catalog.specification_price (spec_id, price_id);

CREATE TABLE orth_catalog.component_price (
    price_id text PRIMARY KEY,
    snapshot jsonb NOT NULL CHECK (snapshot->>'price_id' = price_id),
    amount numeric(12, 2) GENERATED ALWAYS AS ((snapshot->>'amount')::numeric(12, 2)) STORED NOT NULL CHECK (amount > 0)
);
CREATE INDEX component_price_subject ON orth_catalog.component_price
    ((snapshot#>>'{component,namespace}'), (snapshot#>>'{component,value}'));

CREATE TABLE orth_catalog.same_physical_specification (
    relation_id text PRIMARY KEY,
    left_spec_id text NOT NULL REFERENCES orth_catalog.product_specification,
    right_spec_id text NOT NULL REFERENCES orth_catalog.product_specification,
    snapshot jsonb NOT NULL CHECK (snapshot->>'id' = relation_id),
    revoked_at timestamptz,
    CHECK (left_spec_id COLLATE "C" < right_spec_id COLLATE "C")
);
CREATE UNIQUE INDEX same_physical_active_pair ON orth_catalog.same_physical_specification
    (left_spec_id, right_spec_id) WHERE revoked_at IS NULL;
CREATE INDEX same_physical_active_reverse ON orth_catalog.same_physical_specification
    (right_spec_id) WHERE revoked_at IS NULL;
CREATE TABLE orth_catalog.published_price_reference (
    spec_id text NOT NULL REFERENCES orth_catalog.product_specification,
    price_id text NOT NULL REFERENCES orth_catalog.price_record,
    component_identifier_id text,
    FOREIGN KEY (spec_id, component_identifier_id) REFERENCES orth_catalog.specification_identifier,
    PRIMARY KEY (spec_id, price_id)
);

CREATE VIEW orth_catalog.product_specification_v1 AS
SELECT spec_id, snapshot FROM orth_catalog.product_specification;
CREATE VIEW orth_catalog.specification_identifier_v1 AS
SELECT spec_id, identifier_id, snapshot FROM orth_catalog.specification_identifier;
CREATE VIEW orth_catalog.specification_price_v1 AS
SELECT spec_id, price_id, snapshot FROM orth_catalog.specification_price;
CREATE VIEW orth_catalog.component_price_v1 AS
SELECT price_id, snapshot FROM orth_catalog.component_price;
CREATE VIEW orth_catalog.active_same_physical_specification_v1 AS
SELECT left_spec_id, right_spec_id, snapshot
FROM orth_catalog.same_physical_specification WHERE revoked_at IS NULL;

-- An award example remains a category price and is returned by its original price_id.
-- Re-check current governance evidence so a later correction can withdraw the link.
CREATE VIEW orth_catalog.published_price_reference_v1 AS
SELECT reference.spec_id, price.price_id,
       CASE WHEN example.system_code IS NULL THEN jsonb_build_object(
            'price_id', price.price_id, 'relationship', 'product_spec')
       ELSE jsonb_build_object('price_id', price.price_id, 'relationship', 'category_award_example',
            'system_code', example.system_code, 'evidence', example.evidence) END AS snapshot
FROM orth_catalog.published_price_reference AS reference
JOIN orth_catalog.price_v1 AS price USING (price_id)
LEFT JOIN orth_catalog.specification_identifier AS component
  ON (component.spec_id, component.identifier_id) = (reference.spec_id, reference.component_identifier_id)
 AND component.snapshot->>'scheme' = 'platform_component_code'
LEFT JOIN LATERAL (
    SELECT packet#>>'{related_system,system_code}' AS system_code, member->'evidence' AS evidence
    FROM orth_catalog.price_evidence_v1 AS source
    CROSS JOIN LATERAL jsonb_array_elements(source.current_governance) AS packets(packet)
    CROSS JOIN LATERAL jsonb_array_elements(packet#>'{related_system,members}') AS members(member)
    WHERE source.price_id = price.price_id AND price.subject_kind = 'kit_category'
      AND component.snapshot->>'namespace' = lower(price.round_id)
      AND packet#>>'{related_system,relationship}' = 'category_award_example'
      AND member->>'component_code' = component.snapshot->>'value'
    LIMIT 1
) AS example ON reference.component_identifier_id IS NOT NULL
WHERE (reference.component_identifier_id IS NULL AND price.subject_kind = 'product_spec'
        AND price.product_spec_id = reference.spec_id) OR example.system_code IS NOT NULL;

CREATE FUNCTION orth_catalog.merge_trace_price_evidence(current_fact jsonb, next_fact jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT jsonb_set(current_fact, '{evidence}', current_fact->'evidence' || coalesce((
        SELECT jsonb_agg(ref ORDER BY position)
        FROM jsonb_array_elements(next_fact->'evidence') WITH ORDINALITY AS next(ref, position)
        WHERE NOT current_fact->'evidence' @> jsonb_build_array(ref)
    ), '[]'::jsonb));
$$;

CREATE FUNCTION orth_catalog.trace_price_scope_conflicts(current_fact jsonb, next_fact jsonb)
RETURNS boolean
LANGUAGE sql STABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
    WITH dates AS (
        SELECT (current_fact->>'effective_from')::date AS current_start,
               (current_fact->>'effective_to')::date AS current_end,
               (next_fact->>'effective_from')::date AS next_start,
               (next_fact->>'effective_to')::date AS next_end
    ), non_scope AS (
        SELECT ARRAY['price_id', 'amount', 'evidence', 'original_identifier_ids', 'original_registration_numbers',
            'source_nhsa_20', 'effective_from', 'effective_to', 'effective_to_exclusive',
            'effective_to_basis', 'effective_date_text'] AS fields
    )
    SELECT current_fact->>'price_id' <> next_fact->>'price_id'
       AND (EXISTS (
                SELECT 1
                FROM jsonb_array_elements(current_fact->'evidence') AS original(ref)
                JOIN jsonb_array_elements(next_fact->'evidence') AS proposed(ref)
                  ON (original.ref->>'url', original.ref->>'sha256', original.ref->>'sheet_name', original.ref->>'price_cell') =
                     (proposed.ref->>'url', proposed.ref->>'sha256', proposed.ref->>'sheet_name', proposed.ref->>'price_cell')
            ) OR (
                current_fact - fields = next_fact - fields
                AND ((current_start IS NOT NULL AND next_start IS NOT NULL
                      AND current_fact->>'effective_to_basis' IN ('known', 'open')
                      AND next_fact->>'effective_to_basis' IN ('known', 'open')
                      AND daterange(current_start, current_end, '[]') && daterange(next_start, next_end, '[]'))
                     OR ((next_fact->>'round_id' IS NOT NULL OR next_start IS NOT NULL OR next_end IS NOT NULL)
                         AND (current_start, current_end, current_fact->>'effective_to_basis')
                             IS NOT DISTINCT FROM (next_start, next_end, next_fact->>'effective_to_basis')))
            ))
    FROM dates CROSS JOIN non_scope;
$$;

REVOKE ALL ON FUNCTION orth_catalog.merge_trace_price_evidence(jsonb, jsonb),
    orth_catalog.trace_price_scope_conflicts(jsonb, jsonb) FROM PUBLIC;

CREATE FUNCTION orth_catalog.publish_specification(candidate text, operator_name text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    packet orth_governance.specification_candidate%ROWTYPE;
    target_spec text;
    fact jsonb;
    target_identifier text;
BEGIN
    SELECT * INTO packet FROM orth_governance.specification_candidate
    WHERE candidate_id = candidate FOR UPDATE;

    IF NOT FOUND OR packet.reviewed_at IS NULL THEN
        RETURN false;
    END IF;
    IF packet.published_at IS NOT NULL THEN
        RETURN true;
    END IF;

    CASE packet.proposal->>'kind'
    WHEN 'specification' THEN
        fact := packet.proposal->'specification';
        target_spec := fact->>'id';
        INSERT INTO orth_catalog.product_specification (spec_id, snapshot)
        VALUES (target_spec, fact) ON CONFLICT (spec_id) DO NOTHING;
        -- Serialize additions to the same registration identity.
        PERFORM 1 FROM orth_catalog.product_specification WHERE spec_id = target_spec AND snapshot = fact FOR UPDATE;
        IF NOT FOUND THEN
            RETURN false;
        END IF;

        FOR fact IN SELECT value FROM jsonb_array_elements(packet.proposal->'identifiers') LOOP
            INSERT INTO orth_catalog.specification_identifier (spec_id, identifier_id, snapshot)
            VALUES (target_spec, fact->>'id', fact) ON CONFLICT (spec_id, identifier_id) DO NOTHING;
            IF NOT EXISTS (SELECT 1 FROM orth_catalog.specification_identifier
                WHERE (spec_id, identifier_id, snapshot) = (target_spec, fact->>'id', fact)) THEN
                RAISE SQLSTATE 'OD001';
            END IF;
        END LOOP;
        IF EXISTS (
            SELECT 1 FROM orth_catalog.specification_identifier AS certificate
            WHERE certificate.spec_id = target_spec AND certificate.snapshot ? 'via_component'
              AND NOT EXISTS (
                  SELECT 1 FROM orth_catalog.specification_identifier AS component
                  WHERE component.spec_id = target_spec
                    AND component.identifier_id = certificate.snapshot->>'via_component'
                    AND component.snapshot->>'scheme' = 'platform_component_code'
              )
        ) THEN
            RAISE SQLSTATE 'OD001';
        END IF;
        FOR fact IN SELECT value FROM jsonb_array_elements(packet.proposal->'prices')
                    ORDER BY value->>'price_id' LOOP
            FOR target_identifier IN SELECT value FROM jsonb_array_elements_text(fact->'original_identifier_ids') LOOP
                IF NOT EXISTS (SELECT 1 FROM orth_catalog.specification_identifier
                    WHERE spec_id = target_spec AND identifier_id = target_identifier
                      AND (snapshot->>'scheme' <> 'udi_di' OR fact->>'pack_quantity' IS NULL
                           OR snapshot#>>'{packaging,quantity}' IS NULL
                           OR snapshot#>>'{packaging,quantity}' = fact->>'pack_quantity')) THEN
                    RAISE SQLSTATE 'OD001';
                END IF;
            END LOOP;
            IF EXISTS (SELECT 1 FROM orth_catalog.specification_price
                WHERE spec_id = target_spec AND orth_catalog.trace_price_scope_conflicts(snapshot, fact)) THEN
                RAISE SQLSTATE 'OD001';
            END IF;
            INSERT INTO orth_catalog.specification_price AS price (price_id, spec_id, snapshot)
            VALUES (fact->>'price_id', target_spec, fact) ON CONFLICT (price_id) DO UPDATE
            SET snapshot = orth_catalog.merge_trace_price_evidence(price.snapshot, EXCLUDED.snapshot)
            WHERE price.spec_id = target_spec AND price.snapshot - 'evidence' = EXCLUDED.snapshot - 'evidence';
            IF NOT FOUND THEN
                RAISE SQLSTATE 'OD001';
            END IF;
        END LOOP;
        FOR fact IN SELECT value FROM jsonb_array_elements(coalesce(
                    packet.proposal->'published_price_references', '[]'::jsonb)) ORDER BY value->>'price_id' LOOP
            INSERT INTO orth_catalog.published_price_reference (spec_id, price_id, component_identifier_id)
            VALUES (target_spec, fact->>'price_id', fact->>'component_identifier_id')
            ON CONFLICT (spec_id, price_id) DO NOTHING;
            IF NOT EXISTS (
                SELECT 1 FROM orth_catalog.published_price_reference AS reference
                JOIN orth_catalog.published_price_reference_v1 AS active USING (spec_id, price_id)
                WHERE reference.spec_id = target_spec AND reference.price_id = fact->>'price_id'
                  AND reference.component_identifier_id IS NOT DISTINCT FROM fact->>'component_identifier_id'
            ) THEN
                RAISE SQLSTATE 'OD001';
            END IF;
        END LOOP;
    WHEN 'component_price' THEN
        fact := packet.proposal->'price';
        PERFORM pg_advisory_xact_lock(hashtextextended((fact->'component')::text, 6));
        IF EXISTS (SELECT 1 FROM orth_catalog.component_price
            WHERE (snapshot#>>'{component,namespace}', snapshot#>>'{component,value}') =
                  (fact#>>'{component,namespace}', fact#>>'{component,value}')
              AND orth_catalog.trace_price_scope_conflicts(snapshot, fact)) THEN
            RETURN false;
        END IF;
        INSERT INTO orth_catalog.component_price AS price (price_id, snapshot)
        VALUES (fact->>'price_id', fact) ON CONFLICT (price_id) DO UPDATE
        SET snapshot = orth_catalog.merge_trace_price_evidence(price.snapshot, EXCLUDED.snapshot)
        WHERE price.snapshot - 'evidence' = EXCLUDED.snapshot - 'evidence';
        IF NOT FOUND THEN
            RETURN false;
        END IF;
    WHEN 'same_physical' THEN
        fact := packet.proposal->'relation';
        INSERT INTO orth_catalog.same_physical_specification (relation_id, left_spec_id, right_spec_id, snapshot)
        VALUES (fact->>'id', fact->>'left_spec_id', fact->>'right_spec_id', fact)
        ON CONFLICT DO NOTHING;
        IF NOT FOUND THEN
            RETURN false;
        END IF;
    WHEN 'revoke' THEN
        UPDATE orth_catalog.same_physical_specification SET revoked_at = clock_timestamp()
        WHERE relation_id = packet.proposal->>'relation_id' AND revoked_at IS NULL;
        IF NOT FOUND THEN
            RETURN false;
        END IF;
    ELSE
        RETURN false;
    END CASE;

    UPDATE orth_governance.specification_candidate
    SET published_at = clock_timestamp(), published_by = operator_name
    WHERE candidate_id = candidate;
    RETURN true;
EXCEPTION WHEN SQLSTATE 'OD001' OR foreign_key_violation THEN
    -- A rejected packet must leave its prices and identifiers unpublished.
    RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION orth_catalog.publish_specification(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orth_catalog.publish_specification(text, text) TO orth_publisher;
GRANT SELECT ON orth_catalog.product_specification_v1, orth_catalog.specification_identifier_v1,
    orth_catalog.specification_price_v1, orth_catalog.component_price_v1,
    orth_catalog.active_same_physical_specification_v1, orth_catalog.published_price_reference_v1 TO orth_application;
GRANT SELECT, INSERT (candidate_id, proposal, submitted_by), UPDATE (reviewed_at, reviewed_by)
    ON orth_governance.specification_candidate TO orth_governance;
