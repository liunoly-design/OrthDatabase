import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { PublishedPriceSnapshot } from "../contracts/price-v1.d.ts";

export async function checkWebPricePage(base: string, sample: PublishedPriceSnapshot) {
  const home = await fetch(base);
  assert.equal(home.status, 200);
  const { window: homeWindow } = new JSDOM(await home.text(), { url: home.url });
  const form = homeWindow.document.querySelector<HTMLFormElement>("form");
  const code = form?.querySelector<HTMLInputElement>("input");
  assert.ok(form && code);
  assert.equal(form.method, "get");
  code.value = sample.price_id;
  const searchUrl = new URL(form.action);
  for (const [key, value] of new homeWindow.FormData(form)) {
    searchUrl.searchParams.append(key, String(value));
  }
  homeWindow.close();

  const response = await fetch(searchUrl);
  assert.equal(response.status, 200);
  assert.equal(response.url, `${base}/prices/${sample.price_id}`);
  const { window } = new JSDOM(await response.text(), { url: response.url, runScripts: "outside-only" });
  try {
    const { document } = window;
    const script = document.querySelector<HTMLScriptElement>("script[src]");
    assert.ok(script);
    const scriptResponse = await fetch(script.src);
    assert.equal(scriptResponse.status, 200);
    Reflect.deleteProperty(window.URL, "parse");
    const requested: string[] = [];
    window.fetch = (input: string) => {
      const url = new URL(input, window.location.href);
      requested.push(url.href);
      return fetch(url);
    };
    await window.eval(await scriptResponse.text());

    assert.deepEqual(requested, [`${base}/api/v1/prices/${sample.price_id}`]);
    const text = document.body.textContent;
    assert.match(text, /5896\.00 元\/套/);
    assert.ok(text.includes("湖南省医疗保障局"));
    assert.match(text, /Sheet1\s*·\s*第 5 行\s*·\s*G5/);
    const visibleLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .filter((link) => !link.closest("[hidden]"))
      .map((link) => link.href);
    assert.ok(visibleLinks.includes(sample.source.notice_url));
    assert.ok(visibleLinks.includes(sample.source.attachment_url));
  } finally {
    window.close();
  }
}
