// «Всё в вебаппе»: отправка генерации по HTTP-очереди (/api/gen/*) вместо
// tg.sendData(), который закрывает Mini App. ТЗ: docs/specs/
// 2026-11-16_webapp_gen_transport.md (репо бота). Этап 1 — только видео;
// остальные продукты переключаются по готовности бэкенда (тот же вызов).
//
// Контракт:
//   genTransportReady()            -> Promise<boolean>   схема доступна (бот на связи)
//   genSubmitAndWait(payloadText)  -> Promise<{ kind, ... }>
//     kind: "launched" { result }   бот запустил генерацию
//           "rejected" { text }     бот отказал / сбой — показать text, поля не сбрасывать
//           "timeout"               за 20 с ответа нет
//           "fallback"              схема недоступна — отправить по-старому (sendData)
//
// Общие утилиты (tg, waitForInitData) — из app.js/studio.js.

const GEN_API = "/api/gen/";
const GEN_POLL_MS = 1500;
const GEN_WAIT_MS = 20000;

let _genReadyPromise = null;

async function _genPost(action, body) {
  const res = await fetch(GEN_API + action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { httpStatus: res.status, data };
}

// Один раз за сессию. Любая ошибка/404/5xx = схема недоступна (кнопка по-старому).
function genTransportReady() {
  if (!_genReadyPromise) {
    _genReadyPromise = (async () => {
      try {
        if (!tg) return false;
        const { httpStatus, data } = await _genPost("ready", {});
        return httpStatus === 200 && Boolean(data && data.ok && data.available);
      } catch {
        return false;
      }
    })();
  }
  return _genReadyPromise;
}

function genErrorText(code, result) {
  const first = result && Array.isArray(result.messages) ? String(result.messages[0] || "").trim() : "";
  if ((code === "not_started" || code === "not_accepted") && first) return first;
  if (code === "too_many") return "Уже идёт 5 генераций. Дождись, пока одна закончится.";
  return "Не получилось, попробуй ещё раз.";
}

async function genSubmitAndWait(payloadText) {
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return { kind: "rejected", text: "Не получилось, попробуй ещё раз." };
  }

  const initData = await waitForInitData();
  if (!initData) return { kind: "fallback" }; // нет initData — старый путь надёжнее

  let jobId;
  try {
    const { httpStatus, data } = await _genPost("submit", { init_data: initData, payload });
    if (httpStatus === 429 || (data && data.error === "too_many")) {
      return { kind: "rejected", text: genErrorText("too_many") };
    }
    if (!data || !data.ok || !data.job_id) {
      // 404/5xx/бот не на связи/любой сбой самой схемы — откат на sendData
      return { kind: "fallback" };
    }
    jobId = data.job_id;
  } catch (e) {
    console.error("gen submit failed", e);
    return { kind: "fallback" };
  }

  const deadline = Date.now() + GEN_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, GEN_POLL_MS));
    try {
      const { data } = await _genPost("status", { init_data: initData, job_id: jobId });
      if (!data || !data.ok) continue; // сетевой/временный сбой — следующий тик
      if (data.status === "done") return { kind: "launched", result: data.result || {} };
      if (data.status === "error") {
        return { kind: "rejected", text: genErrorText(data.error, data.result) };
      }
    } catch (e) {
      console.error("gen status failed", e);
    }
  }
  return { kind: "timeout" };
}

// ── Общие обёртки для экранов ─────────────────────────────────────────

// Кнопка «Создать» конструктора: тот же поток, что у видео (макет одобрен
// 2026-11-16) — «⏳ Отправляем…», плашка ошибки под кнопкой, прогресс внутри
// вебаппа, откат на прежний путь (sendViaChat) если схема недоступна.
//   btnId/errId — id кнопки и плашки ошибки; buildPayload() -> JSON-строка;
//   sendViaChat() — прежний путь (sendData/answerWebAppQuery);
//   newLabel() — подпись при новой схеме (видео добавляет цену).
// Возвращает ctl: экран зовёт ctl.decorate(empty) из своего renderXContinueBtn
// вместо ручной установки disabled/подписи.
function genBindConstructor({ btnId, errId, buildPayload, sendViaChat, newLabel, noTgToast }) {
  const ctl = { transport: false, submitting: false, rerender: null };
  const btn = () => document.getElementById(btnId);
  const setError = (text) => {
    const el = document.getElementById(errId);
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("hidden", !text);
  };

  ctl.decorate = (empty) => {
    const b = btn();
    if (!b) return;
    b.disabled = Boolean(empty) || ctl.submitting;
    if (!ctl.submitting) {
      b.textContent = ctl.transport
        ? (typeof newLabel === "function" ? newLabel() : "🚀 Создать")
        : "🚀 Продолжить в чат";
    }
  };

  async function run() {
    const b = btn();
    ctl.submitting = true;
    setError("");
    if (b) {
      b.disabled = true;
      b.textContent = "⏳ Отправляем…";
    }
    let outcome;
    try {
      outcome = await genSubmitAndWait(buildPayload());
    } catch (e) {
      console.error("gen submit crashed", e);
      outcome = { kind: "fallback" };
    }
    ctl.submitting = false;

    if (outcome.kind === "fallback") {
      ctl.transport = false; // схема недоступна — дальше подпись и путь по-старому
      if (ctl.rerender) ctl.rerender();
      sendViaChat();
      return;
    }
    if (ctl.rerender) ctl.rerender();
    if (outcome.kind === "launched") {
      const progressId = outcome.result && outcome.result.progress_id;
      if (progressId) progressStart(progressId, outcome.result.product);
      else progressShowStarted();
    } else if (outcome.kind === "timeout") {
      setError("Бот занят, попробуй через минуту.");
    } else {
      setError(outcome.text || "Не получилось, попробуй ещё раз.");
    }
  }

  btn()?.addEventListener("click", () => {
    if (!tg) {
      showToast(noTgToast || "Открой экран внутри Telegram, чтобы продолжить.");
      return;
    }
    if (ctl.submitting) return;
    if (ctl.transport) run();
    else sendViaChat();
  });

  genTransportReady().then((ok) => {
    ctl.transport = ok;
    if (ctl.rerender) ctl.rerender();
  });
  return ctl;
}

// Мгновенное действие (смена аватара, выбор доски, пополнение): без экрана
// прогресса и без закрытия вебаппа. Бот отвечает result.instant=true; текст для
// тоста — result.messages[0]. fallback() — прежний путь через sendData.
// Возвращает true, только если действие применено через очередь.
//   closeAfter — действие отвечает в чате (счёт, анализ доски): после «ок»
//   вебапп закрывается, как раньше.
async function genInstant(payload, { okText = "Готово", fallback, closeAfter = false } = {}) {
  if (!tg || !(await genTransportReady())) { fallback(); return false; }
  const out = await genSubmitAndWait(JSON.stringify(payload));
  if (out.kind === "fallback") { fallback(); return false; }
  if (out.kind === "launched") {
    const msgs = out.result && Array.isArray(out.result.messages) ? out.result.messages : [];
    showToast(String(msgs[0] || okText));
    if (closeAfter) setTimeout(() => tg.close(), 900);
    return true; // применено через очередь, вебапп остаётся открытым
  }
  showToast(out.kind === "timeout" ? "Бот занят, попробуй через минуту." : (out.text || "Не получилось, попробуй ещё раз."));
  return false;
}
