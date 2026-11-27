(() => {
  "use strict";

  const parser = globalThis.MapsTravelParser;
  const runtime = (globalThis.browser || globalThis.chrome)?.runtime;
  if (!parser || !runtime) return;

  const source = "travel";
  const columns = [
    "source", "org_id", "title", "rating", "reviews", "category_first", "categories_all", "address",
    "star_rating", "min_price", "currency", "distance_to_center", "photos_count", "lat", "lon", "url"
  ];
  const collect = () => parser.collect(document, location.href);
  function context() {
    const url = new URL(location.href);
    const map_state = {};
    for (const key of ["bbox", "geoId", "checkinDate", "checkoutDate", "adults", "roomCount", "navigationToken"]) {
      const value = url.searchParams.get(key);
      if (value) map_state[key] = value;
    }
    return {
      source, title: document.title || "", page_url: url.href,
      query: String(document.querySelector("h1")?.textContent || "").trim(),
      map_state, captured_at: new Date().toISOString()
    };
  }
  window.__MAPS_EXPORT_COLLECTOR__ = { source, columns, collect, context };

  let activeRequest;
  async function parseTask(message) {
    const started = Date.now();
    const timeout = Math.max(1000, Number(message.timeout_ms) || 25000);
    const deadline = started + timeout;
    let partial;
    do {
      const challenge = document.querySelector('form[action*="/showcaptcha"], iframe[src*="smartcaptcha.yandex"]');
      if (/\/showcaptcha(?:\/|$)/i.test(location.pathname) || challenge?.getClientRects().length) {
        return { ok: false, status: "captcha", error: "Яндекс Путешествия запросили проверку", url: location.href };
      }
      const current = parser.hotelRef(location.href);
      if (current && message.org_id && message.org_id !== current.org_id) {
        throw new Error(`Открыта другая карточка Яндекс Путешествий: ${current.org_id}`);
      }
      const detail = current ? parser.parseDocument(document, location.href) : null;
      if (detail?.title) {
        partial = detail;
        if (detail.feature_state === "collected" || (document.readyState === "complete" && detail.address && Date.now() - started >= 1400)) {
          detail.duration_ms = Date.now() - started;
          return { ok: true, status: "success", result: detail };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    } while (Date.now() < deadline);
    if (partial) {
      return { ok: false, status: "partial", error: "Не все разделы карточки Яндекс Путешествий загрузились", result: partial };
    }
    throw new Error("Карточка Яндекс Путешествий не найдена или не загрузилась");
  }

  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case "PING":
        sendResponse({ ok: true });
        return;
      case "GET_CONTEXT":
        sendResponse({ ok: true, context: context() });
        return;
      case "COLLECT":
        try { sendResponse({ ok: true, rows: collect(), columns }); }
        catch (error) { sendResponse({ ok: false, error: String(error?.message || error), rows: [], columns }); }
        return;
      case "ENRICHMENT_PING":
        sendResponse({ ok: true, source, org_id: parser.hotelRef(location.href)?.org_id || "", url: location.href });
        return;
      case "ENRICHMENT_PARSE_DETAIL":
        if (message.source !== source) return;
        break;
      default:
        return;
    }
    const key = [message.run_id, message.object_key, message.attempt, message.assigned_at].join(":");
    if (activeRequest?.key !== key) {
      activeRequest = {
        key,
        response: parseTask(message).catch((error) => ({ ok: false, status: "error", error: String(error?.message || error), url: location.href }))
      };
    }
    activeRequest.response.then(sendResponse);
    return true;
  });

  function announceReady() {
    const ref = parser.hotelRef(location.href);
    if (ref) {
      Promise.resolve(runtime.sendMessage({ type: "ENRICHMENT_WORKER_READY", source, org_id: ref.org_id, url: location.href })).catch(() => {});
    }
  }
  announceReady();
  setInterval(announceReady, 15000);
})();
