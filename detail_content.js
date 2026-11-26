(function initDetailWorker() {
  "use strict";

  const api = globalThis.browser || globalThis.chrome;
  const parser = globalThis.MapsDetailParser;
  const DEFAULT_TIMEOUT_MS = 25000;
  let activeRequest = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function pageLooksLikeCaptcha(text) {
    const url = String(location.href || "");
    text = text.slice(0, 5000);
    return /showcaptcha|captcha/i.test(url) || /\u044f\s+\u043d\u0435\s+\u0440\u043e\u0431\u043e\u0442|\u0432\u0432\u0435\u0434\u0438\u0442\u0435\s+\u0441\u0438\u043c\u0432\u043e\u043b\u044b|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435,?\s+\u0447\u0442\u043e\s+\u0432\u044b\s+\u043d\u0435\s+\u0440\u043e\u0431\u043e\u0442/i.test(text);
  }

  function pageIsRateLimited(pageText) {
    const text = pageText.replace(/\s+/g, " ").trim().toLowerCase();
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

  async function expandCardSections(deadline) {
    const workingHoursControl = document.querySelector(".business-working-status-flip-view._clickable");
    if (!workingHoursControl) return;
    try {
      workingHoursControl.click();
      for (let attempt = 0; attempt < 8 && Date.now() < deadline; attempt += 1) {
        const pageText = String(document.body?.innerText || "");
        if (/\u043f\u043e\u043d\u0435\u0434\u0435\u043b\u044c\u043d\u0438\u043a|\u0432\u043e\u0441\u043a\u0440\u0435\u0441\u0435\u043d\u044c\u0435/i.test(pageText)) break;
        await sleep(250);
      }
    } catch {}
  }

  const featuresSelector = ".business-features-view._view_tab, .tabs-select-view__title._name_features";

  function waitForFeatureChange(timeout) {
    return new Promise((resolve) => {
      let debounce;
      const finish = () => {
        observer.disconnect();
        clearTimeout(fallback);
        clearTimeout(debounce);
        resolve();
      };
      const observer = new MutationObserver((mutations) => {
        if (debounce) return;
        const relevant = mutations.some(({ target, addedNodes, removedNodes }) => {
          const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
          return element?.closest(featuresSelector) ||
            [...addedNodes, ...removedNodes].some((node) =>
              node.nodeType === Node.ELEMENT_NODE &&
              (node.matches(featuresSelector) || node.querySelector(featuresSelector)));
        });
        if (relevant) debounce = setTimeout(finish, 100);
      });
      const fallback = setTimeout(finish, timeout);
      observer.observe(document.body || document.documentElement, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ["aria-busy", "aria-selected", "class", "hidden", "style"]
      });
    });
  }

  async function waitForFeatures(deadline) {
    let clickedAt = -Infinity;
    let previousState = "";
    let stableSince = 0;
    let recognizablePanel = false;

    while (Date.now() < deadline) {
      const pageText = document.body?.innerText || document.title || "";
      if (pageLooksLikeCaptcha(pageText)) return { state: "captcha" };
      if (pageIsRateLimited(pageText)) return { state: "rate_limited" };
      const panel = document.querySelector(".business-features-view._view_tab");
      const activePanel = panel?.getClientRects().length ? panel : null;
      const control = document.querySelector(".tabs-select-view__title._name_features");
      const selected = new URL(location.href).searchParams.get("tab") === "features" ||
        control?.getAttribute("aria-selected") === "true";
      const now = Date.now();
      if (!activePanel && !selected && control && now - clickedAt >= 1500) {
        control.click();
        clickedAt = now;
      }

      const loading = activePanel?.matches('[aria-busy="true"]') ||
        activePanel?.querySelector('[aria-busy="true"], .business-features-view__loader');
      const attributes = activePanel && !loading ? parser.parseAttributePairs(activePanel) : {};
      const empty = activePanel && !loading && activePanel.querySelector(".business-features-view__empty")?.textContent.trim();
      recognizablePanel = Boolean(activePanel && !loading && activePanel.textContent.trim());
      const state = Object.keys(attributes).length ? JSON.stringify(attributes) : empty ? "empty" : "";
      if (state !== previousState) {
        previousState = state;
        stableSince = now;
      } else if (state && now - stableSince >= 500) {
        return { state: state === "empty" ? "empty" : "collected", attributes };
      }
      if (!control && !activePanel && !selected && document.readyState === "complete" &&
          document.querySelector(".tabs-select-view__title._name_overview") && now >= deadline - 100) {
        return { state: "unavailable" };
      }
      const nextCheck = state ? Math.max(100, stableSince + 500 - Date.now()) : 1000;
      await waitForFeatureChange(Math.max(0, Math.min(nextCheck, deadline - Date.now())));
    }
    if (!document.querySelector(featuresSelector) &&
        new URL(location.href).searchParams.get("tab") !== "features" &&
        document.readyState === "complete" && document.querySelector(".tabs-select-view__title._name_overview")) {
      return { state: "unavailable" };
    }
    return { state: recognizablePanel ? "unrecognized" : "timeout" };
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

  async function waitForCard(deadline) {
    let stableChecks = 0;
    while (Date.now() < deadline) {
      const pageText = document.body?.innerText || document.title || "";
      if (pageLooksLikeCaptcha(pageText)) return { captcha: true };
      if (pageIsRateLimited(pageText)) return { rate_limited: true };
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

    const startedAt = Date.now();
    const deadline = startedAt + Math.max(5000, Number(message.timeout_ms) || DEFAULT_TIMEOUT_MS);
    const readiness = await waitForCard(deadline);
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

    const pageLoadMs = Math.max(0, Math.round(Date.now() - performance.timeOrigin));
    await expandCardSections(deadline);
    const overviewResult = parser.parseDocument(document, location.href);
    const coordinates = globalThis.MapsYandexCoordinates?.read(document).get(expectedOrgId || actualOrgId);
    const featuresStartedAt = performance.now();
    const features = await waitForFeatures(deadline);
    const featureReadMs = Math.round(performance.now() - featuresStartedAt);
    if (features.state === "captcha" || features.state === "rate_limited") {
      return { ok: false, status: features.state, url: location.href };
    }
    const finalOrgId = parser.orgIdFromUrl(location.href);
    if (expectedOrgId && finalOrgId !== expectedOrgId) {
      throw new Error(`Открыта другая организация: ${finalOrgId || "ID не найден"} вместо ${expectedOrgId}`);
    }
    const featureResult = features.state === "collected"
      ? parser.parseDocument(document, location.href, features.attributes) : overviewResult;
    const result = { ...mergeParseResults(overviewResult, featureResult), ...coordinates, feature_state: features.state };
    if (!result.title && !result.address) throw new Error("\u0412 \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0435 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u044b \u043e\u0441\u043d\u043e\u0432\u043d\u044b\u0435 \u043f\u043e\u043b\u044f");
    const timings = { page_load_ms: pageLoadMs, features_ms: featureReadMs };
    result.duration_ms = Date.now() - startedAt;
    if (features.state === "timeout" || features.state === "unrecognized") {
      const error = features.state === "timeout" ? "Раздел «Особенности» не загрузился за отведённое время" : "Разметка «Особенностей» не распознана";
      return { ok: false, status: "partial", result, timings, error, url: location.href };
    }
    return { ok: true, status: "success", result, timings };
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ENRICHMENT_PING") {
      sendResponse({ ok: true, org_id: parser?.orgIdFromUrl(location.href) || "", url: location.href });
      return;
    }
    if (message?.type !== "ENRICHMENT_PARSE_DETAIL") return;

    const requestKey = `${message.run_id || ""}:${message.object_key || ""}:${message.attempt || ""}:${message.assigned_at || ""}`;
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
