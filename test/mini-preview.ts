import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";

interface PricePage {
  data: Record<string, unknown>;
  onLoad(options: Record<string, string>): void;
  onShareAppMessage?(event: { from: "button" }): { path: string } | undefined;
}

const route = "pages/price/index";

async function withMiniPreview(base: string, check: (preview: Awaited<ReturnType<typeof createPreview>>) => Promise<void>) {
  const registration = JSON.parse(await readFile("miniprogram/app.json", "utf8"));
  assert.ok(registration.pages.includes(route), "详情路径必须在小程序注册");
  const window = new JSDOM("").window;
  const globals = { window, document: window.document, CustomEvent: window.CustomEvent };
  const descriptors = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, globals);
  try {
    await check(await createPreview(base, window.document));
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  }
}

async function createPreview(base: string, document: Document) {
  const root = "miniprogram/" + route;
  const [script, template] = await Promise.all([readFile(root + ".js", "utf8"), readFile(root + ".wxml", "utf8")]);
  const simulate = await import("miniprogram-simulate");
  const copied: string[] = [];
  let navigation: string | undefined;
  let redirected = false;
  let network: Promise<void> | undefined;
  let requestedUrl: string | undefined;

  async function open(path: string) {
    const url = new URL(path, "https://miniprogram.test");
    assert.equal(url.pathname, "/" + route);
    let page: PricePage | undefined;
    runInNewContext(script, {
      Page(definition: PricePage) { page = definition; },
      getApp() { return { globalData: { apiBaseUrl: base } }; },
      wx: {
        request(options: { url: string; success(response: { statusCode: number; data: unknown }): void }) {
          requestedUrl = options.url;
          network = (async () => {
            const response = await fetch(options.url);
            options.success({ statusCode: response.status, data: await response.json() });
          })();
        },
        navigateTo(options: { url: string }) { navigation = options.url; redirected = false; },
        redirectTo(options: { url: string }) { navigation = options.url; redirected = true; },
        setClipboardData(options: { data: string }) { copied.push(options.data); }
      }
    }, { filename: root + ".js" });
    assert.ok(page, "小程序路径必须注册 Page");
    const { data, onLoad, onShareAppMessage, ...methods } = page;
    const view = simulate.render(simulate.load({
      template, data: structuredClone(data), methods: methods as Record<string, (...args: never[]) => unknown>
    }));
    document.body.replaceChildren();
    view.attach(document.body);
    const setData = view.instance.setData.bind(view.instance);
    view.instance.setData = (patch: Record<string, unknown>) => setData(structuredClone(patch));
    network = undefined;
    onLoad.call(view.instance, Object.fromEntries(url.searchParams));
    await settle();
    return { view, share: () => onShareAppMessage?.call(view.instance, { from: "button" })?.path };
  }

  async function settle() {
    await simulate.sleep(0);
    await network;
    await simulate.sleep(0);
  }

  return { open, settle, copied, requested: () => requestedUrl, navigation: () => navigation, redirected: () => redirected };
}

const noticeUrl = "https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/t20240919_33458275.html";
const attachmentUrl = "https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/33458275/files/0ac80457057341528553dae98aee88b0.xls";

export async function checkMiniPricePage(base: string, priceId: string) {
  await withMiniPreview(base, async ({ open, settle, copied, requested }) => {
    const { view, share } = await open(`/${route}?price_id=${priceId}`);
    const text = view.dom?.textContent ?? "";
    assert.match(text, /5896\.00 元\/套/);
    assert.match(text, /湖南省医疗保障局/);
    assert.match(text, /Sheet1\s*·\s*第 5 行\s*·\s*G5/);
    assert.ok(view.querySelector("#share-price"), "已发布价格应提供小程序分享入口");
    assert.equal(share(), `/${route}?price_id=${priceId}`);
    const notice = view.querySelector("#copy-notice");
    const attachment = view.querySelector("#copy-attachment");
    assert.ok(notice && attachment);
    notice.dispatchEvent("tap");
    attachment.dispatchEvent("tap");
    await settle();
    assert.deepEqual(copied, [noticeUrl, attachmentUrl]);

    const missing = await open(`/${route}?price_id=missing-contract-id`);
    assert.equal(requested(), `${base}/api/v1/prices/missing-contract-id`);
    assert.match(missing.view.dom?.textContent ?? "", /暂无这条已发布价格/);
    assert.equal(missing.view.querySelector("#copy-notice"), undefined);
  });
}

