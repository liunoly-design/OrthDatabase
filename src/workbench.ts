import type { CandidateSummary, ReviewCandidate } from "./price-store.ts";

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
  a { color: #075e58 } li { margin-block: .75rem } .table { overflow: auto }
  table { border-collapse: collapse; width: 100% }
  td, th { border: 1px solid #aebcbd; padding: .5rem; text-align: start; min-width: 2ch }
  mark { background: #ffe59b; padding: .125rem .25rem }
  button { padding: .6rem 1rem; font: inherit; cursor: pointer }
  code { overflow-wrap: anywhere }
</style></head><body><main><h1>${h(title)}</h1>${contents}</main></body></html>`;
}

export function queuePage(candidates: CandidateSummary[]) {
  const rows = candidates.map((row) => `<li><a href="/ops/candidates/${h(row.price_id)}">${h(row.product_system)}
     · ${h(row.applicant)}</a> · ${h(row.status)}<br><code>${h(row.price_id)}</code></li>`).join("");
  return page("价格复核", rows ? `<ul>${rows}</ul>` : "<p>暂无已导入的价格候选。</p>");
}

export function candidatePage(candidate: ReviewCandidate) {
  const { source, price_id: priceId, status } = candidate;
  const columns = Array.from({ length: 8 }, (_, index) => String.fromCharCode(65 + index));
  const rows = candidate.original_rows.map(({ number, cells }) => `<tr><th scope="row">${number}</th>
    ${cells.map((cell, index) => {
      const isPrice = columns[index] + number === source.price_cell;
      return `<td>${isPrice ? `<mark>${h(cell)}</mark>` : h(cell)}</td>`;
    }).join("")}</tr>`).join("");
  const nextAction = status === "待复核" ? "review" : "publish";
  const actionArea = status === "已发布"
    ? `<a href="/api/v1/prices/${h(priceId)}">查看公开 API 结果</a>`
    : `<button type="button" data-endpoint="/ops/candidates/${h(priceId)}/${nextAction}">${nextAction === "review" ? "确认复核" : "发布价格"}</button>
       <p id="result" role="status"></p><script src="/ops/workbench.js" defer></script>`;

  return page(candidate.product_system, `
    <p><a href="/ops">返回复核列表</a></p>
    <p><strong>${h(candidate.amount)} ${h(candidate.unit)}</strong> · ${h(candidate.applicant)} · ${h(status)}</p>
    <p>${h(candidate.region)}自 ${h(candidate.effective_from)} 执行 · ${h(candidate.service_fee_basis)}</p>
    <p>价格编码 <code>${h(priceId)}</code></p>
    <h2>原表</h2>
    <p>${h(source.publisher)} · <a href="${h(source.notice_url)}">${h(source.notice_title)}</a></p>
    <p><a href="${h(source.attachment_url)}">${h(source.attachment_title)}</a>
      · <a href="/ops/candidates/${h(priceId)}/attachment">下载留档原表</a></p>
    <p>工作表 ${h(source.sheet_name)} · 第 ${source.row_number} 行 · 价格格 ${h(source.price_cell)}</p>
    <div class="table"><table aria-label="原表表头与所选行">
      <thead><tr><th scope="col">行</th>${columns.map((column) => `<th scope="col">${column}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
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
      if (!response.ok) throw new Error("操作未完成");
      location.reload();
    } catch {
      result.textContent = "操作未完成，请刷新页面后重试。";
      button.disabled = false;
    }
  });
`;
