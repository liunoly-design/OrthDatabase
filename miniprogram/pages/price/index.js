/** @typedef {import("../../../contracts/price-v1").PublicPriceWithCorrection} PublicPriceWithCorrection */
/** @typedef {import("../../../contracts/price-v1").PriceSearchResponse} PriceSearchResponse */
/** @typedef {PriceSearchResponse["prices"][number]} PriceSearchResult */
/** @typedef {keyof PriceSearchResponse["filters"]} TagKey */
/** @typedef {{ value: string, label: string }} TagOption */
/** @typedef {{ key: TagKey, label: string, options: TagOption[], selected: number }} Picker */
/** @typedef {{ key: "product_spec_id" | "kit_version_id" | "product_system" | "region", value: string, label: string }} SearchScope */

/** @type {Record<TagKey, string>} */
const tagLabels = {
  round_id: "采购轮次",
  published_group: "已公布分组",
  price_type: "价格类型",
  pack_quantity: "包装内数量",
  unit: "计价单位"
};

/** @param {PriceSearchResponse["filters"]} [filters] @param {Picker[]} [previous] */
function searchPickers(filters, previous = []) {
  return /** @type {TagKey[]} */ (Object.keys(tagLabels)).map((key) => {
    const options = [{ value: "", label: "全部" }];
    for (const item of filters?.[key] ?? []) {
      options.push({
        value: item === null ? "unknown" : String(item),
        label: item === null ? "未核实" : String(item)
      });
    }
    const picker = previous.find((picker) => picker.key === key);
    const selected = picker?.options[picker.selected].value ?? "";
    return { key, label: tagLabels[key], options, selected: Math.max(0, options.findIndex((item) => item.value === selected)) };
  });
}

const pagePath = "/pages/price/index";

/** @param {string} priceId */
function detailPath(priceId) {
  return `${pagePath}?price_id=${encodeURIComponent(priceId)}`;
}

