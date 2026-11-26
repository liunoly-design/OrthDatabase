DO $$
DECLARE
    role_name text;
BEGIN
    FOREACH role_name IN ARRAY ARRAY['orth_application', 'orth_governance', 'orth_publisher']
    LOOP
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
                EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
            END IF;
        EXCEPTION WHEN duplicate_object OR unique_violation THEN
            -- The same group role may have been created by another database's migration.
        END;
    END LOOP;
END;
$$;

CREATE SCHEMA orth_governance;
CREATE SCHEMA orth_catalog;
CREATE SCHEMA orth_app;

ALTER TABLE public.import_candidate SET SCHEMA orth_governance;
ALTER TABLE public.price_record SET SCHEMA orth_catalog;

-- Moving a table keeps its ACL. Replace legacy grants with the runtime grants below.
DO $$
DECLARE
    legacy_grant record;
BEGIN
    FOR legacy_grant IN
        SELECT relation.oid::regclass AS relation_name, grantee.rolname
        FROM pg_class AS relation
        CROSS JOIN LATERAL (
            SELECT acl.grantee FROM aclexplode(relation.relacl) AS acl
            WHERE acl.grantor = relation.relowner
            UNION
            SELECT acl.grantee
            FROM pg_attribute AS attribute
            CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
            WHERE attribute.attrelid = relation.oid AND acl.grantor = relation.relowner
        ) AS acl
        JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
        WHERE relation.oid IN ('orth_governance.import_candidate'::regclass, 'orth_catalog.price_record'::regclass)
          AND grantee.oid <> relation.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON TABLE %s FROM %I CASCADE', legacy_grant.relation_name, legacy_grant.rolname);
    END LOOP;
END;
$$;

ALTER TABLE orth_governance.import_candidate ADD CONSTRAINT candidate_effective_from_range
    CHECK (effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31');
ALTER TABLE orth_catalog.price_record ADD CONSTRAINT price_effective_from_range
    CHECK (effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31');

CREATE VIEW orth_catalog.price_v1 AS
SELECT 1 AS contract_version, price_id, 1 AS record_version, 'published'::text AS record_status,
       NULL::text AS supersedes_price_id, 'GH-HD2024-1'::text AS round_id,
       amount::text AS amount, 'CNY'::text AS currency, '元/套'::text AS unit,
       '正式中选价'::text AS price_type, 'kit_category'::text AS subject_kind,
       product_system, applicant, NULL::text AS product_spec_id, NULL::text AS kit_version_id,
       NULL::integer AS pack_quantity, region, NULL::text AS hospital_id,
       to_char(effective_from, 'YYYY-MM-DD') AS effective_from, NULL::text AS effective_to,
       service_fee_basis, source,
       to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at
FROM orth_catalog.price_record;

CREATE TABLE orth_app.account (
    account_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION orth_catalog.publish_price(candidate_id text, operator_name text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    INSERT INTO orth_catalog.price_record
        (price_id, amount, product_system, applicant, region, effective_from,
         service_fee_basis, source, published_by)
    SELECT price_id, amount, product_system, applicant, region, effective_from,
           service_fee_basis, source, operator_name
    FROM orth_governance.import_candidate
    WHERE price_id = candidate_id AND reviewed_at IS NOT NULL
    ON CONFLICT (price_id) DO NOTHING;

    IF FOUND THEN
        RETURN true;
    END IF;
    RETURN EXISTS (SELECT 1 FROM orth_catalog.price_record WHERE price_id = candidate_id);
END;
$$;

REVOKE ALL ON SCHEMA orth_governance, orth_catalog, orth_app FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA orth_governance, orth_catalog, orth_app FROM PUBLIC;
REVOKE ALL ON FUNCTION orth_catalog.publish_price(text, text) FROM PUBLIC;

GRANT USAGE ON SCHEMA orth_governance, orth_catalog TO orth_governance;
GRANT SELECT ON orth_governance.import_candidate TO orth_governance;
GRANT INSERT (price_id, amount, product_system, applicant, region, effective_from,
    service_fee_basis, source, original_rows) ON orth_governance.import_candidate TO orth_governance;
GRANT UPDATE (reviewed_at, reviewed_by) ON orth_governance.import_candidate TO orth_governance;
GRANT SELECT (price_id) ON orth_catalog.price_record TO orth_governance;

GRANT USAGE ON SCHEMA orth_catalog TO orth_publisher;
GRANT EXECUTE ON FUNCTION orth_catalog.publish_price(text, text) TO orth_publisher;

GRANT USAGE ON SCHEMA orth_catalog, orth_app TO orth_application;
GRANT SELECT ON orth_catalog.price_v1 TO orth_application;
GRANT SELECT, INSERT, UPDATE, DELETE ON orth_app.account TO orth_application;
