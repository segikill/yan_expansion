"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SESSION_KEY = "maps_export_session_v2";
const JOB_KEY = "maps_export_enrichment_job_v1";
const RESULTS_KEY = "maps_export_enrichment_results_v1";
const storage = {
  [SESSION_KEY]: {
    objects: {
      "yandex:1234567890": {
        object_key: "yandex:1234567890",
        source: "yandex",
        org_id: "1234567890",
        title: "\u0422\u0435\u0441\u0442\u043e\u0432\u0430\u044f \u043e\u0440\u0433\u0430\u043d\u0438\u0437\u0430\u0446\u0438\u044f",
        url: "https://yandex.ru/maps/org/test/1234567890/"
      }
    },
    snapshots: [],
    observations: []
  }
};

let runtimeMessageHandler;
let tabsUpdatedHandler;
let nextTabId = 10;
let nextWindowId = 10;
const tabs = new Map();
let parseCalls = 0;
let parseGate;
let workerResponse = {
  ok: true,
  status: "success",
  result: {
    schema_version: 1,
    parser_version: "test",
    org_id: "1234567890",
    title: "\u0422\u0435\u0441\u0442\u043e\u0432\u0430\u044f \u043e\u0440\u0433\u0430\u043d\u0438\u0437\u0430\u0446\u0438\u044f",
    enriched_at: new Date().toISOString()
  }
};

const windowCreates = [];
const windowUpdates = [];
const removedWindows = [];
const event = () => ({ addListener() {} });
const browser = {
  runtime: {
    getURL: (name) => `chrome-extension://test/${name}`,
    onMessage: { addListener(handler) { runtimeMessageHandler = handler; } },
    onStartup: event(),
    onInstalled: event()
  },
  storage: {
    local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(patch) { Object.assign(storage, structuredClone(patch)); }
    }
  },
  alarms: {
    onAlarm: event(),
    async create() {},
    async clear() { return true; }
  },
  windows: {
    onRemoved: event(),
    async getAll() { return Promise.all([...new Set([...tabs.values()].map((tab) => tab.windowId))].map((id) => this.get(id))); },
    async get(id) {
      if (removedWindows.includes(id) && ![...tabs.values()].some((tab) => tab.windowId === id)) throw new Error('No window');
      return { id, type: "normal", tabs: [...tabs.values()].filter((tab) => tab.windowId === id) };
    },
    async getLastFocused() { return { id: -1 }; },
    async create(properties) {
      windowCreates.push(properties);
      if (properties.type === "popup") throw new Error("Popup unsupported");
      if (properties.url) {
        const windowId = properties.url === "about:blank" ? nextWindowId++ : 3;
        const tab = { id: nextTabId++, windowId, url: properties.url };
        tabs.set(tab.id, tab);
        return { id: windowId, tabs: [tab] };
      }
      tabs.get(properties.tabId).windowId = 2;
      return { id: 2 };
    },
    async update(id, properties) { windowUpdates.push({ id, properties }); },
    async remove(id) {
      removedWindows.push(id);
      for (const [tabId, tab] of tabs) if (tab.windowId === id) tabs.delete(tabId);
    }
  },
  tabs: {
    onUpdated: { addListener(handler) { tabsUpdatedHandler = handler; } },
    onRemoved: event(),
    async create(properties) {
      const tab = { id: nextTabId++, windowId: 1, ...properties };
      tabs.set(tab.id, tab);
      return tab;
    },
    async get(tabId) {
      if (!tabs.has(tabId)) throw new Error("No tab");
      return tabs.get(tabId);
    },
    async update(tabId, properties) {
      const tab = { ...tabs.get(tabId), ...properties };
      tabs.set(tabId, tab);
      return tab;
    },
    async sendMessage() {
      parseCalls++;
      await parseGate;
      return structuredClone(workerResponse);
    },
    async remove(tabIds) {
      for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) tabs.delete(tabId);
    },
    async query({ windowId } = {}) { return [...tabs.values()].filter((tab) => windowId == null || tab.windowId === windowId); }
  }
};

const context = vm.createContext({
  browser,
  chrome: undefined,
  console,
  Date,
  Math,
  Object,
  Promise,
  Set,
  URL,
  setTimeout,
  clearTimeout,
  structuredClone
});
context.globalThis = context;

const backgroundPath = path.join(__dirname, "..", "background.js");
vm.runInContext(fs.readFileSync(backgroundPath, "utf8"), context, { filename: backgroundPath });

