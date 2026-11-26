# 品规追溯 v1

数据应用系统开放免登录查询。字段类型见 [specification-v1.d.ts](specification-v1.d.ts)。既有 `/api/v1/prices` 继续提供原价格和修订证据。本契约的 `sp_` 品规价和 `cp_` 部件价使用本页的独立详情入口。

## 公开查询

`GET /api/v1/specifications/lookup?scheme=udi_di&value=06921814258644`

| scheme | 匹配依据 | 可查粒度 |
| --- | --- | --- |
| `registration_number` | 现证、旧证各自留原编号和依据。同证续期可记录多个证照版本和各自有效期 | 证号可覆盖多个品规。沿官方部件编号关联的证号带 `via_component`，指向同一结果内的部件标识 |
| `nhsa_27` | 完整 27 位医保医用耗材代码，C 加 26 位数字 | 医保招采规格型号。价格各自保留包装数量和计价单位 |
| `udi_di` | 已人工核验的器械产品标识，按原值输入并保留前导零 | 型号、规格及相应包装。包装描述、已知件数和核验证据随标识返回 |
| `platform_component_code` | 平台或采购轮次的部件编号，必须同时传 `namespace` | 一个部件可覆盖多个规格。系统编码、部件编码、规格型号编号和 GOODS_ID 分别保留来源语义 |

查询按类型和完整值匹配。返回 `matched`、`ambiguous`、`component_only` 或 `unverified`。只有部件级证号证据时，品规线索位于 `component_matches`。多条直接匹配或同一 DI 出现不同包装断言时返回 `ambiguous`。每页至多 30 个品规，按直接匹配、部件线索、实物联查的顺序返回。后续页使用 `after=next_cursor` 并保持同一查询条件。整体匹配状态跨页一致。

每条结果包含命中的标识和证据、该品规的其它已发布标识、品规价 `prices` 和沿部件编号关联的 `component_prices`。品规价先列原文直接披露该标识的记录，再按已知生效日从近到远排列。原文证号、证照版本、时段、地区、医院、采购轮次和证据随价格保留。深圳附件披露的 20 位医保码存入部件价格的 `source_nhsa_20`，保留与原采购记录的对应关系。

传 `include_related=1` 展开一层已经人工复核并发布的同一实物关联，证据随各结果的 `relations` 返回。经不同证照分别登记的品规保留各自的 ID、证照、原价和适用范围。撤销发布后，公开联查移除该关联，治理候选保留审核记录和撤销原因。现证与旧证若已在同一登记品规的证据中核对，可以记录在该品规下。

UDI 查询接收已经从载体解析出来的 DI。品规价的 `packaging_match` 为 `matched` 时，原价依据明确披露所命中的 DI。两边的件数均明确且不同时返回 `other`。其余包装对应关系为 `unverified`。部件价采用部件原表口径。不同发码规则下的载体解析和真机验收属于 #9。

`GET /api/v1/specifications/prices/:priceId` 返回单条已发布的价格、计价对象 `subject_kind` 和原始依据。价格有效期、证照有效期及政策所述采购周期各自按对应来源记录。缺失的日期、部件计价单位和包装数量可为 `null`。`effective_to_basis` 区分明确截止日、明确无截止日及未披露。`effective_to` 保留原文所含的截止日，`effective_to_exclusive` 提供归一化的不含止日上界，可附 `effective_date_text` 对照原文。结果的 `published_price_links` 可按原有 `aj_` 编码返回既有价格引用。对于官方供应表只证明相关套件示例的情况，用 `category_award_example` 标明原套件类别价的口径，并返回部件来源坐标。原记录通过 `/api/v1/prices/:priceId` 查询。

## 治理发布

独立治理 API 在 `/api/governance/v1/specification-candidates` 提供候选列表、提交和复核发布，沿用运营 Basic 认证。

- `POST /` 提交一个 JSON 对象，返回稳定的 `candidate_id`。候选类型为 `specification`、`component_price`、`same_physical` 或 `revoke`。
- `GET /:candidateId` 对照候选正文、证据和 `unresolved` 复核。仅外形相近、型号文字相同或只有证照层信息的映射，可在 `unresolved` 附上待核线索。
- `POST /:candidateId/review` 完成人工复核，`POST /:candidateId/publish` 事务发布。价格的原始标识只填写原文披露且已核对的标识版本。证据冲突、引用缺失和未审核的候选返回 HTTP 409。原价格事实及标识一致、仅补充证据时复用原编码。同口径已知有效期重叠的记录，或在已发布证据中引用相同原表金额单元格的同品规价格，进入冲突复核。表格证据可用 `price_cell` 指明金额单元格。仅定位到 PDF 页的证据可同时支持该页明确披露的多个计价口径。显式提供 `published_price_references` 时，发布会核对既有价格和现行治理证据。对于套件类别价，需提供同一品规的 `component_identifier_id`，与当前已发布套件示例的部件编号和采购轮次一致。
- 撤销同一实物关联时提交 `{ "kind": "revoke", "relation_id": "...", "reason": "..." }`，按相同步骤复核并发布。之后重新建立关系需提出使用新关系 ID 的候选。

## 湖北与深圳真实验收

[候选样本](../samples/joint-specification-trace.official.json) 可逐项提交到隔离测试库，包含一个部件的五条规格和两条部件价格。系统、部件、品规和包装粒度分别用各自的证据表示。

