(function init2gisDetailBridge() {
  "use strict";
  if (window.__MAPS_EXPORT_2GIS_DETAIL_BRIDGE__) return;
  window.__MAPS_EXPORT_2GIS_DETAIL_BRIDGE__ = true;

  const pending = new Map();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function findEmbeddedItem(targetId) {
    const queue = [window.initialState, window.__REACT_QUERY_STATE__];
    const seen = new WeakSet();
    for (let index = 0; index < queue.length && index < 100000; index += 1) {
      const value = queue[index];
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      const id = String(value.id || value.branch_id || value.firm_id || "").match(/^\d+/)?.[0] || "";
      if (id === targetId && (value.name || value.title || value.attribute_groups || value.schedule || value.reviews)) return value;
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === "object") queue.push(child);
      } else {
        for (const child of Object.values(value)) if (child && typeof child === "object") queue.push(child);
      }
    }
    return null;
  }

  async function fetchItem(targetId) {
    const embeddedDeadline = Date.now() + 6000;
    let embedded = findEmbeddedItem(targetId);
    while (!embedded && Date.now() < embeddedDeadline) {
      await sleep(150);
      embedded = findEmbeddedItem(targetId);
    }
    if (embedded) return { item: embedded, request_url: "embedded:initialState" };
    throw new Error("Встроенный объект карточки 2ГИС не найден в initialState");
  }

  window.addEventListener("message", (event) => {
    const message = event?.data || {};
    if (!message.__MAPS_EXPORT_2GIS_DETAIL_REQUEST__) return;
    const targetId = String(message.org_id || "").match(/^\d{10,}$/)?.[0] || "";
    const requestId = String(message.request_id || "");
    if (!targetId || !requestId) return;
    let task = pending.get(targetId);
    if (!task) {
      task = fetchItem(targetId).finally(() => pending.delete(targetId));
      pending.set(targetId, task);
    }
    task.then((result) => window.postMessage({
      __MAPS_EXPORT_2GIS_DETAIL_RESPONSE__: true,
      request_id: requestId,
      org_id: targetId,
      ...result
    }, "*")).catch((error) => window.postMessage({
      __MAPS_EXPORT_2GIS_DETAIL_RESPONSE__: true,
      request_id: requestId,
      org_id: targetId,
      error: String(error?.message || error)
    }, "*"));
  });
})();
