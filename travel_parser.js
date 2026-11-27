(() => {
  "use strict";

  const origin = "https://travel.yandex.ru";
  const source = "travel";
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const nodeText = (node) => clean(node?.innerText || node?.textContent);
  const unique = (values) => [...new Set(values.map(clean).filter(Boolean))];
  const countPattern = /(?<![\d.,])(\d+(?:[ \u00a0\u202f]\d{3})*)\s+(?:отзыв(?:а|ов)?|оцен(?:ка|ки|ок))(?=[\s.,•·]|$)/iu;
  const ratingAndCount = /(?<![\d.,])([1-5][.,]\d)\s*[•·]?\s*(\d+(?:[ \u00a0\u202f]\d{3})*)\s+(?:отзыв(?:а|ов)?|оцен(?:ка|ки|ок))(?=[\s.,•·]|$)/iu;
  const pricePattern = /(?:от\s*)?([\d\s\u00a0\u202f]+)\s*(₽|руб(?:\.|лей)?)/iu;
  const kindPattern = /(?:^|[•·\n])\s*(Гостиница|Отель|Апартаменты|Апарт-отель|Хостел|Квартира|Иное жильё|Гостевой дом|Санаторий|База отдыха|Кемпинг|Коттедж|Дом|Вилла|Курортный отель)\s*(?:$|[•·\n])/iu;
  const headingSelector = "h1,h2,h3,h4,[role=heading]";

  function hotelRef(value, base = origin) {
    try {
      const url = new URL(String(value || ""), base);
      const path = url.pathname.match(/^\/hotels\/([\w-]+)\/([\w-]+)\/?$/iu);
      if (url.origin !== origin || url.username || url.password || !path || /^filter(?:-|$)|^(?:map|search|reviews)$/i.test(path[2])) return null;
      const org_id = `${path[1]}/${path[2]}`;
      return { org_id, url: `${origin}/hotels/${org_id}/` };
    } catch {
      return null;
    }
  }

  function numeric(value) {
    const text = clean(value).replace(/\s/g, "").replace(",", ".");
    const result = Number(text);
    return text && Number.isFinite(result) ? result : "";
  }

  function coordinatePair(latitude, longitude) {
    const lat = numeric(latitude);
    const lon = numeric(longitude);
    return lat !== "" && lon !== "" && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon)
      ? { lat, lon } : {};
  }

  function mapCoordinates(value, base) {
    if (typeof value !== "string" || !value) return {};
    try {
      const url = new URL(value.replace(/&amp;/g, "&"), base);
      const isStatic = url.hostname === "static-maps.yandex.ru";
      const isMaps = url.hostname === "maps.yandex.ru" ||
        (url.hostname === "yandex.ru" && /^\/maps(?:\/|$)/.test(url.pathname));
      if (!isStatic && !isMaps) return {};
      const marker = url.searchParams.get("pt");
      if (marker?.includes("~")) return {};
      const point = marker || (isStatic ? url.searchParams.get("ll") : "");
      const [lon, lat] = String(point || "").split(",");
      return coordinatePair(lat, lon);
    } catch {
      return {};
    }
  }

  function geoFromMap(node, base) {
    const selector = "img[src],a[href]";
    const items = [...node.querySelectorAll(selector)];
    if (node.matches(selector)) items.unshift(node);
    for (const item of items) {
      const point = mapCoordinates(item.getAttribute("src") || item.getAttribute("href"), base);
      if (point.lat !== undefined) return point;
    }
    return {};
  }

  function structuredHotels(doc, base) {
    const hotels = [];
    const visit = (item) => {
      if (Array.isArray(item)) {
        item.forEach(visit);
        return;
      }
      if (!item || typeof item !== "object") return;
      const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
      const ref = hotelRef(item.url || item["@id"], base);
      if (ref && (types.some((type) => /(?:Hotel|LodgingBusiness|Hostel|Resort|Motel|BedAndBreakfast|Accommodation|VacationRental|Apartment|Campground)$/i.test(type || "")) || item.name)) {
        hotels.push({ ref, item });
      }
      for (const key of ["@graph", "mainEntity", "itemListElement", "item"]) visit(item[key]);
    };
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(script.textContent)); } catch {}
    }
    return hotels;
  }

  const searchPageCoordinates = new WeakMap();

  function coordinatesFromSearchData(doc, pageUrl) {
    const prefix = /^\s*window\.__PRELOADED_REDUX_STATE__\s*=\s*/u;
    const script = [...doc.querySelectorAll("script:not([src])")].find((node) => prefix.test(node.textContent));
    if (!script) return new Map();
    if (searchPageCoordinates.has(script)) return searchPageCoordinates.get(script);
    const points = new Map();
    try {
      const state = JSON.parse(script.textContent.replace(prefix, "").trim().replace(/;$/u, ""));
      const results = state?.hotels?.searchHotelsPage?.search?.data;
      const entries = [
        ...(Array.isArray(results?.hotels) ? results.hotels : []),
        ...(Array.isArray(results?.seoInfo?.topReviews?.reviews) ? results.seoInfo.topReviews.reviews : [])
      ];
      for (const { hotel } of entries) {
        const ref = typeof hotel?.hotelSlug === "string" && hotelRef(`/hotels/${hotel.hotelSlug}/`, pageUrl);
        if (!ref || points.has(ref.org_id)) continue;
        const point = coordinatePair(hotel.coordinates?.lat, hotel.coordinates?.lon);
        if (point.lat !== undefined) points.set(ref.org_id, point);
      }
    } catch {}
    searchPageCoordinates.set(script, points);
    return points;
  }

  function readTextMetrics(text) {
    const ratingMatch = text.match(ratingAndCount);
    const reviewMatch = text.match(countPattern);
    const price = text.match(pricePattern);
    const distance = text.match(/([\d.,]+\s*(?:км|м))\s+до центра/iu);
    const categoryMatch = text.match(/[•·]\s*(Гостиница|Отель|Апартаменты|Апарт-отель|Хостел|Квартира|Иное жильё|Гостевой дом|Санаторий|База отдыха|Кемпинг|Коттедж|Дом|Вилла|Курортный отель)(?=\s|[\d•·]|$)/iu);
    return {
      rating: numeric(ratingMatch?.[1]),
      reviews: numeric(ratingMatch?.[2] || reviewMatch?.[1]),
      min_price: numeric(price?.[1]),
      currency: price ? "RUB" : "",
      distance_to_center: clean(distance?.[1]),
      category_first: clean(categoryMatch?.[1])
    };
  }

  function searchOffer(card, pageUrl) {
    const params = new URL(pageUrl).searchParams;
    const text = nodeText(card);
    const period = /(\d+)\s+ноч(?:ь|и|ей)\s*[•·]?\s*(?:[^\d₽]{0,4})(\d[\d \u00a0\u202f]*)\s*₽\s*за ночь/iu.exec(text);
    const explicit = period || /(?:^|\D)(\d[\d \u00a0\u202f]*)\s*₽\s*за ночь/iu.exec(text);
    const checkin = params.get("checkinDate") || "";
    const checkout = params.get("checkoutDate") || "";
    const dateNights = (Date.parse(checkout) - Date.parse(checkin)) / 86400000;
    const nights = period ? Number(period[1]) : dateNights;
    if (period && dateNights > 0 && nights !== dateNights) return null;
    const oneNight = /(?:^|\D)1\s+ночь(?=\s|[•·]|$)/iu.exec(text);
    const singleNight = !explicit && oneNight && (!Number.isFinite(dateNights) || dateNights === 1);
    const price = explicit ? numeric(period ? period[2] : explicit[1])
      : singleNight ? numeric(text.match(pricePattern)?.[1]) : "";
    if (!price) return null;
    // Keep the qualifying room with the price from the same search card.
    const tail = explicit ? text.slice(explicit.index + explicit[0].length)
      : text.slice(oneNight.index + oneNight[0].length);
    const room = clean(tail.replace(/^[\s•·]+/, "").split(/(?=\s*(?:Вам верн[её]тся|До\s+\d+\s*%|Ещё\s*[-−]?\s*\d|\d+\s*балл|Выбрать|Показать|Бесплатная отмена|Завтрак включён))/iu)[0]);
    return {
      nightly_price: price, checkin, checkout,
      room: room.length <= 180 && /номер|люкс|апартамент|студи|квартир|коттедж|дом|шале|бунгало|койко|кровать|сьют/iu.test(room) ? room : "",
      adults: params.get("adults") || "",
      children_ages: params.get("childrenAges") || "",
      rooms: params.get("roomCount") || ""
    };
  }

  function addressFrom(item) {
    const address = item?.address;
    if (typeof address === "string") return clean(address);
    return unique([address?.addressCountry, address?.addressRegion, address?.addressLocality, address?.streetAddress]).join(", ");
  }

  function structuredFields(item) {
    const rating = item?.aggregateRating;
    const offers = item?.offers;
    return {
      title: clean(item?.name), address: addressFrom(item),
      rating: numeric(rating?.ratingValue), reviews: numeric(rating?.reviewCount ?? rating?.ratingCount),
      min_price: numeric(offers?.lowPrice ?? offers?.price ?? clean(item?.priceRange).match(pricePattern)?.[1]),
      currency: clean(offers?.priceCurrency) || (pricePattern.test(clean(item?.priceRange)) ? "RUB" : ""),
      star_rating: numeric(item?.starRating?.ratingValue ?? item?.starRating),
      ...mapCoordinates(item?.hasMap),
      ...coordinatePair(item?.geo?.latitude, item?.geo?.longitude)
    };
  }

  function canonicalRow(ref) {
    return { source, object_key: `${source}:${ref.org_id}`, org_id: ref.org_id, url: ref.url };
  }

  function attach(row, values) {
    for (const [key, value] of Object.entries(values)) {
      if (value !== "" && value != null) row[key] = value;
    }
    if (row.category_first) row.categories_all = [row.category_first];
    return row;
  }

  function titleWithoutStars(text) {
    const withStars = clean(text).match(/^(.*?)\s+([1-5])\s*(?:\*|★)$/u);
    return { title: withStars?.[1] || clean(text), star_rating: numeric(withStars?.[2]) };
  }

  function cardNode(link) {
    let card = link;
    let chosen = link;
    for (let step = 0; card && step < 9; step++, card = card.parentElement) {
      if (card.matches("main,body,header,footer,nav")) break;
      const candidates = card.querySelectorAll("h3,[role=heading][aria-level='3']");
      const refs = [...card.querySelectorAll("a[href]")].map((anchor) => hotelRef(anchor.href)).filter(Boolean);
      if (candidates.length > 1 || new Set(refs.map(({ org_id }) => org_id)).size > 1) break;
      if (candidates.length || step === 0) chosen = card;
      if (candidates.length && /₽|Выбрать/iu.test(nodeText(card))) return card;
    }
    return chosen;
  }

  function collect(doc, pageUrl) {
    const current = hotelRef(pageUrl);
    if (current) {
      const detail = parseDocument(doc, pageUrl);
      return detail?.title ? [detail] : [];
    }
    const rows = new Map();
    const map = doc.querySelector('[aria-label="Яндекс Карты"]');
    const mapExpanded = map && doc.querySelector('[aria-label="Свернуть карту"]');
    const points = coordinatesFromSearchData(doc, pageUrl);
    if (!mapExpanded) {
      for (const { ref, item } of structuredHotels(doc, pageUrl)) {
        rows.set(ref.org_id, attach(canonicalRow(ref), structuredFields(item)));
      }
    }
    const anchors = (mapExpanded ? map : doc).querySelectorAll(
      "h3 a[href], a[href]:has(h3), [role=heading][aria-level='3'] a[href], " +
      "[data-href]:has(h3)"
    );
    for (const link of anchors) {
      const ref = hotelRef(link.getAttribute("href") || link.getAttribute("data-href"), pageUrl);
      if (!ref) continue;
      if (link.closest("footer,nav")) continue;
      const headingSelector = "h3,[role=heading][aria-level='3']";
      const heading = link.closest(headingSelector) || link.querySelector(headingSelector);
      const card = map?.contains(link) && heading
        ? heading.parentElement : cardNode(link);
      const label = nodeText(heading) || link.getAttribute("aria-label") || (nodeText(link).length <= 180 ? nodeText(link) : "");
      if (!label || /^(выбрать|подробнее|показать(?: на карте)?|отели|забронировать)$/iu.test(clean(label))) continue;
      const row = rows.get(ref.org_id) || canonicalRow(ref);
      attach(row, readTextMetrics(nodeText(card)));
      attach(row, points.get(ref.org_id) || geoFromMap(card, pageUrl));
      const offer = searchOffer(card, pageUrl);
      if (offer) row.travel_offer = offer;
      const category = [...card.querySelectorAll("span,div")].find((node) =>
        !node.children.length && !node.closest(headingSelector) && kindPattern.test(nodeText(node)));
      if (category) row.category_first = nodeText(category).match(kindPattern)[1];
      if (row.category_first) row.categories_all = [row.category_first];
      const visibleRating = card.querySelector('[aria-label^="Оценка "]')?.getAttribute("aria-label");
      const rating = numeric(visibleRating?.match(/([0-5](?:[.,]\d+)?)$/)?.[1]);
      if (rating !== "") row.rating = rating;
      if (!row.title || heading) attach(row, titleWithoutStars(label));
      rows.set(ref.org_id, row);
    }
    return [...rows.values()].filter((row) => row.title);
  }

  function findHeading(doc, pattern) {
    return [...doc.querySelectorAll(headingSelector)].find((node) => pattern.test(nodeText(node)));
  }

  function sectionNodes(heading) {
    if (!heading) return [];
    const nodes = [];
    const startsSection = (node) => node.matches("h1,h2,[role=heading][aria-level='2']") ||
      node.querySelector("h1,h2,[role=heading][aria-level='2']");
    for (let current = heading, depth = 0; current && depth < 4; current = current.parentElement, depth++) {
      if (current.parentElement?.matches("body,header,footer,main") && current !== heading && !nodes.length) break;
      for (let node = current.nextElementSibling; node; node = node.nextElementSibling) {
        if (startsSection(node) || node.matches("nav,footer")) return nodes;
        nodes.push(node);
      }
      if (nodes.length) return nodes;
    }
    return nodes;
  }

  function sectionLines(nodes) {
    const lines = [];
    for (const node of nodes) {
      const items = [...node.querySelectorAll("li,dt,dd,p")];
      if (node.matches("li,dt,dd,p")) items.unshift(node);
      if (items.length) {
        for (const item of items) if (!item.querySelector("li,dt,dd,p")) lines.push(nodeText(item));
      } else {
        lines.push(...String(node.innerText || node.textContent || "").split(/\r?\n/u));
      }
    }
    return unique(lines.filter((line) => clean(line).length <= 240));
  }

  function parseDocument(doc, pageUrl) {
    const ref = hotelRef(pageUrl);
    if (!ref) return null;
    const heading = doc.querySelector("h1,[role=heading][aria-level='1']");
    const infoHeading = findHeading(doc, /^об (?:этом месте|отеле|объекте)$/iu);
    const amenityHeading = findHeading(doc, /^удобства(?: и услуги)?$/iu);
    const mapHeading = findHeading(doc, /^(?:где находится|расположение)$/iu);
    let header = heading;
    for (let step = 0; step < 3 && header?.parentElement; step++) {
      const next = header.parentElement;
      if (next.matches("main,body") || next.querySelector("h2")) break;
      header = next;
      if (countPattern.test(nodeText(header))) break;
    }
    const item = structuredHotels(doc, pageUrl).find((entry) => entry.ref.org_id === ref.org_id)?.item;
    const row = attach(canonicalRow(ref), readTextMetrics(nodeText(header)));
    attach(row, titleWithoutStars(nodeText(heading)));
    attach(row, structuredFields(item));
    if (!row.title) return null;

    const mapNodes = sectionNodes(mapHeading);
    for (const node of mapNodes) {
      if (row.lat === undefined) attach(row, geoFromMap(node, pageUrl));
    }
    const addressLine = sectionLines(mapNodes).find((line) => line.includes(",") && /\d/u.test(line));
    const entityAddress = doc.querySelector('[itemprop="streetAddress"],[itemprop="address"]');
    row.address ||= nodeText(entityAddress) || addressLine || "";
    const amenityNodes = sectionNodes(amenityHeading);
    const amenities = sectionLines(amenityNodes).filter((line) =>
      !/^(?:показать|смотреть|все удобства|скрыть|закрыть)|^(?:количество номеров|дата постройки|дата реконструкции|время заезда|время выезда)$/iu.test(line));
    amenities.push(...(Array.isArray(item?.amenityFeature) ? item.amenityFeature
      .filter((feature) => feature != null && feature.value !== false && feature.value !== "false")
      .map((feature) => typeof feature === "string" ? feature : feature.name) : []));
    const amenitiesList = unique(amenities);
    const infoText = sectionNodes(infoHeading).map(nodeText).filter(Boolean).join("\n");
    const description = clean(item?.description) || infoText;
    if (description) row.description = description;
    const rulesHeading = findHeading(doc, /^правила проживания$/iu);
    const sectionText = [...amenityNodes, ...sectionNodes(rulesHeading)].map(nodeText).join(" ");
    const roomCountPattern = /(?:количество|число) номеров\s*:?\s*(\d+(?:[ \u00a0\u202f]\d{3})*)/iu;
    const totalRoomsPattern = /(?:всего|располагает)\s+(\d+(?:[ \u00a0\u202f]\d{3})*)\s+номер(?:ов|ами)(?=[\s,.]|$)/iu;
    const roomCount = numeric(item?.numberOfRooms?.value ?? item?.numberOfRooms) ||
      numeric([sectionText, infoText, description].map((text) =>
        text.match(roomCountPattern)?.[1] || text.match(totalRoomsPattern)?.[1]).find(Boolean));
    const roomHeadings = [...doc.querySelectorAll("h3,[role=heading][aria-level='3']")].filter((node) =>
      infoHeading && (node.compareDocumentPosition(infoHeading) & 4));
    const roomTypes = unique(roomHeadings.map(nodeText).filter((title) => /номер|студия|люкс|апартаменты|двухместный|одноместный/iu.test(title)));
    const roomCharacteristics = roomHeadings.flatMap((heading) => {
      const title = nodeText(heading);
      if (!roomTypes.includes(title)) return [];
      const wrapper = heading.parentElement;
      const card = [wrapper, wrapper?.parentElement, wrapper?.parentElement?.parentElement]
        .find((node) => node && node.querySelectorAll("h3,[role=heading][aria-level='3']").length === 1 &&
          /\d+(?:[.,]\d+)?\s*м[²2]|кроват|спальн|гост(?:я|ей)/iu.test(nodeText(node)));
      if (!card) return [];
      const values = sectionLines([card]).flatMap((line) =>
        line.match(/\d+(?:[.,]\d+)?\s*м[²2]|\d+\s+(?:гост(?:ь|я|ей)|спальн(?:я|и|ен))|(?:(?:\d+\s+)?(?:односпальн\S*|двуспальн\S*|двухъярусн\S*)\s+)?кроват(?:ь|и|ей)/giu) || []);
      return values.length ? [`${title}: ${unique(values).join(", ")}`] : [];
    });
    const registry = nodeText(doc.body).match(/Объект\s*№\s*([A-ZА-Я]?\d{6,})/iu);
    const matchTime = (label) => sectionText.match(new RegExp(label + "\\s*:?\\s*(\\d{1,2}:\\d{2})", "iu"))?.[1] || "";
    const photos = nodeText(header).match(/([\d\s]+)\s+фото(?:графий)?(?:\s|$)/iu);
    row.photos_count = numeric(photos?.[1]);
    row.room_count = roomCount;
    row.feature_state = amenitiesList.length ? "collected" : "unavailable";
    row.category_data = {
      fields: {
        amenities: amenitiesList, room_types: roomTypes, room_characteristics: unique(roomCharacteristics),
        star_rating: row.star_rating || "",
        hotel_type: row.category_first || "",
        room_count: roomCount,
        checkin_time: matchTime("время заезда"), checkout_time: matchTime("время выезда"),
        construction_year: numeric(sectionText.match(/дата постройки\s*:?\s*((?:18|19|20)\d{2})/iu)?.[1]),
        registry_number: registry?.[1] || ""
      },
      raw_attributes: amenitiesList.length ? { "Удобства и услуги": amenitiesList } : {}
    };
    return row;
  }

  globalThis.MapsTravelParser = { hotelRef, collect, parseDocument };
})();
