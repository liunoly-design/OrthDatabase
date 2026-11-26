CREATE TABLE orth_catalog.procurement_round (
    round_id text PRIMARY KEY,
    title text NOT NULL,
    categories text[] NOT NULL CHECK (cardinality(categories) > 0)
);

CREATE TABLE orth_catalog.procurement_event (
    event_id text PRIMARY KEY,
    round_id text NOT NULL REFERENCES orth_catalog.procurement_round (round_id),
    region text,
    event_type text NOT NULL CHECK (event_type IN
        ('submission', 'official_award', 'annual_renewal', 'local_execution',
         'product_information_maintenance', 'product_information_confirmation', 'product_information_notice')),
    announced_on date NOT NULL,
    effective_from date,
    effective_to date,
    summary text NOT NULL,
    price_disclosure text NOT NULL CHECK (price_disclosure IN
        ('not_disclosed', 'disclosed', 'referenced', 'not_stated')),
    publisher text NOT NULL,
    notice_title text NOT NULL,
    notice_url text NOT NULL CHECK (notice_url LIKE 'https://%'),
    notice_location text NOT NULL,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
    CHECK (effective_to IS NULL OR effective_to > effective_from AND effective_from IS NOT NULL),
    CHECK (event_type NOT IN ('annual_renewal', 'local_execution') OR region IS NOT NULL),
    UNIQUE (round_id, region, event_type, notice_url)
);

CREATE INDEX procurement_event_lookup
    ON orth_catalog.procurement_event (round_id, region, announced_on);
CREATE INDEX procurement_local_price_source
    ON orth_catalog.procurement_event (round_id, region, notice_url, effective_from)
    WHERE event_type = 'local_execution';

CREATE VIEW orth_catalog.procurement_event_v1 AS
SELECT event.event_id, event.round_id, round.title AS round_title, round.categories, event.region,
       event.event_type, to_char(event.announced_on, 'YYYY-MM-DD') AS announced_on,
       to_char(event.effective_from, 'YYYY-MM-DD') AS effective_from,
       to_char(event.effective_to, 'YYYY-MM-DD') AS effective_to,
       event.summary, event.price_disclosure,
       jsonb_build_object('publisher', event.publisher, 'title', event.notice_title, 'url', event.notice_url,
                          'location', event.notice_location) AS source,
       event.evidence
FROM orth_catalog.procurement_event AS event
JOIN orth_catalog.procurement_round AS round USING (round_id);

REVOKE ALL ON orth_catalog.procurement_round, orth_catalog.procurement_event, orth_catalog.procurement_event_v1 FROM PUBLIC;
GRANT SELECT ON orth_catalog.procurement_event_v1 TO orth_application;

-- Reviewed official policy facts. Prices still go through candidate review and publication.
INSERT INTO orth_catalog.procurement_round (round_id, title, categories) VALUES
    ('GH-HD2024-1', '人工关节集中带量采购协议期满接续采购', ARRAY['人工关节']),
    ('national-spine-lens-sports-renewal-2026',
     '国家组织骨科脊柱类、人工晶体类及运动医学类医用耗材集中带量采购接续采购',
     ARRAY['骨科脊柱', '人工晶体', '运动医学']);

INSERT INTO orth_catalog.procurement_event
    (event_id, round_id, region, event_type, announced_on, effective_from, effective_to,
     summary, price_disclosure, publisher, notice_title, notice_url, notice_location, evidence)
