(() => {
  if (window.__mapsExportOverlayV190__) return;
  window.__mapsExportOverlayV190__ = true;

  const STORAGE_KEY = "maps_export_session_v2";
  const PREFS_KEY = "maps_export_overlay_prefs_v1";

  const BASE_COLS = [
    "org_id", "title", "rating", "reviews",
    "categories_all", "address",
    "photos_count", "lat", "lon",
    "url", "scraped_at"
  ];

  const OBJECT_COLS = [
    "object_key", "source", "org_id", "title", "rating", "reviews",
    "categories_all", "address", "photos_count",
    "lat", "lon", "url", "scraped_at",
    "first_snapshot_id", "last_snapshot_id", "snapshot_ids", "seen_count",
    "first_seen_at", "last_seen_at"
  ];

  const SNAPSHOT_COLS = [
    "snapshot_id", "snapshot_index", "source", "query", "page_url",
    "center_lat", "center_lon", "zoom",
    "collected_count", "added_count", "duplicate_count", "created_at"
  ];

  const OBSERVATION_COLS = [
    "snapshot_id", "snapshot_index", "object_key", "source", "org_id", "title",
    "lat", "lon", "url", "seen_at"
  ];

  let session = emptySession();
  let lastRows = [];
  let lastSnapshot = null;
  let busy = false;
  let shadow = null;
  let els = {};
  let collectTimer = null;
  let autoTimer = null;

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
    if (v === "" || v == null) return "";
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : "";
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
    row.lat = normalizeCoord(row.lat);
    row.lon = normalizeCoord(row.lon);
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
      const v = newObj[key];
      if (v !== "" && v != null) merged[key] = v;
    }

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
    const s = obj?.[STORAGE_KEY];
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
      await saveSession();
    }
    lastSnapshot = session.snapshots[session.snapshots.length - 1] || null;
  }

  async function saveSession() {
    session.updated_at = nowIso();
    await chrome.storage.local.set({ [STORAGE_KEY]: session });
  }

  function setBusy(flag) {
    busy = !!flag;
    for (const key of ["fix", "miniFix", "xlsx", "reset"]) {
      if (els[key]) els[key].disabled = busy;
    }
    if (els.root) els.root.classList.toggle("busy", busy);
  }

  function setStatus(text) {
    if (els.status) els.status.textContent = text || "";
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
    setStatus("фиксация...");
    try {
      const api = getCollector();
      const source = api?.source || "unknown";
      const rows = await collectPreview(true);

      if (!rows.length) {
        setStatus("нет объектов");
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
      setStatus(`зафиксировано: +${snapshot.added_count}, дублей ${snapshot.duplicate_count}`);
    } catch (e) {
      console.error("Maps Export fix error:", e);
      setStatus("ошибка фиксации");
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
      alert("Нет накопленных данных. Сначала нажмите «Фикс».");
      return;
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetFromRows(OBJECT_COLS, objects.map(r => normalizeForSheet(r, OBJECT_COLS))), "objects");
    XLSX.utils.book_append_sheet(wb, sheetFromRows(SNAPSHOT_COLS, session.snapshots.map(r => normalizeForSheet(r, SNAPSHOT_COLS))), "snapshots");
    XLSX.utils.book_append_sheet(wb, sheetFromRows(OBSERVATION_COLS, session.observations.map(r => normalizeForSheet(r, OBSERVATION_COLS))), "observations");

    if (lastRows.length) {
      XLSX.utils.book_append_sheet(wb, sheetFromRows(BASE_COLS, lastRows.map(r => normalizeForSheet(r, BASE_COLS))), "current_preview");
    }

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
    setStatus("скачивание XLSX");
  }

  async function clearSession() {
    if (!confirm("Сбросить накопленную сессию?")) return;
    session = emptySession();
    lastSnapshot = null;
    await saveSession();
    updateStats();
    setStatus("сессия сброшена");
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
      handle.setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
    });

    handle.addEventListener("pointermove", (ev) => {
      if (!active) return;
      const nextLeft = Math.max(8, Math.min(window.innerWidth - 80, startLeft + ev.clientX - sx));
      const nextTop = Math.max(8, Math.min(window.innerHeight - 40, startTop + ev.clientY - sy));
      host.style.left = `${nextLeft}px`;
      host.style.top = `${nextTop}px`;
    });

    handle.addEventListener("pointerup", async (ev) => {
      if (!active) return;
      active = false;
      const rect = host.getBoundingClientRect();
      await savePrefs({ left: rect.left, top: rect.top });
      try { handle.releasePointerCapture?.(ev.pointerId); } catch {}
    });
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
    if (Number.isFinite(prefs.left) && Number.isFinite(prefs.top)) {
      host.style.left = `${prefs.left}px`;
      host.style.top = `${prefs.top}px`;
      host.style.right = "auto";
    }

    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .mx-panel {
          width: 258px;
          color: #101828;
          background: rgba(255,255,255,.94);
          border: 1px solid rgba(16,24,40,.12);
          border-radius: 18px;
          box-shadow: 0 18px 45px rgba(16,24,40,.22);
          backdrop-filter: blur(14px);
          overflow: hidden;
          user-select: none;
        }
        .mx-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 10px 7px 12px;
          cursor: move;
        }
        .mx-title {
          display: flex;
          align-items: center;
          gap: 7px;
          font: 700 12px/1.2 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          letter-spacing: .02em;
        }
        .mx-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #246BFD;
          box-shadow: 0 0 0 3px rgba(36,107,253,.12);
        }
        .mx-source {
          color: #667085;
          font: 500 11px/1.2 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
        }
        .mx-icon-btn {
          min-width: 27px;
          height: 27px;
          border: 0;
          border-radius: 9px;
          background: #F2F4F7;
          color: #344054;
          cursor: pointer;
          font: 700 14px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
        }
        .mx-icon-btn:hover { background: #E4E7EC; }
        .mx-body { padding: 0 10px 10px 10px; }
        .mx-stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
          margin: 2px 0 8px 0;
        }
        .mx-card {
          border: 1px solid rgba(16,24,40,.08);
          background: #F9FAFB;
          border-radius: 13px;
          padding: 7px 7px 6px;
          min-width: 0;
        }
        .mx-num {
          display: block;
          font: 800 18px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          letter-spacing: -.03em;
          color: #101828;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mx-label {
          display: block;
          margin-top: 3px;
          color: #667085;
          font: 500 10px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          text-transform: lowercase;
        }
        .mx-main-btn {
          width: 100%;
          height: 36px;
          border: 0;
          border-radius: 12px;
          background: #175CD3;
          color: white;
          cursor: pointer;
          font: 800 12px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          letter-spacing: .03em;
          text-transform: uppercase;
        }
        .mx-main-btn:hover { background: #1849A9; }
        .mx-main-btn:disabled { opacity: .55; cursor: default; }
        .mx-actions {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
          margin-top: 6px;
        }
        .mx-small-btn {
          height: 31px;
          border: 1px solid rgba(16,24,40,.1);
          border-radius: 11px;
          background: #FFFFFF;
          color: #344054;
          cursor: pointer;
          font: 700 11px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          text-transform: uppercase;
        }
        .mx-small-btn:hover { background: #F2F4F7; }
        .mx-small-btn:disabled { opacity: .55; cursor: default; }
        .mx-status {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-height: 26px;
          margin-top: 8px;
          padding: 6px 8px;
          border-radius: 11px;
          background: #F2F4F7;
          color: #475467;
          font: 600 11px/1.2 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
        }
        .mx-last {
          color: #175CD3;
          white-space: nowrap;
        }
        .mx-mini {
          display: none;
          align-items: center;
          gap: 6px;
          padding: 8px;
          background: rgba(255,255,255,.96);
          border: 1px solid rgba(16,24,40,.12);
          border-radius: 999px;
          box-shadow: 0 12px 35px rgba(16,24,40,.2);
          backdrop-filter: blur(14px);
        }
        .mx-mini-count {
          min-width: 48px;
          padding: 0 4px;
          color: #344054;
          font: 800 12px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          text-align: center;
        }
        .mx-mini-fix {
          height: 28px;
          padding: 0 12px;
          border: 0;
          border-radius: 999px;
          background: #175CD3;
          color: white;
          cursor: pointer;
          font: 800 11px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
          text-transform: uppercase;
        }
        .mx-mini-open {
          width: 28px;
          height: 28px;
          border: 0;
          border-radius: 999px;
          background: #F2F4F7;
          color: #344054;
          cursor: pointer;
          font: 800 13px/1 system-ui, -apple-system, Segoe UI, Arial, sans-serif;
        }
        .collapsed .mx-panel { display: none; }
        .collapsed .mx-mini { display: inline-flex; }
      </style>
      <div class="mx-wrap">
        <div class="mx-panel">
          <div class="mx-head" id="dragHandle">
            <div>
              <div class="mx-title"><span class="mx-dot"></span><span>Maps Export</span></div>
              <div class="mx-source" id="source">Maps</div>
            </div>
            <button class="mx-icon-btn" id="collapse" title="Свернуть">−</button>
          </div>
          <div class="mx-body">
            <div class="mx-stats">
              <div class="mx-card"><span class="mx-num" id="current">0</span><span class="mx-label">сейчас</span></div>
              <div class="mx-card"><span class="mx-num" id="total">0</span><span class="mx-label">всего</span></div>
              <div class="mx-card"><span class="mx-num" id="snapshots">0</span><span class="mx-label">фиксаций</span></div>
            </div>
            <button class="mx-main-btn" id="fix">Сбор</button>
            <div class="mx-actions">
              <button class="mx-small-btn" id="xlsx">XLSX</button>
              <button class="mx-small-btn" id="reset">Сброс</button>
            </div>
            <button class="mx-small-btn" id="details" style="width:100%;margin-top:6px">Досбор по URL</button>
            <div class="mx-status"><span id="status">готово</span><span class="mx-last" id="last">нет фиксаций</span></div>
          </div>
        </div>
        <div class="mx-mini" id="miniBar">
          <span class="mx-mini-count" id="miniNumbers">0 / 0</span>
          <button class="mx-mini-fix" id="miniFix">Сбор</button>
          <button class="mx-mini-open" id="expand" title="Развернуть">+</button>
        </div>
      </div>
    `;

    els = {
      host,
      root: shadow.querySelector(".mx-wrap"),
      dragHandle: shadow.getElementById("dragHandle"),
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
      details: shadow.getElementById("details"),
      collapse: shadow.getElementById("collapse"),
      expand: shadow.getElementById("expand"),
      miniNumbers: shadow.getElementById("miniNumbers")
    };

    bindDrag(host, els.dragHandle);

    els.fix.addEventListener("click", fixCurrentView);
    els.miniFix.addEventListener("click", fixCurrentView);
    els.xlsx.addEventListener("click", exportSession);
    els.reset.addEventListener("click", clearSession);
    els.details.addEventListener("click", async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: "OPEN_ENRICHMENT" });
        setStatus(response?.ok ? "открыт досбор" : (response?.error || "ошибка"));
      } catch (error) {
        setStatus(String(error?.message || error));
      }
    });
    els.collapse.addEventListener("click", async () => {
      els.root.classList.add("collapsed");
      await savePrefs({ collapsed: true });
    });
    els.expand.addEventListener("click", async () => {
      els.root.classList.remove("collapsed");
      await savePrefs({ collapsed: false });
    });

    if (prefs.collapsed) els.root.classList.add("collapsed");
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "MAPS_EXPORT_OVERLAY_SHOW") {
      (async () => {
        try {
          await renderOverlay();
          els.root?.classList.remove("collapsed");
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
