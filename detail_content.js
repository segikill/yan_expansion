(function initDetailWorker() {
  "use strict";

  const api = globalThis.browser || globalThis.chrome;
  const parser = globalThis.MapsDetailParser;
  const DEFAULT_TIMEOUT_MS = 25000;
  let activeRequest = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function pageLooksLikeCaptcha() {
    const url = String(location.href || "");
    const text = String(document.body?.innerText || document.title || "").slice(0, 5000);
    return /showcaptcha|captcha/i.test(url) || /\u044f\s+\u043d\u0435\s+\u0440\u043e\u0431\u043e\u0442|\u0432\u0432\u0435\u0434\u0438\u0442\u0435\s+\u0441\u0438\u043c\u0432\u043e\u043b\u044b|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435,?\s+\u0447\u0442\u043e\s+\u0432\u044b\s+\u043d\u0435\s+\u0440\u043e\u0431\u043e\u0442/i.test(text);
  }

  function pageIsRateLimited() {
    const text = String(document.body?.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
    return text === "limited" || text === "too many requests" || /temporarily limited/i.test(text);
  }

  function hasUsefulCard() {
    return Boolean(
      document.querySelector("h1") ||
      document.querySelector(".orgpage-header-view__header") ||
      document.querySelector('[class*="business-contacts-view"]') ||
      document.querySelector('script[type="application/ld+json"]')
    );
  }

  async function expandCardSections() {
    const workingHoursControl = document.querySelector(".business-working-status-flip-view._clickable");
    if (!workingHoursControl) return;
    try {
      workingHoursControl.click();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const pageText = String(document.body?.innerText || "");
        if (/\u043f\u043e\u043d\u0435\u0434\u0435\u043b\u044c\u043d\u0438\u043a|\u0432\u043e\u0441\u043a\u0440\u0435\u0441\u0435\u043d\u044c\u0435/i.test(pageText)) break;
        await sleep(250);
      }
    } catch {}
  }

  async function openFeaturesTab() {
    const panelSelector = ".business-features-view._view_tab";
    const control = document.querySelector(".tabs-select-view__title._name_features");
    const alreadyOpened = document.querySelector(panelSelector) ||
      new URL(location.href).searchParams.get("tab") === "features";
    if (!alreadyOpened && !control) return false;
    if (!alreadyOpened) control.click();

    let previousState = "";
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const panel = document.querySelector(panelSelector);
      const rows = panel?.querySelectorAll(".business-features-view__valued, .business-features-view__bool-item, [class*='business-features-view__feature'], [class*='business-features-view__group'] li");
      const text = Array.from(rows || [], (row) => row.textContent.trim()).filter(Boolean).join("\n");
      const emptyNotice = panel?.querySelector(".business-features-view__empty")?.textContent.trim();
      const state = text ? `rows:${text}` : emptyNotice ? `empty:${emptyNotice}` : "";
      const ready = state && panel.getAttribute("aria-busy") !== "true";
      if (ready && state === previousState) return Boolean(text);
      previousState = ready ? state : "";
      await sleep(250);
    }
    throw new Error("Раздел «Особенности» не загрузился за отведённое время");
  }

  function mergeParseResults(overview, features) {
    const merged = { ...features };
    const preferOverview = [
      "title", "address", "websites", "phones", "rating", "reviews", "opening_hours", "working_status",
      "close_time", "description", "social_links"
    ];
    for (const key of preferOverview) {
      const value = merged[key];
      if ((!value || (Array.isArray(value) && !value.length)) && overview[key]) merged[key] = overview[key];
    }
    merged.categories = Array.from(new Set([...(overview.categories || []), ...(features.categories || [])]));
    merged.categories_all = merged.categories;
    merged.category_first = merged.categories[0] || "";
    merged.category_data = {
      ...(features.category_data || overview.category_data || {}),
      raw_attributes: {
        ...(overview.category_data?.raw_attributes || {}),
        ...(features.category_data?.raw_attributes || {})
      }
    };
    return merged;
  }

  async function waitForCard(timeoutMs) {
    const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    let stableChecks = 0;
    while (Date.now() < deadline) {
      if (pageLooksLikeCaptcha()) return { captcha: true };
      if (pageIsRateLimited()) return { rate_limited: true };
      if (hasUsefulCard()) {
        stableChecks += 1;
        if (stableChecks >= 2) return { ready: true };
      } else {
        stableChecks = 0;
      }
      await sleep(500);
    }
    return { timeout: true };
  }

  async function parseTask(message) {
    if (!parser) throw new Error("detail_parser.js \u043d\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043d");
    const actualOrgId = parser.orgIdFromUrl(location.href);
    const expectedOrgId = String(message.org_id || "");
    if (expectedOrgId && actualOrgId && expectedOrgId !== actualOrgId) {
      throw new Error(`\u041e\u0442\u043a\u0440\u044b\u0442\u0430 \u0434\u0440\u0443\u0433\u0430\u044f \u043e\u0440\u0433\u0430\u043d\u0438\u0437\u0430\u0446\u0438\u044f: ${actualOrgId} \u0432\u043c\u0435\u0441\u0442\u043e ${expectedOrgId}`);
    }

    const readiness = await waitForCard(message.timeout_ms);
    if (readiness.captcha) return { ok: false, status: "captcha", url: location.href };
    if (readiness.rate_limited) {
      return {
        ok: false,
        status: "rate_limited",
        error: "\u042f\u043d\u0434\u0435\u043a\u0441 \u0432\u0440\u0435\u043c\u0435\u043d\u043d\u043e \u043e\u0433\u0440\u0430\u043d\u0438\u0447\u0438\u043b \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0443 \u0441\u0442\u0440\u0430\u043d\u0438\u0446",
        url: location.href
      };
    }
    if (readiness.timeout) throw new Error("\u041a\u0430\u0440\u0442\u043e\u0447\u043a\u0430 \u043e\u0440\u0433\u0430\u043d\u0438\u0437\u0430\u0446\u0438\u0438 \u043d\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043b\u0430\u0441\u044c \u0437\u0430 \u043e\u0442\u0432\u0435\u0434\u0451\u043d\u043d\u043e\u0435 \u0432\u0440\u0435\u043c\u044f");

    await expandCardSections();
    const startedAt = Date.now();
    const overviewResult = parser.parseDocument(document, location.href);
    const featuresReady = await openFeaturesTab();
    const featureResult = featuresReady ? parser.parseDocument(document, location.href) : overviewResult;
    const result = mergeParseResults(overviewResult, featureResult);
    if (!result.title && !result.address) throw new Error("\u0412 \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0435 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u044b \u043e\u0441\u043d\u043e\u0432\u043d\u044b\u0435 \u043f\u043e\u043b\u044f");
    result.duration_ms = Date.now() - startedAt;
    return { ok: true, status: "success", result };
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ENRICHMENT_PING") {
      sendResponse({ ok: true, org_id: parser?.orgIdFromUrl(location.href) || "", url: location.href });
      return;
    }
    if (message?.type !== "ENRICHMENT_PARSE_DETAIL") return;

    const requestKey = `${message.run_id || ""}:${message.object_key || ""}:${message.attempt || ""}`;
    if (!activeRequest || activeRequest.key !== requestKey) {
      activeRequest = {
        key: requestKey,
        promise: parseTask(message).catch((error) => ({
          ok: false,
          status: "error",
          error: String(error?.message || error),
          url: location.href
        }))
      };
    }
    activeRequest.promise.then(sendResponse);
    return true;
  });

  function announceReady() {
    try {
      Promise.resolve(api.runtime.sendMessage({
        type: "ENRICHMENT_WORKER_READY",
        org_id: parser?.orgIdFromUrl(location.href) || "",
        url: location.href
      })).catch(() => {});
    } catch {}
  }

  announceReady();
  setInterval(announceReady, 15000);
})();