export async function checkMiniPriceSearch(base: string, priceId: string) {
  await withMiniPreview(base, async ({ open, settle, copied, requested, navigation, redirected }) => {
    const { view } = await open("/" + route);
    const form = view.querySelector("#keyword-search");
    assert.ok(form, "小程序首页应提供关键词搜索表单");
    form.dispatchEvent("submit", { detail: { value: { q: priceId } } });
    await settle();
    assert.equal(navigation(), `/${route}?price_id=${priceId}`, "搜索完整价格编码可直接打开详情");
    for (const q of ["合金-聚乙烯类髋关节产品系统", "天津正天", "合金对聚乙烯髋关节"]) {
      form.dispatchEvent("submit", { detail: { value: { q } } });
      await settle();
      assert.equal(new URL(requested()!).searchParams.get("q"), q);
      assert.match(view.dom?.textContent ?? "", /5896\.00 元\/套/);
    }
    for (const [id, amount, group] of [
      [priceId, "5896.00", "A"],
      ["aj_b9bc5f35d293633e492172797daf37ab", "5907.00", "A"],
      ["aj_ccae1099b7994af9d907259d7004c70e", "5610.00", "B"]
    ]) {
      const card = view.querySelector("#result-" + id)?.dom?.parentElement?.textContent ?? "";
      assert.ok(card.includes(amount + " 元/套"), id);
      assert.ok(card.includes("分组 " + group), id);
    }

    const options = {
      round_id: "GH-HD2024-1", published_group: "A", price_type: "正式中选价",
      pack_quantity: "unknown", unit: "元/套"
    };
    for (const [key, value] of Object.entries(options)) {
      const picker = view.querySelector("#filter-" + key);
      assert.ok(picker, key);
      picker.dispatchEvent("change", { detail: { value: "1" } });
      await settle();
      assert.equal(new URL(requested()!).searchParams.get(key), value);
    }
    const resultsText = view.dom?.textContent ?? "";
    for (const label of ["正式中选价", "A", "湖南省", "包装内数量未核实", "含伴随服务费", "2024-10-15"]) {
      assert.ok(resultsText.includes(label), label);
    }
    assert.match(resultsText, /天津正天/);
    assert.match(resultsText, /嘉思特/);
    assert.match(resultsText, /5907\.00 元\/套/);
    assert.doesNotMatch(resultsText, /5610\.00 元\/套/);
    const result = view.querySelector("#result-" + priceId);
    assert.ok(result);
    result.dispatchEvent("tap");
    await settle();

    const resultPath = navigation();
    assert.ok(resultPath);
    const sender = await open(resultPath);
    assert.ok(sender.view.querySelector("#share-price"));
    const sharePath = sender.share();
    assert.equal(sharePath, `/${route}?price_id=${priceId}`);

    const recipient = await open(sharePath);
    assert.equal(requested(), `${base}/api/v1/prices/${priceId}`);
    const recipientText = recipient.view.dom?.textContent ?? "";
    assert.ok(recipientText.includes(priceId));
    assert.match(recipientText, /5896\.00 元\/套/);
    assert.match(recipientText, /湖南省医疗保障局/);
    assert.match(recipientText, /Sheet1\s*·\s*第 5 行\s*·\s*G5/);
    for (const [selector, url] of [["#copy-notice", noticeUrl], ["#copy-attachment", attachmentUrl]]) {
      const button = recipient.view.querySelector(selector);
      assert.ok(button);
      button.dispatchEvent("tap");
      await settle();
      assert.equal(copied.at(-1), url);
    }

    for (const [id, key, value] of [
      ["subject", "product_system", "合金-聚乙烯类髋关节产品系统"],
      ["region", "region", "湖南省"],
      ["round", "round_id", "GH-HD2024-1"]
    ]) {
      const { view } = await open(sharePath);
      const button = view.querySelector("#continue-" + id);
      assert.ok(button, id);
      button.dispatchEvent("tap");
      await settle();
      assert.equal(new URL(requested()!).searchParams.get(key), value);
      assert.ok(view.querySelector("#result-" + priceId));
      if (key === "round_id") {
        view.querySelector("#filter-round_id")?.dispatchEvent("change", { detail: { value: "1" } });
        await settle();
        assert.deepEqual(new URL(requested()!).searchParams.getAll("round_id"), [value]);
        assert.ok(view.querySelector("#result-" + priceId), "继续查询时仍可调整同一轮次");
      }
      view.querySelector("#result-" + priceId)?.dispatchEvent("tap");
      await settle();
      assert.equal(navigation(), sharePath);
      assert.equal(redirected(), true, "连续查看详情时应复用当前详情页栈位置");
    }
  });
}

export async function checkMiniSpecFollowup(base: string, priceId: string, specId: string) {
  await withMiniPreview(base, async ({ open, settle, requested }) => {
    const { view: list } = await open("/" + route);
    const specCard = list.querySelector("#result-" + priceId)?.dom?.parentElement?.textContent ?? "";
    for (const label of ["5896.00 元/件", "挂网价", "契约测试地区", "包装内数量 4"]) {
      assert.ok(specCard.includes(label), label);
    }
    assert.match(list.dom?.textContent ?? "", /5907\.00 元\/套/);
    const { view } = await open(`/${route}?price_id=${priceId}`);
    const button = view.querySelector("#continue-subject");
    assert.match(button?.dom?.textContent ?? "", /同品规/);
    button?.dispatchEvent("tap");
    await settle();
    assert.equal(new URL(requested()!).searchParams.get("product_spec_id"), specId);
    const results = view.querySelectorAll(".result-link");
    assert.equal(results.length, 1);
    assert.ok(view.querySelector("#result-" + priceId));
  });
}
