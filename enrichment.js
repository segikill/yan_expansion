(function initEnrichmentDashboard() {
  "use strict";

  const api = globalThis.browser || globalThis.chrome;
  const IMPORT_KEY = "maps_export_enrichment_xlsx_v1";
  const SESSION_KEY = "maps_export_session_v2";
  const JOB_KEY = "maps_export_enrichment_job_v1";
  const RESULTS_KEY = "maps_export_enrichment_results_v1";
  const THEME_KEY = "maps_export_ui_theme_v1";
  const LEGACY_THEME_KEY = "maps_export_enrichment_theme_v1";
  const THEME_IDS = new Set([
    "theme-dark", "theme-gis", "theme-mission", "theme-bloomberg", "theme-linear",
    "theme-blueprint", "theme-scada", "theme-neon", "theme-light"
  ]);
  const $ = (id) => document.getElementById(id);
  let lastState = null;
  let refreshTimer = null;
  let inputWorkbook = null;

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
    partial: "частично",
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
    $("statusText").style.color = isError ? "var(--red)" : "";
  }

  function initThemePreferences() {
    let savedTheme = "theme-dark";
    try {
      const stored = localStorage.getItem(THEME_KEY) || localStorage.getItem(LEGACY_THEME_KEY);
      if (THEME_IDS.has(stored)) savedTheme = stored;
    } catch {}

    const savedRadio = $(savedTheme);
    if (savedRadio) savedRadio.checked = true;
    const drawerToggle = $("themeDrawerToggle");
    const drawer = document.querySelector(".theme-drawer");
    const toggle = document.querySelector(".theme-toggle");

    const syncThemeAccessibility = () => {
      for (const themeId of THEME_IDS) {
        const option = document.querySelector(`.theme-option[for="${themeId}"]`);
        option?.setAttribute("aria-checked", String($(themeId)?.checked === true));
      }
    };
    const applyTheme = (themeId) => {
      if (!THEME_IDS.has(themeId)) return;
      const radio = $(themeId);
      if (radio) radio.checked = true;
      syncThemeAccessibility();
    };
    const syncDrawerAccessibility = () => {
      const open = drawerToggle?.checked === true;
      toggle?.setAttribute("aria-expanded", String(open));
      drawer?.setAttribute("aria-hidden", String(!open));
    };
    const activateFromKeyboard = (element) => {
      element?.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        element.click();
      });
    };

    activateFromKeyboard(toggle);
    activateFromKeyboard(document.querySelector(".theme-close"));
    for (const themeId of THEME_IDS) {
      const radio = $(themeId);
      const option = document.querySelector(`.theme-option[for="${themeId}"]`);
      activateFromKeyboard(option);
      radio?.addEventListener("change", () => {
        if (!radio.checked) return;
        try { localStorage.setItem(THEME_KEY, themeId); } catch {}
        api.storage.local.set({ [THEME_KEY]: themeId }).catch(() => {});
        if (drawerToggle) drawerToggle.checked = false;
        syncThemeAccessibility();
        syncDrawerAccessibility();
        toggle?.focus();
      });
    }
    drawerToggle?.addEventListener("change", () => {
      syncDrawerAccessibility();
      if (drawerToggle.checked) {
        const selectedId = Array.from(THEME_IDS).find((themeId) => $(themeId)?.checked) || "theme-dark";
        const selected = document.querySelector(`.theme-option[for="${selectedId}"]`);
        setTimeout(() => selected?.focus(), 0);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !drawerToggle?.checked) return;
      drawerToggle.checked = false;
      syncDrawerAccessibility();
      toggle?.focus();
    });
    syncThemeAccessibility();
    syncDrawerAccessibility();
    api.storage.local.get(THEME_KEY).then((stored) => {
      const shared = stored?.[THEME_KEY];
      if (THEME_IDS.has(shared)) applyTheme(shared);
      else {
        const selected = Array.from(THEME_IDS).find((themeId) => $(themeId)?.checked) || savedTheme;
        api.storage.local.set({ [THEME_KEY]: selected }).catch(() => {});
      }
    }).catch(() => {});
    return applyTheme;
  }

  function selectedSource() {
    return $("detailSource").value;
  }

  function formatDuration(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0) return "\u2014";
    if (minutes < 1) return "<1 \u043c\u0438\u043d";
    if (minutes < 60) return `${Math.ceil(minutes)} \u043c\u0438\u043d`;
    const hours = Math.floor(minutes / 60);
    const rest = Math.ceil(minutes % 60);
    return `${hours} \u0447 ${rest} \u043c\u0438\u043d`;
  }

  function workerStageTime(startedAt) {
    if (!startedAt) return "—";
    const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (elapsed < 60) return `${elapsed} с`;
    return `${Math.floor(elapsed / 60)} мин ${elapsed % 60} с`;
  }

  function browserTabState(tab) {
    if (tab.discarded) return "Выгружена браузером";
    if (tab.frozen) return "Заморожена браузером";
    if (typeof tab.frozen !== "boolean") return "Заморозка: нет сведений";
    return tab.active ? "Активна · не заморожена" : "В фоне · не заморожена";
  }

  let checkingWorkerTabs = false;
  let arrangingWorkerWindows = false;
  async function updateWorkerDiagnostics() {
    for (const element of $("workersList").querySelectorAll("[data-stage-started]")) {
      element.textContent = workerStageTime(Number(element.dataset.stageStarted));
    }
    if (checkingWorkerTabs) return;
    checkingWorkerTabs = true;
    try {
      await Promise.all(Array.from($("workersList").querySelectorAll("[data-worker-tab]"), async (element) => {
        try {
          const tab = await api.tabs.get(Number(element.dataset.workerTab));
          element.textContent = browserTabState(tab);
          element.dataset.suspended = String(Boolean(tab.discarded || tab.frozen));
        } catch {
          element.textContent = "Вкладка закрыта или недоступна";
          element.dataset.suspended = "false";
        }
      }));
    } finally {
      checkingWorkerTabs = false;
    }
  }

  function renderWorkers(job) {
    const root = $("workersList");
    $("btnArrangeWorkers").disabled = arrangingWorkerWindows || !job.workers?.some((worker) => Number.isInteger(worker.tab_id));
    if (!job.workers?.length) {
      root.className = "workers empty";
      root.textContent = "\u041d\u0435\u0442 \u0437\u0430\u043f\u0443\u0449\u0435\u043d\u043d\u044b\u0445 \u0432\u043a\u043b\u0430\u0434\u043e\u043a";
      return;
    }
    const focusedWorker = root.contains(document.activeElement) ? document.activeElement.dataset.openWorker : "";
    root.className = "workers";
    root.innerHTML = job.workers.map((worker) => {
      const task = job.tasks?.[worker.current_object_key];
      const workerState = worker.status === "idle" && Number(worker.processed || 0) > 0
        ? "готово"
        : (STATUS_LABELS[worker.status] || worker.status);
      const startedAt = Number(worker.stage_started_at) || Date.parse(task?.assigned_at || "") || 0;
      const tabId = Number.isInteger(worker.tab_id) ? worker.tab_id : null;
      return `<article class="worker">
        <div class="worker-head"><strong>${escapeHtml(worker.worker_id)}</strong><span class="worker-state">${escapeHtml(workerState)}</span></div>
        <div class="worker-title">${escapeHtml(task?.title || (task?.org_id ? `Карточка ${task.org_id}` : "") || (worker.status === "idle" ? "\u041e\u0436\u0438\u0434\u0430ет задачу" : ""))}</div>
        <div class="worker-diagnostics">
          <small>На этапе <span data-stage-started="${startedAt}">${workerStageTime(startedAt)}</span></small>
          <small ${tabId == null ? "" : `data-worker-tab="${tabId}"`}>${tabId == null ? "Вкладка не открыта" : "Проверяю состояние…"}</small>
        </div>
        <button type="button" class="button secondary worker-open"
          data-open-worker="${escapeHtml(worker.worker_id)}" data-object-key="${escapeHtml(task?.object_key || "")}"
          ${!task || tabId == null ? "disabled" : ""}>Открыть карточку</button>
        <small>\u0413\u043e\u0442\u043e\u0432\u043e: ${Number(worker.processed || 0)}${worker.tab_id ? ` \u00b7 tab ${worker.tab_id}` : ""}</small>
      </article>`;
    }).join("");
    if (focusedWorker) {
      const button = Array.from(root.querySelectorAll("[data-open-worker]")).find((item) => item.dataset.openWorker === focusedWorker && !item.disabled);
      (button || $("workersModal").querySelector("form button")).focus();
    }
    void updateWorkerDiagnostics();
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
    const jobLocked = ["running", "paused", "blocked"].includes(job.status);
    if (jobLocked && ["yandex", "2gis", "xlsx"].includes(job.source)) $("detailSource").value = job.source;
    const source = jobLocked ? job.source : selectedSource();
    const fromFile = source === "xlsx";
    const savedFile = fromFile && job.source === "xlsx";
    const input = fromFile ? selectedWorkbookColumn() : null;
    const sourceBaseCount = fromFile ? input?.links.length || 0 : Number(state.base_counts?.[source] ?? state.base_count ?? 0);
    $("xlsxSetup").classList.toggle("hidden", !fromFile);
    if (fromFile) $("xlsxInfo").textContent = input
      ? `Строк со ссылками: ${input.links.length} из ${input.rowCount}. Повторяющиеся карточки обрабатываются один раз.`
      : "Выберите файл. Первая строка листа используется как заголовок.";
    const totals = job.totals || {};
    const done = Number(totals.success || 0) + Number(totals.error || 0) + Number(totals.captcha || 0) + Number(totals.rate_limited || 0) + Number(totals.cancelled || 0);
    const total = Number(totals.total || 0);
    const percent = total ? Math.min(100, Math.round(done * 100 / total)) : 0;
    const elapsedMinutes = job.started_at ? Math.max((Date.now() - Date.parse(job.started_at)) / 60000, 1 / 60) : 0;
    const speed = done && elapsedMinutes ? done / elapsedMinutes : 0;
    const eta = speed ? (total - done) / speed : NaN;

    document.body.dataset.jobStatus = job.status || "idle";
    $("statusBackdropText").textContent = STATUS_LABELS[job.status] || job.status || "ожидание";
    $("jobBadgeText").textContent = STATUS_LABELS[job.status] || job.status;
    $("jobBadge").className = `job-badge ${job.status}`;
    $("statTotal").textContent = String(total);
    $("statSuccess").textContent = String(totals.success || 0);
    $("statSaved").textContent = String(state.saved_counts?.[source] || 0);
    $("statSavedScope").textContent = `с деталями из ${fromFile ? (savedFile ? total : 0) : sourceBaseCount}`;
    $("statActive").textContent = String(totals.active || 0);
    $("statError").textContent = String((totals.error || 0) + (totals.captcha || 0) + (totals.rate_limited || 0));
    $("statSpeed").textContent = speed ? speed.toFixed(speed < 10 ? 1 : 0) : "\u2014";
    $("statEta").textContent = formatDuration(eta);
    $("progressBar").style.width = `${percent}%`;
    $("progressPercent").textContent = `${percent}%`;
    $("progressTrack").setAttribute("aria-valuenow", String(percent));
    $("progressTrack").setAttribute("aria-valuetext", total ? `${done} из ${total}` : "Очередь не создана");
    $("progressText").textContent = total ? `\u041e\u0431\u0440\u0430\u0431\u043e\u0442\u0430\u043d\u043e ${done} \u0438з ${total}` : "\u0413\u043e\u0442\u043e\u0432\u043e \u043a \u0437\u0430\u043f\u0443\u0441\u043a\u0443";
    $("baseCount").textContent = fromFile ? `${sourceBaseCount} строк со ссылками · ${job.source === "xlsx" ? state.result_count : 0} результатов` : `${sourceBaseCount} объектов ${source === "2gis" ? "2ГИС" : "Яндекса"} в базовом сборе · ${state.result_count || 0} результатов всего`;
    $("sourceModeHint").textContent = fromFile ? "Поддерживаются ссылки на карточки Яндекса и 2ГИС." : source === "2gis"
      ? "Отдельная очередь откроет /tab/info в 1–8 неактивных вкладках и прочитает структурированный объект карточки."
      : "Карточки Яндекса откроются в фоновых вкладках: обзор и вкладка «Особенности».";
    if (sourceBaseCount && $("statusText").textContent.startsWith("\u0421\u043d\u0430\u0447\u0430\u043b\u0430")) {
      setStatus("\u0411\u0430\u0437\u043e\u0432\u044b\u0435 URL \u0433\u043e\u0442\u043e\u0432\u044b. \u0412\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u043f\u0430\u0440\u0430\u043c\u0435\u0442\u0440\u044b \u0438 \u0437\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u0435 \u0434\u043e\u0441\u0431\u043e\u0440.");
    }

    $("startLabel").textContent = savedFile ? "Начать заново" : "Запустить";
    $("btnStart").disabled = (!sourceBaseCount && !(savedFile && !inputWorkbook)) || jobLocked;
    $("btnStart").title = savedFile && !inputWorkbook ? "Заново обработать сохранённый XLSX" : !sourceBaseCount && fromFile ? "Выберите лист и столбец со ссылками" : !sourceBaseCount ? `Сначала зафиксируйте карточки ${source === "2gis" ? "2ГИС" : "Яндекса"} на карте` : "Запустить новую очередь досбора";
    for (const id of ["detailSource", "workers", "maxAttempts", "timeout", "xlsxFile"]) $(id).disabled = jobLocked;
    $("scope").disabled = jobLocked || fromFile;
    $("xlsxSheet").disabled = jobLocked || !inputWorkbook;
    $("xlsxColumn").disabled = jobLocked || !$("xlsxColumn").options.length;
    $("btnPause").disabled = job.status !== "running";
    $("btnResume").textContent = job.source === "xlsx" ? "Продолжить досбор" : "Продолжить";
    $("btnResume").disabled = !["paused", "blocked", "stopped"].includes(job.status);
    $("btnStop").disabled = !["running", "paused", "blocked"].includes(job.status);
    $("btnForceReset").disabled = job.status === "idle" && !total && !state.result_count;
    $("btnRetry").disabled = !(totals.error || totals.captcha || totals.rate_limited);
    $("btnExport").disabled = fromFile ? job.source !== "xlsx" || !total : !state.base_count;

    const blockedWorker = job.workers?.find((worker) => ["captcha", "rate_limited"].includes(worker.status));
    $("alert").classList.toggle("hidden", job.status !== "blocked");
    const isRateLimited = blockedWorker?.status === "rate_limited";
    const provider = job.tasks?.[blockedWorker?.current_object_key]?.source === "2gis" || job.source === "2gis" ? "2ГИС" : "Яндекс";
    $("alertTitle").textContent = isRateLimited ? `Лимит ${provider}` : "CAPTCHA";
    $("alertText").textContent = job.status === "blocked" ? `${provider} запросил проверку. Очередь остановлена, данные сохранены.` : "";
    if (job.status === "blocked" && isRateLimited) {
      $("alertText").textContent = `${provider} временно ограничил загрузку страниц. Прогресс сохранён; продолжите позже или с меньшим числом вкладок.`;
    }
    $("btnOpenWorker").dataset.workerId = blockedWorker?.worker_id || "";
    renderWorkers(job);
    renderTasks(job);
  }

  async function refresh() {
    try {
      const response = await send("ENRICHMENT_GET_STATE");
      if (!lastState && response.job.source === "xlsx") $("detailSource").value = "xlsx";
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

  function categoryList(value) {
    const raw = Array.isArray(value) ? value : String(value || "").split(/\s*\|\s*/);
    const seen = new Set();
    const technical = new Set([
      "organization", "localbusiness", "hotel", "lodgingbusiness", "restaurant", "store", "medicalbusiness", "карты"
    ]);
    return raw.map((item) => String(item || "").replace(/\s+/g, " ").trim()).filter((item) => {
      const key = item.toLocaleLowerCase("ru");
      if (!key || technical.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function exportCategories(base, detail) {
    const baseCategories = categoryList(base?.categories_all);
    const detailCategories = categoryList(detail?.categories_all || detail?.categories);
    if (detail?.category_first && detailCategories.length) return detailCategories;
    if (baseCategories.length) return baseCategories;
    return detailCategories.slice(0, 1);
  }

  function hotelAmenities(base, detail) {
    const data = detail.category_data;
    if (data?.fields?.amenities?.length) return data.fields.amenities;
    if ((detail.source || base.source) !== "yandex") return [];
    const categories = exportCategories(base, detail).join(" ");
    if (data?.adapter_id !== "hotel" && !/отел|гостиниц|гостев(?:ой|ые) дом|хостел|мотел|hotel/i.test(categories)) return [];

    const amenityName = /wi[- ]?fi|интернет|парков|кондиционер|бассейн|саун|баня|завтрак|питан|трансфер|прачечн|лифт|спа|spa|фитнес|тренажёр|кухня|пляж|детская площадка|с животными|уборка|холодильник|терраса|мангальн/i;
    const amenities = Object.entries(data?.raw_attributes || {})
      .filter(([key, value]) => amenityName.test(key) && String(value ?? "").trim())
      .map(([key, value]) => /^да$/i.test(String(value).trim()) ? key : `${key}: ${value}`);
    return Array.from(new Set(amenities));
  }

  function selectedWorkbookColumn() {
    if (!$("xlsxColumn").value) return null;
    return workbookColumn(inputWorkbook?.book, $("xlsxSheet").value, Number($("xlsxColumn").value));
  }

  function workbookColumn(book, sheet, column) {
    const worksheet = book?.Sheets[sheet];
    if (!worksheet?.["!ref"]) return null;
    const range = XLSX.utils.decode_range(worksheet["!ref"]);
    const links = [];
    for (let row = range.s.r + 1; row <= range.e.r; row++) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })];
      const url = String(cell?.l?.Target || cell?.v || "").trim();
      if (url) links.push({ row, url });
    }
    return { sheet, column, links, rowCount: range.e.r - range.s.r };
  }

  function populateWorkbookColumns() {
    const worksheet = inputWorkbook?.book.Sheets[$("xlsxSheet").value];
    const select = $("xlsxColumn");
    select.replaceChildren();
    if (worksheet?.["!ref"]) {
      const range = XLSX.utils.decode_range(worksheet["!ref"]);
      for (let column = range.s.c; column <= range.e.c; column++) {
        const cell = worksheet[XLSX.utils.encode_cell({ r: range.s.r, c: column })];
        const label = String(cell?.v ?? "").trim();
        select.add(new Option(`${XLSX.utils.encode_col(column)} · ${label || "Без заголовка"}`, column));
        if (/^(url|ссылка)$/i.test(label)) select.value = String(column);
      }
    }
    if (lastState) render(lastState);
  }

  async function loadInputWorkbook() {
    const file = $("xlsxFile").files[0];
    inputWorkbook = null;
    $("xlsxSheet").replaceChildren();
    populateWorkbookColumns();
    if (!file) return;
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      if ($("xlsxFile").files[0] !== file) return;
      inputWorkbook = { data, name: file.name, book: XLSX.read(data, { type: "base64", cellStyles: true }) };
      for (const name of inputWorkbook.book.SheetNames) $("xlsxSheet").add(new Option(name, name));
      populateWorkbookColumns();
    } catch {
      setStatus("Не удалось открыть XLSX", true);
    }
  }

  function importedCoordinatePair(latValue, lonValue) {
    const latitude = String(latValue ?? "").trim().replace(",", ".");
    const longitude = String(lonValue ?? "").trim().replace(",", ".");
    if (!latitude || !longitude) return null;
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (!lat && !lon)) return null;
    return { lat, lon };
  }

  async function exportImportedWorkbook() {
    const [storage, response] = await Promise.all([
      api.storage.local.get([IMPORT_KEY, JOB_KEY]),
      send("ENRICHMENT_GET_RESULTS", { imported: true })
    ]);
    const imported = storage[IMPORT_KEY];
    const job = storage[JOB_KEY];
    if (!imported || job?.source !== "xlsx" || job.run_id !== imported.runId) throw new Error("Нет результатов досбора из XLSX");
    const book = XLSX.read(imported.data, { type: "base64", cellStyles: true });
    const sheet = book.Sheets[imported.sheet];
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const byRow = new Map();
    for (const task of Object.values(job.tasks)) {
      for (const row of task.rows || []) byRow.set(row, task);
    }
    const columns = Object.keys(detailRow({}, {}));
    const existing = new Set();
    let latitudeColumn = -1;
    let longitudeColumn = -1;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const name = String(sheet[XLSX.utils.encode_cell({ r: range.s.r, c })]?.v ?? "");
      existing.add(name);
      const label = name.trim().toLowerCase();
      if (latitudeColumn < 0 && /^(lat|latitude|широта)$/.test(label)) latitudeColumn = c;
      if (longitudeColumn < 0 && /^(lon|lng|longitude|долгота)$/.test(label)) longitudeColumn = c;
    }
    const headers = columns.map((name) => {
      let label = name;
      for (let index = 1; existing.has(label); index++) label = `Досбор — ${name}${index > 1 ? ` (${index})` : ""}`;
      existing.add(label);
      return label;
    });
    const output = [headers];
    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      const task = byRow.get(r);
      const cell = sheet[XLSX.utils.encode_cell({ r, c: imported.column })];
      const detail = task ? response.results[task.object_key] || task : {};
      const row = task ? detailRow({ source: task.source }, detail) : {};
      const existingPair = latitudeColumn >= 0 && longitudeColumn >= 0
        ? importedCoordinatePair(
          sheet[XLSX.utils.encode_cell({ r, c: latitudeColumn })]?.v,
          sheet[XLSX.utils.encode_cell({ r, c: longitudeColumn })]?.v
        )
        : null;
      const coordinates = existingPair || importedCoordinatePair(detail.lat, detail.lon);
      row["Широта"] = coordinates?.lat ?? "";
      row["Долгота"] = coordinates?.lon ?? "";
      if (!task) row["Статус досбора"] = String(cell?.l?.Target || cell?.v || "").trim()
        ? "неподдерживаемая ссылка" : "нет ссылки";
      output.push(columns.map((name) => Array.isArray(row[name]) ? row[name].join(" | ") : row[name] ?? ""));
    }
    XLSX.utils.sheet_add_aoa(sheet, output, { origin: { r: range.s.r, c: range.e.c + 1 } });
    const filename = `${safeFilePart(imported.name.replace(/\.xlsx$/i, ""))}_досбор.xlsx`;
    XLSX.writeFileXLSX(book, filename, { compression: true });
    setStatus(`Скачан ${filename}`);
  }

  function detailRow(base, detail) {
    const fields = detail.category_data?.fields || {};
    const categories = exportCategories(base, detail);
    return {
      "Источник": base.source || detail.source || "",
      "ID объекта": detail.org_id || base.org_id || "",
      "Название": detail.title || base.title || "",
      "categories_all": categories,
      "category_first": categories[0] || "",
      "Адрес": detail.address || base.address || "",
      "Телефоны": detail.phones || [],
      "Сайты": detail.websites || [],
      "Рейтинг": detail.rating || base.rating || "",
      "Количество отзывов": detail.reviews || base.reviews || "",
      "Количество фотографий": base.photos_count || "",
      "Широта": detail.lat || base.lat || "",
      "Долгота": detail.lon || base.lon || "",
      "URL": publicUrl(detail.url || base.url),
      "opening_hours": detail.opening_hours || [],
      "working_status": detail.working_status || "",
      "close_time": detail.close_time || "",
      "Описание": detail.description || "",
      "Социальные сети": detail.social_links || [],
      "Средний счёт": fields.average_bill || "",
      "Ценовой уровень": fields.price_level || "",
      "Кухня": fields.cuisine || [],
      "Тип заведения": fields.venue_types || [],
      "Посадочных мест": fields.seats || "",
      "Меню": fields.menu || [],
      "Услуги заведения": fields.services || [],
      "Способы оплаты": fields.payment_methods || [],
      "Количество звёзд": fields.star_rating || "",
      "Тип гостиницы": fields.hotel_type || "",
      "Количество номеров": fields.room_count || "",
      "Типы номеров": fields.room_types || [],
      "Цена номера": fields.room_price || "",
      "Время заезда": fields.checkin_time || "",
      "Год постройки": fields.construction_year || "",
      "Время выезда": fields.checkout_time || "",
      "Удобства отеля": hotelAmenities(base, detail),
      "Номер в реестре": fields.registry_number || "",
      "Ссылка на реестр": fields.registry_url || "",
      "Парковка — характеристики": fields.parking_features || [],
      "Парковка — платная": yesNo(fields.paid),
      "Парковка — охраняемая": yesNo(fields.guarded),
      "Парковка — открытая": yesNo(fields.open_air),
      "Парковка — уличная": yesNo(fields.street),
      "Парковка — вместимость": fields.capacity || "",
      "Парковка — доступ": fields.access || "",
      "Парковка — уровень": fields.level || "",
      "Парковка — покрытие": fields.paving || "",
      "Все особенности": detail.feature_state === "empty" ? "--" : detail.status === "partial" ? "" : readableAttributes(detail.category_data?.raw_attributes),
      "Статус досбора": detail.status === "success" && detail.last_attempt_status
        ? "Детали сохранены · повтор не удался"
        : STATUS_LABELS[detail.status] || detail.status || "не обработано",
      "Ошибка досбора": detail.last_attempt_error || detail.error || ""
    };
  }

  async function exportWorkbook() {
    try {
      if (selectedSource() === "xlsx") {
        await exportImportedWorkbook();
        return;
      }
      setStatus("\u0421обираю XLSX\u2026");
      const [storage, response] = await Promise.all([
        api.storage.local.get(SESSION_KEY),
        send("ENRICHMENT_GET_RESULTS")
      ]);
      const session = storage?.[SESSION_KEY] || {};
      const results = response.results || {};
      const objects = Object.entries(session.objects || {}).map(([objectKey, base]) => {
        const detail = results[objectKey] || {};
        return detailRow(base, detail);
      });

      if (!objects.length) throw new Error("\u0412 \u0431\u0430зовой \u0441\u0435\u0441\u0441\u0438\u0438 \u043d\u0435т \u043e\u0431\u044a\u0435\u043a\u0442\u043eв");
      const columns = [
        "Источник", "ID объекта", "Название", "categories_all", "category_first", "Адрес", "Телефоны", "Сайты", "Рейтинг", "Количество отзывов",
        "Количество фотографий", "Широта", "Долгота", "URL", "opening_hours", "working_status", "close_time",
        "Описание", "Социальные сети", "Средний счёт", "Ценовой уровень", "Кухня", "Тип заведения", "Посадочных мест", "Меню", "Услуги заведения", "Способы оплаты",
        "Количество звёзд", "Тип гостиницы", "Количество номеров", "Типы номеров", "Цена номера", "Время заезда",
        "Год постройки", "Время выезда", "Удобства отеля", "Номер в реестре", "Ссылка на реестр", "Парковка — характеристики", "Парковка — платная", "Парковка — охраняемая",
        "Парковка — открытая", "Парковка — уличная", "Парковка — вместимость", "Парковка — доступ", "Парковка — уровень", "Парковка — покрытие", "Все особенности", "Статус досбора", "Ошибка досбора"
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
    setInterval(updateWorkerDiagnostics, 1000);
    const workersModal = $("workersModal");
    $("btnWorkersModal").addEventListener("click", () => {
      $("workersModalStatus").hidden = true;
      $("workersModalBody").append($("workersList"));
      workersModal.showModal();
    });
    $("btnArrangeWorkers").addEventListener("click", async () => {
      arrangingWorkerWindows = true;
      $("btnArrangeWorkers").disabled = true;
      const message = $("workersModalStatus");
      message.hidden = false;
      message.textContent = "Раскладываю рабочие окна…";
      try {
        const area = {
          left: Math.round(screen.availLeft ?? 0),
          top: Math.round(screen.availTop ?? 0),
          width: Math.round(screen.availWidth),
          height: Math.round(screen.availHeight)
        };
        const result = await send("ENRICHMENT_ARRANGE_WINDOWS", { area });
        message.textContent = `Разложено: ${result.arranged} · в фоне: ${result.background}` +
          (result.skipped ? ` · не удалось переместить: ${result.skipped}` : "");
      } catch (error) {
        message.textContent = String(error?.message || error);
      } finally {
        arrangingWorkerWindows = false;
        await refresh();
      }
    });
    workersModal.addEventListener("close", () => {
      $("workersInline").append($("workersList"));
    });
    $("workersList").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-open-worker]");
      if (!button || button.disabled) return;
      const message = $("workersModalStatus");
      message.hidden = true;
      try {
        await send("ENRICHMENT_OPEN_WORKER", {
          worker_id: button.dataset.openWorker,
          object_key: button.dataset.objectKey
        });
      } catch (error) {
        message.textContent = String(error?.message || error);
        message.hidden = false;
      }
    });
    const applyTheme = initThemePreferences();
    $("detailSource").addEventListener("change", () => lastState && render(lastState));
    $("xlsxFile").addEventListener("change", loadInputWorkbook);
    $("xlsxSheet").addEventListener("change", populateWorkbookColumns);
    $("xlsxColumn").addEventListener("change", () => lastState && render(lastState));
    $("btnStart").addEventListener("click", async () => {
      const workers = $("workers");
      if (!workers.reportValidity()) return;
      const source = selectedSource();
      let fileOptions = {};
      if (source === "xlsx") {
        try {
          const saved = (await api.storage.local.get(IMPORT_KEY))[IMPORT_KEY];
          let input = selectedWorkbookColumn();
          let file = inputWorkbook;
          if (!file && saved) {
            file = saved;
            input = workbookColumn(XLSX.read(saved.data, { type: "base64" }), saved.sheet, saved.column);
          }
          if (!input?.links.length) return;
          if (saved && !confirm("Начать досбор XLSX заново? Сохранённые результаты предыдущего досбора из файла будут заменены. Сначала скачайте их, если они нужны.")) return;
          fileOptions = {
            workbook: { data: file.data, name: file.name, sheet: input.sheet, column: input.column },
            links: input.links,
            restartWorkbook: Boolean(saved)
          };
        } catch (error) {
          setStatus(String(error?.message || error), true);
          return;
        }
      }
      runAction("ENRICHMENT_START", {
        options: {
          source,
          ...fileOptions,
          scope: $("scope").value,
          workers: workers.valueAsNumber,
          max_attempts: Number($("maxAttempts").value),
          timeout_ms: Number($("timeout").value) * 1000,
          delay_ms: 1200
        }
      }, "\u0414осбор \u0437а\u043fущен");
    });
    $("btnPause").addEventListener("click", () => runAction("ENRICHMENT_PAUSE", {}, "\u041eче\u0440е\u0434\u044c \u043d\u0430 \u043f\u0430\u0443\u0437е"));
    $("btnResume").addEventListener("click", () => runAction("ENRICHMENT_RESUME", {}, "\u041e\u0447\u0435\u0440е\u0434\u044c \u043f\u0440од\u043e\u043b\u0436\u0435на"));
    $("btnRetry").addEventListener("click", () => runAction("ENRICHMENT_RETRY_ERRORS", {}, "\u041e\u0448\u0438\u0431\u043a\u0438 \u0432е\u0440\u043dу\u0442ы \u0432 \u043e\u0447\u0435р\u0435\u0434ь"));
    $("btnStop").addEventListener("click", () => {
      if (confirm("\u041e\u0441\u0442\u0430\u043d\u043e\u0432ить досбор и закрыть рабочие вкладки?")) runAction("ENRICHMENT_STOP", {}, "\u0414\u043e\u0441б\u043e\u0440 \u043eстановлен");
    });
    $("btnForceReset").addEventListener("click", () => {
      if (lastState?.job.source === "xlsx") {
        if (confirm("Сбросить очередь и результаты досбора из XLSX?")) {
          runAction("ENRICHMENT_FORCE_RESET", { importOnly: true }, "Досбор из XLSX сброшен");
        }
        return;
      }
      if (confirm("Принудительно закрыть рабочие вкладки и удалить очередь вместе с результатами досбора? Базовые карточки и URL останутся в основной сессии.")) {
        runAction("ENRICHMENT_FORCE_RESET", {}, "Досбор полностью сброшен. Можно запускать новое задание");
      }
    });
    $("btnOpenWorker").addEventListener("click", () => runAction("ENRICHMENT_OPEN_WORKER", { worker_id: $("btnOpenWorker").dataset.workerId }, "\u0412\u043a\u043b\u0430дк\u0430 \u043eткрыта"));
    $("btnExport").addEventListener("click", exportWorkbook);
    api.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[THEME_KEY]?.newValue) applyTheme(changes[THEME_KEY].newValue);
      if (area === "local" && (changes[JOB_KEY] || changes[RESULTS_KEY] || changes[SESSION_KEY])) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, 100);
      }
    });
    refresh();
    setInterval(refresh, 3000);
  });
})();
