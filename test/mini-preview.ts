import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import type { PublicPrice } from "../contracts/price-v1.d.ts";

interface PricePage {
  data: { price: PublicPrice | null; error: string; loading: boolean; priceId: string };
  onLoad(options: { price_id: string }): void;
  [key: string]: unknown;
}

export async function checkMiniPricePage(base: string, priceId: string) {
  const registration = JSON.parse(await readFile("miniprogram/app.json", "utf8"));
  const route = "pages/price/index";
  assert.ok(registration.pages.includes(route), "The detail route must be registered in the app");
  const root = "miniprogram/" + route;
  const [script, template] = await Promise.all([readFile(root + ".js", "utf8"), readFile(root + ".wxml", "utf8")]);
  const window = new JSDOM("").window;
  const globals = { window, document: window.document, CustomEvent: window.CustomEvent };
  const descriptors = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, globals);
  try {
    const simulate = await import("miniprogram-simulate");
    let page: PricePage | undefined;
    let network: Promise<void> | undefined;
    const copied: string[] = [];
    runInNewContext(script, {
      Page(definition: PricePage) { page = definition; },
      getApp() { return { globalData: { apiBaseUrl: base } }; },
      wx: {
        request(options: { url: string; success(response: { statusCode: number; data: unknown }): void }) {
          network = (async () => {
            const response = await fetch(options.url);
            options.success({ statusCode: response.status, data: await response.json() });
          })();
        },
        setClipboardData(options: { data: string }) { copied.push(options.data); }
      }
    }, { filename: root + ".js" });
    assert.ok(page, "The WeChat route must register a Page");
    const { data, onLoad, ...methods } = page;
    const view = simulate.render(simulate.load({
      template,
      data,
      methods: methods as Record<string, (...args: never[]) => unknown>
    }));
    view.attach(window.document.body);
    try {
      onLoad.call(view.instance, { price_id: priceId });
      assert.ok(network, "Opening the detail route must query the public API");
      await network;
      await simulate.sleep(0);

      const text = view.dom?.textContent ?? "";
      assert.match(text, /5896\.00 元\/套/);
      assert.match(text, /湖南省医疗保障局/);
      assert.match(text, /Sheet1\s*·\s*第 5 行\s*·\s*G5/);
      const notice = view.querySelector("#copy-notice");
      const attachment = view.querySelector("#copy-attachment");
      assert.ok(notice && attachment);
      notice.dispatchEvent("tap");
      attachment.dispatchEvent("tap");
      await simulate.sleep(0);
      assert.deepEqual(copied, [
        "https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/t20240919_33458275.html",
        "https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202409/33458275/files/0ac80457057341528553dae98aee88b0.xls"
      ]);
    } finally {
      view.detach();
    }
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  }
}
