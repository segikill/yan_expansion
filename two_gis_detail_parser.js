(function init2gisDetailParser(global) {
  "use strict";

  const PARSER_VERSION = "1.12.3";
  const DAYS = { Mon: "Понедельник", Tue: "Вторник", Wed: "Среда", Thu: "Четверг", Fri: "Пятница", Sat: "Суббота", Sun: "Воскресенье" };
  const clean = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  const unique = (values) => Array.from(new Set((values || []).map(clean).filter(Boolean)));

  function orgIdFromUrl(raw) {
    try { return new URL(raw).pathname.match(/\/(?:firm|geo)\/(\d{10,})/i)?.[1] || ""; } catch { return ""; }
  }

  function coordinatePair(latValue, lonValue) {
    const lat = Number(String(latValue ?? "").replace(",", "."));
    const lon = Number(String(lonValue ?? "").replace(",", "."));
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
      ? { lat: String(lat), lon: String(lon) }
      : { lat: "", lon: "" };
  }

  function coordinatesFromDetail(item, rawUrl) {
    const candidates = [item?.point, item?.geoPosition, item?.geo_position, item?.location, item?.geometry?.centroid];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const pair = Array.isArray(candidate)
        ? coordinatePair(candidate[1], candidate[0])
        : coordinatePair(candidate.lat ?? candidate.latitude, candidate.lon ?? candidate.lng ?? candidate.longitude);
      if (pair.lat && pair.lon) return pair;
    }
    try {
      const url = new URL(rawUrl);
      const match = decodeURIComponent(url.pathname).match(/\/(?:firm|geo)\/[^/]+\/(-?\d+(?:[.,]\d+)?),(-?\d+(?:[.,]\d+)?)/i);
      if (match) return coordinatePair(match[2], match[1]);
    } catch {}
    return { lat: "", lon: "" };
  }

  function normalizeRating(value) {
    return clean(value).match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(".", ",") || "";
  }

  function firstNumber(value) {
    return clean(value).replace(/\s/g, "").match(/\d+/)?.[0] || "";
  }

  function scalar(value) {
    if (value == null) return "";
    if (["string", "number", "boolean"].includes(typeof value)) return clean(value);
    if (Array.isArray(value)) return unique(value.map(scalar)).join(" | ");
    if (typeof value === "object") return clean(value.name || value.text || value.value || value.label || value.title || value.comment || "");
    return "";
  }

  function scheduleFromItem(item) {
    const schedule = item?.schedule || {};
    const result = [];
    for (const key of Object.keys(DAYS)) {
      const day = schedule[key];
      if (!day) continue;
      const intervals = (day.working_hours || []).map((interval) => `${clean(interval?.from)}–${clean(interval?.to) === "24:00" ? "00:00" : clean(interval?.to)}`).filter((value) => !value.startsWith("–"));
      result.push(`${DAYS[key]} ${intervals.length ? intervals.join(", ") : day.is_working === false ? "выходной" : "круглосуточно"}`);
    }
    return result;
  }

  function contactsFromItem(item) {
    const phones = [], websites = [], social = [];
    for (const group of item?.contact_groups || []) {
      for (const contact of group?.contacts || []) {
        const type = clean(contact?.type).toLowerCase();
        const value = clean(/phone/.test(type) ? (contact?.value || contact?.text) : (contact?.url || contact?.value || contact?.text));
        if (!value) continue;
        if (/phone/.test(type) || /^\+?[\d() -]{7,}$/.test(value)) phones.push(value);
        else if (/facebook|vk|telegram|whatsapp|instagram|social/.test(type + value)) social.push(value);
        else if (/website|url|web/.test(type) || /^https?:\/\//i.test(value)) websites.push(value);
      }
    }
    return { phones: unique(phones), websites: unique(websites), social_links: unique(social) };
  }

  function statusFromSchedule(item, domStatus) {
    const rawDirect = clean(domStatus);
    const direct = /^круглосуточно$/i.test(rawDirect) ? "Открыто круглосуточно" : rawDirect;
    if (direct) return { working_status: direct, close_time: direct.match(/(?:до|закроется\s+в)\s*(\d{1,2}:\d{2})/i)?.[1] || "" };
    const schedule = item?.schedule || {};
    const offset = Number(item?.timezone_offset);
    const local = new Date(Date.now() + (Number.isFinite(offset) ? offset : -new Date().getTimezoneOffset()) * 60000);
    const keys = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayIndex = local.getUTCDay();
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    const parseMinute = (value) => {
      const match = clean(value).match(/^(\d{1,2}):(\d{2})$/);
      return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
    };
    const check = (day, currentMinute) => {
      for (const interval of day?.working_hours || []) {
        const start = parseMinute(interval?.from);
        let end = parseMinute(interval?.to);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        if (end <= start) end += 1440;
        if (currentMinute >= start && currentMinute < end) return clean(interval?.to) === "24:00" ? "00:00" : clean(interval?.to);
      }
      return "";
    };
    const today = schedule[keys[dayIndex]];
    const yesterday = schedule[keys[(dayIndex + 6) % 7]];
    const close = check(today, minute) || check(yesterday, minute + 1440);
    if (close) {
      const allDay = today?.is_24x7 || (today?.working_hours || []).some((interval) => clean(interval?.from) === "00:00" && ["24:00", "00:00"].includes(clean(interval?.to)));
      return { working_status: allDay ? "Открыто круглосуточно" : `Открыто до ${close}`, close_time: close };
    }
    return Object.keys(schedule).length ? { working_status: "Закрыто", close_time: "" } : { working_status: "", close_time: "" };
  }

  function normalizeAttributeGroups(item) {
    return (item?.attribute_groups || []).map((group) => ({
      name: clean(group?.name || group?.title),
      attributes: (group?.attributes || []).map((attribute) => ({
        tag: clean(attribute?.tag || attribute?.id),
        name: clean(attribute?.name || attribute?.title),
        value: scalar(attribute?.value ?? attribute?.text ?? attribute?.values)
      })).filter((attribute) => attribute.name || attribute.tag)
    })).filter((group) => group.name || group.attributes.length);
  }

  function rawAttributes(groups) {
    const result = {};
    for (const group of groups) {
      for (const attribute of group.attributes) {
        const key = attribute.tag || attribute.name;
        const value = attribute.value || attribute.name || "да";
        if (key && !result[key]) result[key] = value;
      }
    }
    return result;
  }

  function groupValues(groups, pattern) {
    return unique(groups.filter((group) => pattern.test(group.name)).flatMap((group) => group.attributes.map((attribute) => attribute.value || attribute.name)));
  }

  function allAttributeValues(groups, pattern) {
    return unique(groups.flatMap((group) => group.attributes.filter((attribute) => pattern.test(`${attribute.tag} ${attribute.name}`)).map((attribute) => attribute.value || attribute.name)));
  }

  function bodyLines(doc) {
    const textLines = String(doc?.body?.innerText || "").split(/\n+/);
    const blockLines = Array.from(doc?.querySelectorAll?.("h1, h2, h3, div, p, li, dt, dd") || []).map((node) => node.textContent);
    return unique([...textLines, ...blockLines]);
  }

  function valueAfterLine(lines, label) {
    const index = lines.findIndex((line) => label.test(line));
    return index >= 0 ? clean(lines[index + 1]) : "";
  }

  function linksFromDocument(doc, pattern) {
    return unique(Array.from(doc?.querySelectorAll?.("a[href]") || []).map((anchor) => anchor.href).filter((href) => pattern.test(href)));
  }

  function foodFields(groups, body) {
    const cuisines = allAttributeValues(groups, /cuisine|кухн/i);
    const averageBill = body.match(/(?:средний\s+)?чек\s*((?:от\s+)?[\d\s]+(?:[–—-][\d\s]+)?\s*₽)/i)?.[1] || "";
    const seats = body.match(/до\s+(\d+)\s+мест/i)?.[1] || body.match(/(\d+)\s+посадочн/i)?.[1] || "";
    return {
      average_bill: clean(averageBill),
      cuisine: cuisines,
      seats: firstNumber(seats),
      venue_types: [],
      menu: groupValues(groups, /меню/i),
      services: groupValues(groups, /ресторан|кафе|дополнительно|услуг/i),
      payment_methods: groupValues(groups, /способ.*оплат|оплат/i)
    };
  }

  function hotelFields(groups, body, doc, item) {
    const registryUrls = unique([
      ...linksFromDocument(doc, /tourism\.fsa\.gov\.ru/i),
      ...findUrls(item).filter((url) => /tourism\.fsa\.gov\.ru/i.test(url))
    ]);
    return {
      star_rating: body.match(/(\d+)\s*зв[её]зд/i)?.[1] || firstNumber(allAttributeValues(groups, /star|зв[её]зд/i)[0]),
      hotel_type: clean(item?.name_ex?.extension || item?.org?.extension),
      room_price: clean(body.match(/(?:цена|стоимость)[^\n]{0,60}?((?:от\s+)?[\d\s]+(?:[–—-][\d\s]+)?\s*₽)/i)?.[1] || ""),
      room_count: firstNumber(body.match(/(\d+)\s+номер(?:ов|а)?/i)?.[1] || allAttributeValues(groups, /room.*count|количество.*номер|номерной фонд/i)[0]),
      room_types: allAttributeValues(groups, /room.*type|тип.*номер|категори.*номер/i),
      amenities: unique([...groupValues(groups, /гостиниц|отел|дополнительно|удобств|инфраструктур/i), ...allAttributeValues(groups, /hotel|amenit|wifi|parking|breakfast/i)]),
      registry_number: clean(body.match(/(?:регистрац\w*\s+в\s+реестре[\s\S]{0,100}?)?номер\s*:\s*([A-ZА-ЯЁ]\d{6,})/i)?.[1] || ""),
      registry_url: registryUrls[0] || "",
      checkin_time: clean(body.match(/(?:заезд|время\s+заезда)\s*(?:с|:)??\s*(\d{1,2}:\d{2})/i)?.[1] || ""),
      checkout_time: clean(body.match(/(?:выезд|время\s+выезда)\s*(?:до|:)??\s*(\d{1,2}:\d{2})/i)?.[1] || "")
    };
  }

  function parkingFields(groups, body, lines, item) {
    const isPaid = typeof item?.is_paid === "boolean" ? item.is_paid : /\bплатная\b/i.test(body) ? true : /\bбесплатная\b/i.test(body) ? false : "";
    const features = unique([...groupValues(groups, /парков|общие/i), ...allAttributeValues(groups, /parking|parkings/i)]);
    return {
      paid: isPaid,
      capacity: firstNumber(scalar(item?.capacity) || valueAfterLine(lines, /^мест всего$/i) || body.match(/(\d+)\s+мест/i)?.[1]),
      access: ({ public: "Общедоступная", private: "Частная", restricted: "Ограниченный" })[scalar(item?.access)] || scalar(item?.access) || valueAfterLine(lines, /^доступ$/i),
      level: valueAfterLine(lines, /^уровень$/i),
      paving: ({ asphalt: "Асфальт", ground: "Грунт", concrete: "Бетон", gravel: "Щебень" })[scalar(item?.paving_type)] || scalar(item?.paving_type) || valueAfterLine(lines, /^покрытие$/i),
      features,
      parking_features: features
    };
  }

  function findUrls(value, output = [], seen = new Set()) {
    if (value == null || seen.has(value)) return output;
    if (typeof value === "string") {
      for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/g)) output.push(match[0]);
      return output;
    }
    if (typeof value !== "object") return output;
    seen.add(value);
    if (Array.isArray(value)) value.forEach((entry) => findUrls(entry, output, seen));
    else Object.values(value).forEach((entry) => findUrls(entry, output, seen));
    return output;
  }

  function parseDocument(doc, pageUrl, item = null) {
    const lines = bodyLines(doc);
    const body = lines.join("\n");
    const groups = normalizeAttributeGroups(item || {});
    const raw = rawAttributes(groups);
    const rubrics = item?.rubrics || [];
    const categories = unique([
      ...rubrics.filter((rubric) => rubric?.kind === "primary").map((rubric) => rubric?.name || rubric?.title),
      ...rubrics.map((rubric) => rubric?.name || rubric?.title)
    ]);
    const contacts = contactsFromItem(item || {});
    if (!categories.length && /\/geo\//i.test(pageUrl)) categories.push("Парковка");
    const title = clean(item?.name_ex?.primary || item?.name) || clean(doc?.querySelector?.("h1")?.textContent) || clean(doc?.title).replace(/[,—].*$/, "");
    const address = clean(item?.address_name || item?.address?.name || item?.address?.text) || lines.find((line) => /\d/.test(line) && /(?:улиц|просп|переул|шоссе|дом|корпус)/i.test(line)) || "";
    const rating = normalizeRating(item?.reviews?.general_rating || body.match(/[★☆]\s*(\d+[.,]\d+)/)?.[1]);
    const reviews = firstNumber(item?.reviews?.general_review_count || body.match(/\((\d+)\)/)?.[1]);
    const openingHours = scheduleFromItem(item || {});
    const domWorkingStatus = lines.find((line) => /^(?:открыто|закрыто|круглосуточно)(?:\s|$)/i.test(line)) || "";
    const status = statusFromSchedule(item || {}, domWorkingStatus);
    const point = coordinatesFromDetail(item || {}, pageUrl);
    const categoryText = `${categories.join(" ")} ${title} ${body.slice(0, 2500)}`;
    let adapterId = "common";
    let fields = {};
    if (/парков/i.test(`${categories.join(" ")} ${title}`) || /\/geo\//i.test(pageUrl)) {
      adapterId = "parking";
      fields = parkingFields(groups, body, lines, item || {});
    } else if (/отел|гостиниц|хостел|апарт-отел/i.test(`${categories.join(" ")} ${title}`)) {
      adapterId = "hotel";
      fields = hotelFields(groups, body, doc, item || {});
    } else if (/ресторан|кафе|бар|столов|кофейн|доставка еды/i.test(categoryText)) {
      adapterId = "food";
      fields = foodFields(groups, body);
      fields.venue_types = categories;
    }

    return {
      schema_version: 1,
      parser_version: PARSER_VERSION,
      source: "2gis",
      org_id: orgIdFromUrl(pageUrl),
      url: pageUrl,
      title,
      address,
      websites: contacts.websites,
      phones: contacts.phones,
      rating,
      reviews,
      categories,
      categories_all: categories,
      category_first: categories[0] || "",
      opening_hours: openingHours,
      working_status: status.working_status,
      close_time: status.close_time,
      description: clean(item?.description),
      social_links: contacts.social_links,
      lat: point.lat,
      lon: point.lon,
      category_data: { adapter_id: adapterId, fields, raw_attributes: raw, attribute_groups: groups },
      structured_source: item ? "items/byid" : "dom",
      enriched_at: new Date().toISOString()
    };
  }

  global.Maps2gisDetailParser = Object.freeze({ PARSER_VERSION, orgIdFromUrl, parseDocument, normalizeAttributeGroups });
})(globalThis);
