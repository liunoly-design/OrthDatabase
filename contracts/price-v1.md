# 价格发布契约 v1

采集治理系统复核后发布价格。数据应用系统使用应用运行角色读取 PostgreSQL 视图 `orth_catalog.price_v1`。免登录的 `GET /api/v1/prices/{price_id}` 返回同形 JSON。未导入、待复核、已复核未发布的编码均返回 `404` 和 `{"error":"price_not_found"}`。事务提交后才返回 `200`。当前导入器支持人工关节接续采购的产品系统中选价附件。响应字段类型见 [price-v1.d.ts](price-v1.d.ts)。

## 标识与计价

| 字段 | 含义 |
| --- | --- |
| `price_id` | 一条明确价格事实的稳定编码，用于查询和分享。现有导入器按公告 URL、附件 URL、文件 SHA-256、表名及明细行号生成 `aj_` 编码。原封重导及重试发布复用原编码。同一来源位置或同一计价范围出现冲突时，采集任务留存原记录和本次观察的金额与来源坐标。 |
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
- `supersedes_price_id: null` 表示样本无前序价格。官方调价或实质更正应产生新价格编码，并指向上一条价格。同一价格事实增加已核验的证据时沿用价格编码，通过记录版本区分。平台误录纠错也沿用该价格编码，并在版本历史保留旧的误录快照。官方更正后的新价格仍从版本 1 开始，原编码可查。

## 已发布证据与版本历史

免登录的 `GET /api/v1/prices/{price_id}/evidence` 与只读视图 `orth_catalog.price_evidence_v1` 同形，返回下列字段。原价格详情的字段与结构沿用 v1。尚未发布的价格编码在两个接口都返回 `404`。

| 字段 | 含义 |
| --- | --- |
| `contract_version`、`price_id` | 契约版本 1 及这条价格的稳定编码。 |
| `superseded_by_price_id` | 有正式更正时指向后继价格。其他情况下为 `null`。 |
| `current_governance` | 当前有效的已发布治理证据，按版本由近到远排列。平台纠错提交替换包时，用该包和其后的追加证据构成当前证据。 |
| `revisions` | 版本降序。每项有 `record_version`、操作 `operation`、变更理由 `reason`、本次证据来源 `source`、当时的公开价格快照 `price` 和本次发布时间 `published_at`。 |
| `revisions[].governance` | 可空。含类别组成 `category_composition`、补充清单中选定的同类别中选系统示例 `related_system`、逐项标识关联 `identifier_links` 及待查说明 `unresolved`。组成和标识都带证据定位。附件可按 SHA-256 和表、行、单元格核对，政策文件可按章节或 PDF 文件页码核对。 |

- `initial` 首次正式发布。旧版本迁移时保留原快照和首次发布时间，已有记录也能读取原价格证据。
- `additional_evidence` 在同一价格事实下新增证据。该版本的 `source` 是本次提交的证据来源。价格快照的主 `source` 仍指向原价出处。
- `official_correction` 根据有出处的正式变更发布新编码，价格快照的 `supersedes_price_id` 记录原编码。
- `platform_correction` 在同一价格编码下更新当前快照。更正之前的快照用于解释误录历史，当前价格以详情接口为准。

变更提交时须指明目标版本并经运营复核。发现目标版本已变化、目标已有正式后继或证据与操作条件冲突时返回 `409`。采集失败及运营身份只在治理端查询。

## 公开搜索

免登录的 `GET /api/v1/prices` 读取正式区视图 `orth_catalog.price_search_v1`。可选参数 `q` 在产品名称、检索别名或申报企业名称中匹配字面子串，去掉首尾空白并忽略英文大小写，也可以精确匹配价格编码。人工关节接续的四个产品系统类别有按官方名称和材料组合整理的检索别名，例如「合金对聚乙烯髋关节」。详情继续使用 `GET /api/v1/prices/{price_id}`。

| 参数 | 匹配规则 |
| --- | --- |
| `round_id`、`published_group`、`price_type`、`unit` | 精确匹配采购轮次、已公布分组、价格类型和计价单位。湖南样本的分组取自原表「竞价单元」列。 |
| `pack_quantity` | 精确匹配包装内数量，传正整数或 `unknown`（原记录为 `null`）。 |
| `product_spec_id`、`kit_version_id`、`region` | 通过详情继续按已核验的品规、套件版本或地区精确查询。 |
| `product_system` | 按名称精确查询同一产品系统类别的套价。 |
| `after` | 加载下一页时传入上次返回的 `next_cursor`，其余查询条件保持一致。 |

不同条件取交集。响应的 `prices` 按 `price_id` 升序返回至多 30 项，每项沿用详情字段并补充 `published_group`（未公布时为 `null`）和 `superseded_by_price_id`（无正式后继时为 `null`）。小程序详情请求可用 `?include_correction=1` 取得同一后继字段，旧分享仍打开原价格。默认详情响应沿用原 v1 字段。`filters` 给出全站已发布记录的五类标签值，即使当前条件命中为空也返回。包装内数量的 `null` 可选，未知的轮次和分组不生成标签。`next_cursor` 为 `null` 时已到末页。已知参数的格式无效时返回 `400` 和 `{"error":"invalid_price_search"}`。

## 共享回归样本

治理端使用原表与导入清单，应用端使用发布快照检查字段和值。`published_at` 在数据库发布时生成。 [原表](../samples/hunan-joint-results.xls) · [导入清单](../samples/hunan-joint-results.json) · [发布快照](../samples/hunan-joint-results.published.json)

样本来自湘医保函〔2024〕48 号附件 1 的 `Sheet1!G5`，为天津正天医疗器械有限公司的合金-聚乙烯类髋关节产品系统，金额 **5896.00 元/套**，价格编码 `aj_8ccf6bc8657afcaaa14a3a3e901056fc`。 [湖南省医保局执行通知](https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/t20240919_33458275.html) · [官方原表](https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/33458275/files/0ac80457057341528553dae98aee88b0.xls)