VALUES
    ('gh-hd2024-1-submission', 'GH-HD2024-1', NULL, 'submission',
     '2024-04-30', '2024-05-21', '2024-05-22',
     '联采办发布采购文件。5月21日8:30开始现场接收申报材料，10:00截止并公开申报信息。',
     'not_disclosed', '国家组织高值医用耗材联合采购办公室', '人工关节集中带量采购协议期满接续采购公告（第2号）',
     'https://www.nhsa.gov.cn/art/2024/4/30/art_109_12575.html', '国耗联采字〔2024〕1号，正文末段及采购文件链接',
     $evidence$
     {
         "attachments": [
             {
                 "title": "人工关节集中带量采购协议期满接续采购文件",
                 "url": "https://www.nhsa.gov.cn/module/download/downfile.jsp?classid=0&filename=b7cee42cfccc4c8a8a947ee4891606a0.pdf",
                 "location": "正文第20页（PDF第22页），第一部分第六、七节"
             }
         ]
     }
     $evidence$),
    ('gh-hd2024-1-award', 'GH-HD2024-1', NULL, 'official_award',
     '2024-05-24', NULL, NULL,
     '国家联采办公布正式中选结果。各地具体执行日期由联盟各地区确定。',
     'disclosed', '国家组织高值医用耗材联合采购办公室', '关于公布人工关节集中带量采购协议期满接续采购中选结果的通知',
     'https://hc.tjmpc.cn:10128/public/show14438.html', '正文第一段及下方附件表',
     $evidence$
     {
         "attachments": [
             {
                 "title": "人工关节集中带量采购协议期满接续采购中选结果",
                 "url": "https://hc.tjmpc.cn:10128/public/show14438.html",
                 "location": "公告下方附件表，申报产品系统类别中选价格列"
             }
         ]
     }
     $evidence$),
    ('gh-hd2024-1-hunan-execution', 'GH-HD2024-1', '湖南省', 'local_execution',
     '2024-09-19', '2024-10-15', '2027-10-15',
     '湖南执行国家人工关节接续结果。适用于具备相关资质的公立医疗机构（含军队医疗机构）和参与报量的各类医疗机构。',
     'disclosed', '湖南省医疗保障局', '湖南省医疗保障局关于做好人工关节集中带量采购协议期满接续中选结果执行工作的通知',
     'https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/t20240919_33458275.html',
     '湘医保函〔2024〕48号，第一节实施范围、第二节采购周期与协议采购量',
     $evidence$
     {
         "execution_date_location": "第二节采购周期与协议采购量",
         "price_rule_location": "第一节第（三）项价格范围，第三节第（四）项规范采购使用",
         "applicable_price_basis": "企业与产品系统类别中选套价，含伴随服务费，按中选价挂网并零差率收费。",
         "attachments": [
             {
                 "title": "附件1 国家组织人工关节集中带量采购协议期满接续中选结果",
                 "url": "https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/33458275/files/0ac80457057341528553dae98aee88b0.xls",
                 "sha256": "b6af63a9ad50d50b05025319225a000065c1b2ffc05505d49fa9e361a87bd7f5",
                 "location": "Sheet1，中选价格列"
             }
         ],
         "execution_end_basis": "第二节采购周期与协议采购量明确采购周期为三年。止日从执行起日推算，采用不含止日的口径。",
         "pricing_unit_source": {
             "title": "人工关节集中带量采购协议期满接续采购文件（GH-HD2024-1）",
             "url": "https://www.nhsa.gov.cn/module/download/downfile.jsp?classid=0&filename=b7cee42cfccc4c8a8a947ee4891606a0.pdf",
             "location": "正文第24–25页（PDF第26–27页），第二部分第二节申报材料编制第（四）项申报报价"
         }
     }
     $evidence$),
    ('gh-hd2024-1-fujian-execution', 'GH-HD2024-1', '福建省', 'local_execution',
     '2024-09-18', '2024-10-12', '2027-10-12',
     '福建10月10日挂网，10月12日起执行。适用于相关公立医疗机构（含驻闽军队医疗机构）。',
     'referenced', '福建省医疗保障局', '福建省医疗保障局关于落实国家组织人工关节集中带量采购协议期满接续采购有关工作的通知',
     'https://ybj.fj.gov.cn/zfxxgkzl/fdzdgknr/qtyzdgkzfxx/202409/t20240918_6523431.htm',
     '闽医保〔2024〕73号，第二节中选结果及执行时间、第三节医疗机构实施范围、第五节明确产品挂网价格',
     $evidence$
     {
         "execution_date_location": "第二节中选结果及执行时间",
         "price_rule_location": "第四节第（二）项签订方式、第五节明确产品挂网价格",
         "applicable_price_basis": "地方附件核实中选资格，按国家正式中选价执行。相关中选产品系统及其部件按含伴随服务费的中选价挂网，医疗机构零差率销售。",
         "attachments": [
             {
                 "title": "福建通知附件：国家组织人工关节集中带量采购协议期满接续采购中选结果",
                 "url": "https://ybj.fj.gov.cn/zfxxgkzl/fdzdgknr/qtyzdgkzfxx/202409/P020240918628974592265.pdf",
                 "sha256": "ccf8ad7007670538de45ffe824f6fbde1cf5e4e5edbd3134f300382b28712fd6",
                 "location": "附件 PDF 中选清单，按申报企业与产品系统类别核对"
             }
         ],
         "referenced_award_event_id": "gh-hd2024-1-award",
         "execution_end_basis": "第二节中选结果及执行时间明确采购周期为三年。止日从执行起日推算，采用不含止日的口径。",
         "pricing_unit_source": {
             "title": "人工关节集中带量采购协议期满接续采购文件（GH-HD2024-1）",
             "url": "https://www.nhsa.gov.cn/module/download/downfile.jsp?classid=0&filename=b7cee42cfccc4c8a8a947ee4891606a0.pdf",
             "location": "正文第24–25页（PDF第26–27页），第二部分第二节申报材料编制第（四）项申报报价"
         }
     }
     $evidence$),
    ('gh-hd2024-1-xizang-renewal-2', 'GH-HD2024-1', '西藏自治区', 'annual_renewal',
     '2026-08-26', '2026-01-01', '2027-01-01',
     '第二年度计算协议量的采购期为2026年1月1日至12月31日，三方协议签订时间为8月29日至9月12日。',
     'not_stated', '西藏自治区医疗保障局', '西藏自治区医疗保障局关于开展国家组织人工关节类医用耗材集中带量采购第二年度协议续签工作的通知',
     'https://ggfw.ylbzj.xizang.gov.cn/webPortal/detail.html?CatalogId=2&infoId=418662', '第二节执行时间、第三节有关事项及要求',
     '{}'),
    ('national-spine-lens-sports-renewal-2026-product-maintenance', 'national-spine-lens-sports-renewal-2026',
     NULL, 'product_information_maintenance', '2026-04-30', '2026-04-30', '2026-05-16',
     '联采办组织企业集中维护产品信息，维护期为2026年4月30日至5月15日。',
     'not_disclosed', '国家组织高值医用耗材联合采购办公室',
     '关于开展骨科脊柱类、人工晶体类及运动医学类医用耗材产品信息集中维护工作的通知',
     'https://hc.tjmpc.cn:10128/public/show14522.html', '第三节维护方式及时间安排',
     '{}'),
    ('national-spine-lens-sports-renewal-2026-product-confirmation', 'national-spine-lens-sports-renewal-2026',
     NULL, 'product_information_confirmation', '2026-10-16', '2026-10-16', '2026-10-24',
     '产品信息确认安排在2026年10月16日至23日。企业间关系确认安排在10月19日至23日。',
     'not_disclosed', '国家组织高值医用耗材联合采购办公室',
     '关于开展骨科脊柱类、人工晶体类及运动医学类医用耗材产品信息确认及企业间关系确认工作的通知',
     'https://hc.tjmpc.cn:10128/public/show14566.html', '第三节产品信息确认、第四节企业间关系确认',
     '{}'),
    ('national-spine-lens-sports-renewal-2026-product-notice', 'national-spine-lens-sports-renewal-2026',
     NULL, 'product_information_notice', '2026-11-10', '2026-11-11', '2026-11-18',
     '联采办发布产品信息公示安排。2026年11月11日至17日，申报企业可登录平台查阅部件公示。该通知未公布正式中选价。',
     'not_disclosed', '国家组织高值医用耗材联合采购办公室',
     '关于开展骨科脊柱类、人工晶体类及运动医学类医用耗材产品信息公示工作的通知',
     'https://hc.tjmpc.cn:10128/public/show14567.html', '第二节产品信息公示',
     '{}');

