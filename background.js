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

  function detailUrlForObject(object) {
    if (!object || !object.url) return "";
    try {
      const sourceUrl = new URL(object.url);
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
    return { job, result_count: resultCount, base_count: baseCount.total, base_counts: baseCount, saved_counts: savedCounts, controller_version: "1.12.7" };
  }

  async function getState() {
    const [job, results, session] = await Promise.all([loadJob(), loadResults(), storageGet(SESSION_KEY)]);
    const objects = Object.values(session?.objects || {});
    const baseCount = {
      total: objects.length,
      yandex: objects.filter((object) => object?.source === "yandex" && detailUrlForObject(object)).length,
      "2gis": objects.filter((object) => object?.source === "2gis" && detailUrlForObject(object)).length
    };
    const saved = { yandex: 0, "2gis": 0, xlsx: 0 };
    for (const [key, object] of Object.entries(session?.objects || {})) {
      if (Object.hasOwn(saved, object?.source) && object.source !== "xlsx" && detailUrlForObject(object) && results[key]?.status === "success") saved[object.source]++;
    }
    if (job.source === "xlsx") {
      saved.xlsx = Object.keys(job.tasks).filter((key) => results[key]?.status === "success").length;
    }
    return publicState(job, Object.keys(results).filter((key) => key.startsWith("xlsx:") === (job.source === "xlsx")).length, baseCount, saved);
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
      const source = yandex ? "yandex" : gis ? "2gis" : "";
      const orgId = yandex && parsed.pathname.startsWith("/maps/") ? orgIdFromYandexUrl(parsed.href)
        : gis ? parsed.pathname.match(/\/(?:firm|geo)\/(\d{10,})(?:\/|$)/i)?.[1] : "";
      if (!source || !orgId) continue;
      const key = `xlsx:${runId}:${source}:${orgId}`;
      const object = objects[key] ||= { source, org_id: orgId, url: parsed.href, rows: [] };
      object.rows.push(row);
    }
    return objects;
  }

  async function startJob(options) {
    const workbook = options?.workbook;
    const source = workbook ? "xlsx" : options?.source === "2gis" ? "2gis" : "yandex";
    const scope = ["unprocessed", "all", "errors"].includes(options?.scope) ? options.scope : "unprocessed";
    const requestedWorkers = Number(options?.workers ?? 2);
    const workersCount = Math.min(8, Math.max(1, Number.isFinite(requestedWorkers) ? Math.trunc(requestedWorkers) : 2));
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
          org_id: String(object.org_id || orgIdFromYandexUrl(object.url) || ""),
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
        current_object_key: "",
        processed: 0,
        last_error: ""
      }));
      if (workbook) {
        recalculateTotals(job);
        const baseResults = Object.fromEntries(Object.entries(results).filter(([key]) => !key.startsWith("xlsx:")));
        await storageSetMany({ [JOB_KEY]: job, [RESULTS_KEY]: baseResults, [IMPORT_KEY]: { ...workbook, runId } });
      } else {
        await saveJob(job);
      }
    });

    await ensureWatchdog(true);
    await pump();
    return { ok: true, state: await getState() };
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

  function requeueWorkerTask(job, worker, reason, interrupted = false) {
    const task = job.tasks?.[worker.current_object_key];
    if (task && ACTIVE_TASK_STATES.has(task.status)) {
      if (interrupted) task.attempts = Math.max(0, task.attempts - 1);
      task.status = task.attempts >= job.settings.max_attempts ? "error" : "queued";
      task.error = reason;
      task.assigned_worker = "";
      task.assigned_at = "";
      task.next_attempt_at = interrupted ? 0 : Date.now() + job.settings.delay_ms;
      if (task.status === "error") task.completed_at = nowIso();
    }
    worker.status = "idle";
    worker.current_object_key = "";
    worker.last_error = reason;
  }

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
        if (!worker.tab_id) {
          const tab = await api.tabs.create({ url: "about:blank", active: false });
          worker.tab_id = tab.id;
        }
      }

      const readyTasks = Object.values(job.tasks).filter((task) => task.status === "queued" && Number(task.next_attempt_at || 0) <= Date.now());
      const assignments = [];
      for (const worker of job.workers) {
        if (worker.current_object_key || worker.status !== "idle") continue;
        const task = readyTasks.shift();
        if (!task) break;
        task.status = "navigating";
        task.attempts += 1;
        task.assigned_worker = worker.worker_id;
        task.assigned_at = nowIso();
        task.error = "";
        worker.status = "navigating";
        worker.current_object_key = task.object_key;
        worker.last_error = "";
        assignments.push({ tab_id: worker.tab_id, task: { ...task }, run_id: job.run_id, settings: { ...job.settings } });
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
        const completedTabs = job.workers.map((worker) => worker.tab_id).filter(Number.isInteger);
        if (completedTabs.length) {
          try { await api.tabs.remove(completedTabs); } catch {}
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
        worker.status = "waiting_dom";
        await saveJob(job);
      }
    });
  }

  async function dispatchForTab(tabId, allowRepeat = false) {
    const payload = await serial(async () => {
      const job = await loadJob();
      const worker = job.workers.find((item) => item.tab_id === tabId);
      if (!worker?.current_object_key || !["running", "paused"].includes(job.status)) return null;
      const task = job.tasks[worker.current_object_key];
      if (!task || (task.status === "parsing" && !allowRepeat) || !ACTIVE_TASK_STATES.has(task.status)) return null;
      task.status = "parsing";
      worker.status = "parsing";
      await saveJob(job);
      return {
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
      if (response?.ok && response?.result) await finishSuccess(payload, response.result);
      else if (response?.status === "captcha") await finishCaptcha(payload, response.url || "");
      else if (response?.status === "rate_limited") await finishRateLimited(payload, response.url || "", response.error || "");
      else if (response?.status === "partial" && response.result) await finishWithError(payload, response.error, response.result);
      else await finishWithError(payload, response?.error || "\u041f\u0430\u0440\u0441\u0435\u0440 \u043d\u0435 \u0432\u0435\u0440\u043d\u0443\u043b \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442");
    } catch (error) {
      await serial(async () => {
        const job = await loadJob();
        const worker = job.workers.find((item) => item.tab_id === tabId);
        const task = worker && job.tasks[worker.current_object_key];
        if (task?.object_key === payload.object_key && task.status === "parsing") {
          task.status = "waiting_dom";
          worker.status = "waiting_dom";
          worker.last_error = String(error?.message || error);
          await saveJob(job);
        }
      });
    }
  }

  function matchingAssignment(job, assignment) {
    if (job.run_id !== assignment.run_id) return null;
    const task = job.tasks[assignment.object_key];
    return task && ACTIVE_TASK_STATES.has(task.status) && task.assigned_worker === assignment.worker_id &&
      task.attempts === assignment.attempt && task.assigned_at === assignment.assigned_at ? task : null;
  }

  async function finishSuccess(assignment, result) {
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
      await storageSetMany(storagePatch);
      task.status = "success";
      task.completed_at = nowIso();
      task.error = "";
      const worker = job.workers.find((item) => item.worker_id === task.assigned_worker);
      if (worker) {
        worker.status = "idle";
        worker.current_object_key = "";
        worker.processed = Number(worker.processed || 0) + 1;
      }
      task.assigned_worker = "";
      await saveJob(job);
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

  async function finishWithError(assignment, errorText, partial) {
    await serial(async () => {
      const [job, results] = await Promise.all([loadJob(), loadResults()]);
      const { object_key: objectKey } = assignment;
      const task = matchingAssignment(job, assignment);
      if (!task) return;
      const worker = job.workers.find((item) => item.worker_id === task.assigned_worker);
      task.error = String(errorText || "\u041d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u0430\u044f \u043e\u0448\u0438\u0431\u043a\u0430");
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
        worker.status = "idle";
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
      task.error = "CAPTCHA";
      task.completed_at = nowIso();
      results[objectKey] = failedResult(results[objectKey], task, "captcha", url || task.url);
      await storageSet(RESULTS_KEY, results);
      const worker = job.workers.find((item) => item.worker_id === task.assigned_worker);
      if (worker) worker.status = "captcha";
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
      task.error = error;
      task.completed_at = nowIso();
      results[objectKey] = failedResult(results[objectKey], task, "rate_limited", url || task.url);
      await storageSet(RESULTS_KEY, results);
      const worker = job.workers.find((item) => item.worker_id === task.assigned_worker);
      if (worker) worker.status = "rate_limited";
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

  async function resumeJob() {
    const result = await serial(async () => {
      const job = await loadJob();
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
          worker.status = "idle";
          worker.current_object_key = "";
        }
      }
      job.status = "running";
      job.completed_at = "";
      await saveJob(job);
      return { ok: true };
    });
    await ensureWatchdog(true);
    await pump();
    return result;
  }

  async function stopJob() {
    const tabIds = await serial(async () => {
      const job = await loadJob();
      for (const worker of job.workers) requeueWorkerTask(job, worker, "\u041e\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u043e \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u0435\u043c", true);
      job.status = "stopped";
      await saveJob(job);
      return job.workers.map((worker) => worker.tab_id).filter(Number.isInteger);
    });
    if (tabIds.length) {
      try { await api.tabs.remove(tabIds); } catch {}
    }
    await ensureWatchdog(false);
    return { ok: true };
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

  async function retryErrors() {
    await serial(async () => {
      const job = await loadJob();
      let changed = 0;
      for (const task of Object.values(job.tasks)) {
        if (["error", "captcha", "rate_limited"].includes(task.status)) {
          task.status = "queued";
          task.attempts = 0;
          task.error = "";
          task.completed_at = "";
          task.next_attempt_at = 0;
          changed += 1;
        }
      }
      if (!changed) throw new Error("\u041d\u0435\u0442 \u043e\u0448\u0438\u0431\u043e\u043a \u0434\u043b\u044f \u043f\u043e\u0432\u0442\u043e\u0440\u0430");
      job.status = "running";
      job.completed_at = "";
      await saveJob(job);
    });
    await ensureWatchdog(true);
    await pump();
    return { ok: true };
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

  async function openWorker(workerId) {
    const job = await loadJob();
    const worker = job.workers.find((item) => item.worker_id === workerId) || job.workers.find((item) => ["captcha", "rate_limited"].includes(item.status));
    if (!worker?.tab_id) throw new Error("\u0420\u0430\u0431\u043e\u0447\u0430\u044f \u0432\u043a\u043b\u0430\u0434\u043a\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430");
    await api.tabs.update(worker.tab_id, { active: true });
    return { ok: true };
  }

  async function handleMessage(message, sender) {
    switch (message?.type) {
      case "ENRICHMENT_GET_STATE": return { ok: true, ...(await getState()) };
      case "ENRICHMENT_GET_RESULTS": {
        const results = await loadResults();
        return { ok: true, results: Object.fromEntries(Object.entries(results)
          .filter(([key]) => key.startsWith("xlsx:") === (message.imported === true))) };
      }
      case "ENRICHMENT_START": return startJob(message.options || {});
      case "ENRICHMENT_PAUSE": return pauseJob();
      case "ENRICHMENT_RESUME": return resumeJob();
      case "ENRICHMENT_STOP": return stopJob();
      case "ENRICHMENT_FORCE_RESET": return forceResetEnrichment(message.importOnly === true);
      case "ENRICHMENT_RETRY_ERRORS": return retryErrors();
      case "OPEN_ENRICHMENT": {
        let sourceTab = sender?.tab || null;
        if (!sourceTab?.id && Number.isInteger(message.source_tab_id)) {
          try { sourceTab = await api.tabs.get(message.source_tab_id); } catch { sourceTab = null; }
        }
        return openDashboard(sourceTab);
      }
      case "ENRICHMENT_OPEN_WORKER": return openWorker(message.worker_id);
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

  api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "complete") return;
    markWaiting(tabId).then(() => dispatchForTab(tabId)).catch(() => {});
  });

  api.tabs.onRemoved.addListener((tabId) => {
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
