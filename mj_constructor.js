// Midjourney-конструктор (Хаб генерации, Full). ТЗ:
// docs/specs/2026-08-13_webapp_generation_hub.md (репо бота), раздел
// «Midjourney-конструктор» + docs/briefs/frontend.md, пункт «Full —
// конструкторы Midjourney и Аватар». Тот же принцип, что и constructor.js
// (видео): экран собирает настройки, `tg.sendData()` шлёт ОДИН payload
// `start_generation`/`sg`, карточка подтверждения и запуск (`mj_generate`)
// остаются в чате. Общие утилиты (tg, showToast, thumbUrl, APP_VERSION,
// switchTab, isOpenedViaInlineButton) — из app.js; аплоадер фото на imgbb —
// studioCall/studioCompressImageToBase64 из studio.js (тот же приём, что и
// constructor.js/boards.js — не строим заново).
//
// ⚠️ EvoLink Midjourney принимает РОВНО ОДИН референс (см.
// _apply_webapp_generation_midjourney в SirNike.py — refs[0], остальное
// молча отбрасывается). Экран поэтому пускает только один файл в
// аплоадере, не до девяти, как у видео.
//
// ⚠️ Нет `cfg`/`price_table` для Midjourney (бот не пробрасывает таблицу
// цен в URL для этого продукта — только для video-конструктора). Цена
// сетки/апскейла (MIDJOURNEY_GRID_COST/MIDJOURNEY_UPSCALE_COST) сейчас
// захардкожена в config.py бота, а не передана в URL — показываем как
// приблизительную подсказку с явной пометкой «уточнится в чате» (тот же
// текст, что видит юзер в статичном макете спеки), финальная карточка
// подтверждения от бота — источник истины по цене.
const MJ_GRID_COST_HINT = 15; // config.py: MIDJOURNEY_GRID_COST default — только текстовая подсказка, не источник истины
const MJ_UPSCALE_COST_HINT = 10; // config.py: MIDJOURNEY_UPSCALE_COST default

let mjState = { description: "", refs: [] };

function renderMjRefs() {
  const wrap = document.getElementById("mjRefs");
  if (!wrap) return;
  wrap.innerHTML = "";
  mjState.refs.forEach((url, idx) => {
    const thumb = document.createElement("div");
    thumb.className = "vc-ref-thumb";
    const img = document.createElement("img");
    img.src = typeof thumbUrl === "function" ? thumbUrl(url, 160) : url;
    img.alt = "";
    img.loading = "lazy";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.setAttribute("aria-label", "Удалить фото");
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      mjState.refs.splice(idx, 1);
      renderMjRefs();
      renderMjContinueBtn();
    });
    thumb.appendChild(img);
    thumb.appendChild(rm);
    wrap.appendChild(thumb);
  });
  const uploadBtn = document.getElementById("mjUploadBtn");
  const atLimit = mjState.refs.length >= 1;
  if (uploadBtn) {
    uploadBtn.disabled = atLimit;
    uploadBtn.title = atLimit ? "Midjourney принимает только один референс" : "";
  }
}

function renderMjContinueBtn() {
  const btn = document.getElementById("mjContinueBtn");
  if (!btn) return;
  btn.disabled = mjState.description.trim().length === 0;
}

// ── prefill (deep-link «✏️ Изменить» / библиотечное «Использовать») ────
// Симметрично buildMjStartGenerationPayload — бот кодирует ТУ ЖЕ форму
// полей в base64 JSON (build_generation_prefill/constructor_prefill_url,
// SirNike.py) и кладёт в &prefill= рядом с &tab=midjourney_constructor.
// Повреждённый/отсутствующий prefill не должен ронять экран — try/catch,
// экран просто открывается пустым, как сегодня.
function mjParsePrefillFromUrl() {
  try {
    const raw = new URLSearchParams(window.location.search).get("prefill");
    if (!raw) return null;
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const json = new TextDecoder("utf-8").decode(bytes);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    console.error("mj constructor: prefill parse failed, ignoring", e);
    return null;
  }
}

