// Живой прогресс генерации (D1-зеркало). ТЗ:
// docs/specs/2026-08-13_webapp_generation_hub_full.md (репо бота), раздел
// «Экран — Прогресс». Открывается ТОЛЬКО с инлайн-кнопки «👀 Смотреть
// прогресс» на статусном сообщении бота (&tab=progress&job_id=...&product=...),
// НЕ из общей навигации — нет входа с tab-bar. Тонкое зеркало статуса, НЕ
// очередь заданий: НИКОГДА не пытается показать сам результат (фото/видео)
// внутри вебвью (провайдерские URL ненадёжны для вебвью — та же находка,
// что уже чинили у Студии) — только стадийный текст, по готовности просто
// «Открой чат, там результат» + кнопка «Закрыть».
//
// Общие утилиты — из app.js/studio.js, загруженных раньше в том же
// документе: tg, switchTab, waitForInitData (уже написана и проверена в
// живом бою для той же initData-гонки на Studio, 2026-07-28).

const PROGRESS_API = "/api/progress/";
const PROGRESS_POLL_MS = 4000;

let progressJobId = "";
let progressTimer = null;
let progressStopped = false;

function progressParams() {
  const params = new URLSearchParams(window.location.search);
  return { tab: params.get("tab"), jobId: params.get("job_id"), product: params.get("product") };
}

function progressSetSpinnerState(state) {
  // state: "loading" | "done" | "error"
  const el = document.getElementById("progressSpinner");
  if (!el) return;
  el.classList.toggle("progress-spinner--done", state === "done");
  el.classList.toggle("progress-spinner--error", state === "error");
}

function progressRenderIdle(stageText, hintText, { final = false, state = "loading" } = {}) {
  const stageEl = document.getElementById("progressStageText");
  const hintEl = document.getElementById("progressHintText");
  const closeBtn = document.getElementById("progressCloseBtn");
  if (stageEl) stageEl.textContent = stageText;
  if (hintEl) hintEl.textContent = hintText;
  progressSetSpinnerState(state);
  if (closeBtn) closeBtn.classList.toggle("hidden", !final);
}

async function progressFetch(jobId) {
  if (!tg) return { ok: false, error: "no_telegram" };
  const initData = typeof waitForInitData === "function" ? await waitForInitData() : (tg.initData || "");
  if (!initData) return { ok: false, error: "invalid_init_data", debug_reason: "empty_init_data_client" };
  try {
    const res = await fetch(PROGRESS_API + "progress.get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: initData, job_id: jobId }),
    });
    return await res.json().catch(() => ({ ok: false, error: "bad_response" }));
  } catch (e) {
    console.error("progress.get failed", e);
    return { ok: false, error: "network" };
  }
}

function progressStopPolling() {
  progressStopped = true;
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

async function progressTick() {
  if (progressStopped) return;
  const data = await progressFetch(progressJobId);
  if (progressStopped) return; // могли остановить, пока ждали ответ

  if (!data || !data.ok) {
    if (data && data.error === "not_found") {
      progressStopPolling();
      progressRenderIdle("Не нашли эту генерацию", "Ссылка устарела — открой чат, там актуальный статус.", { final: true, state: "error" });
      return;
    }
    if (data && data.error === "forbidden") {
      progressStopPolling();
      progressRenderIdle("Это не твоя генерация", "Открой ссылку из своего чата с ботом.", { final: true, state: "error" });
      return;
    }
    // Сетевая ошибка/invalid_init_data — не финальный отказ, попробуем на
    // следующем тике (initData могла быть временно пуста, тот же прецедент,
    // что и у Студии, 2026-07-28).
    return;
  }

  if (data.status === "done") {
    progressStopPolling();
    progressRenderIdle("Готово! 🎉", "Открой чат — результат уже там.", { final: true, state: "done" });
    return;
  }
  if (data.status === "error") {
    progressStopPolling();
    progressRenderIdle("Не получилось 😔", "Открой чат — там подробности (и возврат изюминок, если списались).", { final: true, state: "error" });
    return;
  }
  progressRenderIdle(String(data.stage || "Готовим…"), "Можно закрыть — результат всё равно придёт в чат.", { final: false, state: "loading" });
}

function progressInit() {
  const { tab, jobId } = progressParams();
  if (tab !== "progress") return;
  switchTab("progress");

  const closeBtn = document.getElementById("progressCloseBtn");
  closeBtn?.addEventListener("click", () => {
    if (tg) tg.close();
  });

  progressJobId = String(jobId || "").trim();
  if (!progressJobId) {
    progressRenderIdle("Не нашли эту генерацию", "Ссылка неполная — открой чат и попробуй заново.", { final: true, state: "error" });
    return;
  }

  progressRenderIdle("Готовим…", "Можно закрыть — результат всё равно придёт в чат.", { final: false, state: "loading" });
  progressTick();
  progressTimer = setInterval(progressTick, PROGRESS_POLL_MS);
}

try {
  progressInit();
} catch (e) {
  console.error("progress init failed", e);
}
