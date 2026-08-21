const STORAGE_KEY = "maps_export_session_v2";
const ENRICHMENT_RESULTS_KEY = "maps_export_enrichment_results_v1";

const OBJECT_COLS = [
  "object_key", "source", "org_id", "title", "rating", "reviews",
  "categories_all", "address", "photos_count",
  "lat", "lon", "url", "scraped_at",
  "first_snapshot_id", "last_snapshot_id", "snapshot_ids", "seen_count",
  "first_seen_at", "last_seen_at"
];

const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $("status").textContent = text || "";
}

function setBusy(flag) {
  for (const id of ["btnShowPanel", "btnEnrichment", "btnExport", "btnClear", "btnInstructions"]) {
    const el = $(id);
    if (el) el.disabled = !!flag;
  }
}

function emptySession() {
  const now = new Date().toISOString();
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

async function loadSession() {
  const obj = await chrome.storage.local.get(STORAGE_KEY);
  const s = obj?.[STORAGE_KEY];
  if (s && typeof s === "object") {
    return {
      ...emptySession(),
      ...s,
      objects: s.objects || {},
      snapshots: Array.isArray(s.snapshots) ? s.snapshots : [],
      observations: Array.isArray(s.observations) ? s.observations : []
    };
  }
  const fresh = emptySession();
  await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
  return fresh;
}

function detectDomain(url) {
  if (!url) return "unknown";
  try {
    const u = new URL(url);
    const host = String(u.hostname || "").toLowerCase();
    const path = String(u.pathname || "");
    if (host.includes("google.") && path.startsWith("/maps")) return "google";
    if (host.includes("2gis.")) return "2gis";
    if ((host.includes("yandex.") || host.includes("ya.")) && path.startsWith("/maps")) return "yandex";
  } catch {}
  return "unknown";
}

function sourceLabel(source) {
  return source === "yandex" ? "Yandex" : source === "google" ? "Google" : source === "2gis" ? "2GIS" : "карта не открыта";
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function safeSend(tabId, msg) {
  try { return await chrome.tabs.sendMessage(tabId, msg); } catch { return null; }
}

async function ping(tabId) {
  const resp = await safeSend(tabId, { type: "PING" });
  return resp?.ok === true;
}

async function ensureScripts(tab, source) {
  if (!tab?.id || source === "unknown") return false;
  if (await ping(tab.id)) return true;

  const files = source === "google"
    ? ["xlsx.full.min.js", "google_content.js", "overlay.js"]
    : ["xlsx.full.min.js", "content.js", "overlay.js"];

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
  } catch (e) {
    console.warn("Inject failed:", e);
  }
  return await ping(tab.id);
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

async function exportSession() {
  const session = await loadSession();
  const objects = Object.values(session.objects || {});
  if (!objects.length) {
    setStatus("Нет данных для экспорта. Сначала зафиксируйте карточки на карте.");
    return false;
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFromRows(OBJECT_COLS, objects.map(r => normalizeForSheet(r, OBJECT_COLS))), "objects");

  const ts = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  const last = session.snapshots[session.snapshots.length - 1];
  const fname = `maps_export_${safeFilePart(last?.source || "maps")}_${safeFilePart(last?.query || "session")}_${stamp}.xlsx`;

  if (typeof XLSX.writeFileXLSX === "function") {
    XLSX.writeFileXLSX(wb, fname, { compression: true });
  } else {
    XLSX.writeFile(wb, fname, { bookType: "xlsx", bookSST: true, compression: true });
  }
  return true;
}

async function refreshStats() {
  const [session, detailStorage] = await Promise.all([
    loadSession(),
    chrome.storage.local.get(ENRICHMENT_RESULTS_KEY)
  ]);
  const detailResults = detailStorage?.[ENRICHMENT_RESULTS_KEY] || {};
  const tab = await activeTab();
  const source = detectDomain(tab?.url || "");
  $("source").textContent = sourceLabel(source);
  $("source").dataset.source = source;
  $("sessionCount").textContent = String(Object.keys(session.objects || {}).length);
  $("snapshotCount").textContent = String((session.snapshots || []).length);
  $("detailCount").textContent = String(Object.values(detailResults).filter((item) => item?.status === "success").length);

  if (tab?.id) {
    const overlayStats = await safeSend(tab.id, { type: "MAPS_EXPORT_OVERLAY_STATS" });
    if (overlayStats?.ok) {
      $("currentCount").textContent = String(overlayStats.current || 0);
      $("sessionCount").textContent = String(overlayStats.total || 0);
      $("snapshotCount").textContent = String(overlayStats.snapshots || 0);
    }
  }
}

async function openEnrichment() {
  const tab = await activeTab();
  const response = await chrome.runtime.sendMessage({ type: "OPEN_ENRICHMENT", source_tab_id: tab?.id });
  if (!response?.ok) setStatus(response?.error || "Не удалось открыть досбор.");
  window.close();
}

async function openInstructions() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("instructions.html") });
  window.close();
}

async function showPanel() {
  setBusy(true);
  try {
    const tab = await activeTab();
    const source = detectDomain(tab?.url || "");
    if (source === "unknown") {
      setStatus("Откройте Яндекс.Карты, 2GIS или Google Maps.");
      return;
    }
    const ok = await ensureScripts(tab, source);
    if (!ok) {
      setStatus("Панель недоступна на этой странице.");
      return;
    }
    const resp = await safeSend(tab.id, { type: "MAPS_EXPORT_OVERLAY_SHOW" });
    setStatus(resp?.ok ? "Панель открыта на странице." : "Панель уже должна быть на странице.");
    await refreshStats();
  } finally {
    setBusy(false);
  }
}

async function clearSession() {
  if (!confirm("Сбросить базовую сессию, очередь и результаты досбора? Сначала скачайте нужные XLSX.")) return;
  const resetResponse = await chrome.runtime.sendMessage({ type: "ENRICHMENT_FORCE_RESET" });
  if (!resetResponse?.ok) {
    setStatus(resetResponse?.error || "Не удалось сбросить досбор.");
    return;
  }
  const fresh = emptySession();
  await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
  setStatus("Основная сессия и досбор сброшены.");
  await refreshStats();
}

document.addEventListener("DOMContentLoaded", async () => {
  $("btnShowPanel").addEventListener("click", showPanel);
  $("btnEnrichment").addEventListener("click", openEnrichment);
  $("btnExport").addEventListener("click", async () => {
    setBusy(true);
    try {
      const exported = await exportSession();
      if (exported) setStatus("XLSX подготовлен к скачиванию.");
    } finally {
      setBusy(false);
    }
  });
  $("btnClear").addEventListener("click", clearSession);
  $("btnInstructions").addEventListener("click", openInstructions);
  try {
    await refreshStats();
  } catch (error) {
    setStatus(`Не удалось обновить статистику: ${error?.message || error}`);
  }
});
