/** @typedef {import("../../../contracts/price-v1").PublicPrice} PublicPrice */

Page({
  data: {
    price: /** @type {PublicPrice | null} */ (null),
    error: "",
    loading: false,
    priceId: ""
  },

  onLoad(options) {
    if (options?.price_id) this.loadPrice(options.price_id);
  },

  /** @param {WechatMiniprogram.CustomEvent<{value: {price_id: string}}>} event */
  searchPrice(event) {
    this.loadPrice(event.detail.value.price_id.trim());
  },

  /** @param {string} priceId */
  loadPrice(priceId) {
    if (this.data.loading) return;
    this.setData({ priceId, price: null, error: "" });
    if (!priceId) {
      this.setData({ error: "请输入价格编码。" });
      return;
    }

    this.setData({ loading: true });
    const { apiBaseUrl } = getApp().globalData;
    /** @type {WechatMiniprogram.RequestOption<PublicPrice>} */
    const request = {
      url: `${apiBaseUrl}/api/v1/prices/${encodeURIComponent(priceId)}`,
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
    const path = "/pages/price/index";
    if (!price) return { title: "骨科集采公开价格查询", path };
    return {
      title: `${price.product_system} · ${price.amount} ${price.unit}`,
      path: `${path}?price_id=${encodeURIComponent(price.price_id)}`
    };
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
