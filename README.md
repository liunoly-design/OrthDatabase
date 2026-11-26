# 骨科集采查价

从官方原始工作簿导入产品系统中选价，在 Web 后台对照原表、确认复核并发布，然后通过用户 Web 和微信小程序共用的公开 API 查价。两套系统共用 [价格发布契约 v1](contracts/price-v1.md) 和 PostgreSQL，使用独立的运行登录。

## 真实样本

原表是湖南省医疗保障局发布的湘医保函〔2024〕48 号附件 1。工作簿标题为《国家组织人工关节集中带量采购协议期满接续中选结果》。`Sheet1` 第 5 行为天津正天医疗器械有限公司，合金-聚乙烯类髋关节产品系统，价格格 `G5` 为 5896。按采购文件 GH-HD2024-1 正文第 24–25 页的产品系统报价规则记录为 **5896.00 元/套**。湖南执行通知明确自 2024-10-15 执行并包含伴随服务费。 [湖南执行通知](https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/t20240919_33458275.html) · [官方原表](https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/33458275/files/0ac80457057341528553dae98aee88b0.xls) · [采购文件](https://ylbzj.qdn.gov.cn/xwzx_500425/tzgg_5823021/202405/P020240501382474157441.pdf)

`samples/hunan-joint-results.xls` 是原表字节快照，SHA-256 记录在同目录清单中。导入器从原表读取所选行的金额、产品系统和申报企业，从清单读取官方链接、地区与执行口径。工作簿按哈希留档，候选与发布状态存在 PostgreSQL。[发布快照](samples/hunan-joint-results.published.json) 提供双方可复用的期望响应值。

## 数据库分权

| PostgreSQL 运行角色 | 授权 |
| --- | --- |
| `orth_governance` | 读取官方信源、采集任务和候选，记录复核结果，读取正式区的 `price_id` 来显示发布状态。兼容手工导入入口沿用此登录，进入与 Worker 相同的采集流程。 |
| `orth_worker` | 登记官方信源和采集任务，读写导入所需候选字段。 |
| `orth_publisher` | 调用 `orth_catalog.publish_price`，在单次事务内将已复核候选写入正式区。 |
| `orth_application` | 只读 `orth_catalog.price_v1`，读写 `orth_app.account`。该表为应用账号区提供独立授权入口。 |

## 本地复现

需要 Node.js 24 和 PostgreSQL。用迁移账号连接开发库，在初始化时创建四个权限组。迁移账号需要建 schema 和角色的权限。升级 Issue #2 的库时，迁移账号还需要拥有原 `public` 模式下的两张表。迁移保留已有候选和已发布记录，用新角色授权替换旧表授权。已有执行日期超出公元 0001 至 9999 年时，迁移会报错并回滚。

```sh
npm ci
export DATABASE_URL='postgresql://localhost/orthdatabase'
npm run migrate
```

上例使用 PostgreSQL 本地默认登录，按实际迁移账号填写 `DATABASE_URL`。再在 `psql` 中用有角色管理权限的账号配置四个独立登录。开发库如有单独的连接权限策略，同时为四个登录授予该库的 `CONNECT`。

```sql
CREATE ROLE orth_governance_login LOGIN IN ROLE orth_governance;
CREATE ROLE orth_worker_login LOGIN IN ROLE orth_worker;
CREATE ROLE orth_publisher_login LOGIN IN ROLE orth_publisher;
CREATE ROLE orth_application_login LOGIN IN ROLE orth_application;
\password orth_governance_login
\password orth_worker_login
\password orth_publisher_login
\password orth_application_login
```

## 独立运行

在不同进程启动以下入口。将示例连接串里的密码替换成实际值并按 URL 规则编码。治理 API 和 Worker 使用同一个绝对留档目录，跨主机部署时将同一存储挂载给这两个进程。

治理 API 使用治理和发布两个数据库登录。运营账号在这个进程中配置，复核和发布以该运营用户名留痕。

```sh
export ORTH_GOVERNANCE_DATABASE_URL='postgresql://orth_governance_login:PASSWORD@localhost/orthdatabase'
export ORTH_PUBLISHER_DATABASE_URL='postgresql://orth_publisher_login:PASSWORD@localhost/orthdatabase'
export ORTH_OPERATOR_USER='reviewer'
export ORTH_OPERATOR_PASSWORD='填写运营账号密码'
export ORTH_DATA_DIR="$PWD/.orth-data"
npm run start:governance
```

运营 Web 把登录请求和操作交给治理 API，使用服务端配置的 API 地址。浏览器在 HTTP Basic 登录提示中输入运营用户名和密码。两个服务默认绑定回环地址。跨主机通信和对外入口应使用 HTTPS，治理 API 应部署在受限网络。

```sh
ORTH_GOVERNANCE_API_URL='http://127.0.0.1:3001/api/governance/v1' ORTH_APPLICATION_API_ORIGIN='http://127.0.0.1:3000' npm run start:operations
```

`ORTH_APPLICATION_API_ORIGIN` 用于在已发布候选上显示公开查价链接，可省略。治理 API 提供 `/api/governance/v1/sources`、`/tasks`、`/candidates` 和候选的附件、复核、发布路由。

采集 Worker 每次运行处理一份清单指定的 Excel 明细位置。省略工作簿路径时从清单的官方附件地址下载；离线回放时可在命令末尾加上 `samples/hunan-joint-results.xls`。两种模式都核对清单中的 SHA-256。每次运行都有独立任务记录，重复导入复用原价格编码。Worker 异常退出后，运营端会标记中断的任务；重新执行会生成新任务。可从外部调度器定时执行同一入口。

```sh
export ORTH_WORKER_DATABASE_URL='postgresql://orth_worker_login:PASSWORD@localhost/orthdatabase'
export ORTH_DATA_DIR="$PWD/.orth-data"
npm run start:worker -- samples/hunan-joint-results.json
```

### 数据应用系统

应用服务同时提供访客 Web 和查询 API，使用自己的数据库登录。该登录在 `orth_app` 维护应用数据，从 `orth_catalog.price_v1` 读取已发布价格。应用默认监听 `127.0.0.1:3000`，治理 API 和采集 Worker 暂停时仍可查到最后一次发布的价格。

```sh
ORTH_APPLICATION_DATABASE_URL='postgresql://orth_application_login:PASSWORD@localhost/orthdatabase' npm run start:application
```

## 联调查价

1. 打开 `http://127.0.0.1:3002/ops`，登录后查看「官方信源」「采集任务」和「价格复核」。从任务打开候选，核对公告、官方原表、留档文件和高亮价格格。
2. 点击「确认复核」，再点击「发布价格」。
3. 执行下方公开查询。导入后及已复核未发布时返回 `404`，发布后返回 `200`。金额是十进制字符串，`source` 提供公告、原表、SHA-256、工作表、行号和价格格。

```sh
curl -i http://127.0.0.1:3000/api/v1/prices/aj_8ccf6bc8657afcaaa14a3a3e901056fc
```

- Web 打开 `http://127.0.0.1:3000/` 输入价格编码，或直接打开 `http://127.0.0.1:3000/prices/aj_8ccf6bc8657afcaaa14a3a3e901056fc`。详情提供湖南执行公告、官方原表和原表价格格。
- 微信开发者工具导入仓库根目录。启动页可输入价格编码，或用自定义编译条件打开 `pages/price/index?price_id=aj_8ccf6bc8657afcaaa14a3a3e901056fc`。详情可分享同一价格编码，查看 `Sheet1 · 第 5 行 · G5` 并复制两个官方链接。
- 小程序游客配置默认连接 `http://127.0.0.1:3000`。接入真机或发布时，在 `miniprogram/app.js` 配置应用服务的 HTTPS 地址，并设置小程序请求合法域名。Web 和小程序共用 `GET /api/v1/prices/{price_id}`。

## 构建与部署

| 独立构建 | 生成的 Node.js 24 入口 | 默认监听 |
| --- | --- | --- |
| `npm run build:governance` | `node dist/governance/start-governance.js` | `127.0.0.1:3001` |
| `npm run build:operations` | `node dist/operations/start-operations.js` | `127.0.0.1:3002` |
| `npm run build:worker` | `node dist/worker/start-worker.js <manifest.json> [workbook.xls]` | 单次任务 |

部署时分发对应的输出目录和根目录的 npm 清单及锁文件，执行 `npm ci --omit=dev` 安装运行依赖。HTTP 服务的监听地址和端口可用 `HOST` 和 `PORT` 配置。数据库迁移在部署前单独执行一次。

数据应用系统可用 Node.js 24 执行 `npm run start:application`。分发 `src/application`、其导入的服务端文件与 npm 清单及锁文件，`src/application` 下的页面和静态资源保持原目录结构。

## 验证

```sh
export TEST_DATABASE_URL='postgresql://localhost/postgres'
npm run test:governance-api
npm run test:worker
npm run test:governance
npm test
npm run typecheck
```

请使用开发或测试 PostgreSQL 实例。测试账号需要建库和管理角色的权限。测试为每个用例创建临时数据库及独立登录，用运行角色直接检查数据库权限，通过导入命令、后台 HTTP 操作及公开查询 API 验证发布可见性。临时数据库与运行登录在用例结束后清理。测试独立启动应用进程，并在关闭治理服务后通过应用 API 复验最后一次发布。Web 测试提交实际页面表单、执行浏览器脚本并检查官方链接。小程序模拟测试加载实际页面脚本与 WXML，经同一 API 验证分享路径和两个出处按钮。
