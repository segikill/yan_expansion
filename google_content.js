// Порядок колонок такой же, как у Яндекса / popup.js
const COLUMN_ORDER = [
  "org_id", "title", "rating", "reviews",
  "categories_all", "address",
  "photos_count",
  "lat", "lon",
  "url", "scraped_at"
];

// Небольшая задержка
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function stableHash(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function cleanGoogleIdPart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_:.%-]+/g, "_").slice(0, 160);
}

function makeStableGoogleOrgId(url, title, lat, lon, address) {
  const raw = String(url || "");
  const decoded = (() => {
    try { return decodeURIComponent(raw); } catch { return raw; }
  })();

  try {
    const u = new URL(raw);
    const cid = u.searchParams.get("cid") || u.searchParams.get("ludocid");
    if (cid) return `cid_${cleanGoogleIdPart(cid)}`;
  } catch {}

  // Частый внутренний идентификатор Google в URL: !1s0x...:0x...
  let m = decoded.match(/!1s([^!]+)/);
  if (m && m[1]) return `place_${cleanGoogleIdPart(m[1])}`;

  // Иногда place_id встречается в query/data.
  m = decoded.match(/place_id[:=]([A-Za-z0-9_-]+)/i);
  if (m && m[1]) return `placeid_${cleanGoogleIdPart(m[1])}`;

  // Последний устойчивый fallback: URL без volatile-параметров + имя/координаты.
  let normalizedUrl = raw;
  try {
    const u = new URL(raw);
    u.searchParams.delete("entry");
    u.searchParams.delete("g_ep");
    normalizedUrl = u.toString();
  } catch {}

  return `hash_${stableHash([normalizedUrl, title, lat, lon, address].join("|"))}`;
}

// Автоскролл панели результатов Google Maps
async function autoScrollResults(maxSteps = 20) {
  const panel =
    document.querySelector('div[role="feed"]') ||
    document.querySelector('div[aria-label*="результаты" i]') ||
    document.querySelector('div[aria-label*="results" i]');

  if (!panel) return;

  let lastHeight = -1;
  let sameCounter = 0;

  for (let i = 0; i < maxSteps; i++) {
    panel.scrollBy(0, 800);
    await sleep(700);

    const h = panel.scrollHeight;
    if (h === lastHeight) {
      sameCounter++;
      if (sameCounter >= 3) break;
    } else {
      sameCounter = 0;
      lastHeight = h;
    }
  }
}

function parsePlaceFromCard(card, index) {
  if (!card) return null;

  // основной линк карточки
  const link =
    card.querySelector('a[href*="/maps/place/"]') ||
    card.closest('a[href*="/maps/place/"]');

  if (!link) return null;
  const url = link.href || "";

  // ===== title =====
  const title =
    (link.getAttribute("aria-label") || "").trim() ||
    (card.querySelector('div[role="heading"], span[role="heading"]')?.textContent || "").trim();

  // будем заполнять по шагам
  let rating = "";
  let reviews = "";
  let categories_all = "";
  let address = "";

  // ===== блок с метаданными карточки =====
  // div.UaQhfb.fontBodyMedium
  const meta = card.querySelector("div.UaQhfb.fontBodyMedium");

  if (meta) {
    // ---------- строка с рейтингом и отзывами (div:nth-child(3)) ----------
    const row3 = meta.querySelector(":scope > div:nth-child(3)");
    if (row3) {
      // Рейтинг: span.MW4etd (твоя разметка) + fallback’и
      const ratingEl =
        row3.querySelector("span.MW4etd") ||
        row3.querySelector('span[aria-label*="из 5"]') ||
        row3.querySelector('span[aria-label*="of 5"]') ||
        row3.querySelector('span[aria-label*="out of 5"]');

      if (ratingEl) {
        const src = (
          ratingEl.getAttribute("aria-label") ||
          ratingEl.textContent ||
          ""
        ).trim();
        const m = src.match(/([\d.,]+)/);
        if (m) {
          rating = m[1].replace(",", "."); // приведём к "4.6"
        }
      }

      // Отзывы: span.UY7F9 (твоя разметка) + fallback’и
      const reviewsEl =
        row3.querySelector("span.UY7F9") ||
        row3.querySelector('span[aria-label*="отзыв"]') ||
        row3.querySelector('span[aria-label*="оценк"]') ||
        row3.querySelector('span[aria-label*="review"]');

      if (reviewsEl) {
        const src = (
          reviewsEl.getAttribute("aria-label") ||
          reviewsEl.textContent ||
          ""
        ).trim();
        const m = src.match(/([\d\s]+)/);
        if (m) {
          const num = m[1].replace(/[^\d]/g, "");
          if (num) reviews = num; // только число, без "отзывов"
        }
      }
    }

    // ---------- строка с категорией и адресом (div:nth-child(4)) ----------
    //   категория: div:nth-child(4) > div:nth-child(1) > span:nth-child(1)
    //   адрес:     div:nth-child(4) > div:nth-child(1) > span:nth-child(2) > span:nth-child(2)
    const row4 = meta.querySelector(":scope > div:nth-child(4)");
    if (row4) {
      // категория
      const catSpan =
        row4.querySelector("div:nth-child(1) > span:nth-child(1) span") ||
        row4.querySelector("div:nth-child(1) > span:nth-child(1)");
      if (catSpan) {
        categories_all = catSpan.textContent.trim();
      }

      // адрес
      const addrSpan =
        row4.querySelector("div:nth-child(1) > span:nth-child(2) span:nth-child(2)") ||
        row4.querySelector("div:nth-child(1) > span:nth-child(2)");
      if (addrSpan) {
        address = addrSpan.textContent.trim();
      }
    }
  }

  // ===== fallback'и, если что-то не нашлось =====
  // адрес: если всё равно пусто — берём первую длинную строку с запятой
  if (!address) {
    const textBlocks = Array.from(card.querySelectorAll("div, span"));
    for (const el of textBlocks) {
      const t = (el.textContent || "").trim();
      if (!t) continue;
      if (t === title) continue;
      if (/отзыв|review|рейтин|звезд|звёзд|закрыто|откроется/i.test(t)) continue;
      if (t.length >= 8 && /,/.test(t)) {
        address = t;
        break;
      }
    }
  }

  // категория: если пусто — короткая строка без цифр
  if (!categories_all) {
    const textBlocks = Array.from(card.querySelectorAll("div, span"));
    for (const el of textBlocks) {
      const t = (el.textContent || "").trim();
      if (!t) continue;
      if (t === title) continue;
      if (/отзыв|review|рейтин|закрыто|откроется/i.test(t)) continue;
      if (/[0-9]/.test(t)) continue;
      if (t.length >= 3 && t.length <= 40) {
        categories_all = t;
        break;
      }
    }
  }

  // если отзывы всё ещё пустые — текстовый fallback
  if (!reviews) {
    const around = (card.textContent || "").slice(0, 600);
    const m2 = around.match(/([\d\s]+)\s*(отзыв|отзыва|отзывов|review|reviews)/i);
    if (m2) {
      const num = m2[1].replace(/[^\d]/g, "");
      if (num) reviews = num;
    }
  }

  // ===== координаты из URL =====
  let lat = "";
  let lon = "";

  // Формат 1: .../@LAT,LON,zoom
  let mCoord = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/);
  if (mCoord) {
    lat = mCoord[1];
    lon = mCoord[2];
  } else {
    // Формат 2: ...!3dLAT!4dLON... (как в твоём примере)
    mCoord = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (mCoord) {
      lat = mCoord[1];
      lon = mCoord[2];
    }
  }

  const org_id = makeStableGoogleOrgId(url, title, lat, lon, address) || `gmaps_${index}`;

  return {
    org_id,
    title,
    rating,
    reviews,
    categories_all,
    address,
    photos_count: "",
    lat,
    lon,
    url,
    scraped_at: new Date().toISOString()
  };
}

