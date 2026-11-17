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
  if (code === "not_started" && first) return first;
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
