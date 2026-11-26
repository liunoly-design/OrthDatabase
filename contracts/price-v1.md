# 价格发布契约 v1

采集治理系统复核后发布价格。数据应用系统使用应用运行角色读取 PostgreSQL 视图 `orth_catalog.price_v1`。免登录的 `GET /api/v1/prices/{price_id}` 返回同形 JSON。未导入、待复核、已复核未发布的编码均返回 `404` 和 `{"error":"price_not_found"}`。事务提交后才返回 `200`。当前导入器支持人工关节接续采购的产品系统中选价附件。响应字段类型见 [price-v1.d.ts](price-v1.d.ts)。

## 标识与计价

| 字段 | 含义 |
| --- | --- |
| `price_id` | 一条明确价格事实的稳定编码，用于查询和分享。现有导入器按公告 URL、附件 URL、文件 SHA-256、表名及明细行号生成 `aj_` 编码。原封重导及重试发布复用原编码；同一来源位置出现计价或适用数据冲突时，导入失败并保留原记录。 |
| `round_id` | 采购轮次标识。轮次未核实时为 `null`。样本使用官方采购文件编号 `GH-HD2024-1`。独立适用范围或生效时期的不同价格事实各有价格编码。 |
| `subject_kind`、`product_system`、`applicant` | 计价对象区分独立品规 `product_spec`、具体套件 `kit` 和套件类别 `kit_category`。样本按原表披露的产品系统类别和申报企业计价，类别与申报企业保留原文。 |
| `product_spec_id`、`kit_version_id` | 分别引用已核验的独立品规和具体套件版本。原表该行披露到企业和产品系统类别，两个引用均为 `null`。按具体品规或具体套件版本计价时，两个引用只填其一。 |
| `price_type`、`amount`、`currency`、`unit` | 样本为正式中选价。金额在 PostgreSQL 中以 `numeric(12,2)` 保存，在视图和 JSON 中以两位小数的十进制字符串传递。币种为 `CNY`，单位为 `元/套`。 |
| `pack_quantity`、`service_fee_basis` | 分别表示来源核实的包装内数量和伴随服务费口径。样本包装数量未核实，填 `null`。湖南执行通知明确含伴随服务费。 |

## 适用范围与证据

| 字段 | 含义 |
| --- | --- |
| `region`、`hospital_id` | 湖南省执行口径来自当地执行通知。`hospital_id: null` 表示这条记录没有单独指定某一家医院。具体机构范围和条件以通知正文为准。 |
| `effective_from`、`effective_to` | 价格适用日期以公元 0001 至 9999 年的 `YYYY-MM-DD` 传递。起日含、止日不含。日期未核实时为 `null`。样本于 `2024-10-15` 开始执行。通知描述三年采购周期和年度签约，价格记录的确切结束日留空。 |
| `source` | `publisher`、`notice_title`、`notice_url` 指向执行公告及其发文方；`attachment_title`、`attachment_url` 指向正式中选原表；`sha256` 锁定附件字节版本；`sheet_name`、`row_number`、`price_cell` 定位 Excel 明细行和计价格。行号从 1 开始。 |

## 状态与版本

- `record_status: "published"` 表示已复核并在正式区发布。治理区记录「待复核」「已复核」状态，发布后运营端显示「已发布」。业务日期由 `effective_from` 和 `effective_to` 表达。
- `contract_version: 1` 标识响应契约版本，与数据库视图及 API 的 `v1` 对应。每条价格事实的 `record_version` 从 1 起算。`published_at` 是系统首次发布时间，以带毫秒的 UTC ISO 8601 字符串传递。迁移和重复发布保留首次发布时间。
- `supersedes_price_id: null` 表示样本无前序价格。官方调价或实质更正应产生新价格编码，并指向上一条价格。同一价格事实增加已核验的证据时沿用价格编码，通过记录版本区分。当前发布入口只支持首次发布及幂等重试。

## 共享回归样本

治理端使用原表与导入清单，应用端使用发布快照检查字段和值。`published_at` 在数据库发布时生成。 [原表](../samples/hunan-joint-results.xls) · [导入清单](../samples/hunan-joint-results.json) · [发布快照](../samples/hunan-joint-results.published.json)

样本来自湘医保函〔2024〕48 号附件 1 的 `Sheet1!G5`，为天津正天医疗器械有限公司的合金-聚乙烯类髋关节产品系统，金额 **5896.00 元/套**，价格编码 `aj_8ccf6bc8657afcaaa14a3a3e901056fc`。 [湖南省医保局执行通知](https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/t20240919_33458275.html) · [官方原表](https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/33458275/files/0ac80457057341528553dae98aee88b0.xls)
