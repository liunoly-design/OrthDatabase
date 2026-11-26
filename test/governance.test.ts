import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { createApp } from "../src/app.ts";
import { checkMiniPricePage } from "./mini-preview.ts";
import { testDatabase } from "./postgres.ts";
import { checkWebPricePage } from "./web-price-preview.ts";

const operator = { ORTH_OPERATOR_USER: "reviewer", ORTH_OPERATOR_PASSWORD: "test-secret" };
const authorization = "Basic " + Buffer.from("reviewer:test-secret").toString("base64");

async function start(entry: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [entry], {
    env: { HOST: "127.0.0.1", PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = once(child, "exit");
  const stop = async () => {
    child.kill("SIGTERM");
    await exited;
  };

  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  try {
    const url = await Promise.race([
      (async () => {
        let stdout = "";
        for await (const chunk of child.stdout.setEncoding("utf8")) {
          stdout += chunk;
          const match = /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(stdout);
          if (match) return match[1];
        }
        throw new Error(`${entry} did not start: ${stderr}`);
      })(),
      exited.then(() => { throw new Error(`${entry} exited: ${stderr}`); })
    ]);
    return { url, stop, [Symbol.asyncDispose]: stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test("独立治理 API 使用运营身份，并拒绝应用身份与公开查询路由", { timeout: 15_000 }, async (t) => {
  const database = await testDatabase(t);
  await database.migrate();
  const governance = await database.login("orth_governance");
  const publisher = await database.login("orth_publisher");
  const application = await database.login("orth_application");
  await using api = await start("src/start-governance.ts", {
    ...operator,
    ORTH_GOVERNANCE_DATABASE_URL: governance.url,
    ORTH_PUBLISHER_DATABASE_URL: publisher.url
  });

  const endpoint = api.url + "/api/governance/v1/candidates";
  assert.equal((await fetch(endpoint)).status, 401);
  const appCredentials = Buffer.from(`${application.name}:${new URL(application.url).password}`).toString("base64");
  assert.equal((await fetch(endpoint, { headers: { authorization: "Basic " + appCredentials } })).status, 401);
  const response = await fetch(endpoint, { headers: { authorization } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.equal((await fetch(api.url + "/api/v1/prices/test")).status, 404);
});

const exec = promisify(execFile);
const manifest = "samples/hunan-joint-results.json";
const workbook = "samples/hunan-joint-results.xls";
const priceId = "aj_8ccf6bc8657afcaaa14a3a3e901056fc";
const apiPath = "/api/governance/v1";
const workRoot = ".orth-data";

async function workspace(t: import("node:test").TestContext) {
  await mkdir(workRoot, { recursive: true });
  const dir = await mkdtemp(join(workRoot, "governance-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("采集 Worker 留下真实信源及任务记录，只有发布后的候选进入 v1 查询", { timeout: 20_000 }, async (t) => {
  const database = await testDatabase(t);
  const dataDir = await workspace(t);
  await database.migrate();
  const worker = await database.login("orth_worker");
  const governance = await database.login("orth_governance");
  const publisher = await database.login("orth_publisher");
  const application = await database.login("orth_application");
  const runWorker = (attachment = workbook) => exec(process.execPath, ["src/start-worker.ts", manifest, attachment], {
    env: { ORTH_WORKER_DATABASE_URL: worker.url, ORTH_DATA_DIR: dataDir }
  });

  const { stdout } = await runWorker();
  const first = JSON.parse(stdout);
  assert.equal(first.price_id, priceId);
  const replay = JSON.parse((await runWorker()).stdout);
  assert.equal(replay.price_id, priceId);
  assert.notEqual(replay.task_id, first.task_id);

  const invalid = join(dataDir, "different.xls");
  await writeFile(invalid, "different workbook bytes");
  await assert.rejects(runWorker(invalid), { stderr: /SHA-256/ });

  await using api = await start("src/start-governance.ts", {
    ...operator, ORTH_GOVERNANCE_DATABASE_URL: governance.url,
    ORTH_PUBLISHER_DATABASE_URL: publisher.url, ORTH_DATA_DIR: dataDir
  });
  await using app = createApp({ applicationPool: application.pool }).listen(0, "127.0.0.1");
  await once(app, "listening");
  const address = app.address();
  assert.ok(address && typeof address === "object");
  const applicationUrl = `http://127.0.0.1:${address.port}`;
  const get = (path: string) => fetch(api.url + apiPath + path, { headers: { authorization } });
  const action = (name: string) => fetch(api.url + apiPath + "/candidates/" + priceId + "/" + name, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}"
  });
  const price = () => fetch(applicationUrl + "/api/v1/prices/" + priceId);

  const sources = await (await get("/sources")).json();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].publisher, "湖南省医疗保障局");
  assert.equal(sources[0].notice_url, "https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/t20240919_33458275.html");
  assert.ok(sources[0].last_success_at);
  const tasks = await (await get("/tasks")).json();
  assert.deepEqual(tasks.map(({ status }: { status: string }) => status), ["failed", "imported", "imported"]);
  assert.match(tasks[0].error, /SHA-256/);
  assert.equal(tasks.find(({ task_id }: { task_id: string }) => task_id === first.task_id).candidate_status, "待复核");
  const candidates = await (await get("/candidates")).json();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].price_id, priceId);

  assert.equal((await price()).status, 404);
  assert.equal((await action("publish")).status, 409);
  assert.equal((await action("review")).status, 204);
  assert.equal((await price()).status, 404);
  assert.equal((await action("publish")).status, 204);
  await api.stop();
  const response = await price();
  assert.equal(response.status, 200);
  const { published_at, ...snapshot } = await response.json();
  assert.ok(published_at);
  assert.deepEqual(snapshot, JSON.parse(await readFile("samples/hunan-joint-results.published.json", "utf8")));
});

test("独立 Worker 使用专属登录导入候选、留档和记录任务", { timeout: 15_000 }, async (t) => {
  const database = await testDatabase(t);
  const dataDir = await workspace(t);
  await database.migrate();
  const worker = await database.login("orth_worker");
  const env = { ORTH_WORKER_DATABASE_URL: worker.url, ORTH_DATA_DIR: dataDir };
  const { stdout } = await exec(process.execPath, ["src/start-worker.ts", manifest, workbook], { env });
  const result = JSON.parse(stdout);
  assert.equal(result.price_id, priceId);
  const { rows: [task] } = await worker.pool.query(`
    SELECT candidate_id, status, sha256 FROM orth_governance.collection_task WHERE task_id = $1
  `, [result.task_id]);
  assert.equal(task.status, "imported");
  assert.equal(task.candidate_id, priceId);
  const expected = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(task.sha256, expected.sha256);
  assert.deepEqual(await readFile(join(dataDir, task.sha256 + ".xls")), await readFile(workbook));
});

test("运行中的采集可见，强制停止后标记中断且手工入口可重新导入", { timeout: 22_000 }, async (t) => {
  const database = await testDatabase(t);
  const dataDir = await workspace(t);
  await database.migrate();
  const worker = await database.login("orth_worker");
  const governance = await database.login("orth_governance");
  const publisher = await database.login("orth_publisher");
  await using api = await start("src/start-governance.ts", {
    ...operator, ORTH_GOVERNANCE_DATABASE_URL: governance.url,
    ORTH_PUBLISHER_DATABASE_URL: publisher.url, ORTH_DATA_DIR: dataDir
  });

  async function getTasks() {
    const response = await fetch(api.url + apiPath + "/tasks", { headers: { authorization } });
    assert.equal(response.status, 200);
    return await response.json() as Array<{ task_id: string; status: string; candidate_id: string | null }>;
  }

  const blocker = await database.owner.connect();
  try {
    await blocker.query("BEGIN");
    // Readers can still see the task while candidate insertion is blocked.
    await blocker.query("LOCK TABLE orth_governance.import_candidate IN SHARE MODE");
    const child = spawn(process.execPath, ["src/start-worker.ts", manifest, workbook], {
      env: { ORTH_WORKER_DATABASE_URL: worker.url, ORTH_DATA_DIR: dataDir },
      stdio: "ignore"
    });
    const exited = once(child, "exit");
    try {
      let tasks = await getTasks();
      for (let attempt = 0; !tasks.length && attempt < 100; attempt++) {
        await wait(30);
        tasks = await getTasks();
      }
      assert.deepEqual(tasks.map(({ status }) => status), ["running"]);
      const session = "orth-worker:" + tasks[0].task_id;
      let blocked = false;
      for (let attempt = 0; !blocked && attempt < 100; attempt++) {
        const { rowCount } = await database.owner.query(`
          SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'
        `, [session]);
        blocked = rowCount === 1;
        if (!blocked) await wait(30);
      }
      assert.ok(blocked, "Worker must be blocked in PostgreSQL before stopping it");
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
    let interrupted = await getTasks();
    for (let attempt = 0; interrupted[0]?.status === "running" && attempt < 120; attempt++) {
      await wait(100);
      interrupted = await getTasks();
    }
    assert.deepEqual(interrupted.map(({ status }) => status), ["interrupted"]);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }

  const manual = await exec(process.execPath, ["src/import-price.ts", manifest, workbook], {
    env: { ORTH_GOVERNANCE_DATABASE_URL: governance.url, ORTH_DATA_DIR: dataDir }
  });
  assert.deepEqual(JSON.parse(manual.stdout), { price_id: priceId });
  const tasks = await getTasks();
  assert.deepEqual(tasks.map(({ status, candidate_id }) => [status, candidate_id]), [
    ["imported", priceId], ["interrupted", null]
  ]);
});

test("独立 Worker、运营 Web 和数据应用用同一原表完成发布与查价", { timeout: 20_000 }, async (t) => {
  const database = await testDatabase(t);
  const dataDir = await workspace(t);
  await database.migrate();
  const governance = await database.login("orth_governance");
  const publisher = await database.login("orth_publisher");
  const worker = await database.login("orth_worker");
  const application = await database.login("orth_application");
  await exec(process.execPath, ["src/start-worker.ts", manifest, workbook], {
    env: { ORTH_WORKER_DATABASE_URL: worker.url, ORTH_DATA_DIR: dataDir }
  });

  await using api = await start("src/start-governance.ts", {
    ...operator, ORTH_GOVERNANCE_DATABASE_URL: governance.url,
    ORTH_PUBLISHER_DATABASE_URL: publisher.url, ORTH_DATA_DIR: dataDir
  });
  await using app = await start("src/application/start.ts", { ORTH_APPLICATION_DATABASE_URL: application.url });
  await using web = await start("src/start-operations.ts", {
    ORTH_GOVERNANCE_API_URL: api.url + apiPath,
    ORTH_APPLICATION_API_ORIGIN: app.url
  });
  const price = () => fetch(`${app.url}/api/v1/prices/${priceId}`);

  assert.equal((await fetch(web.url + "/ops")).status, 401);
  const get = (path: string) => fetch(web.url + "/ops" + path, { headers: { authorization } });
  const action = (name: string, contentType = "application/json") =>
    fetch(web.url + "/ops/candidates/" + priceId + "/" + name, {
      method: "POST", headers: { authorization, "content-type": contentType }, body: "{}"
    });

  assert.match(await (await get("/sources")).text(), /湖南省医疗保障局/);
  const head = await fetch(web.url + "/ops", { method: "HEAD", headers: { authorization } });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const queue = await (await get("")).text();
  assert.match(queue, /价格复核/);
  assert.match(queue, new RegExp(priceId));
  const tasks = await (await get("/tasks")).text();
  assert.match(tasks, /已导入/);
  const candidateRoute = "/candidates/" + priceId;
  assert.ok(tasks.includes(`href="/ops${candidateRoute}"`));
  const detail = await (await get(candidateRoute)).text();
  assert.match(detail, /<mark>5896<\/mark>/);
  assert.match(detail, /价格格 G5/);
  assert.match(detail, /ybj\.hunan\.gov\.cn/);
  const downloaded = await get(candidateRoute + "/attachment");
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), await readFile(workbook));

  assert.equal((await action("review", "text/plain")).status, 415);
  assert.equal((await price()).status, 404);
  assert.equal((await action("review")).status, 204);
  assert.match(await (await get(candidateRoute)).text(), /已复核/);
  assert.equal((await price()).status, 404);
  assert.equal((await action("publish")).status, 204);
  assert.match(await (await get("/tasks")).text(), /已发布/);
  const published = await price();
  assert.equal(published.status, 200);
  const { published_at, ...snapshot } = await published.json();
  const expected = JSON.parse(await readFile("samples/hunan-joint-results.published.json", "utf8"));
  assert.ok(published_at);
  assert.deepEqual(snapshot, expected);

  await web.stop();
  await api.stop();
  const afterShutdown = await price();
  assert.equal(afterShutdown.status, 200);
  assert.deepEqual(await afterShutdown.json(), { ...expected, published_at });
  await checkWebPricePage(app.url, expected);
  await checkMiniPricePage(app.url, priceId);
});
