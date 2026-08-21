// Инжектируется в страницу. Не имеет доступа к chrome.*, общение — через window.postMessage.
(function () {
  if (window.__ym_sniffer__) return;
  window.__ym_sniffer__ = true;

  // kind:
  //  - "org_html"   : Yandex org page html (payload = html string)
  //  - "2gis_json"  : 2GIS search/items json (payload = parsed json)
  function report(kind, url, payload) {
    try {
      const msg = { __YMAPS_INTERCEPT__: true, kind, url };
      if (kind === "org_html") msg.html = payload;
      else msg.payload = payload;
      window.postMessage(msg, "*");
    } catch {}
  }

  function looksLike2gisSearch(url, ctype) {
    if (!url) return false;
    const u = String(url);
    if (!/2gis\./i.test(u)) return false;
    if (!/json/i.test(String(ctype || ""))) return false;
    // Перехватываем только выдачу организаций и карточку по ID. Раньше
    // любое JSON catalog.api попадало в кэш, включая рубрики и геообъекты.
    return /catalog\.api\.2gis\.[^/]+\/[^?#]*\/items(?:\/byid)?(?:[/?#]|$)/i.test(u);
  }

  // ---- fetch ----
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    try {
      const url = String(res.url || (args[0] && args[0].url) || args[0] || "");

      // Yandex org page HTML
      if (/\/maps\/org\//.test(url) && res.ok && res.headers.get("content-type")?.includes("text/html")) {
        const clone = res.clone();
        const text = await clone.text();
        report("org_html", url, text);
        return res;
      }

      // 2GIS JSON search/items
      const ctype = res.headers.get("content-type") || "";
      if (res.ok && looksLike2gisSearch(url, ctype)) {
        const clone = res.clone();
        const text = await clone.text();
        try {
          const json = JSON.parse(text);
          report("2gis_json", url, json);
        } catch {
          // ignore
        }
      }
    } catch {}
    return res;
  };

  // ---- XHR ----
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ym_url = String(url || "");
    return XO.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      this.addEventListener(
        "load",
        () => {
          try {
            const url = this.__ym_url || "";
            const ctype = this.getResponseHeader && this.getResponseHeader("content-type");
            const isTextLike = !this.responseType || this.responseType === "" || this.responseType === "text";

            // Yandex org page HTML
            if (/\/maps\/org\//.test(url)) {
              if (isTextLike && (!ctype || /text\/html/i.test(ctype))) {
                const html = String(this.responseText || "");
                if (html) report("org_html", url, html);
              }
              return;
            }

            // 2GIS JSON search/items
            if (isTextLike && looksLike2gisSearch(url, ctype)) {
              const text = String(this.responseText || "");
              if (!text) return;
              try {
                const json = JSON.parse(text);
                report("2gis_json", url, json);
              } catch {
                // ignore
              }
            }
          } catch {}
        },
        { once: true }
      );
    } catch {}
    return XS.apply(this, args);
  };
})();
