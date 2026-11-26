(() => {
  const api = globalThis.browser || globalThis.chrome;
  const $ = (id) => document.getElementById(id);
  const labels = {
    idle: "Ожидание", running: "В работе", paused: "Пауза",
    completed: "Завершён", stopped: "Остановлен", blocked: "Требуется внимание"
  };
  const duration = (seconds) => {
    if (!Number.isFinite(seconds)) return "—";
    const minutes = Math.floor(seconds / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин` :
      `${minutes} мин ${Math.floor(seconds % 60)} с`;
  };
  async function refresh() {
    try {
      const state = await api.runtime.sendMessage({ type: "ENRICHMENT_GET_SUMMARY" });
      if (!state?.ok) throw new Error("Unavailable");
      const { job } = state;
      const totals = job.totals || {};
      const total = totals.total || 0;
      const success = totals.success || 0;
      const errors = (totals.error || 0) + (totals.captcha || 0) + (totals.rate_limited || 0);
      const done = Math.min(total, success + errors + (totals.cancelled || 0));
      const remaining = total - done;
      const elapsed = Math.max(0, ((Date.parse(job.completed_at) || Date.now()) - Date.parse(job.started_at)) / 1000);
      const status = `${labels[job.status] || job.status} · ${done} из ${total}`;
      if ($("status").textContent !== status) $("status").textContent = status;
      $("progress").max = total || 1;
      $("progress").value = done;
      $("success").textContent = success;
      $("remaining").textContent = remaining;
      $("errors").textContent = errors;
      $("saved").textContent = state.saved_counts?.[job.source] || 0;
      $("elapsed").textContent = duration(elapsed);
      const lastSaved = Date.parse(job.last_saved_at);
      $("lastSaved").textContent = Number.isFinite(lastSaved)
        ? new Date(lastSaved).toLocaleString("ru-RU") : "—";
      $("eta").textContent = duration(job.status === "running" && done ? elapsed * remaining / done : NaN);
    } catch {
      $("status").textContent = "Не удалось прочитать состояние досбора";
    } finally {
      setTimeout(refresh, 2000);
    }
  }
  refresh();
})();
