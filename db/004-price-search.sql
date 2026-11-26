ALTER TABLE orth_catalog.price_record ADD COLUMN published_group text;

-- The Hunan workbook calls its disclosed grouping 竞价单元 (column C).
CREATE FUNCTION orth_catalog.hunan_joint_group(original_rows jsonb, source jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT CASE WHEN original_rows #>> '{0,cells,0}' = '国家组织人工关节集中带量采购协议期满接续中选结果'
                      AND original_rows #>> '{1,cells,2}' = '竞价单元'
                      AND original_rows #>> '{3,number}' = source ->> 'row_number'
                THEN NULLIF(btrim(original_rows #>> '{3,cells,2}'), '')
           END;
$$;

REVOKE ALL ON FUNCTION orth_catalog.hunan_joint_group(jsonb, jsonb) FROM PUBLIC;

UPDATE orth_catalog.price_record AS price
SET published_group = orth_catalog.hunan_joint_group(candidate.original_rows, price.source)
FROM orth_governance.import_candidate AS candidate
WHERE candidate.price_id = price.price_id AND candidate.source = price.source;

CREATE OR REPLACE FUNCTION orth_catalog.publish_price(candidate_id text, operator_name text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    INSERT INTO orth_catalog.price_record
        (price_id, amount, product_system, applicant, region, effective_from,
         service_fee_basis, source, published_by, published_group)
    SELECT price_id, amount, product_system, applicant, region, effective_from,
           service_fee_basis, source, operator_name, orth_catalog.hunan_joint_group(original_rows, source)
    FROM orth_governance.import_candidate
    WHERE price_id = candidate_id AND reviewed_at IS NOT NULL
    ON CONFLICT (price_id) DO NOTHING;

    IF FOUND THEN
        RETURN true;
    END IF;
    RETURN EXISTS (SELECT 1 FROM orth_catalog.price_record WHERE price_id = candidate_id);
END;
$$;

CREATE VIEW orth_catalog.price_search_v1 AS
SELECT price.*, record.published_group, names.product_alias
FROM orth_catalog.price_v1 AS price
JOIN orth_catalog.price_record AS record USING (price_id)
LEFT JOIN (VALUES
    ('合金-聚乙烯类髋关节产品系统', '合金对聚乙烯髋关节'),
    ('陶瓷-聚乙烯类髋关节产品系统', '陶瓷对聚乙烯髋关节'),
    ('陶瓷-陶瓷类髋关节产品系统', '陶瓷对陶瓷髋关节'),
    ('膝关节产品系统', '人工全膝关节')
) AS names(product_system, product_alias)
    ON price.round_id = 'GH-HD2024-1' AND price.subject_kind = 'kit_category'
       AND price.product_system = names.product_system;

REVOKE ALL ON orth_catalog.price_search_v1 FROM PUBLIC;
GRANT SELECT ON orth_catalog.price_search_v1 TO orth_application;