ALTER TABLE orth_governance.collection_task DROP CONSTRAINT collection_task_row_number_check;
ALTER TABLE orth_governance.collection_task ADD CHECK (row_number >= 2);

-- Both official result formats disclose the 竞价单元 in column C.
CREATE OR REPLACE FUNCTION orth_catalog.hunan_joint_group(original_rows jsonb, source jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT CASE
        WHEN source->>'attachment_format' = 'html'
         AND original_rows #>> '{0,cells,2}' = '竞价单元'
         AND original_rows #>> '{1,number}' = source->>'row_number'
            THEN NULLIF(btrim(original_rows #>> '{1,cells,2}'), '')
        WHEN original_rows #>> '{0,cells,0}' = '国家组织人工关节集中带量采购协议期满接续中选结果'
         AND original_rows #>> '{1,cells,2}' = '竞价单元'
         AND original_rows #>> '{3,number}' = source->>'row_number'
            THEN NULLIF(btrim(original_rows #>> '{3,cells,2}'), '')
    END;
$$;

CREATE VIEW orth_catalog.procurement_price_v1 AS
WITH RECURSIVE direct_execution AS (
    SELECT price.price_id, execution.event_id
    FROM orth_catalog.price_v1 AS price
    JOIN orth_catalog.procurement_event AS execution
      ON execution.event_type = 'local_execution'
     AND execution.round_id = price.round_id AND execution.region = price.region
     AND execution.notice_url = price.source->>'notice_url'
     AND to_char(execution.effective_from, 'YYYY-MM-DD') = price.effective_from
    WHERE execution.price_disclosure <> 'referenced' OR EXISTS (
        SELECT 1 FROM orth_catalog.procurement_event AS award
        WHERE award.event_id = execution.evidence->>'referenced_award_event_id'
          AND award.round_id = execution.round_id AND award.event_type = 'official_award'
          AND award.evidence->'attachments' @> jsonb_build_array(
              jsonb_build_object('url', price.source->>'attachment_url')
          )
    )
), execution_link AS (
    SELECT price_id, event_id FROM direct_execution
    UNION ALL

    -- A formal correction can carry a new notice and start date within the same local policy window.
    SELECT successor.price_id, link.event_id
    FROM execution_link AS link
    JOIN orth_catalog.procurement_event_v1 AS execution USING (event_id)
    JOIN orth_catalog.price_v1 AS successor ON successor.supersedes_price_id = link.price_id
    WHERE successor.round_id = execution.round_id AND successor.region = execution.region
      AND successor.effective_from >= execution.effective_from
      AND (execution.effective_to IS NULL OR successor.effective_from < execution.effective_to)
      AND NOT EXISTS (SELECT 1 FROM direct_execution WHERE price_id = successor.price_id)
), correction_dates AS (
    -- Propagate the earliest start from the latest correction back through its predecessors.
    SELECT latest.price_id, latest.supersedes_price_id, latest.effective_from AS earliest_from
    FROM orth_catalog.price_v1 AS latest
    WHERE latest.supersedes_price_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM orth_catalog.price_v1 AS successor WHERE successor.supersedes_price_id = latest.price_id
      )

    UNION ALL

    SELECT prior.price_id, prior.supersedes_price_id, LEAST(prior.effective_from, trail.earliest_from)
    FROM correction_dates AS trail
    JOIN orth_catalog.price_v1 AS prior ON prior.price_id = trail.supersedes_price_id
    WHERE prior.supersedes_price_id IS NOT NULL
)
SELECT price.price_id, execution.categories, price.region, price.round_id,
       price.effective_from, valid_period.applicable_to,
       to_jsonb(price) - 'product_alias' || jsonb_build_object(
           'superseded_by_price_id', replacement.price_id, 'execution', to_jsonb(execution),
           'applicable_to', valid_period.applicable_to
       ) AS result
FROM orth_catalog.price_search_v1 AS price
JOIN execution_link USING (price_id)
JOIN orth_catalog.procurement_event_v1 AS execution USING (event_id)
LEFT JOIN correction_dates AS replacement ON replacement.supersedes_price_id = price.price_id
CROSS JOIN LATERAL (
    SELECT LEAST(price.effective_to, execution.effective_to, replacement.earliest_from) AS applicable_to
) AS valid_period;

REVOKE ALL ON orth_catalog.procurement_price_v1 FROM PUBLIC;
GRANT SELECT ON orth_catalog.procurement_price_v1 TO orth_application;