function message(message, sender = {}) {
  return new Promise((resolve) => {
    const keepChannel = runtimeMessageHandler(message, sender, resolve);
    assert.equal(keepChannel, true);
  });
}

async function waitForJob(status) {
  const deadline = Date.now() + 2000;
  while (storage[JOB_KEY].status !== status && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(storage[JOB_KEY].status, status);
}

(async () => {
  const start = await message({
    type: "ENRICHMENT_START",
    options: { scope: "unprocessed", workers: 1, timeout_ms: 10000, max_attempts: 2, delay_ms: 300 }
  });
  assert.equal(start.ok, true);
  assert.equal(storage[JOB_KEY].status, "running");
  assert.equal(storage[JOB_KEY].totals.total, 1);
  assert.equal(storage[JOB_KEY].totals.active, 1);

  const workerTabId = storage[JOB_KEY].workers[0].tab_id;
  assert.equal(tabs.get(workerTabId).url, "https://yandex.ru/maps/org/object/1234567890/");
  const arrange = {
    type: "ENRICHMENT_ARRANGE_WINDOWS",
    area: { left: 0, top: 0, width: 1200, height: 800 }
  };
  const dashboard = { url: browser.runtime.getURL("enrichment.html") };
  const arrangement = await message(arrange, dashboard);
  assert.equal(arrangement.arranged, 1);
  assert.equal(arrangement.skipped, 0);
  assert.deepEqual(windowCreates.map(({ type }) => type), ["popup", "normal"]);
  assert.equal(windowCreates[1].tabId, workerTabId);
  assert.equal(storage[JOB_KEY].workers[0].tab_id, workerTabId);
  assert.equal((await message(arrange, dashboard)).arranged, 1);
  assert.equal(windowCreates.length, 2);
  assert.equal(windowUpdates.at(-1).id, 2);
  const withSummary = await message({ ...arrange, with_summary: true }, dashboard);
  assert.equal(withSummary.summary_opened, true);
  assert.equal(withSummary.arranged, 1);
  assert.equal(windowCreates.at(-1).url, browser.runtime.getURL("enrichment-summary.html"));
  assert.equal(windowCreates.at(-1).type, "normal");
  assert.equal(windowCreates.at(-1).tabId, undefined);
  const summaryFixture = [...tabs.values()].find((tab) => tab.windowId === 3);
  delete summaryFixture.url;
  const createsBeforeReuse = windowCreates.length;
  const updatesBeforeReuse = windowUpdates.length;
  assert.equal((await message({ ...arrange, with_summary: true }, dashboard)).summary_opened, true);
  assert.equal(windowCreates.length, createsBeforeReuse);
  const summaryUpdates = windowUpdates.slice(updatesBeforeReuse).filter(({ id }) => id === summaryFixture.windowId);
  assert.deepEqual(summaryUpdates.map(({ properties }) => ({ ...properties })), [{ focused: true }]);

  let releaseParse;
  parseGate = new Promise((resolve) => { releaseParse = resolve; });
  const ready = { type: "ENRICHMENT_WORKER_READY" };
  const sender = { tab: { id: workerTabId } };
  const firstParse = message(ready, sender);
  await message(ready, sender);
  assert.equal(parseCalls, 1);
  releaseParse();
  await firstParse;
  parseGate = undefined;

  const deadline = Date.now() + 2000;
  while (storage[JOB_KEY].status !== "completed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(storage[JOB_KEY].status, "completed");
  assert.equal(storage[JOB_KEY].totals.success, 1);
  assert.equal(storage[RESULTS_KEY]["yandex:1234567890"].status, "success");

  const originalResponse = workerResponse;
  const savedDetails = structuredClone(storage[RESULTS_KEY]["yandex:1234567890"]);
  workerResponse = { ok: false, error: "Timed out" };
  const repeatOptions = { scope: "all", workers: 1, max_attempts: 1 };
  assert.equal((await message({ type: "ENRICHMENT_START", options: repeatOptions })).ok, true);
  assert.equal((await message({ type: "ENRICHMENT_GET_STATE" })).saved_counts.yandex, 1);
  assert.equal(storage[JOB_KEY].totals.success, 0);
  tabsUpdatedHandler(storage[JOB_KEY].workers[0].tab_id, { status: "complete" });
  await waitForJob("completed");
  assert.equal(storage[JOB_KEY].totals.error, 1);
  assert.deepEqual(storage[RESULTS_KEY]["yandex:1234567890"], {
    ...savedDetails, last_attempt_status: "error", last_attempt_error: "Timed out"
  });
  assert.equal((await message({ type: "ENRICHMENT_GET_STATE" })).saved_counts.yandex, 1);

  workerResponse = originalResponse;
  assert.equal((await message({ type: "ENRICHMENT_START", options: { ...repeatOptions, scope: "errors" } })).ok, true);
  assert.equal((await message(arrange, dashboard)).arranged, 1);
  assert.equal((await message({ type: "ENRICHMENT_STOP" })).ok, true);
  assert.deepEqual(removedWindows, [2, 3]);
  assert.ok(Date.parse(storage[JOB_KEY].completed_at));
  assert.equal(storage[JOB_KEY].status, "stopped");
  assert.equal(storage[RESULTS_KEY]["yandex:1234567890"].title, savedDetails.title);
  assert.equal((await message({ type: "ENRICHMENT_RESUME" })).ok, true);
  tabsUpdatedHandler(storage[JOB_KEY].workers[0].tab_id, { status: "complete" });
  await waitForJob("completed");
  assert.equal(storage[JOB_KEY].totals.success, 1);
  assert.deepEqual(storage[RESULTS_KEY]["yandex:1234567890"], savedDetails);

  const fileOptions = {
    ...repeatOptions,
    workbook: { data: "fixture", name: "hotels.xlsx", sheet: "Hotels", column: 0 },
    links: [{ row: 1, url: "https://yandex.ru/maps/org/test/1234567890/" }]
  };
  assert.equal((await message({ type: "ENRICHMENT_START", options: fileOptions })).ok, true);
  tabsUpdatedHandler(storage[JOB_KEY].workers[0].tab_id, { status: "complete" });
  await waitForJob("completed");
  assert.equal((await message({ type: "ENRICHMENT_GET_STATE" })).saved_counts.xlsx, 1);
  const fileRun = storage[JOB_KEY].run_id;
  assert.equal((await message({ type: "ENRICHMENT_START", options: fileOptions })).ok, false);
  assert.equal(storage[JOB_KEY].run_id, fileRun);
  const fileResults = (await message({ type: "ENRICHMENT_GET_RESULTS", imported: true })).results;
  assert.equal((await message({ type: "ENRICHMENT_START", options: repeatOptions })).ok, true);
  let state = await message({ type: "ENRICHMENT_GET_STATE" });
  assert.equal(state.xlsx_queue.status, "completed");
  assert.equal(state.saved_counts.xlsx, 1);
  assert.deepEqual((await message({ type: "ENRICHMENT_GET_RESULTS", imported: true })).results, fileResults);
  assert.equal((await message({ type: "ENRICHMENT_RESUME", source: "xlsx" })).ok, false);
  assert.equal((await message({ type: "ENRICHMENT_STOP" })).ok, true);
  assert.equal((await message({ type: "ENRICHMENT_GET_STATE" })).saved_counts.xlsx, 1);
  assert.equal((await message({ type: "ENRICHMENT_START", options: { ...fileOptions, restartWorkbook: true } })).ok, true);
  assert.notEqual(storage[JOB_KEY].run_id, fileRun);
  assert.equal((await message({ type: "ENRICHMENT_GET_STATE" })).saved_counts.xlsx, 0);
  assert.deepEqual(storage[RESULTS_KEY]["yandex:1234567890"], savedDetails);
  const pendingFileRun = storage[JOB_KEY].run_id;
  assert.equal((await message({ type: "ENRICHMENT_STOP" })).ok, true);
  assert.equal((await message({ type: "ENRICHMENT_START", options: repeatOptions })).ok, true);
  assert.equal((await message({ type: "ENRICHMENT_STOP" })).ok, true);
  assert.equal((await message({ type: "ENRICHMENT_RESUME", source: "xlsx" })).ok, true);
  assert.equal(storage[JOB_KEY].run_id, pendingFileRun);
  assert.equal(storage[JOB_KEY].totals.active, 1);
  assert.equal((await message({ type: "ENRICHMENT_FORCE_RESET", importOnly: true })).ok, true);

  storage[SESSION_KEY].objects = {
    "yandex:9876543210": {
      object_key: "yandex:9876543210",
      source: "yandex",
      org_id: "",
      title: "\u041e\u0433\u0440\u0430\u043d\u0438\u0447\u0435\u043d\u043d\u0430\u044f \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0430",
      url: "https://yandex.ru/maps/36/stavropol/?mode=whatshere&whatshere%5Buri%5D=ymapsbm1%3A%2F%2Forg%3Foid%3D9876543210"
    }
  };
  workerResponse = {
    ok: false,
    status: "rate_limited",
    error: "\u042f\u043d\u0434\u0435\u043a\u0441 \u0432\u0440\u0435\u043c\u0435\u043d\u043d\u043e \u043e\u0433\u0440\u0430\u043d\u0438\u0447\u0438\u043b \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0443 \u0441\u0442\u0440\u0430\u043d\u0438\u0446"
  };
  const limitedStart = await message({
    type: "ENRICHMENT_START",
    options: { scope: "all", workers: 1, timeout_ms: 10000, max_attempts: 2, delay_ms: 300 }
  });
  assert.equal(limitedStart.ok, true);
  const limitedTabId = storage[JOB_KEY].workers[0].tab_id;
  assert.equal(tabs.get(limitedTabId).url, "https://yandex.ru/maps/org/object/9876543210/");
  tabsUpdatedHandler(limitedTabId, { status: "complete" });

  const limitedDeadline = Date.now() + 2000;
  while (storage[JOB_KEY].status !== "blocked" && Date.now() < limitedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(storage[JOB_KEY].status, "blocked");
  assert.equal(storage[JOB_KEY].totals.rate_limited, 1);
  assert.equal(storage[RESULTS_KEY]["yandex:9876543210"].status, "rate_limited");

  workerResponse = { ok: false, status: "captcha" };
  assert.equal((await message({ type: "ENRICHMENT_RETRY_ERRORS" })).ok, true);
  assert.equal(storage[JOB_KEY].totals.active, 1);
  tabsUpdatedHandler(limitedTabId, { status: "complete" });
  await waitForJob("blocked");
  assert.equal(storage[JOB_KEY].totals.captcha, 1);
  workerResponse = { ok: false, status: "rate_limited" };
  assert.equal((await message({ type: "ENRICHMENT_RETRY_ERRORS" })).ok, true);
  assert.equal(storage[JOB_KEY].totals.active, 1);
  tabsUpdatedHandler(limitedTabId, { status: "complete" });
  await waitForJob("blocked");

  const blockedReset = await message({ type: "ENRICHMENT_FORCE_RESET" });
  assert.equal(blockedReset.ok, true);
  assert.equal(storage[JOB_KEY].status, "idle");
  assert.equal(Object.keys(storage[JOB_KEY].tasks).length, 0);
  assert.equal(Object.keys(storage[RESULTS_KEY]).length, 0);
  assert.equal(tabs.has(limitedTabId), false);

  const restarted = await message({
    type: "ENRICHMENT_START",
    options: { scope: "unprocessed", workers: 1, timeout_ms: 10000, max_attempts: 2, delay_ms: 300 }
  });
  assert.equal(restarted.ok, true);
  assert.equal(storage[JOB_KEY].totals.total, 1);
  const restartedTabId = storage[JOB_KEY].workers[0].tab_id;
  assert.equal(tabs.has(restartedTabId), true);

  const runningReset = await message({ type: "ENRICHMENT_FORCE_RESET" });
  assert.equal(runningReset.ok, true);
  assert.equal(storage[JOB_KEY].status, "idle");
  assert.equal(Object.keys(storage[RESULTS_KEY]).length, 0);
  assert.equal(tabs.has(restartedTabId), false);

  storage[SESSION_KEY].objects = {
    "2gis:70000001090062896": {
      object_key: "2gis:70000001090062896",
      source: "2gis",
      org_id: "70000001090062896",
      title: "Дружба",
      url: "https://2gis.ru/blagoveshensk/firm/70000001090062896"
    }
  };
  workerResponse = {
    ok: true,
    status: "success",
    result: {
      source: "2gis",
      org_id: "70000001090062896",
      title: "Дружба",
      lat: "50.258103",
      lon: "127.524379",
      enriched_at: new Date().toISOString()
    }
  };
  const gisStart = await message({
    type: "ENRICHMENT_START",
    options: { source: "2gis", scope: "all", workers: 1, timeout_ms: 10000, max_attempts: 2, delay_ms: 300 }
  });
  assert.equal(gisStart.ok, true);
  assert.equal(storage[JOB_KEY].source, "2gis");
  const gisTabId = storage[JOB_KEY].workers[0].tab_id;
  assert.equal(tabs.get(gisTabId).url, "https://2gis.ru/blagoveshensk/firm/70000001090062896/tab/info");
  tabsUpdatedHandler(gisTabId, { status: "complete" });
  const gisDeadline = Date.now() + 2000;
  while (storage[JOB_KEY].status !== "completed" && Date.now() < gisDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(storage[JOB_KEY].totals.success, 1);
  assert.equal(storage[SESSION_KEY].objects["2gis:70000001090062896"].lat, "50.258103");
  assert.equal(storage[SESSION_KEY].objects["2gis:70000001090062896"].lon, "127.524379");

  const dashboardOpen = await message(
    { type: "OPEN_ENRICHMENT" },
    { tab: { id: 777, index: 3, windowId: 9 } }
  );
  assert.equal(dashboardOpen.ok, true);
  const dashboardTab = tabs.get(dashboardOpen.tab_id);
  assert.equal(dashboardTab.url, "chrome-extension://test/enrichment.html");
  assert.equal(dashboardTab.active, true);
  assert.equal(dashboardTab.windowId, 9);
  assert.equal(dashboardTab.index, 4);
  const links = Array.from({ length: 9 }, (_, row) => ({
    row, url: `https://yandex.ru/maps/org/test/${1234567890 + row}/`
  }));
  const batched = await message({
    type: "ENRICHMENT_START",
    area: { left: 0, top: 0, width: 1920, height: 1080 },
    options: {
      ...fileOptions, workers: 16, restartWorkbook: true,
      links: [...links, { ...links[0], row: 9 }]
    }
  }, dashboard);
  assert.equal(batched.ok, true);
  assert.equal(batched.layout_error, "");
  assert.equal(storage[JOB_KEY].workers.length, 12);
  assert.equal(batched.layout.working_window_ids.length, 3);
  assert.equal(storage[JOB_KEY].totals.total, 9);
  assert.equal(storage[JOB_KEY].totals.active, 4);
  const batchDeadline = Date.now() + 2200;
  while (storage[JOB_KEY].totals.active < 9 && Date.now() < batchDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const assignments = storage[JOB_KEY].journal.filter(({ type }) => type === "assigned");
  assert.equal(assignments.length, 9);
  const groupedCounts = batched.layout.working_window_ids.map((windowId) =>
    storage[JOB_KEY].workers.filter(({ tab_id }) => tabs.get(tab_id)?.windowId === windowId).length
  );
  assert.deepEqual(Array.from(groupedCounts), [4, 4, 1]);
  for (const [index, windowId] of batched.layout.working_window_ids.entries()) {
    const group = await browser.tabs.query({ windowId });
    assert.equal(group.length, groupedCounts[index]);
    assert.ok(group.every((tab) => tab.url.startsWith("https://yandex.ru/maps/")));
  }
  assert.equal(new Set(assignments.map(({ object_key }) => object_key)).size, 9);
  assert.equal(new Set(assignments.map(({ worker_id }) => worker_id)).size, 9);
  assert.ok(Date.parse(assignments[4].at) - Date.parse(assignments[0].at) >= 400);
  assert.ok(Date.parse(assignments[8].at) - Date.parse(assignments[4].at) >= 400);
  workerResponse.timings = { page_load_ms: 100, features_ms: 20 };
  const firstWorker = storage[JOB_KEY].workers.find(({ current_object_key }) => current_object_key);
  await message({ type: "ENRICHMENT_WORKER_READY" }, { tab: { id: firstWorker.tab_id } });
  const summary = await message({ type: "ENRICHMENT_GET_SUMMARY" });
  const saved = storage[JOB_KEY].journal.find(({ type }) => type === "saved");
  assert.equal(summary.job.last_saved_at, saved.at);
  assert.deepEqual(saved.timings, { page_load_ms: 100, features_ms: 20, activation_wait_ms: null });
  assert.equal(summary.job.totals.success, 1);
  const summaryTab = [...tabs.values()].find(({ windowId }) => windowId === batched.layout.summary_window_id);
  tabs.delete(summaryTab.id);
  await waitForJob("paused");
  assert.match(storage[JOB_KEY].pause_reason, /Сводка закрыта/);
  const benchArea = { left: 0, top: 0, width: 1920, height: 1080 };
  const reopened = await message({ type: "ENRICHMENT_RESUME", source: "xlsx", area: benchArea }, dashboard);
  assert.equal(reopened.ok, true);
  assert.equal(reopened.layout_error, "");
  assert.deepEqual(reopened.layout.working_window_ids, batched.layout.working_window_ids);
  assert.equal((await message({ type: "ENRICHMENT_STOP" })).ok, true);
  assert.equal(batched.layout.working_window_ids.every((id) => removedWindows.includes(id)), true);
  const compact = await message({
    type: "ENRICHMENT_RESUME", source: "xlsx",
    area: { left: 0, top: 0, width: 400, height: 250 }
  }, dashboard);
  assert.equal(compact.ok, true);
  assert.equal(compact.layout_error, "");
  assert.equal(compact.layout.working_window_ids.length, 1);
  const activeTab = tabs.get(storage[JOB_KEY].workers.find(({ tab_id }) => Number.isInteger(tab_id)).tab_id);
  assert.equal(activeTab.windowId, compact.layout.working_window_ids[0]);
  assert.equal((await message({ type: "ENRICHMENT_STOP" })).ok, true);
  const travelId = "himki/sample-hotel";
  const travelUrl = `https://travel.yandex.ru/hotels/${travelId}/`;
  const travelKey = `travel:${travelId}`;
  storage[SESSION_KEY].objects[travelKey] = {
    object_key: travelKey,
    source: "travel",
    title: "Example hotel",
    url: travelUrl + "?adults=2&checkinDate=2026-11-28",
    travel_offer: { checkin: "2026-11-28", checkout: "2026-11-29", adults: "2", rooms: "1" }
  };
  assert.equal((await message({ type: "ENRICHMENT_GET_STATE" })).base_counts.travel, 1);
  const travelStart = await message({ type: "ENRICHMENT_START", options: { source: "travel", workers: 1 } });
  assert.equal(travelStart.ok, true);
  assert.equal(storage[JOB_KEY].tasks[travelKey].org_id, travelId);
  const travelTab = storage[JOB_KEY].workers[0].tab_id;
  assert.equal(tabs.get(travelTab).url, travelUrl + "?checkinDate=2026-11-28&checkoutDate=2026-11-29&adults=2&roomCount=1");
  tabsUpdatedHandler(travelTab, { url: "https://travel.yandex.ru/showcaptcha?test=1" });
  await waitForJob("blocked");
  assert.equal(storage[JOB_KEY].tasks[travelKey].status, "captcha");
  assert.equal((await message({ type: "ENRICHMENT_RESUME" })).ok, true);
  workerResponse = { ok: true, result: { source: "travel", org_id: travelId, title: "Example hotel" } };
  await message({ type: "ENRICHMENT_WORKER_READY" }, { tab: { id: storage[JOB_KEY].workers[0].tab_id } });
  await waitForJob("completed");
  assert.equal((await message({ type: "ENRICHMENT_GET_STATE" })).saved_counts.travel, 1);

  const travelXlsx = await message({
    type: "ENRICHMENT_START",
    options: { workbook: {}, restartWorkbook: true, workers: 1, links: [
      { row: 1, url: travelUrl + "?adults=2" },
      { row: 2, url: travelUrl + "#rooms" },
      { row: 3, url: "https://travel.yandex.ru/hotels/himki/" },
      { row: 4, url: "https://travel.yandex.ru/hotels/himki/filter-pool/" },
      { row: 5, url: "https://travel.yandex.ru/hotels/himki/sample-hotel/reviews/" },
      { row: 6, url: "https://travel.yandex.ru.maps.example/hotels/himki/sample-hotel/" },
      { row: 7, url: "https://travel.yandex.ru/maps/org/object/1234567890/" },
      { row: 8, url: "https://yandex.ru/maps/org/object/1234567890/" }
    ] }
  });
  assert.equal(travelXlsx.ok, true);
  const importedTasks = Object.values(storage[JOB_KEY].tasks);
  assert.equal(importedTasks.length, 2);
  const travelTask = importedTasks.find(({ source }) => source === "travel");
  assert.equal(travelTask.url, travelUrl);
  assert.deepEqual(travelTask.rows, [1, 2]);
  assert.equal(importedTasks.some(({ source }) => source === "yandex"), true);
  assert.equal((await message({ type: "ENRICHMENT_STOP" })).ok, true);
  console.log("PASS background controller: Yandex Maps, Yandex Travel, 2GIS, force-reset and adjacent dashboard paths");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
