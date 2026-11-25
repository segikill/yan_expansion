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
const tabs = new Map();
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
  tabs: {
    onUpdated: { addListener(handler) { tabsUpdatedHandler = handler; } },
    onRemoved: event(),
    async create(properties) {
      const tab = { id: nextTabId++, ...properties };
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
      return structuredClone(workerResponse);
    },
    async remove(tabIds) {
      for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) tabs.delete(tabId);
    },
    async query() { return []; }
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
  tabsUpdatedHandler(workerTabId, { status: "complete" });

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
  assert.equal((await message({ type: "ENRICHMENT_STOP" })).ok, true);
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
  assert.equal((await message({ type: "ENRICHMENT_GET_STATE" })).saved_counts.xlsx, 1);
  assert.equal((await message({ type: "ENRICHMENT_START", options: { ...fileOptions, restartWorkbook: true } })).ok, true);
  assert.notEqual(storage[JOB_KEY].run_id, fileRun);
  assert.equal((await message({ type: "ENRICHMENT_GET_STATE" })).saved_counts.xlsx, 0);
  assert.deepEqual(storage[RESULTS_KEY]["yandex:1234567890"], savedDetails);
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
  console.log("PASS background controller: Yandex, 2GIS, force-reset and adjacent dashboard paths");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
