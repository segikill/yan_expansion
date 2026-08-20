(function () {
  if (window.__ym_interceptor__) return;
  window.__ym_interceptor__ = true;

  function report(kind, url, html) {
    try {
      window.postMessage({
        __YMAPS_INTERCEPT__: true,
        kind, url, html
      }, "*");
    } catch {}
  }

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ymi_url = String(url || "");
    return XO.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      this.addEventListener("load", () => {
        try {
          const url = this.__ymi_url || "";
          if (!/\/maps\/org\//.test(url)) return;
          const ctype = this.getResponseHeader && this.getResponseHeader("content-type");
          const isHtml = !this.responseType || this.responseType === "" || this.responseType === "text";
          if (isHtml && (!ctype || /text\/html/i.test(ctype))) {
            const html = String(this.responseText || "");
            if (html) report("org_html", url, html);
          }
        } catch {}
      }, { once: true });
    } catch {}
    return XS.apply(this, args);
  };
})();
