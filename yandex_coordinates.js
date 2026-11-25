(() => {
  function read(doc) {
    const coordinates = new Map();
    for (const script of doc.querySelectorAll('script[type="application/json"]')) {
      let stack;
      try { stack = JSON.parse(script.textContent)?.stack; } catch { continue; }
      if (!Array.isArray(stack)) continue;
      for (const entry of stack) {
        const items = entry?.results?.items;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          if (item?.type !== "business") continue;
          const uriId = /^ymapsbm1:\/\/org\?oid=(\d+)(?:&|$)/.exec(item.uri || "")?.[1];
          const id = String(item.id ?? uriId ?? "");
          if (!/^\d+$/.test(id) || (uriId && id !== uriId)) continue;
          for (const pair of [item.coordinates, item.displayCoordinates]) {
            if (!Array.isArray(pair) || pair.length !== 2) continue;
            const [lon, lat] = pair;
            if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
                Math.abs(lat) > 90 || Math.abs(lon) > 180 || (!lat && !lon)) continue;
            coordinates.set(id, { lat, lon });
            break;
          }
        }
      }
    }
    return coordinates;
  }

  globalThis.MapsYandexCoordinates = Object.freeze({ read });
})();
