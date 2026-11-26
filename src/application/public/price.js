(async () => {
  const prefix = "/prices/";
  if (!location.pathname.startsWith(prefix)) return;
  const pricePath = location.pathname.slice(prefix.length).replace(/\/$/, "");
  if (!pricePath) return;

  const status = document.getElementById("status");
  document.getElementById("price-id").value = decodeURIComponent(pricePath);
  status.textContent = "正在查询价格…";

  function setText(id, text) {
    document.getElementById(id).textContent = text;
  }

  function setSourceLink(id, title, url) {
    const link = document.getElementById(id);
    try {
      const destination = new URL(url);
      if (destination.protocol === "https:" && !destination.username && !destination.password) {
        link.textContent = title;
        link.href = destination.href;
        link.hidden = false;
        return;
      }
    } catch {
      // Keep the title readable when the source URL is malformed.
    }
    link.parentElement.textContent = title;
  }

  try {
    const response = await fetch(`/api/v1/prices/${pricePath}`);
    if (response.status === 404) {
      status.textContent = "暂无这条已发布价格，请核对编码。";
      return;
    }
    if (!response.ok) throw new Error("Price query failed");
    const price = await response.json();
    const { source } = price;
    const from = price.effective_from ? `自 ${price.effective_from} 起` : "起始日期未确认";
    const until = price.effective_to ? `，截至 ${price.effective_to}（不含当日）` : "";

    setText("price-type", price.price_type);
    setText("amount", `${price.amount} ${price.unit}`);
    setText("product", price.product_system);
    setText("applicant", price.applicant);
    setText("region", price.region);
    setText("effective-period", from + until);
    setText("service-fee", price.service_fee_basis);
    setText("publisher", source.publisher);
    setText("location", `${source.sheet_name} · 第 ${source.row_number} 行 · ${source.price_cell}`);
    setSourceLink("notice", source.notice_title, source.notice_url);
    setSourceLink("attachment", source.attachment_title, source.attachment_url);
    document.getElementById("price-detail").hidden = false;
    status.textContent = "";
  } catch {
    status.textContent = "暂时无法查询，请重试。";
  }
})();