Page({
  data: {
    showDetail: false,
    price: /** @type {PublicPriceWithCorrection | null} */ (null),
    enteredViaDetail: false,
    keyword: "",
    pickers: searchPickers(),
    scope: /** @type {SearchScope | null} */ (null),
    prices: /** @type {PriceSearchResult[]} */ ([]),
    activeQuery: "",
    nextCursor: /** @type {string | null} */ (null),
    searched: false,
    error: "",
    loading: false
  },

  onLoad(options) {
    if (options?.price_id) {
      this.setData({ enteredViaDetail: true });
      this.loadPrice(options.price_id);
    } else {
      this.loadResults();
    }
  },

  /** @param {WechatMiniprogram.Input} event */
  editKeyword(event) {
    this.setData({ keyword: event.detail.value });
  },

  /** @param {WechatMiniprogram.CustomEvent<{value: {q: string}}>} event */
  submitSearch(event) {
    if (this.data.loading) return;
    const keyword = event.detail.value.q.trim();
    this.setData({ keyword });
    this.loadResults(false, true);
  },

  /** @param {WechatMiniprogram.PickerChange} event */
  chooseTag(event) {
    if (this.data.loading) return;
    const { index } = event.currentTarget.dataset;
    this.setData({ [`pickers[${index}].selected`]: Number(event.detail.value) });
    this.loadResults();
  },

  clearSearch() {
    if (this.data.loading) return;
    const pickers = this.data.pickers.map((picker) => ({ ...picker, selected: 0 }));
    this.setData({ keyword: "", scope: null, pickers });
    this.loadResults();
  },

  morePrices() {
    if (this.data.nextCursor) this.loadResults(true);
  },

  /** @param {boolean} [append] @param {boolean} [openExactId] */
  loadResults(append = false, openExactId = false) {
    const { loading, keyword, scope, pickers, activeQuery, nextCursor } = this.data;
    if (loading) return;
    const tags = pickers.map(({ key, options, selected }) => [key, options[selected].value]);
    const terms = [["q", keyword.trim()], ...tags];
    if (scope) terms.push([scope.key, scope.value]);
    const query = append ? activeQuery : terms.filter(([, value]) => value)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
    const params = append ? [query, `after=${encodeURIComponent(nextCursor ?? "")}`].filter(Boolean).join("&") : query;
    const { apiBaseUrl } = getApp().globalData;
    this.setData({ loading: true, error: "" });
    if (!append) this.setData({ prices: [], nextCursor: null, searched: false });
    /** @type {WechatMiniprogram.RequestOption<PriceSearchResponse>} */
    const request = {
      url: `${apiBaseUrl}/api/v1/prices?${params}`,
      timeout: 10000,
      success: ({ data, statusCode }) => {
        if (statusCode !== 200) {
          this.setData({ loading: false, error: "暂时无法查询，请重试。" });
          return;
        }
        this.setData({
          prices: append ? [...this.data.prices, ...data.prices] : data.prices,
          pickers: searchPickers(data.filters, pickers),
          nextCursor: data.next_cursor,
          activeQuery: query,
          searched: true,
          loading: false
        });
        if (openExactId && data.prices[0]?.price_id === keyword) this.openPrice(keyword);
      },
      fail: () => this.setData({ loading: false, error: "暂时无法连接，请重试。" })
    };
    wx.request(request);
  },

  /** @param {WechatMiniprogram.TouchEvent} event */
  selectResult(event) {
    this.openPrice(event.currentTarget.dataset.priceId);
  },

  /** @param {string} priceId */
  openPrice(priceId) {
    const request = {
      url: detailPath(priceId),
      fail: () => wx.showToast({ title: "暂时无法打开，请重试", icon: /** @type {const} */ ("none") })
    };
    if (this.data.enteredViaDetail) wx.redirectTo(request);
    else wx.navigateTo(request);
  },

  /** @param {string} priceId */
  loadPrice(priceId) {
    this.setData({ showDetail: true, price: null, error: "", loading: true });
    const { apiBaseUrl } = getApp().globalData;
    /** @type {WechatMiniprogram.RequestOption<PublicPriceWithCorrection>} */
    const request = {
      url: `${apiBaseUrl}/api/v1/prices/${encodeURIComponent(priceId)}?include_correction=1`,
      timeout: 10000,
      success: ({ data, statusCode }) => {
        if (statusCode === 200) {
          this.setData({ price: data, loading: false });
          return;
        }
        this.setData({
          loading: false,
          error: statusCode === 404 ? "暂无这条已发布价格，请核对编码。" : "暂时无法查询，请重试。"
        });
      },
      fail: () => this.setData({ loading: false, error: "暂时无法连接，请重试。" })
    };
    wx.request(request);
  },

  onShareAppMessage() {
    const { price } = this.data;
    if (!price) return { title: "骨科集采公开价格查询", path: pagePath };
    return {
      title: `${price.superseded_by_price_id ? "已被官方更正 · " : ""}${price.product_system} · ${price.amount} ${price.unit}`,
      path: detailPath(price.price_id)
    };
  },

  /** @param {WechatMiniprogram.TouchEvent} event */
  continueSearch(event) {
    if (this.data.loading) return;
    const { price } = this.data;
    const { key, value, label } = event.currentTarget.dataset;
    if (!price || !value) return;
    let scope = null;
    const pickers = searchPickers();
    if (key === "round_id") {
      const round = pickers.find((picker) => picker.key === "round_id");
      if (round) {
        round.options.push({ value, label });
        round.selected = 1;
      }
    } else {
      scope = { key, value, label };
    }
    this.setData({
      showDetail: false, price: null, keyword: "", pickers, scope
    });
    this.loadResults();
  },

  returnToSearch() {
    if (this.data.loading) return;
    this.setData({ showDetail: false, price: null });
    this.clearSearch();
  },

  copyNotice() {
    if (this.data.price) this.copySource(this.data.price.source.notice_url);
  },

  copyAttachment() {
    if (this.data.price) this.copySource(this.data.price.source.attachment_url);
  },

  /** @param {string} url */
  copySource(url) {
    wx.setClipboardData({
      data: url,
      fail: () => wx.showToast({ title: "复制失败，请重试", icon: "none" })
    });
  }
});
