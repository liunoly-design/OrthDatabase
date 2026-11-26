# 政策与执行价查询契约 v1

访客 Web 使用 `/procurement`。免登录 API 为 `GET /api/v1/procurement`，只读正式区的 `orth_catalog.procurement_event_v1` 和 `orth_catalog.procurement_price_v1`。响应字段见 [procurement-v1.d.ts](procurement-v1.d.ts)。原查价接口继续提供价格详情、分享编码和版本证据。

## 查询条件

| 参数 | 口径 |
| --- | --- |
| `category` | 按公开品类名称精确匹配，如 `人工关节`、`骨科脊柱` 或 `运动医学`。联合采购轮次可按任一所属品类命中。 |
| `region` | 按结果中展示的地区全称精确匹配，如 `湖南省`。政策同时返回国家层面的轮次节点，其 `region` 为 `null`。执行价只返回所选地区的正式记录。 |
| `round_id` | 按轮次编码精确匹配，如 `GH-HD2024-1`。未取得官方编号的轮次使用稳定的本地编码，原公示标题同时返回。 |
| `date` | 可选公历日期 `YYYY-MM-DD`。政策返回截至该日已公开的节点，包括已公开的后续计划。价格按当地执行窗口匹配，含起日、不含止日。已发布的追溯执行价格从其执行日起可查。省略日期可查看已发布的历史窗口。 |
| `after` | 价格分页游标。每次最多 30 条，后续请求沿用原筛选并传入上页的 `next_price_cursor`。政策节点每页都返回。 |

空参数视为省略。无效日期或重复筛选参数返回 HTTP `400` 和 `{"error":"invalid_procurement_search"}`。

## 结果与证据

- `events` 按公告公开日降序返回。节点包括申报 `submission`、正式中选 `official_award`、年度续签 `annual_renewal`、地方执行 `local_execution`、产品信息维护 `product_information_maintenance`、产品信息及企业关系确认 `product_information_confirmation`、产品信息公示 `product_information_notice`。年度续签保留原轮次标识。
- `announced_on` 是公告公开日。`effective_from` 和 `effective_to` 是相应节点的起止日，例如申报日、年度协议量周期或地方执行期。截止到某日结束的公开时间按排他止日传递。由官方周期与执行起日推算的止日在 `evidence.execution_end_basis` 说明依据。
- `price_disclosure` 描述该节点的公开证据。 `disclosed` 表示该政策来源及附件披露金额，`referenced` 表示当地采用引用的正式结果，`not_disclosed` 表示该阶段公告未披露正式中选价，`not_stated` 表示文件未说明价格披露情况。每条事件带发布方、原文链接和段落定位。
- `prices` 复用 v1 的正式价格记录与搜索字段。 `execution` 带该条价格独立的地区、执行日、公告出处和适用范围。价格的 `source` 带金额出处及原表坐标。地方引用国家结果时，可同时核对 `execution.evidence.referenced_award_event_id`、地方执行原文和国家金额原表。`source.local_award_reference` 按该价格的企业和产品系统类别提供地方资格附件的具体页码与序号。
- `applicable_to` 是本查询已知的最早排他止日，依据价格记录、同一地方执行政策的止日或正式更正链中最早的后继生效日。价格自身的 `effective_to` 沿用 v1 价格契约。两者均可为空。更正追溯到某条价格的起日或更早时，该条价格无适用日期，仍可通过原编码核对其历史记录。当前数据覆盖以发布区记录为准。

迁移 `007-procurement-events.sql` 发布已核查的政策节点。价格继续通过采集、复核和发布入库。首次关联核对采购轮次、地区、生效起日和地方执行公告 URL。引用国家结果的地方价格须匹配所引用的正式结果出处。正式更正如有自己的地方执行依据，优先使用该依据。地区和轮次相同且起日在原执行期内的后继价格，可沿已发布的更正关系继承原地方执行依据。金额和新日期的更正出处仍由该价格记录单独提供。