async function collectPlaces(doAutoScroll = false) {
  if (doAutoScroll) await autoScrollResults(25);

  const panel =
    document.querySelector('div[role="feed"]') ||
    document.querySelector('div[aria-label*="результаты" i]') ||
    document.querySelector('div[aria-label*="results" i]');

  if (!panel) return [];

  const cards = Array.from(
    panel.querySelectorAll('div[role="article"], div[jsaction][data-result-index]')
  );

  const stores = [];
  cards.forEach((card, idx) => {
    const s = parsePlaceFromCard(card, idx);
    if (s && s.org_id) stores.push(s);
  });

  return stores;
}

function parseGoogleMapStateFromUrl() {
  const state = { center_lat: "", center_lon: "", zoom: "", raw_url: location.href };
  try {
    const decoded = decodeURIComponent(location.href);
    const m = decoded.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),([\d.]+)z/);
    if (m) {
      state.center_lat = m[1] || "";
      state.center_lon = m[2] || "";
      state.zoom = m[3] || "";
    }
  } catch {}
  return state;
}

function detectGoogleSearchQuery() {
  try {
    const el =
      document.querySelector("input#searchboxinput") ||
      document.querySelector('input[aria-label*="Search"]') ||
      document.querySelector('input[aria-label*="Поиск"]');
    return el ? String(el.value || el.textContent || "").trim() : "";
  } catch {
    return "";
  }
}

function getSnapshotContext() {
  return {
    source: "google",
    query: detectGoogleSearchQuery(),
    title: document.title || "",
    page_url: location.href,
    map_state: parseGoogleMapStateFromUrl(),
    captured_at: new Date().toISOString()
  };
}

// ===== shared API for floating overlay =====
window.__MAPS_EXPORT_COLLECTOR__ = {
  source: "google",
  columns: COLUMN_ORDER,
  collect: (opts = {}) => collectPlaces(Boolean(opts.autoScroll)),
  context: getSnapshotContext
};

// === протокол, совместимый с popup.js ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "PING") {
    sendResponse({ ok: true });
    return;
  }

  if (msg?.type === "GET_CONTEXT") {
    try {
      sendResponse({ ok: true, context: getSnapshotContext() });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  }

  if (msg?.type === "COLLECT") {
    (async () => {
      try {
        const rows = await collectPlaces();
        sendResponse({
          ok: true,
          rows,
          columns: COLUMN_ORDER
        });
      } catch (e) {
        console.error("Google Maps collector error:", e);
        sendResponse({
          ok: false,
          error: String(e),
          rows: [],
          columns: COLUMN_ORDER
        });
      }
    })();
    return true;
  }
});
