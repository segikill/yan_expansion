// ===== helpers =====
const qs  = (root, sel) => root.querySelector(sel);
const qsa = (root, sel) => Array.from(root.querySelectorAll(sel));
const txt = (el) => (el ? (el.textContent || "").trim() : "");

function detectDomainByLocation() {
  const h = String(location.hostname || "").toLowerCase();
  if (h.includes("2gis.")) return "2gis";
  if (h.includes("yandex") || h.endsWith("ya.ru")) return "yandex";
  return "unknown";
}

// 2GIS: приводит id вида "7003..._xxxxx" -> "7003..."
function normalize2gisOrgId(rawId) {
  if (!rawId) return "";
  const s = String(rawId).trim();
  const m = s.match(/^(\d+)/);
  return m ? m[1] : "";
}

function isValid2gisOrgId(orgId) {
  // ID рубрик и служебных сущностей 2ГИС обычно короткие (например 305, 110532).
  // ID филиалов в актуальном каталоге — длинные числовые значения.
  return /^\d{10,}$/.test(String(orgId || ""));
}

// 2GIS: город/префикс из URL (обычно /<city>/search или /<city>/firm)
function get2gisCityPrefix() {
  const parts = String(location.pathname || "/").split("/").filter(Boolean);
  if (!parts.length) return "";
  const first = parts[0].toLowerCase();
  if (first === "firm") return "";
  return first;
}

function normalize2gisUrl(raw) {
  if (!raw) return "";
  try {
    const u = new URL(raw, location.origin);
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}

function build2gisFirmUrl(rawFirmId) {
  const raw = normalize2gisOrgId(rawFirmId);
  if (!isValid2gisOrgId(raw)) return "";
  const city = get2gisCityPrefix();
  const base = String(location.origin || "https://2gis.ru");
  return city ? `${base}/${city}/firm/${raw}` : `${base}/firm/${raw}`;
}

function normalize2gisCoordinatePair(latValue, lonValue) {
  const lat = Number(String(latValue ?? "").replace(",", "."));
  const lon = Number(String(lonValue ?? "").replace(",", "."));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { lat: "", lon: "" };
  }
  return { lat: String(lat), lon: String(lon) };
}

function coordinatesFrom2gisCandidate(candidate) {
  if (!candidate) return { lat: "", lon: "" };
  if (Array.isArray(candidate) && candidate.length >= 2) {
    return normalize2gisCoordinatePair(candidate[1], candidate[0]);
  }
  if (typeof candidate === "string") {
    const point = candidate.match(/POINT\s*\(\s*(-?\d+(?:[.,]\d+)?)\s+(-?\d+(?:[.,]\d+)?)\s*\)/i);
    if (point) return normalize2gisCoordinatePair(point[2], point[1]);
    return { lat: "", lon: "" };
  }
  if (typeof candidate !== "object") return { lat: "", lon: "" };
  const direct = normalize2gisCoordinatePair(
    candidate.lat ?? candidate.latitude,
    candidate.lon ?? candidate.lng ?? candidate.longitude
  );
  if (direct.lat && direct.lon) return direct;
  if (Array.isArray(candidate.coordinates)) return coordinatesFrom2gisCandidate(candidate.coordinates);
  return { lat: "", lon: "" };
}

function decode2gisStat(rawStat) {
  if (!rawStat || typeof atob !== "function") return null;
  try {
    const normalized = String(rawStat).replace(/\s/g, "+").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const json = typeof TextDecoder === "function" ? new TextDecoder().decode(bytes) : binary;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function coordinatesFrom2gisUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, location.origin);
    const stat = decode2gisStat(url.searchParams.get("stat"));
    const statCandidates = [
      stat?.placeItem?.geoPosition,
      stat?.placeItem?.geo_position,
      stat?.geoPosition,
      stat?.geo_position
    ];
    for (const candidate of statCandidates) {
      const pair = coordinatesFrom2gisCandidate(candidate);
      if (pair.lat && pair.lon) return pair;
    }

    const path = decodeURIComponent(url.pathname);
    const route = path.match(/\/(?:firm|geo)\/[^/]+\/(-?\d+(?:[.,]\d+)?),(-?\d+(?:[.,]\d+)?)/i);
    if (route) {
      const pair = normalize2gisCoordinatePair(route[2], route[1]);
      if (pair.lat && pair.lon) return pair;
    }

    const mapState = String(url.searchParams.get("m") || "").match(/(-?\d+(?:[.,]\d+)?),(-?\d+(?:[.,]\d+)?)/);
    if (mapState && /\/(?:firm|geo)\//i.test(path)) {
      return normalize2gisCoordinatePair(mapState[2], mapState[1]);
    }
  } catch {}
  return { lat: "", lon: "" };
}

function extract2gisCoordinates(item, urlHint = "") {
  const candidates = [
    item?.point,
    item?.geoPosition,
    item?.geo_position,
    item?.location,
    item?.coords,
    item?.coord,
    item?.geometry?.centroid,
    item?.geometry?.point,
    item?.geometry?.selection,
    item?.geometry
  ];
  for (const candidate of candidates) {
    const pair = coordinatesFrom2gisCandidate(candidate);
    if (pair.lat && pair.lon) return pair;
  }
  return coordinatesFrom2gisUrl(urlHint);
}