| 官方凭据 | 查看位置 | 核对结果 |
| --- | --- | --- |
| [湖北供应清单公告](https://hbyxjzcg.cn/work/show25003.html) · [20241115 版供应清单](https://hbyxjzcg.cn/upload/202412/24/202412241015272073.xlsx) | `系统表!B9734,K9734,Q9734,R9734,Z9734,AA9734`、`产品表!C5840,D5840,G5840,H5840,I5840` | 系统 `GH0101003129` 的股骨柄-2。部件号 `cc20e421-0a13-11ea-99e3-fa163e0a8baf`，当前列证号 `国械注准20173130995`，旧版列证号 `国械注准20173460995`，中选部件价 2,600 元。 |
| 同上 | `规格型号表!A99456,B99456,F99456,N99456,O99456,P99456,Q99456` | 通过相同部件编号核对天津正天 GB-6、125mm、医保码 `C03440210701011018840000653`、UDI 记录和现证。规格型号表另有该部件的 148、150、152 和 154mm 规格。 |
| [国家药监局 UDI 详情 · 125mm](https://udi.nmpa.gov.cn/showDetailCX.html?deviceRecordKey=13cb40c7-1482-48c6-b89d-fc4d92346250) · [154mm](https://udi.nmpa.gov.cn/showDetailCX.html?deviceRecordKey=5fe74b47-ef2d-4fd8-9335-974595d327bf) | 产品标识基本信息 | DI `06921814258644` 和 `06921814268520` 分别核对到 GB-6 的 125mm 和 154mm，注册人、现证均与湖北表一致，两个最小销售单元均含 1 件。 |
| [湖北接续执行通知](https://hbyxjzcg.cn/upload/202410/12/202410121724149435.pdf) | 第 3–4 页 | 湖北执行范围、中选部件可单独采购、接续采购周期。供应表的 2,600 元在部件列，包装数量及该条部件价的独立生效期留空。 |
| [深圳首轮第二年通知](https://hsa.sz.gov.cn/szsylbzjwzgkml/szsylbzjwzgkml/qt/tzgg/content/post_10729567.html) · [官方目录](https://hsa.sz.gov.cn/attachment/1/1337/1337924/10729567.xlsx) | 通知第二、三项；`关节产品目录表（包含初次、翻修、肿瘤用等）!D5885,K5885,L5885,S5885,U5885,V5885`；`部件规格型号表!A172109,B172109,D172109,Q172109,R172109,U172109` | 相同部件编号和规格型号编号、GB-6 125mm 及 DI。部件中选价为 2,600 元，适用深圳市，采购执行期为 2023-08-01 至 2024-07-31。 |

湖北表的旧证列和品规子表支持沿同一部件回查湖北接续与深圳首轮第二年的中选部件价。深圳原表的旧 20 位码与旧流水号在 `部件规格型号表!H172109,P172109`，同一组合也出现在 `G112940,O112940` 的有领型未中选件。该组合待核，未发布为旧 27 位码映射。该样本保留五条候选品规和两条核验到包装的 DI。证照原件、精确有效期、其它三条 DI 的包装详情、旧证时期独立发布的同规格单价及该医保码在国家目录中的当前状态仍待核实。该条医保码的核对依据为湖北招采原表，国家药监局该 DI 详情的医保码栏为空。 [国家医保局编码入口](https://code.nhsa.gov.cn/search.html?sysflag=1370) · [国家药监局 UDI 规则解读](https://udi.nmpa.gov.cn/toDetail.html?CatalogId=2&infoId=43)

## 国家药监局新旧证与编码真实验收

[药监局候选样本](../samples/nmpa-dual-certificate-udi.json) 记录山西奥瑞同一 DI `06930416802339` 的骨粉，粒径 0.05–1.0mm、0.25g。公开历史 JSON 第 1 版只列 `国械注准20163460428`，第 2 版加入 `国械注准20163130428`，两版同日公开，DI、型号、规格与注册人一致。现行详情列出两证和两个 27 位码 `C03470210900000100520000049`、`C03470210900000100520001618`，GS1 最小销售单元为 1。历史页的 20 位码为旧编码口径。证书有效期和该品规价格待核。 [仅旧证的版本 1](https://udi.nmpa.gov.cn/toDownHis.html?deviceHistoryKey=4679728545A4C72C049BAAB4A67B8142&type=2) · [并列两证的版本 2](https://udi.nmpa.gov.cn/toDownHis.html?deviceHistoryKey=AD63797CEC53A51E04X38A30787C4FF&type=2) · [现行 UDI 详情](https://udi.nmpa.gov.cn/showDetailCX.html?deviceRecordKey=27FEFF79846A1CD99863DC7F5ADF68F0)

同号续期、同医保码不同包装、两项独立登记关系的人工复核与撤销，另用契约演练数据验证。专项测试默认回放已核对的官方候选。提供下载的湖北和深圳工作簿及药监局历史版本（以 `nmpa-dual-v1.json`、`nmpa-dual-v2.json` 命名）可以复验官方字节 SHA-256 和原文定位。

```sh
TEST_DATABASE_URL=postgresql://localhost/postgres \
  ORTH_TEST_SUPPLY_WORKBOOK=/path/to/official-supply.xlsx \
  ORTH_TEST_SHENZHEN_WORKBOOK=/path/to/shenzhen-catalog.xlsx \
  ORTH_TEST_NMPA_HISTORY_DIR=/path/to/nmpa-downloads \
  node --test test/specification-trace.test.ts
```
