(function init2gisDetailWorker() {
  "use strict";

  const api = globalThis.browser || globalThis.chrome;
  const parser = globalThis.Maps2gisDetailParser;
  let activeRequest = null;
  let bridgePromise = null;

  function injectBridge() {
    if (bridgePromise) return bridgePromise;
    bridgePromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = api.runtime.getURL("two_gis_detail_bridge.js");
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); resolve(); };
      (document.head || document.documentElement).appendChild(script);
    });
    return bridgePromise;
  }

  function pageLooksBlocked() {
    const text = String(document.body?.innerText || "").toLowerCase();
    return /captcha|слишком много запросов|too many requests|temporarily limited/.test(`${location.href} ${text.slice(0, 5000)}`);
  }

  async function requestStructuredItem(orgId, timeoutMs) {
    await injectBridge();
    const requestId = `detail_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { window.removeEventListener("message", onMessage); resolve(null); }, Math.min(20000, Math.max(5000, timeoutMs - 2000)));
      function onMessage(event) {
        const message = event?.data || {};
        if (!message.__MAPS_EXPORT_2GIS_DETAIL_RESPONSE__ || message.request_id !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        const id = String(message.item?.id || "").match(/^\d+/)?.[0] || "";
        resolve(id === orgId ? message.item : null);
      }
      window.addEventListener("message", onMessage);
      window.postMessage({ __MAPS_EXPORT_2GIS_DETAIL_REQUEST__: true, request_id: requestId, org_id: orgId }, "*");
    });
  }

  async function waitForDom(timeoutMs) {
    const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 25000);
    while (Date.now() < deadline) {
      if (pageLooksBlocked()) return false;
      const text = String(document.body?.innerText || "");
      if (text.length > 300 && (/инфо/i.test(text) || document.querySelector("h1"))) return true;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return false;
  }

  async function parseTask(message) {
    if (!parser) throw new Error("two_gis_detail_parser.js не загружен");
    const expected = String(message.org_id || "");
    const actual = parser.orgIdFromUrl(location.href);
    if (expected && actual && expected !== actual) throw new Error(`Открыт объект ${actual} вместо ${expected}`);
    const timeoutMs = Math.max(10000, Number(message.timeout_ms) || 25000);
    const [domReady, item] = await Promise.all([waitForDom(timeoutMs), requestStructuredItem(expected || actual, timeoutMs)]);
    if (pageLooksBlocked()) return { ok: false, status: "rate_limited", error: "2ГИС временно ограничил загрузку страницы", url: location.href };
    if (!domReady && !item) throw new Error("Карточка 2ГИС не загрузилась за отведённое время");
    const startedAt = Date.now();
    const result = parser.parseDocument(document, location.href, item);
    if (!result.title && !result.address) throw new Error("В карточке 2ГИС не найдены основные поля");
    result.duration_ms = Date.now() - startedAt;
    return { ok: true, status: "success", result };
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ENRICHMENT_PING") {
      sendResponse({ ok: true, org_id: parser?.orgIdFromUrl(location.href) || "", source: "2gis", url: location.href });
      return;
    }
    if (message?.type !== "ENRICHMENT_PARSE_DETAIL" || message?.source !== "2gis") return;
    const requestKey = `${message.run_id || ""}:${message.object_key || ""}:${message.attempt || ""}`;
    if (!activeRequest || activeRequest.key !== requestKey) {
      activeRequest = { key: requestKey, promise: parseTask(message).catch((error) => ({ ok: false, status: "error", error: String(error?.message || error), url: location.href })) };
    }
    activeRequest.promise.then(sendResponse);
    return true;
  });

  function announceReady() {
    try {
      Promise.resolve(api.runtime.sendMessage({ type: "ENRICHMENT_WORKER_READY", source: "2gis", org_id: parser?.orgIdFromUrl(location.href) || "", url: location.href })).catch(() => {});
    } catch {}
  }
  announceReady();
  setInterval(announceReady, 15000);
})();
