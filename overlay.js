(() => {
  if (window.__mapsExportOverlayV190__) return;
  window.__mapsExportOverlayV190__ = true;

  const STORAGE_KEY = "maps_export_session_v2";
  const PREFS_KEY = "maps_export_overlay_prefs_v1";
  const ENRICHMENT_JOB_KEY = "maps_export_enrichment_job_v1";
  const THEME_KEY = "maps_export_ui_theme_v1";

  const BASE_COLS = [
    "org_id", "title", "rating", "reviews",
    "categories_all", "address",
    "photos_count", "lat", "lon",
    "url", "scraped_at"
  ];

  const OBJECT_COLS = [
    "object_key", "source", "org_id", "title", "rating", "reviews",
    "categories_all", "address", "photos_count",
    "lat", "lon", "url"
  ];

  const TRAVEL_COLS = {
    "Цена за ночь, ₽": "nightly_price",
    "Номер в предложении": "room",
    "Заезд для цены": "checkin",
    "Выезд для цены": "checkout",
    "Взрослых для цены": "adults",
    "Возраст детей для цены": "children_ages",
    "Номеров в поиске": "rooms"
  };

  let session = emptySession();
  let lastRows = [];
  let lastSnapshot = null;
  let busy = false;
  let shadow = null;
  let els = {};
  let collectTimer = null;
  let autoTimer = null;
  let gis2ScanState = null;
  let sharedTheme = "theme-dark";

  function applySharedTheme(themeId) {
    const allowed = new Set(["theme-dark", "theme-gis", "theme-mission", "theme-bloomberg", "theme-linear", "theme-blueprint", "theme-scada", "theme-neon", "theme-light"]);
    sharedTheme = allowed.has(themeId) ? themeId : "theme-dark";
    if (els.host) els.host.dataset.theme = sharedTheme;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function emptySession() {
    const now = nowIso();
    return {
      id: `session_${Date.now()}`,
      version: 2,
      created_at: now,
      updated_at: now,
      objects: {},
      snapshots: [],
      observations: []
    };
  }

  function getCollector() {
    return window.__MAPS_EXPORT_COLLECTOR__ || null;
  }

  function sourceLabel(source) {
    if (source === "travel") return "Яндекс Путешествия";
    return source === "yandex" ? "Yandex" :
      source === "google" ? "Google" :
      source === "2gis" ? "2GIS" : "Maps";
  }

  function sanitizeCount(v) {
    const s = String(v ?? "").trim();
    if (!s) return "";
    const n = parseInt(s.replace(/\D/g, ""), 10);
    if (!Number.isFinite(n) || n < 0 || n > 10000000) return "";
    return n;
  }

  function normalizeCoord(v) {
    const value = String(v ?? "").trim();
    if (!value) return "";
    const n = Number(value.replace(",", "."));
    return Number.isFinite(n) ? n : "";
  }

  function normalizeCoordinatePair(row) {
    const lat = normalizeCoord(row?.lat);
    const lon = normalizeCoord(row?.lon);
    if (lat === "" || lon === "" || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (!lat && !lon)) {
      return { lat: "", lon: "" };
    }
    return { lat, lon };
  }

  function normalizeRating(v) {
    const s = String(v ?? "").replace(".", ",").replace(/[^0-9,]/g, "").trim();
    if (!s) return "";
    const n = Number(s.replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 5) return "";
    return n.toFixed(1).replace(".", ",");
  }

  function normalizeRow(r, source) {
    const row = { ...(r || {}) };
    row.org_id = String(row.org_id ?? "").trim();
    row.title = String(row.title ?? "").replace(/\s+/g, " ").trim();
    row.rating = normalizeRating(row.rating);
    row.reviews = sanitizeCount(row.reviews);
    row.categories_all = String(row.categories_all ?? "").replace(/\s+/g, " ").trim();
    row.address = String(row.address ?? "").replace(/\s+/g, " ").trim();
    row.photos_count = sanitizeCount(row.photos_count);
    Object.assign(row, normalizeCoordinatePair(row));
    row.url = String(row.url ?? "").trim();
    row.scraped_at = row.scraped_at || nowIso();
    row.source = source || "unknown";
    return row;
  }

  function hashString(str) {
    let h = 2166136261;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function makeObjectKey(source, row) {
    const orgId = String(row?.org_id || "").trim();

    if (source === "google") {
      if (orgId && !/^gmaps_\d+$/i.test(orgId)) return `google:${orgId}`;
      const stable = row?.url || `${row?.title || ""}|${row?.lat || ""}|${row?.lon || ""}|${row?.address || ""}`;
      return stable.trim() ? `google:hash_${hashString(stable)}` : "";
    }

    if (orgId) return `${source}:${orgId}`;

    const fallback = row?.url || `${row?.title || ""}|${row?.lat || ""}|${row?.lon || ""}|${row?.address || ""}`;
    return fallback.trim() ? `${source}:hash_${hashString(fallback)}` : "";
  }

  function mergeObject(oldObj, newObj, snapshot) {
    const merged = { ...oldObj };

    for (const key of BASE_COLS) {
      if (key === "lat" || key === "lon") continue;
      const v = newObj[key];
      if (v !== "" && v != null) merged[key] = v;
    }

    const point = normalizeCoordinatePair(newObj);
    Object.assign(merged, point.lat === "" ? normalizeCoordinatePair(oldObj) : point);
    if (newObj.travel_offer) merged.travel_offer = newObj.travel_offer;
    if (newObj.room_count) merged.room_count = newObj.room_count;
    merged.source = oldObj.source || newObj.source;
    merged.last_snapshot_id = snapshot.snapshot_id;
    merged.last_seen_at = snapshot.created_at;
    merged.seen_count = Number(oldObj.seen_count || 0) + 1;

    const ids = new Set(Array.isArray(oldObj.snapshot_ids)
      ? oldObj.snapshot_ids
      : String(oldObj.snapshot_ids || "").split(" | ").filter(Boolean));
    ids.add(snapshot.snapshot_id);
    merged.snapshot_ids = Array.from(ids);

    return merged;
  }

  async function loadSession() {
    const obj = await chrome.storage.local.get(STORAGE_KEY);
    applyStoredSession(obj?.[STORAGE_KEY]);
    if (!obj?.[STORAGE_KEY]) await saveSession();
  }

  function applyStoredSession(s) {
    if (s && typeof s === "object" && s.objects && Array.isArray(s.snapshots)) {
      session = {
        ...emptySession(),
        ...s,
        objects: s.objects || {},
        snapshots: Array.isArray(s.snapshots) ? s.snapshots : [],
        observations: Array.isArray(s.observations) ? s.observations : []
      };
    } else {
      session = emptySession();
    }
    lastSnapshot = session.snapshots[session.snapshots.length - 1] || null;
  }

  async function saveSession() {
    session.updated_at = nowIso();
    await chrome.storage.local.set({ [STORAGE_KEY]: session });
  }

  function setBusy(flag) {
    busy = !!flag;
    for (const key of ["fix", "miniFix", "xlsx", "reset", "details"]) {
      if (els[key]) els[key].disabled = busy;
    }
    if (els.root) els.root.classList.toggle("busy", busy);
  }

  function setStatus(text) {
    if (els.status) els.status.textContent = text || "";
  }

  function update2gisControls(state) {
    const api = getCollector();
    const is2gis = api?.source === "2gis";
    if (els.gis2Tools) els.gis2Tools.hidden = !is2gis;
    if (!is2gis) return;

    gis2ScanState = state || api?.getScanState?.() || gis2ScanState || {};
    const running = !!gis2ScanState.running;
    const discovered = Number(gis2ScanState.discovered ?? gis2ScanState.cached ?? 0);
    const warmed = Number(gis2ScanState.warmed || 0);
    const withCoordinates = Number(gis2ScanState.withCoordinates ?? warmed);
    const withBaseData = Number(gis2ScanState.withBaseData ?? warmed);
    const failed = Number(gis2ScanState.failed || 0);
    const percent = discovered ? Math.min(100, Math.round((withCoordinates / discovered) * 100)) : 0;

    if (els.gis2Scan) {
      els.gis2Scan.textContent = running ? "Остановить автосбор" : "Автосбор страниц";
      els.gis2Scan.classList.toggle("is-running", running);
      els.gis2Scan.setAttribute("aria-pressed", String(running));
    }
    if (els.gis2Progress) els.gis2Progress.style.width = `${percent}%`;
    if (els.gis2ScanMeta) {
      const page = Number(gis2ScanState.page || 0);
      els.gis2ScanMeta.textContent = `${page ? `стр. ${page} · ` : ""}координаты ${withCoordinates}/${discovered} · база ${withBaseData}/${discovered}${failed ? ` · ошибок ${failed}` : ""}`;
    }
    if (running && gis2ScanState.message) setStatus(gis2ScanState.message);
  }

  async function toggle2gisAutoScan() {
    const api = getCollector();
    if (!api || api.source !== "2gis" || typeof api.startAutoScan !== "function") return;
    const state = api.getScanState?.() || {};
    if (state.running) {
      api.stopAutoScan?.();
      update2gisControls(api.getScanState?.());
      return;
    }

    try {
      setStatus("Запускаю автосбор 2ГИС…");
      update2gisControls({ ...state, running: true, message: "Запуск…" });
      const result = await api.startAutoScan({ maxPages: 50 });
      update2gisControls(result);
      await collectPreview(true);
      if (lastRows.length) await fixCurrentView();
      setStatus(result?.message || `Собрано ${lastRows.length} объектов`);
    } catch (error) {
      console.error("2GIS auto scan error:", error);
      setStatus(`Ошибка автосбора: ${String(error?.message || error)}`);
      update2gisControls(api.getScanState?.());
    }
  }

  function setOverlayCollapsed(collapsed) {
    els.root?.classList.toggle("collapsed", !!collapsed);
    els.collapse?.setAttribute("aria-expanded", String(!collapsed));
    els.expand?.setAttribute("aria-expanded", String(!collapsed));
  }

  function updateStats() {
    const total = Object.keys(session.objects || {}).length;
    const snaps = (session.snapshots || []).length;
    const source = getCollector()?.source || "unknown";

    if (els.current) els.current.textContent = String(lastRows.length);
    if (els.total) els.total.textContent = String(total);
    if (els.snapshots) els.snapshots.textContent = String(snaps);
    if (els.last) {
      const added = lastSnapshot?.added_count || 0;
      const duplicates = lastSnapshot?.duplicate_count || 0;
      els.last.textContent = lastSnapshot ? `+${added} / дублей ${duplicates}` : "нет фиксаций";
    }
    if (els.source) els.source.textContent = sourceLabel(source);
    if (els.miniNumbers) els.miniNumbers.textContent = `${lastRows.length} / ${total}`;
    update2gisControls();
  }

  async function collectPreview(silent = true) {
    const api = getCollector();
    if (!api || typeof api.collect !== "function") {
      lastRows = [];
      updateStats();
      if (!silent) setStatus("Коллектор не найден");
      return [];
    }

    try {
      const source = api.source || "unknown";
      const rawRows = await Promise.resolve(api.collect({ preview: true, autoScroll: false }));
      const rows = [];
      const seen = new Set();

      for (const raw of rawRows || []) {
        const row = normalizeRow(raw, source);
        const key = makeObjectKey(source, row);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        row.object_key = key;
        rows.push(row);
      }

      lastRows = rows;
      updateStats();
      if (!silent) setStatus(`Сейчас: ${rows.length}`);
      return rows;
    } catch (e) {
      console.warn("Maps Export preview error:", e);
      if (!silent) setStatus("Ошибка сбора");
      return lastRows;
    }
  }

  async function fixCurrentView() {
    if (busy) return;
    setBusy(true);
    setStatus("Фиксирую карточки…");
    try {
      const api = getCollector();
      const source = api?.source || "unknown";
      const rows = await collectPreview(true);

      if (!rows.length) {
        setStatus("На экране нет объектов");
        return;
      }

      const context = api && typeof api.context === "function"
        ? await Promise.resolve(api.context())
        : { source, query: "", page_url: location.href, map_state: {}, captured_at: nowIso() };

      const snapshot = {
        snapshot_id: `snap_${Date.now()}`,
        snapshot_index: session.snapshots.length + 1,
        source,
        query: context?.query || "",
        page_url: context?.page_url || location.href,
        center_lat: context?.map_state?.center_lat ?? "",
        center_lon: context?.map_state?.center_lon ?? "",
        zoom: context?.map_state?.zoom ?? "",
        ...(source === "travel" ? { navigation_token: context?.map_state?.navigationToken || "0" } : {}),
        collected_count: rows.length,
        added_count: 0,
        duplicate_count: 0,
        created_at: nowIso()
      };

      for (const row of rows) {
        const key = row.object_key || makeObjectKey(source, row);
        if (!key) continue;

        if (!session.objects[key]) {
          session.objects[key] = {
            ...row,
            object_key: key,
            source,
            first_snapshot_id: snapshot.snapshot_id,
            last_snapshot_id: snapshot.snapshot_id,
            snapshot_ids: [snapshot.snapshot_id],
            seen_count: 1,
            first_seen_at: snapshot.created_at,
            last_seen_at: snapshot.created_at
          };
          snapshot.added_count++;
        } else {
          session.objects[key] = mergeObject(session.objects[key], row, snapshot);
          snapshot.duplicate_count++;
        }

        session.observations.push({
          snapshot_id: snapshot.snapshot_id,
          snapshot_index: snapshot.snapshot_index,
          object_key: key,
          source,
          org_id: row.org_id || "",
          title: row.title || "",
          lat: row.lat ?? "",
          lon: row.lon ?? "",
          url: row.url || "",
          seen_at: snapshot.created_at
        });
      }

      session.snapshots.push(snapshot);
      lastSnapshot = snapshot;
      await saveSession();
      updateStats();
      const page = source === "travel" ? Number(snapshot.navigation_token) / 50 + 1 : 0;
      setStatus(`Добавлено ${snapshot.added_count} · дублей ${snapshot.duplicate_count}${Number.isInteger(page) && page > 0 ? ` · стр. ${page}` : ""}`);
    } catch (e) {
      console.error("Maps Export fix error:", e);
      setStatus("Не удалось зафиксировать");
    } finally {
      setBusy(false);
    }
  }

  function normalizeForSheet(row, cols) {
    const out = {};
    for (const c of cols) {
      let v = row[c];
      if (Array.isArray(v)) v = v.join(" | ");
      out[c] = v == null ? "" : v;
    }
    return out;
  }

  function sheetFromRows(cols, rows) {
    const aoa = [cols];
    for (const r of rows) aoa.push(cols.map(c => {
      let v = r[c];
      if (Array.isArray(v)) v = v.join(" | ");
      return v == null ? "" : v;
    }));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = cols.map(c => ({ wch: Math.min(Math.max(String(c).length + 4, 10), 55) }));
    return ws;
  }

  function safeFilePart(v) {
    const s = String(v || "").trim();
    if (!s) return "";
    return s.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 80);
  }

  function exportSession() {
    if (typeof XLSX === "undefined") {
      alert("XLSX-библиотека не загружена. Перезагрузите страницу карты.");
      return;
    }

    const objects = Object.values(session.objects || {});
    if (!objects.length) {
      alert("Нет накопленных данных. Сначала нажмите «Зафиксировать».");
      return;
    }

    const wb = XLSX.utils.book_new();
    const columns = [...OBJECT_COLS];
    if (objects.some((row) => row.source === "travel")) columns.push(...Object.keys(TRAVEL_COLS), "Количество номеров");
    const rows = objects.map((object) => {
      const row = { ...object, ...normalizeCoordinatePair(object) };
      if (row.source !== "travel") return normalizeForSheet(row, columns);
      const offer = Object.fromEntries(Object.entries(TRAVEL_COLS).map(([label, key]) => [label, row.travel_offer?.[key]]));
      return normalizeForSheet({ ...row, ...offer, "Количество номеров": row.room_count }, columns);
    });
    XLSX.utils.book_append_sheet(wb, sheetFromRows(columns, rows), "objects");

    const ts = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const last = session.snapshots[session.snapshots.length - 1];
    const sourcePart = safeFilePart(last?.source || getCollector()?.source || "maps");
    const queryPart = safeFilePart(last?.query || "session");
    const fname = `maps_export_${sourcePart}_${queryPart}_${stamp}.xlsx`;

    if (typeof XLSX.writeFileXLSX === "function") {
      XLSX.writeFileXLSX(wb, fname, { compression: true });
    } else {
      XLSX.writeFile(wb, fname, { bookType: "xlsx", bookSST: true, compression: true });
    }
    setStatus("XLSX подготовлен к скачиванию");
  }

  async function clearSession() {
    if (!confirm("Сбросить базовую сессию, очередь и результаты досбора? Сначала скачайте нужные XLSX.")) return;
    const resetResponse = await chrome.runtime.sendMessage({ type: "ENRICHMENT_FORCE_RESET" });
    if (!resetResponse?.ok) {
      setStatus(resetResponse?.error || "Не удалось сбросить досбор");
      return;
    }
    const api = getCollector();
    if (api?.source === "2gis") {
      api.stopAutoScan?.();
      api.clear?.();
    }
    session = emptySession();
    lastSnapshot = null;
    await saveSession();
    updateStats();
    setStatus("Основная сессия и досбор сброшены");
  }

  async function loadPrefs() {
    try {
      const obj = await chrome.storage.local.get(PREFS_KEY);
      return obj?.[PREFS_KEY] || {};
    } catch {
      return {};
    }
  }

  async function savePrefs(patch) {
    try {
      const prefs = await loadPrefs();
      await chrome.storage.local.set({ [PREFS_KEY]: { ...prefs, ...patch } });
    } catch {}
  }

  function scheduleCollect() {
    clearTimeout(collectTimer);
    collectTimer = setTimeout(() => collectPreview(true), 900);
  }

  function bindDrag(host, handle) {
    let active = false;
    let sx = 0;
    let sy = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest("button")) return;
      if (ev.isPrimary === false || (ev.pointerType === "mouse" && ev.button !== 0)) return;
      active = true;
      sx = ev.clientX;
      sy = ev.clientY;
      const rect = host.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      host.style.left = `${startLeft}px`;
      host.style.top = `${startTop}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
      try { handle.setPointerCapture?.(ev.pointerId); } catch {}
      ev.preventDefault();
    });

    handle.addEventListener("pointermove", (ev) => {
      if (!active) return;
      const rect = host.getBoundingClientRect();
      const maxLeft = Math.max(8, window.innerWidth - Math.min(rect.width, window.innerWidth - 16) - 8);
      const maxTop = Math.max(8, window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8);
      const nextLeft = Math.max(8, Math.min(maxLeft, startLeft + ev.clientX - sx));
      const nextTop = Math.max(8, Math.min(maxTop, startTop + ev.clientY - sy));
      host.style.left = `${nextLeft}px`;
      host.style.top = `${nextTop}px`;
    });

    const finishDrag = async (ev) => {
      if (!active) return;
      active = false;
      const rect = host.getBoundingClientRect();
      await savePrefs({ left: rect.left, top: rect.top });
      try { handle.releasePointerCapture?.(ev.pointerId); } catch {}
    };
    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);
  }

  async function constrainHostToViewport(host) {
    const rect = host.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - Math.min(rect.width, window.innerWidth - 16) - 8);
    const maxTop = Math.max(8, window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8);
    const left = Math.max(8, Math.min(maxLeft, rect.left));
    const top = Math.max(8, Math.min(maxTop, rect.top));
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
    await savePrefs({ left, top });
  }

  async function renderOverlay() {
    if (document.getElementById("maps-export-overlay-host")) return;

    const host = document.createElement("div");
    host.id = "maps-export-overlay-host";
    host.style.position = "fixed";
    host.style.top = "88px";
    host.style.right = "18px";
    host.style.zIndex = "2147483647";
    host.style.fontFamily = "Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Arial, sans-serif";

    const prefs = await loadPrefs();
    try {
      const storedTheme = await chrome.storage.local.get(THEME_KEY);
      applySharedTheme(storedTheme?.[THEME_KEY]);
    } catch {}
    if (Number.isFinite(prefs.left) && Number.isFinite(prefs.top)) {
      host.style.left = `${prefs.left}px`;
      host.style.top = `${prefs.top}px`;
      host.style.right = "auto";
    }

    document.documentElement.appendChild(host);
    host.dataset.theme = sharedTheme;
    shadow = host.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .mx-panel {
          position: relative;
          width: 274px;
          color: #edf5ff;
          background:
            radial-gradient(circle at 8% -18%, rgba(55,214,255,.13), transparent 170px),
            linear-gradient(160deg, rgba(10,27,45,.96), rgba(5,14,25,.95));
          border: 1px solid rgba(138,165,197,.22);
          border-radius: 18px;
          box-shadow: 0 20px 52px rgba(0,0,0,.34), 0 0 34px rgba(55,214,255,.06), inset 0 1px rgba(255,255,255,.04);
          backdrop-filter: blur(18px) saturate(125%);
          overflow: hidden;
          user-select: none;
        }
        .mx-panel::before {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          opacity: .26;
          background-image: linear-gradient(rgba(120,160,200,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(120,160,200,.04) 1px, transparent 1px);
          background-size: 24px 24px;
          mask-image: linear-gradient(180deg,#000,transparent 76%);
        }
        .mx-head {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 11px 10px 8px 12px;
          cursor: move;
          touch-action: none;
        }
        .mx-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .mx-grip {
          display: grid;
          grid-template-columns: repeat(2, 2px);
          gap: 2px;
          flex: 0 0 auto;
          padding: 3px;
          opacity: .46;
        }
        .mx-grip i { display: block; width: 2px; height: 2px; border-radius: 50%; background: #9bb2ca; }
        .mx-title {
          display: flex;
          align-items: center;
          gap: 7px;
          color: #f3f8ff;
          font: 760 12px/1.2 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          letter-spacing: .01em;
        }
        .mx-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #37d6ff;
          box-shadow: 0 0 0 3px rgba(55,214,255,.10), 0 0 12px rgba(55,214,255,.42);
        }
        .mx-source {
          margin-top: 2px;
          color: #7f94ad;
          font: 500 11px/1.2 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
        }
        .mx-icon-btn {
          min-width: 27px;
          height: 27px;
          border: 1px solid rgba(138,165,197,.13);
          border-radius: 9px;
          background: rgba(255,255,255,.04);
          color: #aebdd0;
          cursor: pointer;
          font: 700 14px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
        }
        .mx-icon-btn:hover { color: #edf5ff; background: rgba(255,255,255,.08); }
        .mx-body { position: relative; padding: 0 10px 10px 10px; }
        .mx-stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
          margin: 2px 0 8px 0;
        }
        .mx-card {
          border: 1px solid rgba(138,165,197,.13);
          background: linear-gradient(180deg, rgba(19,41,65,.7), rgba(8,21,36,.68));
          border-radius: 13px;
          padding: 7px 7px 6px;
          min-width: 0;
        }
        .mx-num {
          display: block;
          font: 800 18px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          letter-spacing: -.03em;
          color: #f4f9ff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mx-label {
          display: block;
          margin-top: 3px;
          color: #7f94ad;
          font: 500 10px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          text-transform: lowercase;
        }
        .mx-main-btn {
          width: 100%;
          height: 36px;
          border: 0;
          border-radius: 12px;
          background: linear-gradient(135deg, #65e9ff, #36d2ff 58%, #59a9ff);
          color: #03131a;
          cursor: pointer;
          font: 800 12px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          letter-spacing: .03em;
          text-transform: uppercase;
        }
        .mx-main-btn:hover { background: linear-gradient(135deg, #82efff, #4edaff 58%, #70b7ff); box-shadow: 0 8px 20px rgba(55,214,255,.16); }
        .mx-main-btn:disabled { opacity: .55; cursor: default; }
        .mx-actions {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
          margin-top: 6px;
        }
        .mx-small-btn {
          height: 31px;
          border: 1px solid rgba(138,165,197,.16);
          border-radius: 11px;
          background: rgba(255,255,255,.035);
          color: #c8d5e5;
          cursor: pointer;
          font: 700 11px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          text-transform: uppercase;
        }
        .mx-small-btn:hover { color: #f1f7ff; background: rgba(255,255,255,.075); }
        .mx-small-btn:disabled { opacity: .55; cursor: default; }
        .mx-2gis-tools {
          margin-top: 6px;
          padding: 7px;
          border: 1px solid rgba(61,220,166,.18);
          border-radius: 12px;
          background: linear-gradient(145deg, rgba(16,61,55,.44), rgba(5,25,31,.48));
        }
        .mx-2gis-tools[hidden] { display: none; }
        .mx-2gis-btn {
          width: 100%;
          height: 32px;
          border: 1px solid rgba(80,226,178,.28);
          border-radius: 10px;
          background: rgba(39,190,139,.12);
          color: #8ff1cd;
          cursor: pointer;
          font: 800 11px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          letter-spacing: .02em;
          text-transform: uppercase;
        }
        .mx-2gis-btn:hover { background: rgba(39,190,139,.2); color: #c4ffe8; }
        .mx-2gis-btn.is-running { border-color: rgba(255,113,133,.36); background: rgba(222,56,84,.13); color: #ff9cae; }
        .mx-2gis-progress { height: 3px; margin-top: 7px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.08); }
        .mx-2gis-progress > i { display: block; width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg,#28d79d,#6df5cc); transition: width .2s ease; }
        .mx-2gis-meta { display: block; margin-top: 5px; color: #78a99b; font: 600 10px/1.2 system-ui, -apple-system, Segoe UI, Arial, sans-serif; }
        .mx-status {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-height: 26px;
          margin-top: 8px;
          padding: 6px 8px;
          border-radius: 11px;
          border: 1px solid rgba(138,165,197,.09);
          background: rgba(3,11,20,.34);
          color: #93a5ba;
          font: 600 11px/1.2 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
        }
        .mx-last {
          max-width: 118px;
          overflow: hidden;
          color: #67ddff;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .mx-mini {
          display: none;
          align-items: center;
          gap: 6px;
          padding: 7px;
          color: #edf5ff;
          background: linear-gradient(135deg, rgba(9,27,44,.96), rgba(5,14,25,.96));
          border: 1px solid rgba(138,165,197,.22);
          border-radius: 999px;
          box-shadow: 0 14px 38px rgba(0,0,0,.32), 0 0 26px rgba(55,214,255,.06), inset 0 1px rgba(255,255,255,.04);
          backdrop-filter: blur(18px) saturate(125%);
          cursor: move;
          touch-action: none;
        }
        .mx-mini-grip { display: grid; grid-template-columns: repeat(2,2px); gap: 2px; padding: 0 2px 0 4px; opacity: .5; }
        .mx-mini-grip i { display:block; width:2px; height:2px; border-radius:50%; background:#9bb2ca; }
        .mx-mini-count {
          min-width: 48px;
          padding: 0 4px;
          color: #dce8f6;
          font: 800 12px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          text-align: center;
        }
        .mx-mini-fix {
          height: 28px;
          padding: 0 12px;
          border: 0;
          border-radius: 999px;
          background: linear-gradient(135deg, #62e7ff, #3eafff);
          color: #03131a;
          cursor: pointer;
          font: 800 11px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          text-transform: uppercase;
        }
        .mx-mini-open {
          width: 28px;
          height: 28px;
          border: 1px solid rgba(138,165,197,.14);
          border-radius: 999px;
          background: rgba(255,255,255,.05);
          color: #c5d3e4;
          cursor: pointer;
          font: 800 13px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
        }
        .collapsed .mx-panel { display: none; }
        .collapsed .mx-mini { display: inline-flex; }
        button { transition: background .13s ease, color .13s ease, box-shadow .13s ease, opacity .13s ease; }
        button:focus-visible { outline: 2px solid #37d6ff; outline-offset: 2px; }
        :host([data-theme="theme-gis"]) .mx-panel { background: radial-gradient(circle at 12% -10%,rgba(29,211,232,.18),transparent 170px),linear-gradient(160deg,rgba(4,35,49,.97),rgba(2,18,29,.96)); border-color:rgba(45,218,229,.28); }
        :host([data-theme="theme-mission"]) .mx-panel { background:radial-gradient(circle at 10% -10%,rgba(53,219,149,.17),transparent 170px),linear-gradient(160deg,rgba(7,34,29,.97),rgba(3,18,18,.96)); border-color:rgba(76,220,157,.27); }
        :host([data-theme="theme-bloomberg"]) .mx-panel { background:linear-gradient(160deg,rgba(30,23,8,.98),rgba(13,11,6,.97)); border-color:rgba(235,171,35,.34); }
        :host([data-theme="theme-bloomberg"]) .mx-dot { background:#e5a72c; box-shadow:0 0 12px rgba(229,167,44,.45); }
        :host([data-theme="theme-linear"]) .mx-panel { background:linear-gradient(160deg,rgba(24,25,43,.98),rgba(11,12,24,.97)); border-color:rgba(116,128,236,.3); }
        :host([data-theme="theme-blueprint"]) .mx-panel { background:linear-gradient(rgba(14,111,173,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(14,111,173,.07) 1px,transparent 1px),linear-gradient(160deg,#071d32,#051422); background-size:18px 18px,18px 18px,auto; border-color:rgba(36,162,232,.32); }
        :host([data-theme="theme-scada"]) .mx-panel { background:linear-gradient(160deg,#132913,#071607); border-color:rgba(104,198,82,.34); }
        :host([data-theme="theme-scada"]) .mx-dot { background:#70ca54; box-shadow:0 0 12px rgba(112,202,84,.45); }
        :host([data-theme="theme-neon"]) .mx-panel { background:radial-gradient(circle at 10% -10%,rgba(0,244,255,.2),transparent 160px),linear-gradient(160deg,#12102b,#080817); border-color:rgba(240,45,220,.35); box-shadow:0 20px 52px rgba(0,0,0,.42),0 0 28px rgba(0,231,255,.12),0 0 18px rgba(255,27,220,.08); }
        :host([data-theme="theme-light"]) .mx-panel { color:#101828; background:radial-gradient(circle at 90% 0,rgba(62,128,255,.1),transparent 170px),rgba(250,252,255,.97); border-color:#d7dfeb; box-shadow:0 18px 48px rgba(44,62,85,.18); }
        :host([data-theme="theme-light"]) .mx-title,:host([data-theme="theme-light"]) .mx-num { color:#101828; }
        :host([data-theme="theme-light"]) .mx-source,:host([data-theme="theme-light"]) .mx-label,:host([data-theme="theme-light"]) .mx-status { color:#667085; }
        :host([data-theme="theme-light"]) .mx-card,:host([data-theme="theme-light"]) .mx-status { background:rgba(255,255,255,.82); border-color:#dce3ed; }
        :host([data-theme="theme-light"]) .mx-small-btn,:host([data-theme="theme-light"]) .mx-icon-btn { color:#344054; background:#fff; border-color:#d7dfeb; }
        :host([data-theme="theme-light"]) .mx-mini { color:#101828; background:rgba(250,252,255,.98); border-color:#d7dfeb; box-shadow:0 14px 38px rgba(44,62,85,.18); }
        :host([data-theme="theme-light"]) .mx-mini-count { color:#344054; }
        .busy .mx-dot { animation: mx-pulse 1s ease-in-out infinite; }
        @keyframes mx-pulse { 50% { opacity: .48; transform: scale(.82); } }
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { animation: none !important; transition: none !important; }
        }
      </style>
      <div class="mx-wrap">
        <div class="mx-panel" id="mxPanel" role="dialog" aria-label="Панель сбора организаций">
          <div class="mx-head" id="dragHandle" title="Перетащите панель">
            <div class="mx-brand">
              <span class="mx-grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>
              <div>
                <div class="mx-title"><span class="mx-dot"></span><span>Maps Export</span></div>
                <div class="mx-source" id="source">Maps</div>
              </div>
            </div>
            <button type="button" class="mx-icon-btn" id="collapse" title="Свернуть" aria-label="Свернуть панель" aria-controls="mxPanel" aria-expanded="true">−</button>
          </div>
          <div class="mx-body">
            <div class="mx-stats">
              <div class="mx-card"><span class="mx-num" id="current">0</span><span class="mx-label">на экране</span></div>
              <div class="mx-card"><span class="mx-num" id="total">0</span><span class="mx-label">в сессии</span></div>
              <div class="mx-card"><span class="mx-num" id="snapshots">0</span><span class="mx-label">фиксаций</span></div>
            </div>
            <button type="button" class="mx-main-btn" id="fix">Зафиксировать</button>
            <div class="mx-actions">
              <button type="button" class="mx-small-btn" id="xlsx">Скачать XLSX</button>
              <button type="button" class="mx-small-btn" id="reset">Сбросить</button>
            </div>
            <div class="mx-2gis-tools" id="gis2Tools" hidden>
              <button type="button" class="mx-2gis-btn" id="gis2Scan" aria-pressed="false">Автосбор страниц</button>
              <div class="mx-2gis-progress" aria-hidden="true"><i id="gis2Progress"></i></div>
              <span class="mx-2gis-meta" id="gis2ScanMeta">0/0 карточек</span>
            </div>
            <button type="button" class="mx-small-btn" id="details" style="width:100%;margin-top:6px">Досбор деталей по URL</button>
            <div class="mx-status" role="status" aria-live="polite"><span id="status">Готово к сбору</span><span class="mx-last" id="last">нет фиксаций</span></div>
          </div>
        </div>
        <div class="mx-mini" id="miniBar" role="toolbar" aria-label="Компактная панель сбора" title="Перетащите за свободную область">
          <span class="mx-mini-grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>
          <span class="mx-mini-count" id="miniNumbers">0 / 0</span>
          <button type="button" class="mx-mini-fix" id="miniFix" title="Зафиксировать карточки">Фикс</button>
          <button type="button" class="mx-mini-open" id="expand" title="Развернуть" aria-label="Развернуть панель" aria-controls="mxPanel" aria-expanded="false">+</button>
        </div>
      </div>
    `;

    els = {
      host,
      root: shadow.querySelector(".mx-wrap"),
      dragHandle: shadow.getElementById("dragHandle"),
      miniBar: shadow.getElementById("miniBar"),
      source: shadow.getElementById("source"),
      current: shadow.getElementById("current"),
      total: shadow.getElementById("total"),
      snapshots: shadow.getElementById("snapshots"),
      last: shadow.getElementById("last"),
      status: shadow.getElementById("status"),
      fix: shadow.getElementById("fix"),
      miniFix: shadow.getElementById("miniFix"),
      xlsx: shadow.getElementById("xlsx"),
      reset: shadow.getElementById("reset"),
      gis2Tools: shadow.getElementById("gis2Tools"),
      gis2Scan: shadow.getElementById("gis2Scan"),
      gis2Progress: shadow.getElementById("gis2Progress"),
      gis2ScanMeta: shadow.getElementById("gis2ScanMeta"),
      details: shadow.getElementById("details"),
      collapse: shadow.getElementById("collapse"),
      expand: shadow.getElementById("expand"),
      miniNumbers: shadow.getElementById("miniNumbers")
    };

    bindDrag(host, els.dragHandle);
    bindDrag(host, els.miniBar);

    els.fix.addEventListener("click", fixCurrentView);
    els.miniFix.addEventListener("click", fixCurrentView);
    els.xlsx.addEventListener("click", exportSession);
    els.reset.addEventListener("click", clearSession);
    els.gis2Scan.addEventListener("click", toggle2gisAutoScan);
    els.details.addEventListener("click", async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: "OPEN_ENRICHMENT" });
        setStatus(response?.ok ? "открыт досбор" : (response?.error || "ошибка"));
      } catch (error) {
        setStatus(String(error?.message || error));
      }
    });
    els.collapse.addEventListener("click", async () => {
      setOverlayCollapsed(true);
      await constrainHostToViewport(host);
      await savePrefs({ collapsed: true });
      els.expand.focus();
    });
    els.expand.addEventListener("click", async () => {
      setOverlayCollapsed(false);
      await constrainHostToViewport(host);
      await savePrefs({ collapsed: false });
      els.collapse.focus();
    });

    setOverlayCollapsed(!!prefs.collapsed);
    els.details.textContent = getCollector()?.source === "2gis" ? "Подробный досбор 2ГИС" : "Досбор деталей по URL";
    await constrainHostToViewport(host);
    window.addEventListener("resize", () => constrainHostToViewport(host).catch(() => {}), { passive: true });
  }

  function installAutoPreview() {
    const observer = new MutationObserver(scheduleCollect);
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    clearInterval(autoTimer);
    autoTimer = setInterval(() => collectPreview(true), 4500);
  }

  window.addEventListener("MAPS_EXPORT_2GIS_SCAN_STATE", (event) => {
    update2gisControls(event?.detail || null);
    collectPreview(true).catch(() => {});
  });

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEY]) {
      applyStoredSession(changes[STORAGE_KEY].newValue);
      updateStats();
    }
    if (changes[ENRICHMENT_JOB_KEY]?.newValue?.status === "idle") {
      setStatus("Досбор синхронизирован: очередь пуста");
    }
    if (changes[THEME_KEY]) applySharedTheme(changes[THEME_KEY].newValue);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "MAPS_EXPORT_OVERLAY_SHOW") {
      (async () => {
        try {
          await renderOverlay();
          setOverlayCollapsed(false);
          await savePrefs({ collapsed: false });
          await collectPreview(true);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === "MAPS_EXPORT_OVERLAY_STATS") {
      const total = Object.keys(session.objects || {}).length;
      sendResponse({
        ok: true,
        current: lastRows.length,
        total,
        snapshots: (session.snapshots || []).length,
        last: lastSnapshot
      });
      return true;
    }
  });

  (async function init() {
    await loadSession();
    await renderOverlay();
    updateStats();
    installAutoPreview();
    await collectPreview(true);
    setStatus("готово");
  })();
})();
