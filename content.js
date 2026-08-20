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
  const raw = String(rawFirmId || "").trim();
  if (!raw) return "";
  const city = get2gisCityPrefix();
  const base = String(location.origin || "https://2gis.ru");
  return city ? `${base}/${city}/firm/${raw}` : `${base}/firm/${raw}`;
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

    u.hash = "";
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

function normalize2gisItemToRow(item, urlHint) {
  const rawId = String(item?.id || item?.branch_id || item?.firm_id || "").trim();

  // org_id только числовой
  const org_id = normalize2gisOrgId(rawId);
  const title = String(item?.name || item?.title || "").trim();

  const rating = coerceNumberString(
    item?.rating || item?.reviews_rating || item?.stat?.rating || item?.reviews?.rating
  )?.replace(".", ",") || "";

  const reviews = coerceNumberString(
    item?.reviews_count || item?.review_count || item?.reviews?.count ||
    item?.stat?.reviews_count || item?.stat?.rating_count
  );

  const address = String(
    item?.address_name || item?.address?.name || item?.address?.text || item?.address || ""
  ).replace(/\s+/g, " ").trim();

  let lat = "", lon = "";
  const p = item?.point || item?.location || item?.geometry?.centroid || item?.coords || item?.coord;
  if (p && typeof p === "object") {
    lat = coerceNumberString(p.lat ?? p.latitude ?? (Array.isArray(p) ? p[1] : "")).replace(",", ".");
    lon = coerceNumberString(p.lon ?? p.lng ?? p.longitude ?? (Array.isArray(p) ? p[0] : "")).replace(",", ".");
  }

  const categories_all = pick2gisCategories(item);
  const photos_count = coerceNumberString(item?.photos_count || item?.photo_count || item?.photos?.count);

  // url: берём из item если есть, иначе строим сами
  let url =
    normalize2gisUrl(item?.url) ||
    normalize2gisUrl(item?.link) ||
    normalize2gisUrl(item?.share_link) ||
    "";

  if (!url && rawId) {
    // URL строим по rawId (составной id сохраняем в URL, как в 2ГИС)
    url = build2gisFirmUrl(rawId);
  }

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
    const url = String(d.url || "");
    const payload = d.payload;
    const items = payload?.result?.items || payload?.items || payload?.result?.branches || payload?.result?.firm || [];
    const arr = Array.isArray(items) ? items : (Array.isArray(payload?.result) ? payload.result : []);
    for (const it of arr) {
      const row = normalize2gisItemToRow(it, url);
      if (!row.org_id) continue;

      const key = row.org_id; // числовой

      // merge without overwriting non-empty with empty
      const prev = GIS2_CACHE.get(key) || {};
      const merged = { ...prev, ...row, org_id: key };
      for (const k of Object.keys(merged)) {
        if (merged[k] === "" && prev[k] != null && prev[k] !== "") merged[k] = prev[k];
      }
      GIS2_CACHE.set(key, merged);
    }
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

function parseCard(card) {
  const link = card.querySelector('a[href*="/maps/org/"]');
  const { url, org_id } = cleanOrgUrl(link ? link.href : "");
  const title = parseTitle(card);
  const { rating, reviews } = parseRatingAndReviews(card);
  const categories_all = parseCategories(card);
  const photos_count = parsePhotosCount(card);
  const { lat, lon } = parseCoords(card);
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
    const out = Array.from(GIS2_CACHE.values()).filter(r => r && r.org_id);

    // fallback: если сеть ещё не дала items — добираем id из /firm/
    if (!out.length) {
      const links = qsa(document, 'a[href*="/firm/"]');
      const seen = new Set();
      for (const a of links) {
        const { org_id, url } = clean2gisOrgUrl(a.href);
        if (!org_id || seen.has(org_id)) continue;
        seen.add(org_id);
        out.push({
          org_id,
          title: txt(a) || "",
          rating: "",
          reviews: "",
          categories_all: "",
          address: "",
          photos_count: "",
          lat: "",
          lon: "",
          url,
          scraped_at: new Date().toISOString()
        });
      }
    }
    return out;
  }

  // Yandex
  const links = qsa(document, 'a[href*="/maps/org/"]');
  const seen = new Set();
  const rows = [];

  for (const a of links) {
    const { org_id } = cleanOrgUrl(a.href);
    if (!org_id || seen.has(org_id)) continue;
    const card = cardFromLink(a);
    const row = parseCard(card);
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
  context: getSnapshotContext
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
