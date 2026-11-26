import type { EvidenceReference } from "../contracts/price-v1.d.ts";
import type { CollectionSource, CollectionTask } from "./collection-store.ts";
import { publishedPriceId, type CandidateSummary, type ReviewCandidate } from "./price-store.ts";

function h(text: string | number) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function page(title: string, contents: string) {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} · 骨科集采</title>
<style>
  body { margin: 2rem auto; padding: 0 1rem; max-width: 68rem; font: 16px/1.6 system-ui; color: #18262a }
  nav ul { display: flex; flex-wrap: wrap; gap: 1.25rem; list-style: none; padding: 0 }
  nav li { margin: 0 } [aria-current="page"] { font-weight: bold }
  a { color: #075e58 } li { margin-block: .75rem } .table { overflow: auto }
  table { border-collapse: collapse; width: 100% }
  td, th { border: 1px solid #aebcbd; padding: .5rem; text-align: start; min-width: 2ch }
  mark { background: #ffe59b; padding: .125rem .25rem }
  button { padding: .6rem 1rem; font: inherit; cursor: pointer }
  code { overflow-wrap: anywhere }
</style></head><body><main><h1>${h(title)}</h1>${contents}</main></body></html>`;
}

function operationsNav(current: string) {
  const links = [["/ops", "价格复核"], ["/ops/sources", "官方信源"], ["/ops/tasks", "采集任务"]];
  return `<nav aria-label="运营导航"><ul>${links.map(([href, label]) =>
    `<li><a href="${href}"${current === href ? ' aria-current="page"' : ""}>${label}</a></li>`).join("")}</ul></nav>`;
}

function timestamp(value: string | null) {
  return value ? `<time datetime="${h(value)}">${h(value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC"))}</time>` : "—";
}

export function sourcesPage(sources: CollectionSource[]) {
  const rows = sources.map((source) => `<tr>
    <th scope="row"><a href="${h(source.notice_url)}">${h(source.notice_title)}</a></th>
    <td>${h(source.publisher)}</td><td>${timestamp(source.last_started_at)}</td><td>${timestamp(source.last_success_at)}</td>
  </tr>`).join("");
  return page("官方信源", operationsNav("/ops/sources") + (rows
    ? `<div class="table"><table><thead><tr><th scope="col">公告</th><th scope="col">发文机构</th>
       <th scope="col">最近采集</th><th scope="col">最近成功</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : "<p>暂无官方信源。</p>"));
}

export function tasksPage(tasks: CollectionTask[]) {
  const status = { running: "采集中", imported: "已导入", failed: "采集失败", interrupted: "采集中断" };
  const rows = tasks.map((task) => `<tr>
    <th scope="row"><a href="${h(task.notice_url)}">${h(task.notice_title)}</a><br><code>${h(task.task_id)}</code></th>
    <td><a href="${h(task.attachment_url)}">官方原表</a><br>${h(task.sheet_name)} · 第 ${task.row_number} 行
      ${task.supply_manifest ? `<br><a href="${h(task.supply_manifest.url)}">补充供应清单</a> ·
        ${h(task.supply_manifest.system_code)}<br><code>${h(task.supply_manifest.sha256)}</code>` : ""}</td>
    <td>${status[task.status]}${task.error ? `<br>${h(task.error)}` : ""}
      ${task.conflict ? `<br><a href="/ops/candidates/${h(task.conflict.existing_candidate_id)}">原候选</a>
        ${h(task.conflict.existing_amount)} 元/套 · 本次 ${h(task.conflict.proposed_amount)} 元/套` : ""}
      ${task.skill_version && task.parser_version
        ? `<br><small>${h(task.skill_version)} · ${h(task.parser_version)}</small>` : ""}</td>
    <td>${timestamp(task.started_at)}<br>${timestamp(task.finished_at)}</td>
    <td>${task.candidate_id && task.candidate_status
      ? `<a href="/ops/candidates/${h(task.candidate_id)}">${h(task.candidate_status)}</a>` : "—"}</td>
  </tr>`).join("");
  return page("采集任务", operationsNav("/ops/tasks") + (rows
    ? `<div class="table"><table><thead><tr><th scope="col">信源与任务</th><th scope="col">附件位置</th>
       <th scope="col">采集状态</th><th scope="col">开始 / 结束</th><th scope="col">复核状态</th>
       </tr></thead><tbody>${rows}</tbody></table></div>`
    : "<p>暂无采集任务。</p>"));
}

export function queuePage(candidates: CandidateSummary[], showNavigation = false) {
  const rows = candidates.map((row) => `<li><a href="/ops/candidates/${h(row.price_id)}">${h(row.product_system)}
     · ${h(row.applicant)}</a> · ${h(row.status)}<br><code>${h(row.price_id)}</code></li>`).join("");
  return page("价格复核", (showNavigation ? operationsNav("/ops") : "") +
    (rows ? `<ul>${rows}</ul>` : "<p>暂无已导入的价格候选。</p>"));
}

function evidenceLinks(evidence: EvidenceReference[]) {
  return evidence.map((source) => {
    const location = "sheet_name" in source ? `${source.sheet_name}! ${source.cells.join("、")}`
      : "page" in source ? `第 ${source.page} 页` : source.section;
    return `<a href="${h(source.url)}">${h(source.title)}</a> · ${h(location)}`;
  }).join("；");
}

function governanceEvidence(governance: ReviewCandidate["governance"], candidateId: string) {
  if (!governance) return "";
  const composition = governance.category_composition;
  const related = governance.related_system;
  const schemeLabels = { platform_system_code: "平台系统编码", platform_component_code: "平台部件编号",
    registration_number: "部件注册证号", former_registration_number: "部件原注册证号" };
  const identifiers = governance.identifier_links.map((link) =>
    `<li>${h(schemeLabels[link.scheme])} <code>${h(link.value)}</code> · 系统 ${h(link.system_code)}${link.component
      ? ` · ${h(link.component)}` : ""}<br>${evidenceLinks(link.evidence)}</li>`).join("");
  return `<h2>治理候选</h2>
    ${composition ? `<h3>类别组成</h3>
      <p>${composition.members.map((member) => h(`${member.name} ${member.quantity} ${member.unit}`)).join("、")}</p>
      ${composition.note ? `<p>${h(composition.note)}</p>` : ""}
      <p>${evidenceLinks(composition.evidence)}</p>` : ""}
    ${related ? `<h3>供应清单关联的系统</h3><p>${h(related.name)} · <code>${h(related.system_code)}</code></p>
      <p>${evidenceLinks([related.evidence])} · <a href="${h(related.evidence.notice_url)}">供应清单公告</a>
        · <a download href="/ops/candidates/${h(candidateId)}/supply">下载留档供应清单</a></p>
      <ul>${related.members.map((member) => `<li>${h(member.role)} · ${h(member.name)} · ${h(member.award_status)}
        <br>${evidenceLinks([member.evidence])}</li>`).join("")}</ul>` : ""}
    ${identifiers ? `<h3>标识关联</h3><ul>${identifiers}</ul>` : ""}
    ${governance.unresolved.length ? `<h3>待核实</h3><ul>${governance.unresolved.map((item) => `<li>${h(item)}</li>`).join("")}</ul>` : ""}`;
}

export function candidatePage(
  candidate: ReviewCandidate,
  publicPriceUrl: string | null = `/api/v1/prices/${encodeURIComponent(publishedPriceId(candidate))}`
) {
  const { source, price_id: priceId, status, change } = candidate;
  const changeLabel = {
    additional_evidence: "追加证据", official_correction: "官方更正", platform_correction: "平台误录纠错"
  };
  const columns = Array.from({ length: 8 }, (_, index) => String.fromCharCode(65 + index));
  const rows = candidate.original_rows.map(({ number, cells }) => `<tr><th scope="row">${number}</th>
    ${cells.map((cell, index) => {
      const isPrice = columns[index] + number === source.price_cell;
      return `<td>${isPrice ? `<mark>${h(cell)}</mark>` : h(cell)}</td>`;
    }).join("")}</tr>`).join("");
  const nextAction = status === "待复核" ? "review" : "publish";
  const actionArea = status === "已发布"
    ? (publicPriceUrl ? `<p><a href="${h(publicPriceUrl)}">查看公开 API 结果</a>
        · <a href="${h(publicPriceUrl + "/evidence")}">查看公开证据与历史</a></p>` : "")
    : `<button type="button" disabled data-endpoint="/ops/candidates/${h(priceId)}/${nextAction}">${nextAction === "review" ? "确认复核" : "发布价格"}</button>
       <p id="result" role="status"></p><script src="/ops/workbench.js" defer></script>`;

  return page(candidate.product_system, `
    <p><a href="/ops">返回复核列表</a></p>
    <p><strong>${h(candidate.amount)} ${h(candidate.unit)}</strong> · ${h(candidate.applicant)} · ${h(status)}</p>
    <p>${h(candidate.region)} · ${candidate.effective_from ? `自 ${h(candidate.effective_from)} 执行` : "生效日期待核实"}
      · ${h(candidate.service_fee_basis)}</p>
    <p>价格编码 <code>${h(publishedPriceId(candidate))}</code>
      ${change ? ` · 候选编码 <code>${h(priceId)}</code>` : ""}</p>
    ${change ? `<p><strong>${changeLabel[change.operation]}</strong> · ${candidate.target_candidate_id
          ? `<a href="/ops/candidates/${h(candidate.target_candidate_id)}">目标价格 ${h(change.target_price_id)}</a>`
          : `目标价格 <code>${h(change.target_price_id)}</code>`} · 目标版本 ${change.target_record_version}</p>
      <p>${h(change.reason)}</p>` : ""}
    ${candidate.reviewed_by ? `<p>复核人 ${h(candidate.reviewed_by)}${candidate.published_by
      ? ` · 发布人 ${h(candidate.published_by)}` : ""}</p>` : ""}
    <h2>原表</h2>
    <p>${h(source.publisher)} · <a href="${h(source.notice_url)}">${h(source.notice_title)}</a></p>
    <p><a href="${h(source.attachment_url)}">${h(source.attachment_title)}</a>
      · <a download href="/ops/candidates/${h(priceId)}/attachment">下载留档原表</a></p>
    <p>工作表 ${h(source.sheet_name)} · 第 ${source.row_number} 行 · 价格格 ${h(source.price_cell)}</p>
    <div class="table"><table aria-label="原表表头与所选行">
      <thead><tr><th scope="col">行</th>${columns.map((column) => `<th scope="col">${column}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${governanceEvidence(candidate.governance, priceId)}
    <div>${actionArea}</div>
  `);
}

export const workbenchScript = `
  const button = document.querySelector("button[data-endpoint]");
  const result = document.getElementById("result");
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const response = await fetch(button.dataset.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      if (response.status === 409) {
        result.textContent = "发布条件已变化或候选证据不符合要求，请重新核对目标价格和版本。";
        button.disabled = false;
        return;
      }
      if (!response.ok) throw new Error("操作未完成");
      location.reload();
    } catch {
      result.textContent = "操作未完成，请刷新页面后重试。";
      button.disabled = false;
    }
  });
  button.disabled = false;
`;
