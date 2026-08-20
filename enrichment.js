(function initEnrichmentDashboard() {
  "use strict";

  const api = globalThis.browser || globalThis.chrome;
  const SESSION_KEY = "maps_export_session_v2";
  const JOB_KEY = "maps_export_enrichment_job_v1";
  const RESULTS_KEY = "maps_export_enrichment_results_v1";
  const $ = (id) => document.getElementById(id);
  let lastState = null;
  let refreshTimer = null;

  const STATUS_LABELS = {
    idle: "\u043d\u0435 \u0437\u0430\u043f\u0443\u0449\u0435\u043d",
    running: "\u0432\u044b\u043f\u043e\u043b\u043d\u044f\u0435\u0442\u0441\u044f",
    paused: "\u043f\u0430\u0443\u0437\u0430",
    stopped: "\u043e\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d",
    completed: "\u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d",
    blocked: "\u043d\u0443\u0436\u043d\u043e \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435",
    queued: "\u043e\u0436\u0438\u0434\u0430\u0435\u0442",
    navigating: "\u043e\u0442\u043a\u0440\u044bвается",
    waiting_dom: "\u0437\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u0442\u0441\u044f",
    parsing: "\u043f\u0430\u0440\u0441\u0438\u0442\u0441\u044f",
    success: "\u0433\u043e\u0442\u043e\u0432\u043e",
    error: "\u043e\u0448\u0438\u0431\u043a\u0430",
    captcha: "CAPTCHA",
    rate_limited: "\u043b\u0438\u043c\u0438\u0442 \u042f\u043d\u0434\u0435\u043a\u0441\u0430",
    cancelled: "\u043e\u0442\u043c\u0435\u043d\u0435\u043d\u043e"
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[char]);
  }

  async function send(type, extra = {}) {
    const response = await api.runtime.sendMessage({ type, ...extra });
    if (!response?.ok) throw new Error(response?.error || "\u041e\u043f\u0435\u0440\u0430\u0446\u0438\u044f \u043d\u0435 \u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043dа");
    return response;
  }

  function setStatus(text, isError = false) {
    $("statusText").textContent = text || "";
    $("statusText").style.color = isError ? "var(--danger)" : "";
  }

  function formatDuration(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0) return "\u2014";
    if (minutes < 1) return "<1 \u043c\u0438\u043d";
    if (minutes < 60) return `${Math.ceil(minutes)} \u043c\u0438\u043d`;
    const hours = Math.floor(minutes / 60);
    const rest = Math.ceil(minutes % 60);
    return `${hours} \u0447 ${rest} \u043c\u0438\u043d`;
  }

  function renderWorkers(job) {
    const root = $("workersList");
    if (!job.workers?.length) {
      root.className = "workers empty";
      root.textContent = "\u041d\u0435\u0442 \u0437\u0430\u043f\u0443\u0449\u0435\u043d\u043d\u044b\u0445 \u0432\u043a\u043b\u0430\u0434\u043e\u043a";
      return;
    }
    root.className = "workers";
    root.innerHTML = job.workers.map((worker) => {
      const task = job.tasks?.[worker.current_object_key];
      const workerState = worker.status === "idle" && Number(worker.processed || 0) > 0
        ? "готово"
        : (STATUS_LABELS[worker.status] || worker.status);
      return `<article class="worker">
        <div class="worker-head"><strong>${escapeHtml(worker.worker_id)}</strong><span class="worker-state">${escapeHtml(workerState)}</span></div>
        <div class="worker-title">${escapeHtml(task?.title || (worker.status === "idle" ? "\u041e\u0436\u0438\u0434\u0430ет задачу" : ""))}</div>
        <small>\u0413\u043e\u0442\u043e\u0432\u043e: ${Number(worker.processed || 0)}${worker.tab_id ? ` \u00b7 tab ${worker.tab_id}` : ""}</small>
      </article>`;
    }).join("");
  }

  function renderTasks(job) {
    const root = $("tasksBody");
    const order = { parsing: 0, waiting_dom: 1, navigating: 2, captcha: 3, rate_limited: 3, error: 4, queued: 5, success: 6, cancelled: 7 };
    const tasks = Object.values(job.tasks || {})
      .sort((a, b) => (order[a.status] ?? 99) - (order[b.status] ?? 99) || String(b.completed_at || b.assigned_at).localeCompare(String(a.completed_at || a.assigned_at)))
      .slice(0, 200);
    if (!tasks.length) {
      root.innerHTML = '<tr><td colspan="5" class="empty-row">\u041e\u0447\u0435\u0440\u0435\u0434\u044c \u0435\u0449\u0451 \u043d\u0435 \u0441\u043e\u0437\u0434\u0430\u043d\u0430</td></tr>';
      return;
    }
    root.innerHTML = tasks.map((task) => `<tr>
      <td><span class="task-status ${escapeHtml(task.status)}">${escapeHtml(STATUS_LABELS[task.status] || task.status)}</span></td>
      <td>${escapeHtml(task.title || "\u2014")}</td>
      <td>${escapeHtml(task.org_id || "\u2014")}</td>
      <td>${Number(task.attempts || 0)}</td>
      <td class="task-error">${escapeHtml(task.error || "")}</td>
    </tr>`).join("");
  }

  function render(state) {
    lastState = state;
    const job = state.job;
    const totals = job.totals || {};
    const done = Number(totals.success || 0) + Number(totals.error || 0) + Number(totals.captcha || 0) + Number(totals.rate_limited || 0) + Number(totals.cancelled || 0);
    const total = Number(totals.total || 0);
    const percent = total ? Math.min(100, Math.round(done * 100 / total)) : 0;
    const elapsedMinutes = job.started_at ? Math.max((Date.now() - Date.parse(job.started_at)) / 60000, 1 / 60) : 0;
    const speed = done && elapsedMinutes ? done / elapsedMinutes : 0;
    const eta = speed ? (total - done) / speed : NaN;

    document.body.dataset.jobStatus = job.status || "idle";
    $("statusBackdropText").textContent = STATUS_LABELS[job.status] || job.status || "ожидание";
    $("jobBadge").textContent = STATUS_LABELS[job.status] || job.status;
    $("jobBadge").className = `badge ${job.status}`;
    $("statTotal").textContent = String(total);
    $("statSuccess").textContent = String(totals.success || 0);
    $("statActive").textContent = String(totals.active || 0);
    $("statError").textContent = String((totals.error || 0) + (totals.captcha || 0) + (totals.rate_limited || 0));
    $("statSpeed").textContent = speed ? speed.toFixed(speed < 10 ? 1 : 0) : "\u2014";
    $("statEta").textContent = formatDuration(eta);
    $("progressBar").style.width = `${percent}%`;
    $("progressPercent").textContent = `${percent}%`;
    $("progressText").textContent = total ? `\u041e\u0431\u0440\u0430\u0431\u043e\u0442\u0430\u043d\u043e ${done} \u0438з ${total}` : "\u0413\u043e\u0442\u043e\u0432\u043e \u043a \u0437\u0430\u043f\u0443\u0441\u043a\u0443";
    $("baseCount").textContent = `${state.base_count || 0} \u043e\u0431\u044a\u0435\u043a\u0442\u043e\u0432 \u0432 \u0431\u0430\u0437\u043e\u0432\u043e\u043c \u0441\u0431\u043e\u0440\u0435 \u00b7 ${state.result_count || 0} \u0441 \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442\u043e\u043c`;

    $("btnStart").disabled = ["running", "paused"].includes(job.status);
    $("btnPause").disabled = job.status !== "running";
    $("btnResume").disabled = !["paused", "blocked", "stopped"].includes(job.status);
    $("btnStop").disabled = !["running", "paused", "blocked"].includes(job.status);
    $("btnRetry").disabled = !(totals.error || totals.captcha || totals.rate_limited);
    $("btnExport").disabled = !state.base_count;

    const blockedWorker = job.workers?.find((worker) => ["captcha", "rate_limited"].includes(worker.status));
    $("alert").classList.toggle("hidden", job.status !== "blocked");
    const isRateLimited = blockedWorker?.status === "rate_limited";
    $("alertTitle").textContent = isRateLimited ? "\u041b\u0438\u043c\u0438\u0442 \u042f\u043d\u0434\u0435\u043a\u0441\u0430" : "CAPTCHA";
    $("alertText").textContent = job.status === "blocked" ? "\u042f\u043dдекс запросил проверку. Очередь остановлена, данные сохранены." : "";
    if (job.status === "blocked" && isRateLimited) {
      $("alertText").textContent = "\u042f\u043d\u0434\u0435\u043a\u0441 \u0432\u0440\u0435\u043c\u0435\u043d\u043d\u043e \u043e\u0433\u0440\u0430\u043d\u0438\u0447\u0438\u043b \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0443 \u0441\u0442\u0440\u0430\u043d\u0438\u0446. \u041f\u0440\u043e\u0433\u0440\u0435\u0441\u0441 \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d; \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0438\u0442\u0435 \u043f\u043e\u0437\u0436\u0435 \u0438\u043b\u0438 \u0441 \u043c\u0435\u043d\u044c\u0448\u0438\u043c \u0447\u0438\u0441\u043b\u043e\u043c \u0432\u043a\u043b\u0430\u0434\u043e\u043a.";
    }
    $("btnOpenWorker").dataset.workerId = blockedWorker?.worker_id || "";
    renderWorkers(job);
    renderTasks(job);
  }

  async function refresh() {
    try {
      const response = await send("ENRICHMENT_GET_STATE");
      render(response);
    } catch (error) {
      setStatus(String(error?.message || error), true);
    }
  }

  async function runAction(type, extra, successText) {
    try {
      setStatus("\u0412\u044bпол\u043dяю\u2026");
      await send(type, extra);
      setStatus(successText || "\u0413\u043e\u0442\u043eво");
      await refresh();
    } catch (error) {
      setStatus(String(error?.message || error), true);
    }
  }

  function sheetFromRows(columns, rows) {
    const aoa = [columns];
    for (const row of rows) {
      aoa.push(columns.map((column) => {
        const value = row[column];
        if (Array.isArray(value)) return value.join(" | ");
        if (value && typeof value === "object") return JSON.stringify(value);
        return value == null ? "" : value;
      }));
    }
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet["!cols"] = columns.map((column) => ({ wch: Math.min(Math.max(column.length + 3, 12), 55) }));
    return sheet;
  }

  function safeFilePart(value) {
    return String(value || "session").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 80);
  }

  function publicUrl(value) {
    try {
      const url = new URL(value);
      if (/\/maps\/org\//i.test(url.pathname)) return `${url.origin}${url.pathname}`;
      return url.toString();
    } catch {
      return String(value || "");
    }
  }

  function yesNo(value) {
    if (value === true) return "да";
    if (value === false) return "нет";
    return "";
  }

  function readableAttributes(attributes) {
    return Object.entries(attributes || {})
      .filter(([key, value]) => key && value != null && value !== "")
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join(" | ");
  }

  async function exportWorkbook() {
    try {
      setStatus("\u0421обираю XLSX\u2026");
      const [storage, response] = await Promise.all([
        api.storage.local.get(SESSION_KEY),
        send("ENRICHMENT_GET_RESULTS")
      ]);
      const session = storage?.[SESSION_KEY] || {};
      const results = response.results || {};
      const objects = Object.entries(session.objects || {}).map(([objectKey, base]) => {
        const detail = results[objectKey] || {};
        const fields = detail.category_data?.fields || {};
        return {
          "ID Яндекс": detail.org_id || base.org_id || "",
          "Название": detail.title || base.title || "",
          "Категории": detail.categories?.length ? detail.categories : base.categories_all || "",
          "Адрес": detail.address || base.address || "",
          "Телефоны": detail.phones || [],
          "Сайты": detail.websites || [],
          "Рейтинг": detail.rating || base.rating || "",
          "Количество отзывов": detail.reviews || base.reviews || "",
          "Количество фотографий": base.photos_count || "",
          "Широта": base.lat || "",
          "Долгота": base.lon || "",
          "URL": publicUrl(detail.url || base.url),
          "График работы": detail.opening_hours || [],
          "Статус работы": detail.working_status || "",
          "Время закрытия": detail.close_time || "",
          "Описание": detail.description || "",
          "Социальные сети": detail.social_links || [],
          "Средний счёт": fields.average_bill || "",
          "Ценовой уровень": fields.price_level || "",
          "Кухня": fields.cuisine || [],
          "Тип заведения": fields.venue_types || [],
          "Количество звёзд": fields.star_rating || "",
          "Тип гостиницы": fields.hotel_type || "",
          "Количество номеров": fields.room_count || "",
          "Типы номеров": fields.room_types || [],
          "Цена номера": fields.room_price || "",
          "Время заезда": fields.checkin_time || "",
          "Год постройки": fields.construction_year || "",
          "Время выезда": fields.checkout_time || "",
          "Парковка — характеристики": fields.parking_features || [],
          "Парковка — платная": yesNo(fields.paid),
          "Парковка — охраняемая": yesNo(fields.guarded),
          "Парковка — открытая": yesNo(fields.open_air),
          "Парковка — уличная": yesNo(fields.street),
          "Все особенности": readableAttributes(detail.category_data?.raw_attributes),
          "Статус досбора": STATUS_LABELS[detail.status] || detail.status || "не обработано",
          "Ошибка досбора": detail.error || ""
        };
      });

      if (!objects.length) throw new Error("\u0412 \u0431\u0430зовой \u0441\u0435\u0441\u0441\u0438\u0438 \u043d\u0435т \u043e\u0431\u044a\u0435\u043a\u0442\u043eв");
      const columns = [
        "ID Яндекс", "Название", "Категории", "Адрес", "Телефоны", "Сайты", "Рейтинг", "Количество отзывов",
        "Количество фотографий", "Широта", "Долгота", "URL", "График работы", "Статус работы", "Время закрытия",
        "Описание", "Социальные сети", "Средний счёт", "Ценовой уровень", "Кухня", "Тип заведения",
        "Количество звёзд", "Тип гостиницы", "Количество номеров", "Типы номеров", "Цена номера", "Время заезда",
        "Год постройки", "Время выезда", "Парковка — характеристики", "Парковка — платная", "Парковка — охраняемая",
        "Парковка — открытая", "Парковка — уличная", "Все особенности", "Статус досбора", "Ошибка досбора"
      ];

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheetFromRows(columns, objects), "Организации");

      const date = new Date();
      const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "_");
      const lastSnapshot = session.snapshots?.[session.snapshots.length - 1];
      const filename = `maps_enriched_${safeFilePart(lastSnapshot?.query)}_${stamp}.xlsx`;
      if (typeof XLSX.writeFileXLSX === "function") XLSX.writeFileXLSX(workbook, filename, { compression: true });
      else XLSX.writeFile(workbook, filename, { bookType: "xlsx", compression: true });
      setStatus(`\u0421качан ${filename}`);
    } catch (error) {
      setStatus(String(error?.message || error), true);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("btnStart").addEventListener("click", () => runAction("ENRICHMENT_START", {
      options: {
        scope: $("scope").value,
        workers: Number($("workers").value),
        max_attempts: Number($("maxAttempts").value),
        timeout_ms: Number($("timeout").value) * 1000,
        delay_ms: 1200
      }
    }, "\u0414осбор \u0437а\u043fущен"));
    $("btnPause").addEventListener("click", () => runAction("ENRICHMENT_PAUSE", {}, "\u041eче\u0440е\u0434\u044c \u043d\u0430 \u043f\u0430\u0443\u0437е"));
    $("btnResume").addEventListener("click", () => runAction("ENRICHMENT_RESUME", {}, "\u041e\u0447\u0435\u0440е\u0434\u044c \u043f\u0440од\u043e\u043b\u0436\u0435на"));
    $("btnRetry").addEventListener("click", () => runAction("ENRICHMENT_RETRY_ERRORS", {}, "\u041e\u0448\u0438\u0431\u043a\u0438 \u0432е\u0440\u043dу\u0442ы \u0432 \u043e\u0447\u0435р\u0435\u0434ь"));
    $("btnStop").addEventListener("click", () => {
      if (confirm("\u041e\u0441\u0442\u0430\u043d\u043e\u0432ить досбор и закрыть рабочие вкладки?")) runAction("ENRICHMENT_STOP", {}, "\u0414\u043e\u0441б\u043e\u0440 \u043eстановлен");
    });
    $("btnOpenWorker").addEventListener("click", () => runAction("ENRICHMENT_OPEN_WORKER", { worker_id: $("btnOpenWorker").dataset.workerId }, "\u0412\u043a\u043b\u0430дк\u0430 \u043eткрыта"));
    $("btnExport").addEventListener("click", exportWorkbook);
    api.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes[JOB_KEY] || changes[RESULTS_KEY] || changes[SESSION_KEY])) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, 100);
      }
    });
    refresh();
    setInterval(refresh, 3000);
  });
})();