function cleanOrgUrl(href) {
  try {
    const u = new URL(href);
    if (!/\/maps\/org\//.test(u.pathname)) return { url: "", org_id: "" };

    u.hash = "";
    u.search = "";
    let path = u.pathname.replace(/\/menu\/?$/, "/").replace(/\/+$/, "/");

    const m = path.match(/\/org\/[^/]+\/(\d{5,})\//);
    const org_id = m ? m[1] : "";

    u.hostname = "yandex.ru";
    u.pathname = path;
    return { url: u.toString(), org_id };
  } catch {
    return { url: "", org_id: "" };
  }
}

function clean2gisOrgUrl(href) {
  try {
    const u = new URL(href);
    if (!/2gis\./i.test(u.hostname)) return { url: "", org_id: "" };

    // /firm/<id> где <id> может быть: 7003... или 7003..._<hash>
    const m = u.pathname.match(/\/firm\/([^/?#]+)/);
    const raw = m ? m[1] : "";
    const org_id = normalize2gisOrgId(raw);

    if (!isValid2gisOrgId(org_id)) return { url: "", org_id: "" };

    // Убираем stat, рекламную атрибуцию и составной хвост ID. Для одной
    // организации всегда получается одна стабильная ссылка.
    const city = u.pathname.split("/").filter(Boolean)[0];
    u.hash = "";
    u.search = "";
    u.pathname = city && city !== "firm"
      ? `/${city}/firm/${org_id}`
      : `/firm/${org_id}`;
    return { url: u.toString(), org_id };
  } catch {
    return { url: "", org_id: "" };
  }
}

function cardFromLink(a) {
  let p = a;
  for (let i = 0; i < 6 && p; i++) {
    if (p.matches?.('[class*="search"] [class*="snippet"], [class*="business-snippet"], [class*="card"]')) break;
    p = p.parentElement;
  }
  return p || a;
}

// ===== Yandex fields parsers =====
function parseTitle(card) {
  if (!card) return "";
  const link = card.querySelector('a[href*="/maps/org/"]');
  let s =
    (link && (link.getAttribute("aria-label") || link.getAttribute("title"))) ||
    txt(link) ||
    txt(card.querySelector('[class*="title"] [class*="text"], [class*="title"], a'));
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/Ср\.\s*чек:.*$/i, "").replace(/Награды:.*$/i, "").trim();
  return s;
}

function parseRatingAndReviews(card) {
  const block = card && card.querySelector('[class*="rating"], [class*="rating-and-awards"]');
  const raw = txt(block) || "";
  const strict = document.querySelector(
    'body > div.body > div.app > div:nth-child(8) > div.sidebar-container > aside > div.sidebar-view__panel > div.scroll._width_narrow > div > div.scroll__content > div > div > ul > li:nth-child(31) > div > div > div > div > div.search-business-snippet-view__rating-and-awards > a > div > span.a11y-hidden'
  );
  const add = txt(strict);
  const mix = (raw + " " + add).trim();

  // Рейтинг: строго X,Y — ровно одна цифра после запятой
  const rMatch = mix.match(/(\d+[.,]\d)/);
  const rating = rMatch ? rMatch[1].replace(".", ",") : "";

  // Количество оценок: последняя цифра рейтинга приклеивается к числу оценок.
  // Например: рейтинг 4,9 + 253 оценки → в тексте идёт «9253 оценки».
  // Стратегия 1: число в скобках — самый надёжный источник: (253)
  // Стратегия 2: дублирование «253 оценки253 оценки»
  // Стратегия 3: если рейтинг найден — отрезаем его последнюю цифру спереди
  let reviews = "";
  const parenMatch = mix.match(/\((\d+)\)/);
  if (parenMatch) {
    reviews = parenMatch[1];
  } else {
    const dupMatch = mix.match(/(\d+)\s*(?:оцен|отзыв)[а-яёА-ЯЁ]*\s*\1\s*(?:оцен|отзыв)/i);
    if (dupMatch) {
      reviews = dupMatch[1];
    } else if (rating) {
      // Последняя цифра рейтинга (цифра после запятой)
      const lastDigit = rating.slice(-1);
      // Ищем число перед «оцен/отзыв», начинающееся с этой цифры
      const fusedMatch = mix.match(new RegExp(lastDigit + "(\\d+)\\s*(?:оцен|отзыв)", "i"));
      if (fusedMatch) {
        reviews = fusedMatch[1];
      } else {
        // Крайний случай: берём любое число перед оцен/отзыв
        const rvMatch = mix.match(/(\d{1,7})\s*(?:оцен|отзыв)/i);
        reviews = rvMatch ? rvMatch[1] : "";
      }
    } else {
      const rvMatch = mix.match(/(\d{1,7})\s*(?:оцен|отзыв)/i);
      reviews = rvMatch ? rvMatch[1] : "";
    }
  }

  return { rating, reviews };
}

function parseCategories(card) {
  const chips = qsa(card, '[class*="category"], [class*="rubric"], [class*="tag"]')
    .map((el) => txt(el)).filter(Boolean);
  const uniq = Array.from(new Set(chips));
  return uniq.join(" | ");
}

function parsePhotosCount(card) {
  const overlay =
    txt(card.querySelector('[class*="gallery"][class*="overlay"]')) ||
    txt(card.querySelector('[class*="snippet-gallery"] [class*="overlay"]'));
  const n = (overlay.match(/(\d+)/) || [,""])[1];
  return n || "";
}

function parseAddress(card) {
  const cand =
    card.querySelector('[class*="snippet"][class*="address"]') ||
    card.querySelector('[class*="search-business-snippet-view__address"]') ||
    card.querySelector('a[href*="maps/"] [class*="address"]') ||
    card.querySelector('[class*="address"]');

  let s = txt(cand);
  if (!s && card) {
    const maybe = qsa(card, "a").find(a => /\/maps\//.test(a.getAttribute("href") || "") && /\,/.test(a.textContent || ""));
    s = txt(maybe) || "";
  }
  return s.replace(/\s+/g, " ").trim();
}

function parseCoords(card) {
  let lat = "", lon = "";
  const candidates = [
    ...qsa(card, "[data-coordinates],[data-coord],[data-lat][data-lon]"),
    card
  ];
  let up = card;
  for (let i = 0; i < 4 && up; i++) {
    candidates.push(up);
    up = up.parentElement;
  }
  for (const el of candidates) {
    if (!el || el.nodeType !== 1) continue;
    if (el.hasAttribute?.("data-coordinates")) {
      const raw = el.getAttribute("data-coordinates") || "";
      const nums = raw.match(/-?\d+(?:[.,]\d+)?/g) || [];
      if (nums.length >= 2) {
        lat = nums[1].replace(",", ".");
        lon = nums[0].replace(",", ".");
        break;
      }
    } else if (el.hasAttribute?.("data-lat") && el.hasAttribute?.("data-lon")) {
      lat = el.getAttribute("data-lat").replace(",", ".");
      lon = el.getAttribute("data-lon").replace(",", ".");
      break;
    }
  }
  return { lat, lon };
}

// ===== caches =====
const NET_CACHE = new Map();  // Yandex: org_id -> { rating, reviews, address }
const GIS2_CACHE = new Map(); // 2GIS: numeric org_id -> Row
const GIS2_META = new Map();  // 2GIS: provenance/quality, not exported
let GIS2_CONTEXT_KEY = "";
const GIS2_SCAN = {
  running: false,
  stopRequested: false,
  page: 0,
  pagesDone: 0,
  discovered: 0,
  warmed: 0,
  failed: 0,
  nextControl: "",
  message: "Готово",
  startedAt: "",
  finishedAt: ""
};

function extractFromOrgHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const rating =
    (doc.querySelector(".business-rating-badge-view__rating-text")?.textContent || "")
      .trim().replace(".", ",").match(/^\d+[.,]\d$/)?.[0] || "";

  const reviewsText =
    (doc.querySelector(".business-header-rating-view__text")?.textContent || "")
      .replace(/\D+/g, "").trim();
  const reviews = reviewsText || "";

  const address =
    (doc.querySelector(".business-contacts-view__address-link")?.textContent || "")
      .replace(/\s+/g, " ").trim();

  return { rating, reviews, address };
}

function coerceNumberString(v) {
  if (v == null) return "";
  const s = String(v).trim();
  const m = s.match(/-?\d+(?:[.,]\d+)?/);
  return m ? m[0] : "";
}

function pick2gisCategories(item) {
  const out = [];
  const rubrics = item?.rubrics || item?.rubric || item?.categories || item?.category;
  if (Array.isArray(rubrics)) {
    for (const r of rubrics) {
      const name = r?.name || r?.title || r?.caption || "";
      if (name) out.push(String(name).trim());
    }
  } else if (rubrics && typeof rubrics === "object") {
    const name = rubrics?.name || rubrics?.title || rubrics?.caption || "";
    if (name) out.push(String(name).trim());
  } else if (typeof rubrics === "string") {
    out.push(rubrics.trim());
  }
  return Array.from(new Set(out)).join(" | ");
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === "object") continue;
    const text = String(value).replace(/\s+/g, " ").trim();
    if (text && text !== "[object Object]") return text;
  }
  return "";
}

function get2gisContextKey() {
  try {
    const u = new URL(location.href);
    const routePath = /\/search\//i.test(u.pathname)
      ? u.pathname.replace(/\/firm\/.*$/i, "")
      : u.pathname;
    const path = routePath
      .replace(/\/page\/\d+/gi, "")
      .replace(/\/filters\/sort=[^/?#]+/gi, "")
      .replace(/\/+$/, "");
    const query = new URLSearchParams(u.search);
    for (const key of ["m", "stat", "center", "zoom"]) query.delete(key);
    query.sort();
    return `${u.origin}${path}?${query.toString()}`;
  } catch {
    return String(location.pathname || "");
  }
}

function reset2gisCache(reason = "") {
  GIS2_CACHE.clear();
  GIS2_META.clear();
  GIS2_CONTEXT_KEY = get2gisContextKey();
  GIS2_SCAN.discovered = 0;
  GIS2_SCAN.warmed = 0;
  GIS2_SCAN.failed = 0;
  if (reason) GIS2_SCAN.message = reason;
  emit2gisScanState();
}

function ensure2gisContext() {
  const next = get2gisContextKey();
  if (!GIS2_CONTEXT_KEY) {
    GIS2_CONTEXT_KEY = next;
    return;
  }
  if (!GIS2_SCAN.running && next !== GIS2_CONTEXT_KEY) reset2gisCache("Новый запрос 2ГИС");
}

function is2gisAdOrTechnicalItem(item) {
  const type = String(item?.type || item?.entity_type || item?.result_type || "").toLowerCase();
  if (/^(rubric|category|region|district|street|building|route|geo|advertisement|banner|promo)$/.test(type)) {
    return true;
  }
  if (item?.is_ad === true || item?.is_advertisement === true || item?.is_promo === true || item?.is_sponsored === true) {
    return true;
  }
  return false;
}

function is2gisOrganizationItem(item) {
  if (!item || typeof item !== "object" || is2gisAdOrTechnicalItem(item)) return false;
  const id = normalize2gisOrgId(item?.id || item?.branch_id || item?.firm_id);
  const title = firstNonEmpty(item?.name, item?.title);
  return isValid2gisOrgId(id) && !!title;
}

function classify2gisResponse(url) {
  const value = String(url || "");
  return /\/items\/byid(?:[/?]|$)/i.test(value) ? "detail" : "search";
}

function extract2gisItems(payload) {
  const candidates = [
    payload?.result?.items,
    payload?.items,
    payload?.result?.branches,
    payload?.result?.firm,
    payload?.data ? [payload.data] : null
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return [value];
  }
  return [];
}

function get2gisRowQuality(row) {
  if (!row) return 0;
  return ["title", "rating", "reviews", "categories_all", "address", "lat", "lon"]
    .reduce((score, key) => score + (row[key] !== "" && row[key] != null ? 1 : 0), 0);
}

function merge2gisRows(previous, incoming, incomingKind, previousKind = "") {
  const merged = { ...(previous || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === "" || value == null || value === "[object Object]") continue;
    const oldValue = merged[key];
    const authoritative = incomingKind === "detail" || (incomingKind === "search" && previousKind !== "detail");
    const richerDomTitle = incomingKind === "dom" && key === "title" && String(value).length > String(oldValue || "").length;
    if (oldValue === "" || oldValue == null || authoritative || richerDomTitle || key === "scraped_at") {
      merged[key] = value;
    }
  }
  merged.org_id = incoming.org_id || previous?.org_id || "";
  merged.url = build2gisFirmUrl(merged.org_id);
  return merged;
}

function store2gisItem(item, sourceUrl) {
  if (!is2gisOrganizationItem(item)) return false;
  const row = normalize2gisItemToRow(item, sourceUrl);
  if (!row.org_id) return false;
  const kind = classify2gisResponse(sourceUrl);
  const previous = GIS2_CACHE.get(row.org_id) || {};
  const oldMeta = GIS2_META.get(row.org_id) || {};
  const merged = merge2gisRows(previous, row, kind, oldMeta.kind || "");
  GIS2_CACHE.set(row.org_id, merged);
  GIS2_META.set(row.org_id, {
    ...oldMeta,
    kind: oldMeta.kind === "detail" ? "detail" : kind,
    quality: get2gisRowQuality(merged),
    updatedAt: Date.now()
  });
  return true;
}

function normalize2gisItemToRow(item, urlHint) {
  const rawId = String(item?.id || item?.branch_id || item?.firm_id || "").trim();

  // org_id только числовой
  const org_id = normalize2gisOrgId(rawId);
  const title = String(item?.name || item?.title || "").trim();

  const rating = coerceNumberString(
    item?.reviews?.general_rating || item?.rating || item?.reviews_rating ||
    item?.stat?.rating || item?.reviews?.rating
  )?.replace(".", ",") || "";

  const reviews = coerceNumberString(
    item?.reviews?.general_review_count || item?.reviews_count || item?.review_count || item?.reviews?.count ||
    item?.stat?.reviews_count || item?.stat?.rating_count
  );

  const address = firstNonEmpty(
    item?.address_name,
    item?.address?.name,
    item?.address?.text,
    item?.address?.full_name,
    item?.address
  );

  const { lat, lon } = extract2gisCoordinates(item, urlHint);

  const categories_all = pick2gisCategories(item);
  const photos_count = coerceNumberString(item?.photos_count || item?.photo_count || item?.photos?.count);

  // url: берём из item если есть, иначе строим сами
  const url = build2gisFirmUrl(org_id);

  return {
    org_id,
    title,
    rating,
    reviews,
    categories_all,
    address,
    photos_count,
    lat,
    lon,
    url,
    scraped_at: new Date().toISOString()
  };
}

function injectScript(file) {
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL(file);
    s.dataset.injected = "1";
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch {}
}

// ===== receive intercept messages =====
window.addEventListener("message", (ev) => {
  const d = ev?.data || {};
  if (!d || !d.__YMAPS_INTERCEPT__) return;

  // Yandex: HTML org page
  if (d.kind === "org_html" && d.url && (typeof d.payload === "string" || typeof d.html === "string")) {
    const { url } = d;
    const html = (typeof d.payload === "string") ? d.payload : d.html;
    const { org_id } = cleanOrgUrl(url);
    if (!org_id) return;
    const extra = extractFromOrgHtml(html);
    const prev = NET_CACHE.get(org_id) || {};
    NET_CACHE.set(org_id, { ...prev, ...extra });
    return;
  }

  // 2GIS: JSON pages of search/items
  if (d.kind === "2gis_json" && d.url && d.payload && typeof d.payload === "object") {
    ensure2gisContext();
    const url = String(d.url || "");
    const payload = d.payload;
    for (const item of extract2gisItems(payload)) store2gisItem(item, url);
    GIS2_SCAN.discovered = GIS2_CACHE.size;
    emit2gisScanState();
  }
}, false);

// inject interceptors
(function ensureInterceptors() {
  if (!window.__ym_injected__) {
    window.__ym_injected__ = true;
    injectScript("sniffer.js");
    injectScript("interceptor.js");
  }
})();

// ===== collect =====
const COLUMN_ORDER = [
  "org_id", "title", "rating", "reviews",
  "categories_all", "address",
  "photos_count",
  "lat", "lon",
  "url", "scraped_at"
];

const ACTIVE_DOMAIN = detectDomainByLocation();

function get2gisScanState() {
  const withCoordinates = count2gisCoordinateRows();
  const withBaseData = count2gisBaseRows();
  return {
    ...GIS2_SCAN,
    warmed: count2gisReadyRows(),
    cached: GIS2_CACHE.size,
    withCoordinates,
    missingCoordinates: Math.max(0, GIS2_CACHE.size - withCoordinates),
    withBaseData,
    missingBaseData: Math.max(0, GIS2_CACHE.size - withBaseData)
  };
}

function count2gisReadyRows() {
  let ready = 0;
  for (const row of GIS2_CACHE.values()) {
    if (get2gisRowQuality(row) >= 6) ready++;
  }
  return ready;
}

function count2gisCoordinateRows() {
  let ready = 0;
  for (const row of GIS2_CACHE.values()) {
    if (normalize2gisCoordinatePair(row?.lat, row?.lon).lat) ready++;
  }
  return ready;
}

function count2gisBaseRows() {
  let ready = 0;
  for (const [orgId, row] of GIS2_CACHE.entries()) {
    const hasNetworkItem = GIS2_META.has(orgId);
    const richFields = ["rating", "reviews", "categories_all", "address"]
      .filter((key) => row?.[key] !== "" && row?.[key] != null).length;
    if (hasNetworkItem || richFields >= 2) ready++;
  }
  return ready;
}

function emit2gisScanState() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("MAPS_EXPORT_2GIS_SCAN_STATE", {
      detail: get2gisScanState()
    }));
  } catch {}
}

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function get2gisFirmAnchors() {
  const seen = new Set();
  return qsa(document, 'a[href*="/firm/"]').filter(anchor => {
    const { org_id } = clean2gisOrgUrl(anchor.href);
    if (!org_id || seen.has(org_id)) return false;
    seen.add(org_id);
    return true;
  });
}

function get2gisCardRoot(anchor) {
  let node = anchor?.parentElement || null;
  let best = node;
  for (let level = 0; node && level < 8; level++, node = node.parentElement) {
    const firmLinks = node.querySelectorAll?.('a[href*="/firm/"]').length || 0;
    if (firmLinks > 1) break;
    if (firmLinks === 1) best = node;
  }
  return best || anchor?.parentElement || anchor;
}

function clean2gisDomLine(value) {
  return String(value ?? "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function parse2gisDomCard(anchor) {
  const card = get2gisCardRoot(anchor);
  const lines = String(card?.innerText || "").split(/\r?\n/).map(clean2gisDomLine).filter(Boolean);
  const baseTitle = clean2gisDomLine(anchor?.getAttribute?.("aria-label") || anchor?.getAttribute?.("title") || txt(anchor));
  const titleIndex = Math.max(0, lines.findIndex((line) => line === baseTitle));
  const subtype = lines[titleIndex + 1] || "";
  const subtypeUsable = subtype && subtype.length < 90 && !/^(?:\d+[.,]\d+|\(\d+\)|подтвержд[её]н|премия|реклама|рекомендуем|открыто|закрыто)$/i.test(subtype);
  const title = subtypeUsable && !baseTitle.toLowerCase().includes(subtype.toLowerCase())
    ? `${baseTitle}, ${subtype.toLowerCase()}`
    : baseTitle;
  const rating = (lines.find((line) => /^\d(?:[.,]\d)$/.test(line)) || "").replace(".", ",");
  const reviews = (lines.find((line) => /^\(\s*\d[\d\s]*\s*\)$/.test(line)) || "").replace(/\D/g, "");

  let address = lines.find((line) =>
    /(?:улиц|проспект|переул|шоссе|площад|бульвар|набережн|проезд|тракт|микрорайон|квартал|, ?\s*\d)/i.test(line) &&
    !/(?:цена|чек|звезд|мест|номер на час)/i.test(line)
  ) || "";
  address = address.replace(/\s*\d+\s*филиал\S*$/i, "").trim();
  const addressParts = address.split(",").map(clean2gisDomLine).filter(Boolean);
  if (addressParts.length >= 3 && !/\d/.test(addressParts[addressParts.length - 1])) addressParts.pop();
  address = addressParts.join(", ");

  const featureLine = lines.find((line) => line.includes("·") && line !== address) || "";
  const firstFeature = clean2gisDomLine(featureLine.split("·")[0]);
  const featureLooksLikeCategory = firstFeature && !/(?:₽|цена|чек|номер на час|wi-?fi|звезд|мест|завтрак|парков)/i.test(firstFeature);
  const categories_all = featureLooksLikeCategory ? firstFeature : (subtypeUsable ? subtype : "");

  return { title, rating, reviews, categories_all, address };
}

function get2gisAnchorTitle(anchor) {
  const card = get2gisCardRoot(anchor);
  return firstNonEmpty(
    anchor.getAttribute?.("aria-label"),
    anchor.getAttribute?.("title"),
    txt(anchor),
    txt(card?.querySelector?.("h1, h2, h3, [class*=title]"))
  );
}

function remember2gisAnchor(anchor) {
  const { org_id, url } = clean2gisOrgUrl(anchor?.href || "");
  if (!org_id) return "";
  const previous = GIS2_CACHE.get(org_id) || {};
  const domRow = parse2gisDomCard(anchor);
  const title = previous.title || domRow.title || get2gisAnchorTitle(anchor);
  const coordinates = coordinatesFrom2gisUrl(anchor?.href || "");
  if (title || (coordinates.lat && coordinates.lon)) {
    GIS2_CACHE.set(org_id, merge2gisRows(previous, {
      org_id,
      title,
      rating: domRow.rating,
      reviews: domRow.reviews,
      categories_all: domRow.categories_all,
      address: domRow.address,
      lat: coordinates.lat,
      lon: coordinates.lon,
      url,
      scraped_at: new Date().toISOString()
    }, "dom"));
  }
  return org_id;
}

function find2gisScrollContainer(anchors) {
  let best = null;
  let bestScore = -1;
  for (const anchor of anchors.slice(0, 12)) {
    let node = anchor.parentElement;
    for (let level = 0; node && level < 10; level++, node = node.parentElement) {
      const style = getComputedStyle(node);
      const scrollable = node.scrollHeight > node.clientHeight + 80 && /auto|scroll/.test(style.overflowY || "");
      if (!scrollable) continue;
      const score = node.querySelectorAll?.('a[href*="/firm/"]').length || 0;
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
  }
  return best || document.scrollingElement || document.documentElement;
}

function fire2gisWarmEvents(anchor) {
  try { anchor.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); } catch {}
  const card = get2gisCardRoot(anchor);
  const targets = [card, anchor].filter((node, index, all) => node && all.indexOf(node) === index);
  for (const target of targets) {
    for (const type of ["pointerover", "mouseover", "mouseenter", "focusin"]) {
      try {
        const EventCtor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
        target.dispatchEvent(new EventCtor(type, { bubbles: true, cancelable: true, view: window }));
      } catch {}
    }
  }
}

async function warm2gisAnchor(anchor) {
  const orgId = remember2gisAnchor(anchor);
  if (!orgId) return false;
  // Быстрый режим не открывает карточку организации: это меняло маршрут и
  // масштаб карты. Короткого hover достаточно для виртуализации DOM, а
  // недостающие поля будут получены отдельным подробным досбором 2ГИС.
  fire2gisWarmEvents(anchor);
  await waitMs(25);
  return get2gisRowQuality(GIS2_CACHE.get(orgId)) >= 4;
}

function get2gisPageSignature() {
  return get2gisFirmAnchors().slice(0, 8)
    .map(anchor => clean2gisOrgUrl(anchor.href).org_id)
    .filter(Boolean)
    .join("|");
}

async function settle2gisPageData(pageIds, timeoutMs = 2600) {
  const ids = Array.from(new Set(pageIds || [])).filter(Boolean);
  if (!ids.length) return { ready: 0, pending: 0 };
  const deadline = Date.now() + timeoutMs;
  while (!GIS2_SCAN.stopRequested && Date.now() < deadline) {
    const pending = ids.filter((id) => !GIS2_META.has(id));
    if (!pending.length) return { ready: ids.length, pending: 0 };
    const pendingSet = new Set(pending);
    for (const anchor of get2gisFirmAnchors()) {
      const id = clean2gisOrgUrl(anchor.href).org_id;
      if (pendingSet.has(id)) fire2gisWarmEvents(anchor);
    }
    GIS2_SCAN.message = `Страница ${GIS2_SCAN.page}: ожидаю базовые данные ${ids.length - pending.length}/${ids.length}`;
    emit2gisScanState();
    await waitMs(180);
  }
  const pending = ids.filter((id) => !GIS2_META.has(id)).length;
  return { ready: ids.length - pending, pending };
}

function get2gisCurrentPageNumber() {
  const urlMatch = String(location.pathname || "").match(/\/page\/(\d+)/i);
  if (urlMatch) return Number(urlMatch[1]) || 1;
  const current = document.querySelector('[aria-current="page"], [class*="pagination"] [class*="active"]');
  const n = Number(String(txt(current)).replace(/\D/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function find2gisNextPageControl() {
  const requestedSelector = "#root > div > div > div._1sf34doj > div._1u4plm2 > div:nth-child(3) > div > div > div > div:nth-child(2) > div > div > div > div._1tdquig > div._z72pvu > div._3zzdxk > div > div > div > div._1x4k6z7 > div._5ocwns > div._n5hmn94 > svg";
  const requestedArrow = document.querySelector(requestedSelector);
  const requestedContainer = requestedArrow?.closest("div._5ocwns") || null;
  const containers = [requestedContainer, ...qsa(document, "div._5ocwns")].filter((node, index, all) => node && all.indexOf(node) === index);

  // Начиная со второй страницы класс _n5hmn94 назначен обеим стрелкам.
  // Первая из них ведёт назад, последняя — вперёд. На последней странице
  // правая стрелка становится _7q94tr, поэтому такой контейнер пропускаем.
  for (const container of containers) {
    const forward = container.lastElementChild;
    if (!forward?.matches?.("div._n5hmn94")) continue;
    const svg = forward.querySelector("svg");
    const transform = String(svg?.style?.transform || "");
    if (transform && !/rotate\(\s*-90deg\s*\)/i.test(transform)) continue;
    GIS2_SCAN.nextControl = "requested-forward-arrow";
    return forward;
  }

  const current = get2gisCurrentPageNumber();
  const numbered = qsa(document, 'a[href*="/page/"]').map(anchor => {
    const match = String(anchor.getAttribute("href") || "").match(/\/page\/(\d+)/i);
    return { anchor, page: match ? Number(match[1]) : 0 };
  }).filter(item => item.page > current).sort((a, b) => a.page - b.page);
  if (numbered.length) {
    GIS2_SCAN.nextControl = "numbered-link-fallback";
    return numbered[0].anchor;
  }

  const semantic = qsa(document, '[class*="pagination"] a, [class*="pagination"] button, nav a, nav button').find(element => {
    const label = `${element.getAttribute?.("aria-label") || ""} ${element.getAttribute?.("title") || ""} ${txt(element)}`;
    return /следующ|далее|next/i.test(label) && !element.disabled && element.getAttribute?.("aria-disabled") !== "true";
  }) || null;
  GIS2_SCAN.nextControl = semantic ? "semantic-fallback" : "not-found";
  return semantic;
}

async function scan2gisCurrentPage(globalSeen) {
  let stableRounds = 0;
  let previousCount = globalSeen.size;
  let rounds = 0;
  let container = null;
  const pageSeen = new Set();

  while (!GIS2_SCAN.stopRequested && stableRounds < 4 && rounds < 80) {
    rounds++;
    const anchors = get2gisFirmAnchors();
    for (const anchor of anchors) {
      const id = clean2gisOrgUrl(anchor.href).org_id;
      if (id) pageSeen.add(id);
    }
    if (!container || !document.contains(container)) container = find2gisScrollContainer(anchors);

    const fresh = anchors.filter(anchor => {
      const id = clean2gisOrgUrl(anchor.href).org_id;
      return id && !globalSeen.has(id);
    });

    for (const anchor of fresh) {
      if (GIS2_SCAN.stopRequested) break;
      const id = clean2gisOrgUrl(anchor.href).org_id;
      globalSeen.add(id);
      GIS2_SCAN.discovered = Math.max(GIS2_CACHE.size, globalSeen.size);
      GIS2_SCAN.message = `Страница ${GIS2_SCAN.page}: карточка ${globalSeen.size}`;
      emit2gisScanState();
      await warm2gisAnchor(anchor);
      GIS2_SCAN.warmed = count2gisReadyRows();
      emit2gisScanState();
      await waitMs(90);
    }

    if (globalSeen.size === previousCount) stableRounds++;
    else stableRounds = 0;
    previousCount = globalSeen.size;

    if (container) {
      const oldTop = container.scrollTop;
      const step = Math.max(320, Math.floor(container.clientHeight * 0.78));
      container.scrollTop = Math.min(container.scrollHeight, oldTop + step);
      if (container.scrollTop === oldTop && !fresh.length) stableRounds++;
    }
    await waitMs(420);
  }
  return Array.from(pageSeen);
}

async function waitFor2gisPageChange(oldSignature, oldPage) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && !GIS2_SCAN.stopRequested) {
    await waitMs(250);
    const next = get2gisPageSignature();
    const page = get2gisCurrentPageNumber();
    if (page > oldPage && next && next !== oldSignature) return true;
  }
  return false;
}

async function start2gisAutoScan(options = {}) {
  if (ACTIVE_DOMAIN !== "2gis") throw new Error("Автосбор страниц доступен только в 2ГИС");
  if (GIS2_SCAN.running) return get2gisScanState();

  ensure2gisContext();
  const maxPages = Math.max(1, Math.min(Number(options.maxPages) || 50, 100));
  const globalSeen = new Set();
  const visitedPages = new Set();
  let terminalMessage = "";
  Object.assign(GIS2_SCAN, {
    running: true,
    stopRequested: false,
    page: get2gisCurrentPageNumber(),
    pagesDone: 0,
    discovered: GIS2_CACHE.size,
    warmed: 0,
    failed: 0,
    nextControl: "",
    message: "Запуск автосбора…",
    startedAt: new Date().toISOString(),
    finishedAt: ""
  });
  emit2gisScanState();

  try {
    for (let index = 0; index < maxPages && !GIS2_SCAN.stopRequested; index++) {
      GIS2_SCAN.page = get2gisCurrentPageNumber();
      if (visitedPages.has(GIS2_SCAN.page)) {
        terminalMessage = `Остановлено: страница ${GIS2_SCAN.page} уже обработана`;
        break;
      }
      visitedPages.add(GIS2_SCAN.page);
      GIS2_SCAN.message = `Сканируется страница ${GIS2_SCAN.page}`;
      emit2gisScanState();
      const pageIds = await scan2gisCurrentPage(globalSeen);
      await settle2gisPageData(pageIds);
      GIS2_SCAN.pagesDone++;
      emit2gisScanState();

      if (index + 1 >= maxPages) break;
      const next = find2gisNextPageControl();
      if (!next || GIS2_SCAN.stopRequested) break;
      const pageBefore = GIS2_SCAN.page;
      const signature = get2gisPageSignature();
      try { next.scrollIntoView({ block: "center", behavior: "instant" }); } catch {}
      next.click();
      GIS2_SCAN.message = "Открывается следующая страница…";
      emit2gisScanState();
      if (!await waitFor2gisPageChange(signature, pageBefore)) {
        terminalMessage = "Следующая страница не загрузилась";
        break;
      }
      const pageAfter = get2gisCurrentPageNumber();
      if (pageAfter <= pageBefore || visitedPages.has(pageAfter)) {
        terminalMessage = `Защита пагинации: переход ${pageBefore} → ${pageAfter} остановлен`;
        break;
      }
      await waitMs(650);
    }
  } finally {
    GIS2_SCAN.running = false;
    GIS2_SCAN.finishedAt = new Date().toISOString();
    GIS2_SCAN.discovered = GIS2_CACHE.size;
    const coordinateCount = count2gisCoordinateRows();
    const baseCount = count2gisBaseRows();
    const coordinateStatus = `координаты ${coordinateCount}/${GIS2_CACHE.size}`;
    const baseStatus = `база ${baseCount}/${GIS2_CACHE.size}`;
    GIS2_SCAN.message = GIS2_SCAN.stopRequested
      ? `Остановлено: ${GIS2_CACHE.size} объектов · ${coordinateStatus} · ${baseStatus}`
      : terminalMessage || `Готово: ${GIS2_CACHE.size} объектов · ${coordinateStatus} · ${baseStatus}`;
    emit2gisScanState();
  }
  return get2gisScanState();
}

function stop2gisAutoScan() {
  if (!GIS2_SCAN.running) return get2gisScanState();
  GIS2_SCAN.stopRequested = true;
  GIS2_SCAN.message = "Останавливаю автосбор…";
  emit2gisScanState();
  return get2gisScanState();
}

function parseCard(card, coordinates) {
  const link = card.querySelector('a[href*="/maps/org/"]');
  const { url, org_id } = cleanOrgUrl(link ? link.href : "");
  const title = parseTitle(card);
  const { rating, reviews } = parseRatingAndReviews(card);
  const categories_all = parseCategories(card);
  const photos_count = parsePhotosCount(card);
  const { lat, lon } = coordinates?.get(org_id) || parseCoords(card);
  const address = parseAddress(card);

  const net = org_id ? (NET_CACHE.get(org_id) || {}) : {};
  const rating_final  = net.rating  || rating;
  const reviews_final = net.reviews || reviews;
  const address_final = net.address || address;

  return {
    org_id,
    title,
    rating: rating_final,
    reviews: reviews_final,
    categories_all,
    address: address_final,
    photos_count,
    lat,
    lon,
    url,
    scraped_at: new Date().toISOString()
  };
}

function collectAllCards() {
  if (ACTIVE_DOMAIN === "2gis") {
    ensure2gisContext();
    const out = Array.from(GIS2_CACHE.values()).filter(r => r && r.org_id);

    // fallback: если сеть ещё не дала items — добираем id из /firm/
    if (!out.length) {
      const links = qsa(document, 'a[href*="/firm/"]');
      const seen = new Set();
      for (const a of links) {
        const { org_id, url } = clean2gisOrgUrl(a.href);
        if (!org_id || seen.has(org_id)) continue;
        seen.add(org_id);
        const title = get2gisAnchorTitle(a);
        if (!title) continue;
        const coordinates = coordinatesFrom2gisUrl(a.href);
        out.push({
          org_id,
          title,
          rating: "",
          reviews: "",
          categories_all: "",
          address: "",
          photos_count: "",
          lat: coordinates.lat,
          lon: coordinates.lon,
          url,
          scraped_at: new Date().toISOString()
        });
      }
    }
    return out;
  }

  // Yandex
  const coordinates = globalThis.MapsYandexCoordinates?.read(document);
  const links = qsa(document, 'a[href*="/maps/org/"]');
  const seen = new Set();
  const rows = [];

  for (const a of links) {
    const { org_id } = cleanOrgUrl(a.href);
    if (!org_id || seen.has(org_id)) continue;
    const card = cardFromLink(a);
    const row = parseCard(card, coordinates);
    if (!row.org_id) continue;
    seen.add(org_id);
    rows.push(row);
  }
  return rows;
}

// ===== context for session snapshots =====
function parseMapStateFromCurrentUrl() {
  const state = { center_lat: "", center_lon: "", zoom: "", raw_url: location.href };

  try {
    const u = new URL(location.href);

    if (ACTIVE_DOMAIN === "yandex") {
      const ll = u.searchParams.get("ll");
      const z = u.searchParams.get("z");
      if (ll) {
        const [lon, lat] = ll.split(",");
        state.center_lon = lon || "";
        state.center_lat = lat || "";
      }
      state.zoom = z || "";
    }

    if (ACTIVE_DOMAIN === "2gis") {
      const rawM = u.searchParams.get("m") || decodeURIComponent(u.hash || "");
      const m = String(rawM).match(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:\/([\d.]+))?/);
      if (m) {
        state.center_lon = m[1] || "";
        state.center_lat = m[2] || "";
        state.zoom = m[3] || "";
      }
    }
  } catch {}

  return state;
}

function detectSearchQueryOnPage() {
  try {
    if (ACTIVE_DOMAIN === "yandex") {
      const el =
        document.querySelector('input.input__control._bold') ||
        document.querySelector('input[placeholder*="Поиск"]');
      return el ? String(el.value || el.textContent || "").trim() : "";
    }

    if (ACTIVE_DOMAIN === "2gis") {
      const el =
        document.querySelector('input[type="search"]') ||
        document.querySelector('input[placeholder*="Поиск"]') ||
        document.querySelector('input[aria-label*="Поиск"]');
      return el ? String(el.value || el.textContent || "").trim() : "";
    }
  } catch {}
  return "";
}

function getSnapshotContext() {
  return {
    source: ACTIVE_DOMAIN,
    query: detectSearchQueryOnPage(),
    title: document.title || "",
    page_url: location.href,
    map_state: parseMapStateFromCurrentUrl(),
    captured_at: new Date().toISOString()
  };
}

// ===== shared API for floating overlay =====
window.__MAPS_EXPORT_COLLECTOR__ = {
  source: ACTIVE_DOMAIN,
  columns: COLUMN_ORDER,
  collect: collectAllCards,
  context: getSnapshotContext,
  getScanState: get2gisScanState,
  startAutoScan: start2gisAutoScan,
  stopAutoScan: stop2gisAutoScan,
  clear: () => {
    if (ACTIVE_DOMAIN === "2gis") reset2gisCache("Кэш 2ГИС очищен");
  }
};

window.__MAPS_EXPORT_2GIS_TEST__ = {
  normalizeOrgId: normalize2gisOrgId,
  isValidOrgId: isValid2gisOrgId,
  cleanOrgUrl: clean2gisOrgUrl,
  isOrganizationItem: is2gisOrganizationItem,
  normalizeItem: normalize2gisItemToRow,
  coordinatesFromUrl: coordinatesFrom2gisUrl,
  extractCoordinates: extract2gisCoordinates,
  storeItem: store2gisItem,
  settlePageData: settle2gisPageData,
  parseDomCard: parse2gisDomCard,
  mergeRows: merge2gisRows,
  quality: get2gisRowQuality,
  warmAnchor: warm2gisAnchor,
  findNextPageControl: find2gisNextPageControl
};

// ===== messages from popup =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "PING") { sendResponse({ ok: true }); return; }

  if (msg?.type === "GET_CONTEXT") {
    try {
      sendResponse({ ok: true, context: getSnapshotContext() });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  }

  if (msg?.type === "COLLECT") {
    try {
      const rows = collectAllCards();
      sendResponse({ ok: true, domain: ACTIVE_DOMAIN, rows, columns: COLUMN_ORDER });
    } catch (e) {
      console.error("COLLECT error", e);
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  }
});
