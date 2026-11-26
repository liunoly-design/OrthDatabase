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
