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
let progressProduct = "";
let progressCancelling = false;

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

// «Остановить» есть только у видео (фото/аватар — общая очередь, отмены нет).
function progressRenderIdle(stageText, hintText, { final = false, state = "loading", canStop = false, videoUrl = "" } = {}) {
  const stopBtn = document.getElementById("progressStopBtn");
  if (stopBtn) stopBtn.classList.toggle("hidden", !canStop);
  if (!canStop || final) progressSetStopNote("");
  progressSetVideo(videoUrl);
  const stageEl = document.getElementById("progressStageText");
  const hintEl = document.getElementById("progressHintText");
  const closeBtn = document.getElementById("progressCloseBtn");
  if (stageEl) stageEl.textContent = stageText;
  if (hintEl) hintEl.textContent = hintText;
  progressSetSpinnerState(state);
  if (closeBtn) closeBtn.classList.toggle("hidden", !final);
}

function progressSetStopNote(text) {
  const el = document.getElementById("progressStopNote");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

// Плеер готового видео. Ссылка провайдера живёт недолго — показываем сразу;
// если плеер не смог загрузиться, прячем его (видео и так пришло в чат).
function progressSetVideo(url) {
  const el = document.getElementById("progressVideo");
  if (!el) return;
  if (!url) {
    if (el.getAttribute("src")) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    el.classList.add("hidden");
    return;
  }
  if (el.getAttribute("src") !== url) el.setAttribute("src", url);
  el.classList.remove("hidden");
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

  if (progressCancelling) return; // идёт запрос отмены — не перетираем экран

  if (data.status === "done") {
    progressStopPolling();
    const url = progressProduct === "video" && typeof data.result_url === "string" ? data.result_url : "";
    progressRenderIdle("Готово! 🎉",
      url ? "Видео также пришло в чат. Ссылка живёт недолго, сохрани ролик." : "Открой чат — результат уже там.",
      { final: true, state: "done", videoUrl: url });
    return;
  }
  if (data.status === "error") {
    progressStopPolling();
    progressRenderIdle("Не получилось 😔", "Открой чат — там подробности (и возврат изюминок, если списались).", { final: true, state: "error" });
    return;
  }
  progressRenderIdle(String(data.stage || "Готовим…"), "Можно закрыть — результат всё равно придёт в чат.",
    { final: false, state: "loading", canStop: progressProduct === "video" });
}

// «❌ Остановить» (только видео): тихое действие cancel_generation через
// очередь. done = отмена запрошена, изюминки вернёт бот; not_accepted =
// уже завершилось, причина — текстом бота под кнопкой.
async function progressCancel() {
  if (progressCancelling || progressProduct !== "video") return;
  const btn = document.getElementById("progressStopBtn");
  progressCancelling = true;
  progressSetStopNote("");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Останавливаем…"; }

  let out;
  try {
    out = await genSubmitAndWait(JSON.stringify({ action: "cancel_generation", product: "video" }));
  } catch (e) {
    console.error("cancel failed", e);
    out = { kind: "rejected", text: "Не получилось остановить, попробуй ещё раз." };
  }
  progressCancelling = false;
  if (btn) { btn.disabled = false; btn.textContent = "❌ Остановить"; }

  if (out.kind === "launched") {
    progressStopPolling();
    progressRenderIdle("Остановлено", "Изюминки вернутся на баланс.", { final: true, state: "error" });
    return;
  }
  if (out.kind === "timeout") progressSetStopNote("Бот занят, попробуй через минуту.");
  else if (out.kind === "fallback") progressSetStopNote("Остановить не получилось. Попробуй в чате.");
  else progressSetStopNote(out.text || "Не получилось остановить, попробуй ещё раз.");
}

let progressCloseBound = false;
function progressBindClose() {
  if (progressCloseBound) return;
  progressCloseBound = true;
  document.getElementById("progressStopBtn")?.addEventListener("click", progressCancel);
  document.getElementById("progressCloseBtn")?.addEventListener("click", () => {
    if (tg) tg.close();
  });
}

// Запуск опроса по job_id. Вызывается и из deep-link (progressInit), и
// изнутри вебаппа (gen_transport: «Создать» → прогресс без закрытия).
// Повторный вызов (вторая генерация подряд) сбрасывает прошлый опрос.
function progressStart(jobId, product) {
  progressStopPolling();
  progressStopped = false;
  progressCancelling = false;
  progressProduct = String(product || "").trim().toLowerCase();
  switchTab("progress");

  progressBindClose();

  progressJobId = String(jobId || "").trim();
  if (!progressJobId) {
    progressRenderIdle("Не нашли эту генерацию", "Ссылка неполная — открой чат и попробуй заново.", { final: true, state: "error" });
    return;
  }

  progressRenderIdle("Готовим…", "Можно закрыть — результат всё равно придёт в чат.",
    { final: false, state: "loading", canStop: progressProduct === "video" });
  progressTick();
  progressTimer = setInterval(progressTick, PROGRESS_POLL_MS);
}

// Генерация запущена, но записи прогресса нет (GEN_PROGRESS_ENABLED выключен
// на боте): честно говорим, что запущено, без вечного «Готовим…».
function progressShowStarted() {
  progressStopPolling();
  switchTab("progress");
  progressRenderIdle("Запущено 🚀", "Результат придёт в чат — вебапп можно закрыть.", { final: true, state: "done" });
  progressBindClose();
}

function progressInit() {
  const { tab, jobId, product } = progressParams();
  if (tab !== "progress") return;
  progressStart(jobId, product);
}

try {
  progressInit();
} catch (e) {
  console.error("progress init failed", e);
}
