(function initEnrichmentController() {
  "use strict";

  const api = globalThis.browser || globalThis.chrome;
  const IMPORT_KEY = "maps_export_enrichment_xlsx_v1";
  const SESSION_KEY = "maps_export_session_v2";
  const JOB_KEY = "maps_export_enrichment_job_v1";
  const RESULTS_KEY = "maps_export_enrichment_results_v1";
  const WATCHDOG_ALARM = "maps_export_enrichment_watchdog_v1";
  const DASHBOARD_URL = api.runtime.getURL("enrichment.html");
  const ACTIVE_TASK_STATES = new Set(["navigating", "waiting_dom", "parsing"]);
  let stateLock = Promise.resolve();

  function serial(operation) {
    const next = stateLock.then(operation, operation);
    stateLock = next.catch(() => {});
    return next;
  }

  const nowIso = () => new Date().toISOString();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function validCoordinatePair(latValue, lonValue) {
    if (String(latValue ?? "").trim() === "" || String(lonValue ?? "").trim() === "") return null;
    const lat = Number(String(latValue).replace(",", "."));
    const lon = Number(String(lonValue).replace(",", "."));
    return Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
      ? { lat: String(lat), lon: String(lon) }
      : null;
  }

  async function storageGet(key) {
    const data = await api.storage.local.get(key);
    return data?.[key];
  }

  async function storageSet(key, value) {
    await api.storage.local.set({ [key]: value });
  }

  async function storageSetMany(values) {
    await api.storage.local.set(values);
  }

  function emptyJob() {
    return {
      schema_version: 1,
      run_id: "",
      status: "idle",
      created_at: "",
      updated_at: nowIso(),
      started_at: "",
      completed_at: "",
      source: "yandex",
      last_saved_at: "",
      journal: [],
      settings: { workers: 2, timeout_ms: 25000, max_attempts: 3, delay_ms: 1200 },
      tasks: {},
      workers: [],
      totals: { total: 0, queued: 0, active: 0, success: 0, error: 0, captcha: 0, rate_limited: 0, cancelled: 0 }
    };
  }

  function normalizeJob(raw) {
    const base = emptyJob();
    if (!raw || typeof raw !== "object") return base;
    return {
      ...base,
      ...raw,
      settings: { ...base.settings, ...(raw.settings || {}) },
      tasks: raw.tasks && typeof raw.tasks === "object" ? raw.tasks : {},
      journal: Array.isArray(raw.journal) ? raw.journal.slice(-100) : [],
      workers: Array.isArray(raw.workers) ? raw.workers : [],
      totals: { ...base.totals, ...(raw.totals || {}) }
    };
  }

  function recalculateTotals(job) {
    const totals = { total: 0, queued: 0, active: 0, success: 0, error: 0, captcha: 0, rate_limited: 0, cancelled: 0 };
    for (const task of Object.values(job.tasks || {})) {
      totals.total += 1;
      if (ACTIVE_TASK_STATES.has(task.status)) totals.active += 1;
      else if (Object.hasOwn(totals, task.status)) totals[task.status] += 1;
    }
    job.totals = totals;
    job.updated_at = nowIso();
    return totals;
  }

  async function loadJob() {
    return normalizeJob(await storageGet(JOB_KEY));
  }

  async function saveJob(job) {
    recalculateTotals(job);
    await storageSet(JOB_KEY, job);
  }

  async function loadResults() {
    const raw = await storageGet(RESULTS_KEY);
    return raw && typeof raw === "object" ? raw : {};
  }

  function orgIdFromYandexUrl(raw) {
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

  function travelHotelId(url) {
    if (url.protocol !== "https:" || url.hostname !== "travel.yandex.ru" || url.username || url.password || url.port) return "";
    const match = url.pathname.match(/^\/hotels\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/i);
    if (!match || /^filter(?:-|$)|^(?:map|search|reviews)$/i.test(match[2])) return "";
    return `${match[1]}/${match[2]}`;
  }

  function detailUrlForObject(object) {
    if (!object || !object.url) return "";
    try {
      const sourceUrl = new URL(object.url);
      if (object.source === "travel") {
        const hotelId = travelHotelId(sourceUrl);
        if (!hotelId) return "";
        const detailUrl = new URL(`/hotels/${hotelId}/`, sourceUrl.origin);
        const offer = object.travel_offer;
        if (!offer || !/^\d{4}-\d{2}-\d{2}$/.test(offer.checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(offer.checkout)) return detailUrl.href;
        detailUrl.searchParams.set("checkinDate", offer.checkin);
        detailUrl.searchParams.set("checkoutDate", offer.checkout);
        if (/^\d{1,2}$/.test(offer.adults)) detailUrl.searchParams.set("adults", offer.adults);
        if (/^\d{1,2}$/.test(offer.rooms)) detailUrl.searchParams.set("roomCount", offer.rooms);
        if (/^\d{1,2}(?:,\d{1,2})*$/.test(offer.children_ages)) detailUrl.searchParams.set("childrenAges", offer.children_ages);
        return detailUrl.href;
      }
      if (object.source === "yandex") {
        if (!/(^|\.)(yandex\.|ya\.ru$)/i.test(sourceUrl.hostname)) return "";
        const orgId = String(object.org_id || orgIdFromYandexUrl(sourceUrl.toString()) || "");
        if (!/^\d{5,}$/.test(orgId)) return "";
        return new URL(`/maps/org/object/${orgId}/`, sourceUrl.origin).toString();
      }
      if (object.source === "2gis") {
        if (!/2gis\.(?:ru|com)$/i.test(sourceUrl.hostname)) return "";
        const match = sourceUrl.pathname.match(/\/(firm|geo)\/(\d{10,})/i);
        const orgId = String(object.org_id || match?.[2] || "").match(/^\d{10,}$/)?.[0] || "";
        if (!orgId) return "";
        const entityType = match?.[1]?.toLowerCase() === "geo" ? "geo" : "firm";
        const first = sourceUrl.pathname.split("/").filter(Boolean)[0] || "";
        const city = ["firm", "geo"].includes(first.toLowerCase()) ? "" : first;
        sourceUrl.hash = "";
        sourceUrl.search = "";
        sourceUrl.pathname = `${city ? `/${city}` : ""}/${entityType}/${orgId}/tab/info`;
        return sourceUrl.toString();
      }
      return "";
    } catch {
      return "";
    }
  }

  function publicState(job, resultCount, baseCount, savedCounts) {
    return { job, result_count: resultCount, base_count: baseCount.total, base_counts: baseCount, saved_counts: savedCounts, controller_version: api.runtime.getManifest?.().version || "1.13.2" };
  }

  async function getState() {
    const [job, results, session, imported] = await Promise.all([loadJob(), loadResults(), storageGet(SESSION_KEY), storageGet(IMPORT_KEY)]);
    const objects = Object.values(session?.objects || {});
    const baseCount = {
      total: objects.length,
      yandex: objects.filter((object) => object?.source === "yandex" && detailUrlForObject(object)).length,
      "2gis": objects.filter((object) => object?.source === "2gis" && detailUrlForObject(object)).length,
      travel: objects.filter((object) => object?.source === "travel" && detailUrlForObject(object)).length
    };
    const saved = { yandex: 0, "2gis": 0, travel: 0, xlsx: 0 };
    for (const [key, object] of Object.entries(session?.objects || {})) {
      if (Object.hasOwn(saved, object?.source) && object.source !== "xlsx" && detailUrlForObject(object) && results[key]?.status === "success") saved[object.source]++;
    }
    const xlsxJob = job.source === "xlsx" ? job : imported?.job;
    if (xlsxJob) {
      saved.xlsx = Object.keys(xlsxJob.tasks).filter((key) => results[key]?.status === "success").length;
    }
    return { ...publicState(job, Object.keys(results).filter((key) => key.startsWith("xlsx:") === (job.source === "xlsx")).length, baseCount, saved), xlsx_queue: xlsxJob ? { total: xlsxJob.totals.total, status: xlsxJob.status } : null };
  }

  async function ensureWatchdog(active) {
    try {
      if (active) await api.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
      else await api.alarms.clear(WATCHDOG_ALARM);
    } catch {}
  }

  function importedObjects(links, runId) {
    const objects = {};
    for (const { row, url } of links) {
      if (!Number.isInteger(row) || row < 0 || typeof url !== "string") continue;
      let parsed;
      try { parsed = new URL(url); } catch { continue; }
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.port) continue;
      parsed.protocol = "https:";
      const yandex = /(^|\.)(yandex\.(ru|com)|ya\.ru)$/i.test(parsed.hostname);
      const gis = /(^|\.)2gis\.(ru|com)$/i.test(parsed.hostname);
      const travel = parsed.hostname === "travel.yandex.ru";
      const source = travel ? "travel" : yandex ? "yandex" : gis ? "2gis" : "";
      const orgId = travel ? travelHotelId(parsed)
        : yandex && parsed.pathname.startsWith("/maps/") ? orgIdFromYandexUrl(parsed.href)
        : gis ? parsed.pathname.match(/\/(?:firm|geo)\/(\d{10,})(?:\/|$)/i)?.[1] : "";
      if (!source || !orgId) continue;
      const key = `xlsx:${runId}:${source}:${orgId}`;
      const object = objects[key] ||= { source, org_id: orgId, url: parsed.href, rows: [] };
      object.rows.push(row);
    }
    return objects;
  }

  async function startJob(options, area, sender) {
    const workbook = options?.workbook;
    const source = workbook ? "xlsx" : ["2gis", "travel"].includes(options?.source) ? options.source : "yandex";
    const scope = ["unprocessed", "all", "errors"].includes(options?.scope) ? options.scope : "unprocessed";
    const requestedWorkers = Number(options?.workers ?? 2);
    const workersCount = Math.min(12, Math.max(1, Number.isFinite(requestedWorkers) ? Math.trunc(requestedWorkers) : 2));
    const timeoutMs = Math.min(90000, Math.max(10000, Number(options?.timeout_ms) || 25000));
    const maxAttempts = Math.min(5, Math.max(1, Number(options?.max_attempts) || 3));
    const delayMs = Math.min(15000, Math.max(300, Number(options?.delay_ms) || 1200));

    await serial(async () => {
      const [previousJob, session, results] = await Promise.all([loadJob(), storageGet(SESSION_KEY), loadResults()]);
      if (["running", "paused", "blocked"].includes(previousJob.status)) {
        throw new Error("\u0414\u0440\u0443\u0433\u043e\u0439 \u0434\u043e\u0441\u0431\u043e\u0440 \u0443\u0436\u0435 \u0437\u0430\u043f\u0443\u0449\u0435\u043d");
      }

      if (workbook && (previousJob.source === "xlsx" || Object.keys(results).some((key) => key.startsWith("xlsx:"))) && !options.restartWorkbook) {
        throw new Error("Подтвердите запуск XLSX заново. Для сохранения текущей очереди используйте «Продолжить досбор».");
      }

      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const objects = workbook ? importedObjects(options.links || [], runId) : session?.objects || {};
      const tasks = {};
      for (const [objectKey, object] of Object.entries(objects)) {
        if (!workbook && object?.source !== source) continue;
        const detailUrl = detailUrlForObject(object);
        if (!detailUrl) continue;
        const existing = results[objectKey];
        const previousTask = previousJob.tasks?.[objectKey];
        const include = workbook || scope === "all" ||
          (scope === "unprocessed" && existing?.status !== "success") ||
          (scope === "errors" && (["error", "partial", "captcha", "rate_limited"].includes(existing?.last_attempt_status || existing?.status) || previousTask?.status === "error"));
        if (!include) continue;
        tasks[objectKey] = {
          object_key: objectKey,
          source: object.source,
          ...(workbook ? { rows: object.rows } : {}),
          org_id: object.source === "travel" ? travelHotelId(new URL(detailUrl))
            : String(object.org_id || orgIdFromYandexUrl(object.url) || ""),
          title: String(object.title || ""),
          url: detailUrl,
          original_url: String(object.url || ""),
          status: "queued",
          attempts: 0,
          assigned_worker: "",
          assigned_at: "",
          next_attempt_at: 0,
          completed_at: "",
          error: ""
        };
      }
      if (!Object.keys(tasks).length) throw new Error("\u041d\u0435\u0442 URL, \u043f\u043e\u0434\u0445\u043e\u0434\u044f\u0449\u0438\u0445 \u043f\u043e\u0434 \u0432\u044b\u0431\u0440\u0430\u043d\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c");

      const timestamp = nowIso();
      const job = emptyJob();
      job.run_id = runId;
      job.status = "running";
      job.created_at = timestamp;
      job.started_at = timestamp;
      job.source = source;
      job.settings = { workers: workersCount, timeout_ms: timeoutMs, max_attempts: maxAttempts, delay_ms: delayMs };
      job.tasks = tasks;
      job.workers = Array.from({ length: workersCount }, (_, index) => ({
        worker_id: `worker_${index + 1}`,
        tab_id: null,
        status: "idle",
        stage_started_at: Date.now(),
        current_object_key: "",
        processed: 0,
        last_error: ""
      }));
      if (workbook) {
        recalculateTotals(job);
        const baseResults = Object.fromEntries(Object.entries(results).filter(([key]) => !key.startsWith("xlsx:")));
        await storageSetMany({ [JOB_KEY]: job, [RESULTS_KEY]: baseResults, [IMPORT_KEY]: { ...workbook, runId } });
      } else if (previousJob.source === "xlsx") {
        const imported = await storageGet(IMPORT_KEY);
        if (imported?.runId === previousJob.run_id) {
          recalculateTotals(job);
          await storageSetMany({ [JOB_KEY]: job, [IMPORT_KEY]: { ...imported, job: previousJob } });
        } else {
          await saveJob(job);
        }
      } else {
        await saveJob(job);
      }
    });

    await ensureWatchdog(true);
    const opened = await restoreWorkingLayout(area, sender);
    await pump();
    return { ok: true, state: await getState(), ...opened };
  }

  async function restoreWorkingLayout(area, sender) {
    if (!area) return {};
    try {
      return { layout: await serial(() => startWorkerRotation(area, sender, true)), layout_error: "" };
    } catch (error) {
      return { layout_error: String(error?.message || error) };
    }
  }

  async function tabExists(tabId) {
    if (!Number.isInteger(tabId)) return false;
    try {
      await api.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  }

  function setWorkerStage(worker, status) {
    if (worker.status === status && worker.stage_started_at) return;
    worker.status = status;
    worker.stage_started_at = Date.now();
  }

  const firstActivationByWorker = new Map();

  function recordEvent(job, type, task, reason = "", timings) {
    const activation = firstActivationByWorker.get(task.assigned_worker);
    const activationWait = activation?.runId === job.run_id && activation.assignedAt === task.assigned_at
      ? Math.max(0, activation.at - Date.parse(task.assigned_at)) : null;
    job.journal.push({
      at: nowIso(), type, object_key: task.object_key, worker_id: task.assigned_worker, reason,
      ...(timings ? { timings: { ...timings, activation_wait_ms: activationWait } } : {})
    });
    if (job.journal.length > 100) job.journal.shift();
  }

  function requeueWorkerTask(job, worker, reason, interrupted = false) {
    const task = job.tasks?.[worker.current_object_key];
    if (task && ACTIVE_TASK_STATES.has(task.status)) {
      if (interrupted) task.attempts = Math.max(0, task.attempts - 1);
      task.status = task.attempts >= job.settings.max_attempts ? "error" : "queued";
      task.error = reason;
      recordEvent(job, task.status, task, reason);
      task.assigned_worker = "";
      task.assigned_at = "";
      task.next_attempt_at = interrupted ? 0 : Date.now() + job.settings.delay_ms;
      if (task.status === "error") task.completed_at = nowIso();
    }
    setWorkerStage(worker, "idle");
    worker.current_object_key = "";
    worker.last_error = reason;
  }

  const launchBatchSize = 4;
  const launchIntervalMs = 400;
  let nextLaunchAt = 0;
  let launchRunId = "";
  let launchTimer;

  async function pump() {
    const assignments = await serial(async () => {
      const job = await loadJob();
      if (job.status !== "running") return [];

      const staleAfter = job.settings.timeout_ms + 45000;
      for (const worker of job.workers) {
        if (worker.current_object_key) {
          const task = job.tasks[worker.current_object_key];
          const assignedAt = Date.parse(task?.assigned_at || "") || 0;
          if (task && ACTIVE_TASK_STATES.has(task.status) && assignedAt && Date.now() - assignedAt > staleAfter) {
            requeueWorkerTask(job, worker, "\u041f\u0440\u0435\u0432\u044b\u0448\u0435\u043d \u0442\u0430\u0439м\u0430ут ф\u043e\u043d\u043e\u0432\u043e\u0439 \u0432\u043a\u043b\u0430\u0434\u043a\u0438");
          }
        }
        if (worker.tab_id && !(await tabExists(worker.tab_id))) {
          requeueWorkerTask(job, worker, "\u0424\u043e\u043d\u043e\u0432\u0430\u044f \u0432\u043a\u043b\u0430\u0434\u043a\u0430 \u0431\u044b\u043b\u0430 \u0437\u0430\u043a\u0440\u044b\u0442\u0430");
          worker.tab_id = null;
        }
      }

      if (launchRunId !== job.run_id) {
        clearTimeout(launchTimer);
        launchTimer = undefined;
        launchRunId = job.run_id;
        nextLaunchAt = 0;
      }
      const now = Date.now();
      const readyTasks = Object.values(job.tasks).filter((task) => task.status === "queued" && Number(task.next_attempt_at || 0) <= now);
      const assignments = [];
      const idleWorkers = job.workers.filter((worker) => !worker.current_object_key && worker.status === "idle");
      if (readyTasks.length && idleWorkers.length && now < nextLaunchAt) {
        if (!launchTimer) {
          launchTimer = setTimeout(() => {
            launchTimer = undefined;
            pump().catch(() => {});
          }, nextLaunchAt - now);
        }
      }
      const batchSize = now >= nextLaunchAt ? Math.min(launchBatchSize, idleWorkers.length, readyTasks.length) : 0;
      for (let index = 0; index < batchSize; index++) {
        const worker = idleWorkers[index];
        const task = readyTasks[index];
        if (!worker.tab_id) {
          const workerIndex = job.workers.indexOf(worker);
          const lane = rotation?.runId === job.run_id && !rotation.closing
            ? rotation.lanes.find(({ first, last }) => workerIndex >= first && workerIndex < last) : null;
          const props = { url: "about:blank", active: false };
          let tab;
          if (lane) {
            tab = await takeWindowPlaceholder(lane);
            tab ||= await api.tabs.create({ ...props, windowId: lane.windowId }).catch(() => null);
            if (tab) lane.ownedTabs.add(tab.id);
          }
          tab ||= await api.tabs.create(props);
          worker.tab_id = tab.id;
        }
        task.status = "navigating";
        task.attempts += 1;
        task.assigned_worker = worker.worker_id;
        task.assigned_at = nowIso();
        firstActivationByWorker.delete(worker.worker_id);
        task.error = "";
        setWorkerStage(worker, "navigating");
        worker.current_object_key = task.object_key;
        worker.last_error = "";
        recordEvent(job, "assigned", task);
        assignments.push({ tab_id: worker.tab_id, task: { ...task }, run_id: job.run_id, settings: { ...job.settings } });
      }

      if (assignments.length) {
        nextLaunchAt = Date.now() + (job.workers.length > launchBatchSize ? launchIntervalMs : 0);
        if (idleWorkers.length > batchSize && readyTasks.length > batchSize && !launchTimer) {
          launchTimer = setTimeout(() => {
            launchTimer = undefined;
            pump().catch(() => {});
          }, launchIntervalMs);
        }
      }

      const hasActive = job.workers.some((worker) => worker.current_object_key);
      const hasQueued = Object.values(job.tasks).some((task) => task.status === "queued");
      if (!hasActive && !hasQueued) {
        const hasBlock = Object.values(job.tasks).some((task) => ["captcha", "rate_limited"].includes(task.status));
        job.status = hasBlock ? "blocked" : "completed";
        job.completed_at = nowIso();
      }
      await saveJob(job);
      return assignments;
    });

    for (const assignment of assignments) {
      try {
        await api.tabs.update(assignment.tab_id, { url: assignment.task.url, active: false });
      } catch (error) {
        await finishWithError({
          run_id: assignment.run_id,
          object_key: assignment.task.object_key,
          worker_id: assignment.task.assigned_worker,
          attempt: assignment.task.attempts,
          assigned_at: assignment.task.assigned_at
        }, String(error?.message || error));
      }
    }
    if (!assignments.length) {
      const job = await loadJob();
      if (job.status === "completed") {
        await ensureWatchdog(false);
        const { closed } = await closeRotationWindows(job.run_id);
        const completedTabs = job.workers.map((worker) => worker.tab_id).filter(Number.isInteger);
        if (completedTabs.some((id) => !closed.has(id))) {
          try { await api.tabs.remove(completedTabs.filter((id) => !closed.has(id))); } catch {}
        }
      }
    }
  }

  async function markWaiting(tabId) {
    await serial(async () => {
      const job = await loadJob();
      const worker = job.workers.find((item) => item.tab_id === tabId);
      const task = worker && job.tasks[worker.current_object_key];
      if (task?.status === "navigating") {
        task.status = "waiting_dom";
        setWorkerStage(worker, "waiting_dom");
        await saveJob(job);
      }
    });
  }

  const pendingParses = new Map();

  async function dispatchForTab(tabId, allowRepeat = false) {
    const payload = await serial(async () => {
      const job = await loadJob();
      const worker = job.workers.find((item) => item.tab_id === tabId);
      if (!worker?.current_object_key || !["running", "paused"].includes(job.status)) return null;
      const task = job.tasks[worker.current_object_key];
      if (!task || (task.status === "parsing" && !allowRepeat) || !ACTIVE_TASK_STATES.has(task.status)) return null;
      const key = [job.run_id, task.object_key, task.attempts, task.assigned_at].join(":");
      if (pendingParses.get(tabId) === key) return null;
      task.status = "parsing";
      setWorkerStage(worker, "parsing");
      await saveJob(job);
      pendingParses.set(tabId, key);
      return {
        key,
        type: "ENRICHMENT_PARSE_DETAIL",
        run_id: job.run_id,
        worker_id: worker.worker_id,
        object_key: task.object_key,
        org_id: task.org_id,
        source: task.source || job.source || "yandex",
        attempt: task.attempts,
        assigned_at: task.assigned_at,
        timeout_ms: job.settings.timeout_ms
      };
    });
    if (!payload) return;

    try {
      const response = await api.tabs.sendMessage(tabId, payload);
      if (response?.ok && response?.result) await finishSuccess(payload, response.result, response.timings);
      else if (response?.status === "captcha") await finishCaptcha(payload, response.url || "");
      else if (response?.status === "rate_limited") await finishRateLimited(payload, response.url || "", response.error || "");
      else if (response?.status === "partial" && response.result) await finishWithError(payload, response.error, response.result, response.timings);
      else await finishWithError(payload, response?.error || "\u041f\u0430\u0440\u0441\u0435\u0440 \u043d\u0435 \u0432\u0435\u0440\u043d\u0443\u043b \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442");
    } catch (error) {
      await serial(async () => {
        const job = await loadJob();
        const worker = job.workers.find((item) => item.tab_id === tabId);
        const task = worker && job.tasks[worker.current_object_key];
        if (matchingAssignment(job, payload) === task && task?.status === "parsing") {
          task.status = "waiting_dom";
          setWorkerStage(worker, "waiting_dom");
          worker.last_error = String(error?.message || error);
          await saveJob(job);
        }
      });
    } finally {
      if (pendingParses.get(tabId) === payload.key) pendingParses.delete(tabId);
    }
  }

  function matchingAssignment(job, assignment) {
    if (job.run_id !== assignment.run_id) return null;
    const task = job.tasks[assignment.object_key];
    return task && ACTIVE_TASK_STATES.has(task.status) && task.assigned_worker === assignment.worker_id &&
      task.attempts === assignment.attempt && task.assigned_at === assignment.assigned_at ? task : null;
  }

  async function finishSuccess(assignment, result, timings) {
    await serial(async () => {
      const [job, results, session] = await Promise.all([loadJob(), loadResults(), storageGet(SESSION_KEY)]);
      const { object_key: objectKey } = assignment;
      const task = matchingAssignment(job, assignment);
      if (!task) return;
      results[objectKey] = {
        ...result,
        object_key: objectKey,
        status: "success",
        attempts: task.attempts,
        source_url: task.url
      };
      const storagePatch = { [RESULTS_KEY]: results };
      const coordinates = validCoordinatePair(result?.lat, result?.lon);
      const baseObject = job.source === "xlsx" ? null : session?.objects?.[objectKey];
      if (coordinates && baseObject) {
        baseObject.lat = coordinates.lat;
        baseObject.lon = coordinates.lon;
        session.updated_at = nowIso();
        storagePatch[SESSION_KEY] = session;
      }
      task.status = "success";
      task.completed_at = nowIso();
      job.last_saved_at = task.completed_at;
      recordEvent(job, "saved", task, "", timings);
      task.error = "";
      const worker = job.workers.find((item) => item.worker_id === task.assigned_worker);
      if (worker) {
        setWorkerStage(worker, "idle");
        worker.current_object_key = "";
        worker.processed = Number(worker.processed || 0) + 1;
      }
      task.assigned_worker = "";
      recalculateTotals(job);
      await storageSetMany({ ...storagePatch, [JOB_KEY]: job });
    });
    await pump();
  }

  function failedResult(previous, task, status, url = task.url) {
    if (previous?.status === "success" || previous?.status === "partial") {
      return { ...previous, last_attempt_status: status, last_attempt_error: task.error };
    }
    return {
      object_key: task.object_key,
      org_id: task.org_id,
      source_url: url,
      status,
      error: task.error,
      attempts: task.attempts,
      enriched_at: nowIso()
    };
  }

  async function finishWithError(assignment, errorText, partial, timings) {
    await serial(async () => {
      const [job, results] = await Promise.all([loadJob(), loadResults()]);
      const { object_key: objectKey } = assignment;
      const task = matchingAssignment(job, assignment);
      if (!task) return;
      const worker = job.workers.find((item) => item.worker_id === task.assigned_worker);
      task.error = String(errorText || "\u041d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u0430\u044f \u043e\u0448\u0438\u0431\u043a\u0430");
      recordEvent(job, task.attempts < job.settings.max_attempts ? "retry" : "error", task, task.error, timings);
      task.assigned_worker = "";
      task.assigned_at = "";
      if (task.attempts < job.settings.max_attempts) {
        if (partial && results[objectKey]?.status !== "success") {
          results[objectKey] = { ...partial, ...failedResult(null, task, "partial") };
          await storageSet(RESULTS_KEY, results);
        }
        task.status = "queued";
        task.next_attempt_at = Date.now() + job.settings.delay_ms;
      } else {
        task.status = "error";
        task.completed_at = nowIso();
        const previous = results[objectKey];
        results[objectKey] = previous?.status === "success"
          ? failedResult(previous, task, "error")
          : partial || previous?.status === "partial"
            ? { ...(partial || previous), ...failedResult(null, task, "partial") }
            : failedResult(previous, task, "error");
        await storageSet(RESULTS_KEY, results);
      }
      if (worker) {
        setWorkerStage(worker, "idle");
        worker.current_object_key = "";
        worker.last_error = task.error;
      }
      await saveJob(job);
    });
    await sleep(50);
    await pump();
    const job = await loadJob();
    if (job.status === "running" && job.totals.queued) {
      setTimeout(() => pump().catch(() => {}), job.settings.delay_ms + 50);
    }
  }

  async function finishCaptcha(assignment, url) {
    await serial(async () => {
      const [job, results] = await Promise.all([loadJob(), loadResults()]);
      const { object_key: objectKey } = assignment;
      const task = matchingAssignment(job, assignment);
      if (!task) return;
      task.status = "captcha";
      recordEvent(job, "captcha", task);
      task.error = "CAPTCHA";
      task.completed_at = nowIso();
      results[objectKey] = failedResult(results[objectKey], task, "captcha", url || task.url);
      await storageSet(RESULTS_KEY, results);
      const worker = job.workers.find((item) => item.worker_id === task.assigned_worker);
      if (worker) setWorkerStage(worker, "captcha");
      job.status = "blocked";
      await saveJob(job);
    });
  }

  async function finishRateLimited(assignment, url, errorText) {
    await serial(async () => {
      const [job, results] = await Promise.all([loadJob(), loadResults()]);
      const { object_key: objectKey } = assignment;
      const task = matchingAssignment(job, assignment);
      if (!task) return;
      const error = String(errorText || "\u042f\u043d\u0434\u0435\u043a\u0441 \u0432\u0440\u0435\u043c\u0435\u043d\u043d\u043e \u043e\u0433\u0440\u0430\u043d\u0438\u0447\u0438\u043b \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0443 \u0441\u0442\u0440\u0430\u043d\u0438\u0446");
      task.status = "rate_limited";
      recordEvent(job, "rate_limited", task);
      task.error = error;
      task.completed_at = nowIso();
      results[objectKey] = failedResult(results[objectKey], task, "rate_limited", url || task.url);
      await storageSet(RESULTS_KEY, results);
      const worker = job.workers.find((item) => item.worker_id === task.assigned_worker);
      if (worker) setWorkerStage(worker, "rate_limited");
      job.status = "blocked";
      await saveJob(job);
    });
  }

  async function pauseJob() {
    return serial(async () => {
      const job = await loadJob();
      if (job.status === "running") job.status = "paused";
      await saveJob(job);
      return { ok: true, state: await getState() };
    });
  }

  async function resumeJob(source, area, sender) {
    const result = await serial(async () => {
      let job = await loadJob();
      if (source === "xlsx" && job.source !== "xlsx") {
        if (["running", "paused", "blocked"].includes(job.status)) {
          throw new Error("Сначала завершите текущий досбор.");
        }
        const imported = await storageGet(IMPORT_KEY);
        if (!imported?.job || imported.job.run_id !== imported.runId) {
          throw new Error("Нет сохранённой очереди XLSX.");
        }
        job = normalizeJob(imported.job);
        for (const worker of job.workers) worker.tab_id = null;
      }
      if (!["paused", "blocked", "stopped"].includes(job.status)) throw new Error("\u042d\u0442\u0443 \u043e\u0447\u0435\u0440\u0435\u0434\u044c \u043d\u0435\u043b\u044c\u0437\u044f \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0438\u0442\u044c");
      for (const task of Object.values(job.tasks)) {
        if (["captcha", "rate_limited"].includes(task.status)) {
          task.status = "queued";
          task.error = "";
          task.assigned_worker = "";
          task.assigned_at = "";
        }
      }
      for (const worker of job.workers) {
        if (["captcha", "rate_limited"].includes(worker.status)) {
          setWorkerStage(worker, "idle");
          worker.current_object_key = "";
        }
      }
      job.status = "running";
      job.pause_reason = "";
      job.completed_at = "";
      await saveJob(job);
      return { ok: true };
    });
    await ensureWatchdog(true);
    const opened = await restoreWorkingLayout(area, sender);
    await pump();
    return { ...result, ...opened };
  }

  let pendingStops = 0;

  async function stopJob() {
    pendingStops++;
    const requestedRotation = rotation;
    if (requestedRotation) requestedRotation.closing = true;
    return serial(async () => {
      const job = await loadJob();
      const tabIds = job.workers.map((worker) => worker.tab_id).filter(Number.isInteger);
      for (const worker of job.workers) requeueWorkerTask(job, worker, "Остановлено пользователем", true);
      job.status = "stopped";
      job.completed_at = nowIso();
      await saveJob(job);
      const closeOne = async (tab, isSummary = false) => {
        const window = await api.windows?.get(tab.windowId, { populate: true }).catch(() => null);
        if (window?.tabs?.length === 1 && window.tabs[0].id === tab.id &&
            (isSummary || window.type === "popup" || arrangedWorkerWindowIds.has(window.id))) {
          try {
            await api.windows.remove(window.id);
            return;
          } catch {
            // Fall back to closing the tab if closing the window is rejected.
          }
        }
        await api.tabs.remove(tab.id);
      };

      const mode = requestedRotation?.runId === job.run_id ? requestedRotation : rotation;
      const keepSummary = mode?.runId === job.run_id;
      const { closed, pending } = await closeRotationWindows(job.run_id, mode);
      const failed = await Promise.allSettled([
        ensureWatchdog(false),
        ...tabIds.filter((id) => !closed.has(id)).map(async (tabId) => {
          const tab = await api.tabs.get(tabId).catch(() => null);
          if (tab) await closeOne(tab);
        }),
        ...(keepSummary ? [] : [summaryTabs().then((tabs) => Promise.all(tabs.map((tab) => closeOne(tab, true))))])
      ]);
      if (pending.length || failed.some((result) => result.status === "rejected")) {
        throw new Error("Досбор остановлен. Некоторые рабочие вкладки не удалось закрыть.");
      }
      return { ok: true };
    }).finally(() => { pendingStops--; });
  }

  async function forceResetEnrichment(importOnly) {
    const tabIds = await serial(async () => {
      const job = await loadJob();
      const ids = job.workers.map((worker) => worker.tab_id).filter(Number.isInteger);
      const freshJob = emptyJob();
      if (importOnly && job.source !== "xlsx") throw new Error("Текущая очередь создана из базовой сессии");
      const results = importOnly ? Object.fromEntries(Object.entries(await loadResults()).filter(([key]) => !key.startsWith("xlsx:"))) : {};
      await storageSetMany({ [JOB_KEY]: freshJob, [RESULTS_KEY]: results, [IMPORT_KEY]: null });
      return ids;
    });

    if (tabIds.length) {
      try { await api.tabs.remove(tabIds); } catch {}
    }
    await ensureWatchdog(false);
    return { ok: true, ...(await getState()) };
  }

  async function retryErrors(area, sender) {
    await serial(async () => {
      const job = await loadJob();
      let changed = 0;
      for (const task of Object.values(job.tasks)) {
        if (["error", "captcha", "rate_limited"].includes(task.status)) {
          task.status = "queued";
          const worker = job.workers.find((item) => item.current_object_key === task.object_key);
          if (worker) {
            setWorkerStage(worker, "idle");
            worker.current_object_key = "";
            worker.last_error = "";
          }
          task.assigned_worker = "";
          task.assigned_at = "";
          task.attempts = 0;
          task.error = "";
          task.completed_at = "";
          task.next_attempt_at = 0;
          changed += 1;
        }
      }
      if (!changed) throw new Error("\u041d\u0435\u0442 \u043e\u0448\u0438\u0431\u043e\u043a \u0434\u043b\u044f \u043f\u043e\u0432\u0442\u043e\u0440\u0430");
      job.status = "running";
      job.pause_reason = "";
      job.completed_at = "";
      await saveJob(job);
    });
    await ensureWatchdog(true);
    const opened = await restoreWorkingLayout(area, sender);
    await pump();
    return { ok: true, ...opened };
  }

  async function openDashboard(sourceTab = null) {
    let source = sourceTab;
    if (source?.id && (!Number.isInteger(source.index) || !Number.isInteger(source.windowId))) {
      try { source = await api.tabs.get(source.id); } catch { source = null; }
    }
    const hasSourcePosition = Number.isInteger(source?.index) && Number.isInteger(source?.windowId);
    const existing = await api.tabs.query({ url: DASHBOARD_URL });
    if (existing?.[0]?.id) {
      const dashboard = existing.find((tab) => tab.windowId === source?.windowId) || existing[0];
      if (hasSourcePosition && typeof api.tabs.move === "function") {
        const movesInsideSameWindow = dashboard.windowId === source.windowId;
        const wasBeforeSource = movesInsideSameWindow && Number.isInteger(dashboard.index) && dashboard.index < source.index;
        const targetIndex = source.index + (wasBeforeSource ? 0 : 1);
        try {
          await api.tabs.move(dashboard.id, { windowId: source.windowId, index: targetIndex });
        } catch {}
      }
      await api.tabs.update(dashboard.id, { active: true });
      return { ok: true, tab_id: dashboard.id };
    }
    const createProperties = { url: DASHBOARD_URL, active: true };
    if (hasSourcePosition) {
      createProperties.windowId = source.windowId;
      createProperties.index = source.index + 1;
    }
    const tab = await api.tabs.create(createProperties);
    return { ok: true, tab_id: tab.id };
  }

  function workerWindowBounds(area, limit) {
    const { left, top, width, height } = area || {};
    if (![left, top, width, height].every(Number.isInteger) ||
        width < 420 || height < 260 || width > 32768 || height > 32768) return [];
    const gap = 12;
    const fitsStandard = Math.floor((width + gap) / (520 + gap)) *
      Math.floor((height + gap) / (320 + gap)) >= limit;
    const tileWidth = fitsStandard ? 520 : 420;
    const tileHeight = fitsStandard ? 320 : 260;
    const columns = Math.floor((width + gap) / (tileWidth + gap));
    const rows = Math.floor((height + gap) / (tileHeight + gap));
    return Array.from({ length: Math.min(limit, columns * rows) }, (_, index) => ({
      left: left + (index % columns) * (tileWidth + gap),
      top: top + Math.floor(index / columns) * (tileHeight + gap),
      width: tileWidth,
      height: tileHeight
    }));
  }

  const arrangedWorkerWindowIds = new Set();
  api.windows?.onRemoved?.addListener((windowId) => arrangedWorkerWindowIds.delete(windowId));

  let summaryTab;
  const summaryUrl = api.runtime.getURL("enrichment-summary.html");

  async function summaryTabs() {
    const windows = await api.windows.getAll({ populate: true });
    return windows.flatMap((window) => window.tabs || []).filter((tab) =>
      tab.id === summaryTab?.id || [tab.url, tab.pendingUrl].includes(summaryUrl));
  }

  async function openSummaryWindow(bounds) {
    const [existing, ...duplicates] = await summaryTabs();
    const window = existing ? await api.windows.get(existing.windowId).catch(() => null) : null;
    if (window?.type === "normal") {
      await Promise.allSettled(duplicates.map(({ id }) => api.tabs.remove(id)));
      if (window.state === "minimized") await api.windows.update(window.id, { state: "normal" });
      await api.windows.update(window.id, { focused: true });
      summaryTab = existing;
      return existing;
    }

    const created = await api.windows.create({
      ...bounds, url: summaryUrl, type: "normal", focused: true
    });
    const [tab] = created.tabs?.length ? created.tabs : await api.tabs.query({ windowId: created.id });
    if (!tab) {
      await api.windows.remove(created.id).catch(() => {});
      throw new Error("Не удалось найти вкладку сводки.");
    }
    summaryTab = tab;
    // Upgrade a popup created by earlier versions only after the new summary is available.
    await Promise.allSettled([existing, ...duplicates].filter(Boolean).map(({ id }) => api.tabs.remove(id)));
    return tab;
  }

  let rotation;
  const rotationDwellMs = 900;

  async function takeWindowPlaceholder(lane) {
    const id = lane.placeholderTabId;
    if (!Number.isInteger(id)) return null;
    lane.placeholderTabId = null;
    const tab = await api.tabs.get(id).catch(() => null);
    if (tab?.windowId === lane.windowId && (tab.pendingUrl || tab.url) === "about:blank") return tab;
    lane.ownedTabs.delete(id);
    return null;
  }

  async function removeWindowPlaceholder(lane) {
    const tab = await takeWindowPlaceholder(lane);
    if (tab) await api.tabs.remove(tab.id).catch(() => {});
  }

  async function closeRotationWindows(runId, mode = rotation) {
    if (mode?.runId !== runId) return { closed: new Set(), pending: [] };
    if (mode.cleanup) return mode.cleanup;
    mode.closing = true;
    mode.cleanup = cleanupRotationWindows(mode);
    return mode.cleanup;
  }

  async function cleanupRotationWindows(mode) {
    const closed = new Set();
    const pending = [];
    await Promise.all(mode.lanes.map(async (lane) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const window = await api.windows.get(lane.windowId, { populate: true }).catch(() => null);
        if (!window) return;
        const tabs = window.tabs || await api.tabs.query({ windowId: lane.windowId }).catch(() => null);
        if (!tabs || tabs.some(({ id }) => !lane.ownedTabs.has(id))) {
          if (tabs) await removeWindowPlaceholder(lane);
          return;
        }
        try {
          await api.windows.remove(lane.windowId);
          for (const { id } of tabs) closed.add(id);
        } catch {}
        await sleep(250);
      }
      if (await api.windows.get(lane.windowId).catch(() => null)) pending.push(lane.windowId);
    }));
    if (!pending.length && rotation === mode) rotation = undefined;
    if (pending.length) mode.cleanup = undefined;
    return { closed, pending };
  }

  async function pauseWithoutSummary(mode) {
    await serial(async () => {
      if (rotation !== mode || mode.closing) return;
      if (await api.tabs.get(mode.summaryTabId).catch(() => null)) return;
      const job = await loadJob();
      if (job.run_id !== mode.runId || job.status !== "running") return;
      job.status = "paused";
      job.pause_reason = "Сводка закрыта. Нажмите «Продолжить», чтобы открыть её снова.";
      await saveJob(job);
    });
  }

  async function rotateWorkerTabs(mode, lane) {
    let previousWorkerId = "";
    try {
      while (rotation === mode && !mode.closing && !pendingStops) {
        const job = await loadJob();
        if (job.run_id !== mode.runId || !["running", "paused", "blocked"].includes(job.status)) break;
        const summary = await api.tabs.get(mode.summaryTabId).catch(() => null);
        if (!summary) {
          if (job.status === "running") await pauseWithoutSummary(mode);
          await sleep(500);
          continue;
        }
        const focused = await api.windows.getLastFocused();
        if (job.status !== "running" || !(focused.id === summary.windowId || (!mode.split && focused.id === lane.windowId))) {
          await sleep(500);
          continue;
        }
        const activeWorkers = job.workers.slice(lane.first, lane.last).filter((worker) =>
          worker.current_object_key && Number.isInteger(worker.tab_id));
        if (!activeWorkers.length) {
          await sleep(300);
          continue;
        }
        const index = activeWorkers.findIndex((worker) => worker.worker_id === previousWorkerId);
        const worker = activeWorkers[(index + 1) % activeWorkers.length];
        previousWorkerId = worker.worker_id;
        try {
          const tab = await api.tabs.get(worker.tab_id);
          if (rotation !== mode || mode.closing || pendingStops) break;
          const grouped = new Set((await api.tabs.query({ windowId: lane.windowId })).map(({ id }) => id));
          if (rotation !== mode || mode.closing || pendingStops) break;
          for (const { tab_id } of activeWorkers) {
            if (!grouped.has(tab_id)) {
              if (rotation !== mode || mode.closing || pendingStops) break;
              lane.ownedTabs.add(tab_id);
              const moved = await api.tabs.move(tab_id, { windowId: lane.windowId, index: -1 }).catch(() => null);
              if (moved && Number.isInteger(lane.placeholderTabId)) {
                await serial(() => removeWindowPlaceholder(lane));
              }
            }
          }
          if (rotation !== mode || mode.closing || pendingStops) break;
          await api.tabs.update(tab.id, { active: true });
          if (!mode.split) await api.windows.update(lane.windowId, { focused: true });
          const assignedAt = job.tasks[worker.current_object_key]?.assigned_at;
          if (assignedAt && !firstActivationByWorker.has(worker.worker_id)) {
            firstActivationByWorker.set(worker.worker_id, { runId: job.run_id, assignedAt, at: Date.now() });
          }
          await sleep(rotationDwellMs);
          if (rotation !== mode || mode.closing || pendingStops) break;
          if (!mode.split && (await api.windows.getLastFocused()).id === lane.windowId) {
            await api.windows.update(summary.windowId, { focused: true });
          }
        } catch {
          // A worker can disappear while its card is completing.
        }
        await sleep(150);
      }
    } finally {
      if (!mode.closing) {
        const job = await loadJob();
        if (job.run_id !== mode.runId || !["completed", "stopped"].includes(job.status)) {
          await serial(() => removeWindowPlaceholder(lane));
        }
      }
    }
  }

  async function startWorkerRotation(area, sender, split) {
    if (sender.url?.split(/[?#]/)[0] !== api.runtime.getURL("enrichment.html")) {
      throw new Error("Режим доступен из окна досбора.");
    }
    const job = await loadJob();
    if (job.status !== "running" || pendingStops) throw new Error("Сначала запустите досбор.");
    const desiredCount = split ? Math.ceil(job.workers.length / 4) : 1;
    let bounds = workerWindowBounds(area, desiredCount + 1);
    if (bounds.length < 2) {
      const { left, top, width, height } = area || {};
      if (![left, top, width, height].every(Number.isInteger) || width < 320 || height < 220) {
        throw new Error("На экране недостаточно места для рабочих окон и сводки.");
      }
      const slot = { left, top, width: Math.min(width, 420), height: Math.min(height, 260) };
      bounds = [slot, { ...slot }];
    }
    const siteCount = bounds.length - 1;
    const parallel = split && siteCount === desiredCount && bounds[0] !== bounds.at(-1) &&
      (bounds[0].left !== bounds.at(-1).left || bounds[0].top !== bounds.at(-1).top);
    const current = rotation;
    if (current?.runId === job.run_id && !current.closing) {
      const summary = await openSummaryWindow(current.summaryBounds);
      current.summaryTabId = summary.id;
      return { ok: true, working_window_ids: current.lanes.map(({ windowId }) => windowId), summary_window_id: summary.windowId };
    }
    const groupSize = Math.ceil(job.workers.length / siteCount);
    const lanes = [];
    try {
      for (let index = 0; index < siteCount; index++) {
        const working = await api.windows.create({ ...bounds[index], type: "normal", url: "about:blank", focused: false });
        const [seed] = working.tabs?.length ? working.tabs : await api.tabs.query({ windowId: working.id });
        if (!seed) {
          await api.windows.remove(working.id).catch(() => {});
          throw new Error("Не удалось найти рабочее окно.");
        }
        lanes.push({ windowId: working.id, placeholderTabId: seed.id, ownedTabs: new Set([seed.id]), first: index * groupSize, last: (index + 1) * groupSize });
      }
      const summary = await openSummaryWindow(bounds.at(-1));
      const mode = { runId: job.run_id, split: parallel, summaryTabId: summary.id, summaryBounds: bounds.at(-1), lanes };
      rotation = mode;
      Promise.allSettled(lanes.map((lane) => rotateWorkerTabs(mode, lane))).then(() => {
        if (rotation === mode && !mode.closing) {
          loadJob().then((current) => {
            if (rotation === mode && !mode.closing && !["completed", "stopped"].includes(current.status)) rotation = undefined;
          }).catch(() => {});
        }
      });
      return { ok: true, working_window_ids: lanes.map(({ windowId }) => windowId), summary_window_id: summary.windowId };
    } catch (error) {
      await Promise.allSettled(lanes.map(({ windowId }) => api.windows.remove(windowId)));
      throw error;
    }
  }

  async function arrangeWorkerWindows(area, sender, withSummary) {
    if (sender.url?.split(/[?#]/)[0] !== api.runtime.getURL("enrichment.html")) {
      throw new Error("Раскладка доступна из окна досбора.");
    }
    // Read the queue only. Moving tabs keeps their IDs and in-flight work.
    const job = await loadJob();
    const tabs = job.workers.map((worker) => worker.tab_id).filter(Number.isInteger);
    if (!tabs.length || !["running", "paused", "blocked"].includes(job.status)) {
      throw new Error("Сначала запустите досбор.");
    }
    const bounds = workerWindowBounds(area, tabs.length + Number(withSummary));
    if (!bounds.length) throw new Error("На этом экране недостаточно места для рабочего окна.");
    let summaryOpened = false;
    let summaryError = "";
    if (withSummary && !pendingStops) {
      const slot = bounds.pop();
      try {
        await openSummaryWindow(slot);
        summaryOpened = true;
      } catch (error) {
        bounds.push(slot);
        summaryError = String(error?.message || error);
      }
    }
    let arranged = 0;
    let skipped = 0;
    let firstError = "";
    for (const tabId of tabs) {
      if (pendingStops || arranged >= bounds.length) break;
      try {
        const current = await api.tabs.get(tabId);
        const window = await api.windows.get(current.windowId, { populate: true });
        const slot = bounds[arranged];
        if (window.tabs?.length === 1 && (window.type === "popup" || arrangedWorkerWindowIds.has(window.id))) {
          await api.windows.update(window.id, { state: "normal" });
          await api.windows.update(window.id, { ...slot, focused: true });
        } else {
          try {
            await api.windows.create({ ...slot, tabId, type: "popup", focused: true });
          } catch (popupError) {
            try {
              const created = await api.windows.create({ ...slot, tabId, type: "normal", focused: true });
              arrangedWorkerWindowIds.add(created.id);
            } catch (normalError) {
              throw new Error(`Всплывающее окно: ${popupError.message || popupError}. Обычное окно: ${normalError.message || normalError}.`);
            }
          }
        }
        arranged++;
      } catch (error) {
        skipped++;
        firstError ||= String(error?.message || error);
      }
    }
    return { ok: true, arranged, background: tabs.length - arranged, skipped, first_error: firstError, summary_opened: summaryOpened, summary_error: summaryError };
  }

  async function openWorker(workerId, objectKey) {
    const job = await loadJob();
    const worker = workerId
      ? job.workers.find((item) => item.worker_id === workerId)
      : job.workers.find((item) => ["captcha", "rate_limited"].includes(item.status));
    if (objectKey && worker?.current_object_key !== objectKey) throw new Error("Эта вкладка уже обрабатывает другую карточку.");
    if (!worker?.tab_id) throw new Error("\u0420\u0430\u0431\u043e\u0447\u0430\u044f \u0432\u043a\u043b\u0430\u0434\u043a\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430");
    await api.tabs.update(worker.tab_id, { active: true });
    return { ok: true };
  }

  async function resizeRunWindows(message, sender) {
    if (sender.url !== summaryUrl || !Number.isInteger(sender.tab?.windowId)) {
      throw new Error("Изменение размеров доступно из сводки.");
    }
    const summaryId = sender.tab.windowId;
    const ids = [summaryId, ...(rotation && !rotation.closing ? rotation.lanes.map(({ windowId }) => windowId) : [])];
    if (message.type === "ENRICHMENT_RESIZE_WINDOW") {
      const { window_id: id, width, height } = message;
      if (!ids.includes(id) || ![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 32768)) {
        throw new Error("Проверьте окно и размеры.");
      }
      const current = await api.windows.get(id);
      if (current.state !== "normal") await api.windows.update(id, { state: "normal" });
      await api.windows.update(id, { width, height });
    }
    const windows = await Promise.all(ids.map((id) => api.windows.get(id).catch(() => null)));
    return {
      ok: true,
      windows: windows.flatMap((window, index) => window ? [{
        id: window.id, width: window.width, height: window.height,
        label: index === 0 ? "Сводка" : `Рабочее окно ${index}`
      }] : [])
    };
  }

  async function handleMessage(message, sender) {
    switch (message?.type) {
      case "ENRICHMENT_WINDOW_SIZES":
      case "ENRICHMENT_RESIZE_WINDOW":
        return serial(() => resizeRunWindows(message, sender));
      case "ENRICHMENT_GET_SUMMARY": {
        if (sender.url === summaryUrl && sender.tab) summaryTab = sender.tab;
        const { job, saved_counts } = await getState();
        const { source, status, totals, started_at, completed_at, last_saved_at } = job;
        return { ok: true, job: { source, status, totals, started_at, completed_at, last_saved_at }, saved_counts };
      }
      case "ENRICHMENT_GET_STATE": return { ok: true, ...(await getState()) };
      case "ENRICHMENT_GET_RESULTS": {
        const results = await loadResults();
        return { ok: true, results: Object.fromEntries(Object.entries(results)
          .filter(([key]) => key.startsWith("xlsx:") === (message.imported === true))) };
      }
      case "ENRICHMENT_START": return startJob(message.options || {}, message.area, sender);
      case "ENRICHMENT_PAUSE": return pauseJob();
      case "ENRICHMENT_RESUME": return resumeJob(message.source, message.area, sender);
      case "ENRICHMENT_STOP": return stopJob();
      case "ENRICHMENT_FORCE_RESET": return forceResetEnrichment(message.importOnly === true);
      case "ENRICHMENT_RETRY_ERRORS": return retryErrors(message.area, sender);
      case "OPEN_ENRICHMENT": {
        let sourceTab = sender?.tab || null;
        if (!sourceTab?.id && Number.isInteger(message.source_tab_id)) {
          try { sourceTab = await api.tabs.get(message.source_tab_id); } catch { sourceTab = null; }
        }
        return openDashboard(sourceTab);
      }
      case "ENRICHMENT_ROTATE_WINDOWS": return serial(() => startWorkerRotation(message.area, sender, message.split === true));
      case "ENRICHMENT_ARRANGE_WINDOWS": return serial(async () => {
        rotation = undefined;
        return arrangeWorkerWindows(message.area, sender, message.with_summary === true);
      });
      case "ENRICHMENT_OPEN_WORKER": return openWorker(message.worker_id, message.object_key);
      case "ENRICHMENT_WORKER_READY":
        if (sender?.tab?.id) await dispatchForTab(sender.tab.id, true);
        return { ok: true };
      default: return null;
    }
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  });

  async function pauseAtTravelChallenge(tabId, value) {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (url.origin !== "https://travel.yandex.ru" || !/^\/showcaptcha(?:\/|$)/i.test(url.pathname)) return false;
    const job = await loadJob();
    const worker = job.workers.find((item) => item.tab_id === tabId);
    const task = job.tasks[worker?.current_object_key];
    if (!task || task.source !== "travel") return false;
    await finishCaptcha({
      run_id: job.run_id, object_key: task.object_key, worker_id: worker.worker_id,
      assigned_at: task.assigned_at, attempt: task.attempts
    }, task.url);
    return true;
  }

  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url && changeInfo.status !== "complete") return;
    (async () => {
      if (await pauseAtTravelChallenge(tabId, changeInfo.url || tab?.url)) return;
      if (changeInfo.status === "complete") {
        await markWaiting(tabId);
        await dispatchForTab(tabId);
      }
    })().catch(() => {});
  });

  api.tabs.onRemoved.addListener((tabId) => {
    if (summaryTab?.id === tabId) summaryTab = undefined;
    serial(async () => {
      const job = await loadJob();
      const worker = job.workers.find((item) => item.tab_id === tabId);
      if (!worker) return;
      requeueWorkerTask(job, worker, "\u0424\u043e\u043d\u043e\u0432\u0430\u044f \u0432\u043a\u043b\u0430\u0434\u043a\u0430 \u0431\u044b\u043b\u0430 \u0437\u0430\u043a\u0440\u044b\u0442\u0430");
      worker.tab_id = null;
      await saveJob(job);
    }).then(() => pump()).catch(() => {});
  });

  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCHDOG_ALARM) pump().catch(() => {});
  });

  api.runtime.onStartup?.addListener(() => pump().catch(() => {}));
  api.runtime.onInstalled?.addListener(() => pump().catch(() => {}));
})();