function mjApplyPrefill(pf) {
  if (!pf || typeof pf !== "object") return;
  if (typeof pf.description === "string") {
    mjState.description = pf.description;
    if (mjDescriptionInput) mjDescriptionInput.value = pf.description;
  }
  // EvoLink Midjourney принимает только один референс — тот же потолок, что
  // у исходящего payload (renderMjRefs уже отражает лимит в UI).
  if (Array.isArray(pf.refs) && pf.refs.length && typeof pf.refs[0] === "string" && pf.refs[0]) {
    mjState.refs = [pf.refs[0]];
  }
}

const mjDescriptionInput = document.getElementById("mjDescriptionInput");
mjDescriptionInput?.addEventListener("input", () => {
  let text = mjDescriptionInput.value;
  while (new TextEncoder().encode(text).length > 3500) {
    text = text.slice(0, -1);
  }
  if (text !== mjDescriptionInput.value) mjDescriptionInput.value = text;
  mjState.description = text;
  renderMjContinueBtn();
});

const mjPhotoFile = document.getElementById("mjPhotoFile");
document.getElementById("mjUploadBtn")?.addEventListener("click", () => {
  if (mjState.refs.length >= 1) {
    showToast("Midjourney принимает только один референс.");
    return;
  }
  mjPhotoFile?.click();
});
mjPhotoFile?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const base64 = await studioCompressImageToBase64(file);
    if (!base64) throw new Error("empty base64");
    const data = await studioCall("upload", { image_base64: base64 });
    if (data && data.ok && data.url) {
      mjState.refs = [data.url];
      renderMjRefs();
      renderMjContinueBtn();
    }
  } catch (err) {
    console.error("mj constructor photo upload failed", err);
    showToast("Не получилось обработать фото.");
  }
});

function buildMjStartGenerationPayload() {
  const payload = {
    action: "start_generation",
    product: "midjourney",
    description: mjState.description.trim(),
    v: typeof APP_VERSION !== "undefined" ? APP_VERSION : "mj-constructor-v1",
  };
  if (mjState.refs.length) payload.refs = mjState.refs;
  return JSON.stringify(payload);
}

document.getElementById("mjContinueBtn")?.addEventListener("click", () => {
  if (!tg) {
    showToast("Открой Midjourney внутри Telegram, чтобы продолжить.");
    return;
  }
  if (typeof isOpenedViaInlineButton === "function" && isOpenedViaInlineButton()) {
    sendGenerationPayloadViaAnswerWebAppQuery(buildMjStartGenerationPayload());
    return;
  }
  try {
    tg.sendData(buildMjStartGenerationPayload());
    setTimeout(() => tg.close(), 900);
  } catch (e) {
    console.error("mj constructor sendData failed", e);
    showToast("Не получилось отправить настройки. Попробуй ещё раз.");
  }
});

(function initMjCostHint() {
  const el = document.getElementById("mjCostHint");
  if (!el) return;
  el.textContent =
    `Стоимость: ≈ ${MJ_GRID_COST_HINT} 🍇 за сетку из 4 вариантов ` +
    `(≈ ${MJ_UPSCALE_COST_HINT} 🍇 — за увеличение понравившегося, отдельно). ` +
    `Точная цена — в чате перед запуском.`;
})();

(function observeMjPriceStrip() {
  const strip = document.getElementById("mjPriceStrip");
  if (!strip) return;
  const sync = () => {
    const h = strip.classList.contains("hidden") ? 0 : strip.getBoundingClientRect().height;
    document.documentElement.style.setProperty("--vc-price-strip-space", `${h}px`);
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(sync).observe(strip);
  else window.addEventListener("resize", sync);
  sync();
})();

// Deep-link из бота: «🎨 Midjourney» открывает вебапп с
// &tab=midjourney_constructor — сразу переключаемся на экран (тот же
// приём, что constructor.js делает для video_constructor). Бот шлёт
// строго snake_case (midjourney_constructor_kb в SirNike.py), не camelCase.
try {
  if (new URLSearchParams(window.location.search).get("tab") === "midjourney_constructor") {
    switchTab("midjourneyConstructor");
    document.getElementById("mjPriceStrip")?.classList.remove("hidden");
  }
} catch { /* не критично */ }

mjApplyPrefill(mjParsePrefillFromUrl());
renderMjRefs();
renderMjContinueBtn();
