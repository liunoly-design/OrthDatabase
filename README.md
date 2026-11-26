# 骨科集采查价

[Issue #2](https://github.com/liunoly-design/OrthDatabase/issues/2) 的可运行切片。从官方原始工作簿导入一个产品系统的正式中选价，在 Web 后台对照原表、确认复核并发布，然后通过公开 API 和微信小程序查价。

## 真实样本

原表是湖南省医疗保障局发布的湘医保函〔2024〕48 号附件 1。工作簿标题为《国家组织人工关节集中带量采购协议期满接续中选结果》。`Sheet1` 第 5 行为天津正天医疗器械有限公司，合金-聚乙烯类髋关节产品系统，价格格 `G5` 为 5896。按采购文件 GH-HD2024-1 正文第 24–25 页的产品系统报价规则记录为 **5896.00 元/套**。湖南执行通知明确自 2024-10-15 执行并包含伴随服务费。 [湖南执行通知](https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/t20240919_33458275.html) · [官方原表](https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/33458275/files/0ac80457057341528553dae98aee88b0.xls) · [采购文件](https://ylbzj.qdn.gov.cn/xwzx_500425/tzgg_5823021/202405/P020240501382474157441.pdf)

`samples/hunan-joint-results.xls` 是原表字节快照，SHA-256 记录在同目录清单中。导入器从原表读取所选行的金额、产品系统和申报企业，从清单读取官方链接、地区与执行口径。工作簿按哈希留档，候选与发布状态存在 PostgreSQL。样本适配本附件的产品系统中选价表头。

## 本地复现

需要 Node.js 24 和 PostgreSQL。在空的开发库中运行以下命令，按本地配置设置数据库连接和复核人员账号。

```sh
npm ci
export DATABASE_URL='postgresql://localhost/orthdatabase'
export ORTH_OPERATOR_USER='reviewer'
export ORTH_OPERATOR_PASSWORD='填写本地密码'
npm run migrate
npm run import:price -- samples/hunan-joint-results.json samples/hunan-joint-results.xls
npm start
```

默认监听 `127.0.0.1:3000`，原表留档目录为 `.orth-data/`，可通过 `ORTH_DATA_DIR` 修改。导入输出 `aj_8ccf6bc8657afcaaa14a3a3e901056fc`。重复导入相同来源、文件版本和行号时复用这个编码。

1. 打开 `http://127.0.0.1:3000/ops`，用配置的账号登录。点击候选后可看到原表表头、所选行和价格格，也可下载字节一致的留档工作簿。
2. 点击「确认复核」，再点击「发布价格」。
3. 执行下方公开查询。导入后及已复核未发布时返回 `404`，发布后返回 `200`。金额是十进制字符串，`source` 提供公告、原表、SHA-256、工作表、行号和价格格。

```sh
curl -i http://127.0.0.1:3000/api/v1/prices/aj_8ccf6bc8657afcaaa14a3a3e901056fc
```

在微信开发者工具导入仓库根目录。启动页支持输入价格编码，也可用自定义编译条件打开 `pages/price/index?price_id=aj_8ccf6bc8657afcaaa14a3a3e901056fc`。详情显示计价单位和 `Sheet1 · 第 5 行 · G5`，并可复制官方公告链接和原表下载链接。仓库中的游客配置连接本地 API。接入真机或发布时，在 `miniprogram/app.js` 配置实际 HTTPS API 地址并设置小程序请求合法域名。

## 验证

```sh
TEST_DATABASE_URL='postgresql://localhost/orthdatabase_test' npm test
npm run typecheck
```

测试账号需要能在测试数据库创建临时模式。测试通过导入命令及后台 HTTP 操作准备数据，再通过公开 API 验证发布可见性。小程序模拟测试加载实际页面脚本与 WXML，通过同一个运行中的查询 API 取价并验证两个出处按钮。
