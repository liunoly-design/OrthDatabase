import type { ProcurementEvent, ProcurementResponse, ProcurementSource } from "../../contracts/procurement-v1.d.ts";
import { escapeHtml as h } from "../http.ts";
import type { ProcurementFilters } from "./procurement-query.ts";

const eventLabels = {
  submission: "申报",
  official_award: "正式中选",
  annual_renewal: "年度续签",
  local_execution: "地方执行",
  product_information_maintenance: "产品信息维护",
  product_information_confirmation: "产品信息及企业关系确认",
  product_information_notice: "产品信息公示"
} satisfies Record<ProcurementEvent["event_type"], string>;

const disclosureLabels = {
  not_disclosed: "当期公告未披露正式中选价",
  disclosed: "官方来源已披露价格",
  referenced: "按引用的国家正式中选价执行",
  not_stated: "该节点未说明价格披露情况"
} satisfies Record<ProcurementEvent["price_disclosure"], string>;

function sourceLink({ title, url, location }: ProcurementSource) {
  const link = url.startsWith("https://") ? `<a href="${h(url)}">${h(title)}</a>` : h(title);
  return `${link} · ${h(location)}`;
}

function eventCard(event: ProcurementEvent) {
  const { evidence, effective_from: from, effective_to: to } = event;
  const schedule = from ? `<p>节点起日 ${h(from)}${to ? ` · 截至 ${h(to)}（不含当日）` : ""}</p>` : "";
  const attachments = evidence.attachments?.map((attachment) => `<li>${sourceLink(attachment)}</li>`).join("");
  return `<article class="card">
    <h3>${h(eventLabels[event.event_type])} · ${h(event.region ?? "国家层面")}</h3>
    <p>${h(event.round_title)} · ${h(event.round_id)}</p>
    <p>公开日期 ${h(event.announced_on)}</p>
    ${schedule}
    <p>${h(event.summary)}</p>
    <p>${h(disclosureLabels[event.price_disclosure])}</p>
    ${evidence.applicable_price_basis ? `<p>${h(evidence.applicable_price_basis)}</p>` : ""}
    <p class="source">${h(event.source.publisher)} · ${sourceLink(event.source)}</p>
    ${evidence.pricing_unit_source ? `<p class="source">计价单位依据 · ${sourceLink(evidence.pricing_unit_source)}</p>` : ""}
    ${attachments ? `<ul>${attachments}</ul>` : ""}
  </article>`;
}

function priceCard(price: ProcurementResponse["prices"][number]) {
  const { execution, source } = price;
  const localAward = source.local_award_reference;
  const { effective_from: from, applicable_to: to } = price;
  const period = from && to && to <= from ? "执行期已由更正覆盖" :
    `自 ${h(from ?? "待核实")} 执行${to ? ` · 截至 ${h(to)}（不含当日）` : ""}`;
  return `<article class="card">
    <h3><a href="/prices/${encodeURIComponent(price.price_id)}">${h(price.product_system)}</a></h3>
    <p>${h(price.applicant)} · ${h(price.region)} · ${period}</p>
    <p><strong>${h(price.amount)} ${h(price.unit)}</strong> · ${h(price.price_type)} · ${h(price.service_fee_basis)}</p>
    <p>${h(disclosureLabels[execution.price_disclosure])}</p>
    <p class="source">${sourceLink(execution.source)}</p>
    ${source.notice_url !== execution.source.url ? `<p class="source">${sourceLink({
      title: source.notice_title, url: source.notice_url, location: "价格记录公告"
    })}</p>` : ""}
    ${localAward ? `<p class="source">${sourceLink({
      title: localAward.title, url: localAward.url + "#page=" + localAward.page,
      location: `PDF第${localAward.page}页序号${localAward.serial_number}`
    })}</p>` : ""}
    <p class="source">${sourceLink({
      title: source.attachment_title, url: source.attachment_url,
      location: `${source.sheet_name} · 第 ${source.row_number} 行 · ${source.price_cell}`
    })}</p>
  </article>`;
}

export function procurementPage(filters: ProcurementFilters, results: ProcurementResponse | null) {
  const { category, region, round_id, date } = filters;
  const next = results?.next_price_cursor;
  const nextPage = next ? `/procurement?${new URLSearchParams({ ...filters, after: next })}#prices` : null;
  return `<!doctype html>
<html lang="zh-CN"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>政策与执行价 · 骨科集采</title>
  <link rel="stylesheet" href="/assets/price-query/price.css">
</head><body>
  <header class="site-header"><a href="/">骨科集采<span> · 公开价格</span></a></header>
  <main>
    <h1>政策与执行价</h1>
    <form action="/procurement" method="get" role="search" class="procurement-filters">
      <label>品类<input name="category" placeholder="如人工关节" value="${h(category ?? "")}" maxlength="200"></label>
      <label>地区<input name="region" placeholder="如湖南省" value="${h(region ?? "")}" maxlength="200"></label>
      <label>采购轮次<input name="round_id" placeholder="如 GH-HD2024-1" value="${h(round_id ?? "")}" maxlength="200"></label>
      <label>查询日期<input name="date" type="date" value="${h(date ?? "")}"></label>
      <div><button type="submit">查询</button> <a href="/procurement">清除筛选</a></div>
    </form>
    <p>政策按公开日期回看，价格按当地执行日期核对。请使用结果中的品类、地区和轮次名称筛选。</p>
    ${results ? `<section aria-labelledby="prices">
      <h2 id="prices">执行价</h2>
      ${results.prices.map(priceCard).join("") || "<p>当前筛选暂无带地方执行依据的已发布价格。</p>"}
      ${nextPage ? `<p><a href="${h(nextPage)}">下一页价格</a></p>` : ""}
    </section>
    <section aria-labelledby="events">
      <h2 id="events">政策与采购进度</h2>
      ${results.events.map(eventCard).join("") || "<p>当前筛选暂无已收录的公开政策。</p>"}
    </section>` : "<p role=\"alert\">筛选条件无效，请检查日期或其他输入。</p>"}
  </main>
</body></html>`;
}
