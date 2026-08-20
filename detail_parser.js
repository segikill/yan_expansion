(function initMapsDetailParser(global) {
  "use strict";

  const PARSER_VERSION = "1.10.0";
  const MAX_ATTRIBUTE_PAIRS = 160;

  const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

  function textOf(root, selectors) {
    for (const selector of selectors) {
      const value = cleanText(root.querySelector(selector)?.textContent);
      if (value) return value;
    }
    return "";
  }

  function unique(values) {
    const out = [];
    const seen = new Set();
    for (const raw of values || []) {
      const value = cleanText(raw);
      const key = value.toLocaleLowerCase("ru");
      if (!value || seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  }

  function allTexts(root, selectors) {
    const values = [];
    for (const selector of selectors) {
      for (const node of root.querySelectorAll(selector)) values.push(node.textContent);
    }
    return unique(values);
  }

  function safeUrl(raw, baseUrl) {
    try {
      const url = new URL(raw, baseUrl);
      if (!/^https?:$/.test(url.protocol)) return "";
      return url.toString();
    } catch {
      return "";
    }
  }

  function orgIdFromUrl(raw) {
    try {
      const url = new URL(raw);
      const pathId = url.pathname.match(/\/maps\/org\/[^/]+\/(\d{5,})\/?/i)?.[1];
      if (pathId) return pathId;
      const whatshereUri = url.searchParams.get("whatshere[uri]") || "";
      return whatshereUri.match(/[?&]oid=(\d{5,})/i)?.[1] || url.searchParams.get("oid")?.match(/^\d{5,}$/)?.[0] || "";
    } catch {
      return "";
    }
  }

  function walkJson(value, visitor) {
    if (!value || typeof value !== "object") return;
    visitor(value);
    if (Array.isArray(value)) {
      for (const item of value) walkJson(item, visitor);
      return;
    }
    if (Array.isArray(value["@graph"])) walkJson(value["@graph"], visitor);
  }

  function parseJsonLd(doc) {
    const candidates = [];
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        walkJson(JSON.parse(script.textContent || "null"), (item) => {
          const rawType = item?.["@type"];
          const types = Array.isArray(rawType) ? rawType : [rawType];
          if (types.some((type) => /organization|localbusiness|hotel|lodgingbusiness|restaurant|store|medical/i.test(String(type || "")))) {
            candidates.push(item);
          }
        });
      } catch {}
    }
    if (!candidates.length) return {};
    return candidates.sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0] || {};
  }

  function schemaAddress(value) {
    if (!value) return "";
    if (typeof value === "string") return cleanText(value);
    return unique([
      value.postalCode,
      value.addressRegion,
      value.addressLocality,
      value.streetAddress
    ]).join(", ");
  }

  function schemaPhones(schema) {
    const raw = schema.telephone || schema.phone || [];
    return unique(Array.isArray(raw) ? raw : [raw]);
  }

  function normalizePhone(value) {
    const cleaned = cleanText(value).replace(/\u043f\u043e\u043a\u0430\u0437\u0430\u0442\u044c\s+\u0442\u0435\u043b\u0435\u0444\u043e\u043d/gi, " ");
    const match = cleaned.match(/(?:\+?\d[\d\s()\-]{5,}\d)/);
    return cleanText(match?.[0] || "");
  }

  function parsePhones(doc, schema) {
    const values = schemaPhones(schema);
    for (const link of doc.querySelectorAll('a[href^="tel:"]')) {
      values.push(decodeURIComponent(String(link.getAttribute("href") || "").replace(/^tel:/i, "")));
      values.push(link.textContent);
    }
    values.push(...allTexts(doc, [
      ".card-phones-view__number",
      '[class*="business-contacts-view__phone"]',
      '[class*="phones-view__number"]'
    ]));
    const normalized = unique(values.map(normalizePhone).filter(Boolean));
    const seenDigits = new Set();
    return normalized.filter((phone) => {
      const digits = phone.replace(/\D/g, "");
      const key = digits.length === 11 && digits[0] === "8" ? `7${digits.slice(1)}` : digits;
      if (!key || seenDigits.has(key)) return false;
      seenDigits.add(key);
      return true;
    });
  }

  function isYandexHost(host) {
    return /(^|\.)(yandex\.|ya\.ru$)/i.test(host || "");
  }

  function parseLinks(doc, baseUrl, schema) {
    const websites = [];
    const socials = [];
    const socialHost = /(^|\.)(vk\.com|t\.me|telegram\.me|ok\.ru|youtube\.com|youtu\.be|instagram\.com|facebook\.com|rutube\.ru)$/i;
    const candidates = [];
    if (typeof schema.url === "string") candidates.push(schema.url);
    const contactSelectors = [
      '.business-urls-view a[href^="http"]',
      '[class*="business-urls-view"] a[href^="http"]',
      '[class*="business-socials"] a[href^="http"]',
      '.business-contacts-view a[href^="http"]',
      'a[aria-label*="\u0421\u0430\u0439\u0442"][href^="http"]'
    ];
    for (const selector of contactSelectors) {
      for (const link of doc.querySelectorAll(selector)) candidates.push(link.getAttribute("href"));
    }

    for (const candidate of candidates) {
      const url = safeUrl(candidate, baseUrl);
      if (!url) continue;
      const host = new URL(url).hostname.toLowerCase();
      if (socialHost.test(host) && !/\/(?:yandex\.maps|mapsyandex)\/?$/i.test(new URL(url).pathname)) socials.push(url);
      else if (!isYandexHost(host) && !/2gis\.|google\./i.test(host)) websites.push(url);
    }

    return {
      websites: unique(websites),
      social_links: unique(socials)
    };
  }

  function parseCategories(doc, schema) {
    const categories = [];
    const schemaTypes = Array.isArray(schema["@type"]) ? schema["@type"] : [schema["@type"]];
    categories.push(schema.category, ...schemaTypes);
    categories.push(...allTexts(doc, [
      ".business-categories-view__category",
      '[class*="business-categories-view"] a',
      '[class*="breadcrumbs-view__breadcrumb"]'
    ]));
    return unique(categories);
  }

  function parseHours(doc, schema) {
    const schedule = allTexts(doc, [
      ".business-hours-card-view__day",
      '[class*="business-hours-card-view__interval"]',
      '[class*="business-hours-view__day"]',
      '[class*="working-intervals"]',
      '[class*="working-hours"]'
    ]);
    const bodyText = String(doc.body?.innerText || "").replace(/\s+/g, " ");
    const dayPattern = /(\u043f\u043e\u043d\u0435\u0434\u0435\u043b\u044c\u043d\u0438\u043a|\u0432\u0442\u043e\u0440\u043d\u0438\u043a|\u0441\u0440\u0435\u0434\u0430|\u0447\u0435\u0442\u0432\u0435\u0440\u0433|\u043f\u044f\u0442\u043d\u0438\u0446\u0430|\u0441\u0443\u0431\u0431\u043e\u0442\u0430|\u0432\u043e\u0441\u043a\u0440\u0435\u0441\u0435\u043d\u044c\u0435)\s*[:\u2013\u2014-]?\s*(\u043a\u0440\u0443\u0433\u043b\u043e\u0441\u0443\u0442\u043e\u0447\u043d\u043e|\u0432\u044b\u0445\u043e\u0434\u043d\u043e\u0439|\u043d\u0435\s+\u0440\u0430\u0431\u043e\u0442\u0430\u0435\u0442|\d{1,2}:\d{2}\s*[\u2013\u2014-]\s*\d{1,2}:\d{2})/gi;
    const normalizedDays = [];
    for (const match of bodyText.matchAll(dayPattern)) normalizedDays.push(`${match[1]} ${match[2]}`);
    const schemaHours = schema.openingHours || [];
    schedule.push(...(Array.isArray(schemaHours) ? schemaHours : [schemaHours]));
    const status = textOf(doc, [
      ".business-working-status-view",
      '[class*="business-working-status-view"]',
      '[class*="working-status"]'
    ]);
    const closeMatch = status.match(/(?:\u0434\u043e|\u0437\u0430\u043a\u0440\u043e\u0435\u0442\u0441\u044f\s+\u0432)\s*(\d{1,2}:\d{2})/i);
    return {
      opening_hours: normalizedDays.length ? unique(normalizedDays) : unique(schedule),
      working_status: status,
      close_time: closeMatch?.[1] || ""
    };
  }

  function addAttribute(target, label, value) {
    const key = cleanText(label).replace(/[:\s]+$/, "");
    const val = cleanText(value);
    if (!key || !val || key === val || Object.keys(target).length >= MAX_ATTRIBUTE_PAIRS) return;
    if (!target[key]) target[key] = val;
    else if (!target[key].includes(val)) target[key] = `${target[key]} | ${val}`;
  }

  function parseAttributePairs(doc) {
    const attributes = {};

    for (const labelNode of doc.querySelectorAll("dt")) {
      let valueNode = labelNode.nextElementSibling;
      while (valueNode && valueNode.tagName !== "DD") valueNode = valueNode.nextElementSibling;
      addAttribute(attributes, labelNode.textContent, valueNode?.textContent);
    }
    for (const row of doc.querySelectorAll("tr")) {
      const cells = row.querySelectorAll("th, td");
      if (cells.length >= 2) addAttribute(attributes, cells[0].textContent, cells[1].textContent);
    }

    for (const row of doc.querySelectorAll(".business-features-view__valued")) {
      const label = row.querySelector(".business-features-view__valued-title")?.textContent;
      const value = row.querySelector(".business-features-view__valued-value")?.textContent;
      addAttribute(attributes, label, value);
    }

    for (const row of doc.querySelectorAll(".business-features-view__bool-item")) {
      const label = row.querySelector(".business-features-view__bool-text")?.textContent || row.textContent;
      addAttribute(attributes, label, "да");
    }

    const featureRows = doc.querySelectorAll([
      '[class*="business-features-view__feature"]',
      '[class*="business-features-view__group"] li'
    ].join(","));

    for (const row of featureRows) {
      const label = textOf(row, [
        '[class*="feature__name"]',
        '[class*="feature-name"]',
        '[class*="title"]',
        "span:first-child"
      ]);
      const value = textOf(row, [
        '[class*="feature__value"]',
        '[class*="feature-value"]',
        '[class*="value"]',
        "span:last-child"
      ]);
      addAttribute(attributes, label, value || (label ? "\u0434\u0430" : ""));
    }
    return attributes;
  }

  function valueByAttribute(attributes, patterns) {
    for (const [key, value] of Object.entries(attributes || {})) {
      if (patterns.some((pattern) => pattern.test(key))) return value;
    }
    return "";
  }

  function firstInteger(value) {
    const match = cleanText(value).replace(/\s/g, "").match(/\d+/);
    return match ? Number(match[0]) : "";
  }

  function splitValues(value) {
    return unique(String(value || "").split(/\s*[|,;]\s*/));
  }

  function featureFlag(values, positive, negative) {
    if (values.some((value) => negative.test(value))) return false;
    if (values.some((value) => positive.test(value))) return true;
    return "";
  }

  const CATEGORY_ADAPTERS = [
    {
      id: "food",
      matches(context) {
        const haystack = `${context.title} ${context.categories.join(" ")} ${context.schemaTypes.join(" ")}`;
        return /\u0440\u0435\u0441\u0442\u043e\u0440\u0430\u043d|\u043a\u0430\u0444\u0435|\u0431\u0430\u0440|\u0441\u0442\u043e\u043b\u043e\u0432|\u043a\u043e\u0444\u0435\u0439\u043d|\u043f\u0438\u0446\u0446\u0435\u0440|restaurant|foodestablishment/i.test(haystack);
      },
      parse(context) {
        return {
          average_bill: valueByAttribute(context.attributes, [/\u0441\u0440\u0435\u0434\u043d(?:\u0438\u0439|\u0435\u0433\u043e)\s+\u0441\u0447[\u0451\u0435]\u0442/i]),
          price_level: valueByAttribute(context.attributes, [/^\u0446\u0435\u043d\u044b$/i, /\u0446\u0435\u043d\u043e\u0432\u043e\u0439\s+\u0443\u0440\u043e\u0432\u0435\u043d\u044c/i]),
          cuisine: splitValues(valueByAttribute(context.attributes, [/\u043a\u0443\u0445\u043d\u044f/i])),
          venue_types: splitValues(valueByAttribute(context.attributes, [/\u0442\u0438\u043f\s+\u0437\u0430\u0432\u0435\u0434\u0435\u043d\u0438\u044f/i]))
        };
      }
    },
    {
      id: "hotel",
      matches(context) {
        const haystack = `${context.title} ${context.categories.join(" ")} ${context.schemaTypes.join(" ")}`;
        const attributeNames = Object.keys(context.attributes || {}).join(" ");
        return /\u043e\u0442\u0435\u043b|\u0433\u043e\u0441\u0442\u0438\u043d|\u0445\u043e\u0441\u0442\u0435\u043b|\u0430\u043f\u0430\u0440\u0442-?\u043e\u0442\u0435\u043b|hotel|lodging/i.test(haystack) ||
          /\u0442\u0438\u043f\s+\u0433\u043e\u0441\u0442\u0438\u043d\u0438\u0446|\u0432\u0440\u0435\u043c\u044f\s+\u0437\u0430\u0435\u0437\u0434|\u0446\u0435\u043d\u0430\s+\u043d\u043e\u043c\u0435\u0440/i.test(attributeNames);
      },
      parse(context) {
        const roomCountRaw = valueByAttribute(context.attributes, [
          /\u043a\u043e\u043b(?:\u0438\u0447\u0435\u0441\u0442\u0432\u043e|[-.\s]*\u0432\u043e)?\s+\u043d\u043e\u043c\u0435\u0440/i,
          /^\u043d\u043e\u043c\u0435\u0440\u043e\u0432$/i,
          /\u043d\u043e\u043c\u0435\u0440\u043d\u043e\u0439\s+\u0444\u043e\u043d\u0434/i,
          /number\s+of\s+rooms/i
        ]);
        const roomTypesRaw = valueByAttribute(context.attributes, [
          /\u0442\u0438\u043f(?:\u044b)?\s+\u043d\u043e\u043c\u0435\u0440/i,
          /\u043a\u0430\u0442\u0435\u0433\u043e\u0440(?:\u0438\u044f|\u0438\u0438)\s+\u043d\u043e\u043c\u0435\u0440/i,
          /^\u043d\u043e\u043c\u0435\u0440\u0430$/i,
          /room\s+types?/i
        ]);
        return {
          room_count: firstInteger(roomCountRaw),
          room_types: splitValues(roomTypesRaw),
          star_rating: cleanText(valueByAttribute(context.attributes, [/\u043a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432\u043e\s+\u0437\u0432[\u0451\u0435]\u0437\u0434/i]) || context.schema.starRating?.ratingValue || context.schema.starRating || ""),
          hotel_type: valueByAttribute(context.attributes, [/\u0442\u0438\u043f\s+\u0433\u043e\u0441\u0442\u0438\u043d\u0438\u0446/i, /\u0442\u0438\u043f\s+\u043e\u0442\u0435\u043b/i]),
          room_price: valueByAttribute(context.attributes, [/\u0446\u0435\u043d\u0430\s+\u043d\u043e\u043c\u0435\u0440/i, /\u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c\s+\u043d\u043e\u043c\u0435\u0440/i]),
          checkin_time: cleanText(valueByAttribute(context.attributes, [/\u0432\u0440\u0435\u043c\u044f\s+\u0437\u0430\u0435\u0437\u0434/i]) || context.schema.checkinTime || ""),
          construction_year: firstInteger(valueByAttribute(context.attributes, [/\u0434\u0430\u0442\u0430\s+\u043f\u043e\u0441\u0442\u0440\u043e\u0439\u043a\u0438/i, /\u0433\u043e\u0434\s+\u043f\u043e\u0441\u0442\u0440\u043e\u0439\u043a\u0438/i])),
          checkout_time: cleanText(valueByAttribute(context.attributes, [/\u0432\u0440\u0435\u043c\u044f\s+\u0432\u044b\u0435\u0437\u0434/i]) || context.schema.checkoutTime || "")
        };
      }
    },
    {
      id: "parking",
      matches(context) {
        const haystack = `${context.title} ${context.categories.join(" ")} ${context.schemaTypes.join(" ")}`;
        return /\u043f\u0430\u0440\u043a\u043e\u0432|carpark|parking/i.test(haystack);
      },
      parse(context) {
        const parkingRaw = valueByAttribute(context.attributes, [/^\u043f\u0430\u0440\u043a\u043e\u0432\u043a\u0430$/i, /\u0442\u0438\u043f\s+\u043f\u0430\u0440\u043a\u043e\u0432\u043a\u0438/i]);
        const features = splitValues(parkingRaw);
        return {
          parking_features: features,
          paid: featureFlag(features, /\u043f\u043b\u0430\u0442\u043d/i, /\u0431\u0435\u0441\u043f\u043b\u0430\u0442\u043d/i),
          guarded: featureFlag(features, /^\u043e\u0445\u0440\u0430\u043d\u044f\u0435\u043c/i, /\u043d\u0435\u043e\u0445\u0440\u0430\u043d/i),
          open_air: featureFlag(features, /^\u043e\u0442\u043a\u0440\u044b\u0442/i, /^(?:\u0437\u0430\u043a\u0440\u044b\u0442|\u043a\u0440\u044b\u0442)/i),
          street: featureFlag(features, /\u0443\u043b\u0438\u0447\u043d/i, /\u0432\u043d\u0435\u0443\u043b\u0438\u0447|\u043f\u043e\u0434\u0437\u0435\u043c/i)
        };
      }
    }
  ];

  function applyCategoryAdapter(context) {
    const adapter = CATEGORY_ADAPTERS.find((candidate) => candidate.matches(context));
    if (!adapter) return { adapter_id: "common", fields: {}, raw_attributes: context.attributes };
    return {
      adapter_id: adapter.id,
      fields: adapter.parse(context),
      raw_attributes: context.attributes
    };
  }

  function parseRating(doc, schema) {
    const raw = cleanText(schema.aggregateRating?.ratingValue) || textOf(doc, [
      ".business-rating-badge-view__rating-text",
      '[class*="business-rating-badge-view__rating"]',
      '[itemprop="ratingValue"]'
    ]);
    return raw.match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(".", ",") || "";
  }

  function parseReviews(doc, schema) {
    const raw = cleanText(schema.aggregateRating?.reviewCount || schema.aggregateRating?.ratingCount) || textOf(doc, [
      ".business-header-rating-view__text",
      '[class*="business-header-rating-view"]',
      '[itemprop="reviewCount"]'
    ]);
    return raw.replace(/\s/g, "").match(/\d+/)?.[0] || "";
  }

  function parseDocument(doc, pageUrl) {
    const schema = parseJsonLd(doc);
    const schemaTypes = unique(Array.isArray(schema["@type"]) ? schema["@type"] : [schema["@type"]]);
    const title = cleanText(schema.name) || textOf(doc, [
      "h1.orgpage-header-view__header",
      ".orgpage-header-view__header",
      '[class*="business-card-title-view__title"]',
      "h1"
    ]);
    const address = schemaAddress(schema.address) || textOf(doc, [
      ".business-contacts-view__address-link",
      '[class*="business-contacts-view__address"]',
      '[itemprop="address"]'
    ]);
    const categories = parseCategories(doc, schema);
    const attributes = parseAttributePairs(doc);
    const links = parseLinks(doc, pageUrl, schema);
    const hours = parseHours(doc, schema);
    const description = cleanText(schema.description) || textOf(doc, [
      ".business-description-view__text",
      '[class*="business-description-view"]',
      '[itemprop="description"]'
    ]);
    const categoryData = applyCategoryAdapter({
      title,
      categories,
      attributes,
      schema,
      schemaTypes,
      doc
    });

    return {
      schema_version: 1,
      parser_version: PARSER_VERSION,
      source: "yandex",
      org_id: orgIdFromUrl(pageUrl),
      url: pageUrl,
      title,
      address,
      websites: links.websites,
      phones: parsePhones(doc, schema),
      rating: parseRating(doc, schema),
      reviews: parseReviews(doc, schema),
      categories,
      opening_hours: hours.opening_hours,
      working_status: hours.working_status,
      close_time: hours.close_time,
      description,
      social_links: links.social_links,
      category_data: categoryData,
      enriched_at: new Date().toISOString()
    };
  }

  global.MapsDetailParser = Object.freeze({
    PARSER_VERSION,
    CATEGORY_ADAPTERS,
    orgIdFromUrl,
    parseDocument
  });
})(globalThis);
