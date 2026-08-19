// Фото-конструктор (Хаб генерации, Full). ТЗ: docs/briefs/frontend.md
// (репо бота), пункт «Хаб генерации в вебаппе — экран «Конструктор» для
// обычного фото» + docs/specs/2026-08-13_webapp_generation_hub_navigation_full.md,
// раздел 1.3 (плитка «Фото» на «Создать» ведёт на «Стили» — это НЕ этот
// экран; этот экран открывается ТОЛЬКО из чата: кнопка «✨ Сгенерировать
// фото»/`photo_menu_kb`, `&tab=photo_constructor`, флаг
// PHOTO_CONSTRUCTOR_ENABLED). Тот же принцип, что mj_constructor.js/
// avatar_constructor.js: экран собирает настройки, `tg.sendData()` шлёт
// ОДИН payload `start_generation`/`sg`, карточка подтверждения и запуск
// (существующий коллбэк `generate`/`run_generation`) остаются в чате.
// Общие утилиты (tg, showToast, thumbUrl, APP_VERSION, switchTab,
// isOpenedViaInlineButton) — из app.js; аплоадер фото на imgbb —
// studioCall/studioCompressImageToBase64 из studio.js, переиспользуем.
//
// ⚠️ Бэкенд (`_apply_webapp_generation_photo`, SirNike.py): `refs` до 8,
// пустой список — бот молча подставит сохранённый аватар юзера (та же
// логика, что у сегодняшнего run_generation) — экран НЕ блокирует отправку
// без фото, только подсказывает текстом (см. #pcRefsHint в index.html).
//
// ⚠️ Переключатель модели Gemini/GPT-5 сознательно не показан — см.
// комментарий в index.html над #pagePhotoConstructor. Всегда шлём дефолт
// (не передаём image_model вовсе) — бэкенд сам выбирает gemini.
const PC_MAX_PHOTOS = 8;

let pcState = { description: "", refs: [] };

function renderPcRefs() {
  const wrap = document.getElementById("pcRefs");
  if (!wrap) return;
  wrap.innerHTML = "";
  pcState.refs.forEach((url, idx) => {
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
      pcState.refs.splice(idx, 1);
      renderPcRefs();
      renderPcContinueBtn();
    });
    thumb.appendChild(img);
    thumb.appendChild(rm);
    wrap.appendChild(thumb);
  });
  const uploadBtn = document.getElementById("pcUploadBtn");
  const atLimit = pcState.refs.length >= PC_MAX_PHOTOS;
  if (uploadBtn) {
    uploadBtn.disabled = atLimit;
    uploadBtn.title = atLimit ? `Максимум ${PC_MAX_PHOTOS} фото` : "";
  }
}

// Кнопка активна только от непустого описания — тот же принцип, что у
// Midjourney/видео («действие возможно» ⇔ кнопка активна). Фото — всегда
// опциональны (бэкенд подставит аватар сам), описание — обязательно.
function renderPcContinueBtn() {
  const btn = document.getElementById("pcContinueBtn");
  if (!btn) return;
  btn.disabled = pcState.description.trim().length === 0;
}

// ── prefill (deep-link «✏️ Изменить») ───────────────────────────────────
// Симметрично buildPcStartGenerationPayload — бот кодирует ТУ ЖЕ форму
// полей в base64 JSON (build_generation_prefill/constructor_prefill_url,
// SirNike.py) и кладёт в &prefill= рядом с &tab=photo_constructor.
// Повреждённый/отсутствующий prefill не должен ронять экран — try/catch,
// экран просто открывается пустым, как сегодня. `image_model` намеренно
// не читаем — переключатель Gemini/GPT-5 в этом экране не показан
// (см. комментарий вверху файла), бэкенд сам выбирает дефолт при отправке.
function pcParsePrefillFromUrl() {
  try {
    const raw = new URLSearchParams(window.location.search).get("prefill");
    if (!raw) return null;
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const json = new TextDecoder("utf-8").decode(bytes);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    console.error("photo constructor: prefill parse failed, ignoring", e);
    return null;
  }
}

function pcApplyPrefill(pf) {
  if (!pf || typeof pf !== "object") return;
  if (typeof pf.description === "string") {
    pcState.description = pf.description;
    if (pcDescriptionInput) pcDescriptionInput.value = pf.description;
  }
  if (Array.isArray(pf.refs)) {
    pcState.refs = pf.refs.filter((u) => typeof u === "string" && u).slice(0, PC_MAX_PHOTOS);
  }
}

const pcDescriptionInput = document.getElementById("pcDescriptionInput");
pcDescriptionInput?.addEventListener("input", () => {
  let text = pcDescriptionInput.value;
  while (new TextEncoder().encode(text).length > 3500) {
    text = text.slice(0, -1);
  }
  if (text !== pcDescriptionInput.value) pcDescriptionInput.value = text;
  pcState.description = text;
  renderPcContinueBtn();
});

const pcPhotoFile = document.getElementById("pcPhotoFile");
document.getElementById("pcUploadBtn")?.addEventListener("click", () => {
  if (pcState.refs.length >= PC_MAX_PHOTOS) {
    showToast(`Максимум ${PC_MAX_PHOTOS} фото.`);
    return;
  }
  pcPhotoFile?.click();
});
pcPhotoFile?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const base64 = await studioCompressImageToBase64(file);
    if (!base64) throw new Error("empty base64");
    const data = await studioCall("upload", { image_base64: base64 });
    if (data && data.ok && data.url) {
      pcState.refs.push(data.url);
      renderPcRefs();
      renderPcContinueBtn();
    }
  } catch (err) {
    console.error("photo constructor photo upload failed", err);
    showToast("Не получилось обработать фото.");
  }
});

function buildPcStartGenerationPayload() {
  const payload = {
    action: "start_generation",
    product: "photo",
    description: pcState.description.trim(),
    v: typeof APP_VERSION !== "undefined" ? APP_VERSION : "photo-constructor-v1",
  };
  if (pcState.refs.length) payload.refs = pcState.refs;
  return JSON.stringify(payload);
}

document.getElementById("pcContinueBtn")?.addEventListener("click", () => {
  if (!tg) {
    showToast("Открой Фото внутри Telegram, чтобы продолжить.");
    return;
  }
  if (typeof isOpenedViaInlineButton === "function" && isOpenedViaInlineButton()) {
    sendGenerationPayloadViaAnswerWebAppQuery(buildPcStartGenerationPayload());
    return;
  }
  try {
    tg.sendData(buildPcStartGenerationPayload());
    setTimeout(() => tg.close(), 900);
  } catch (e) {
    console.error("photo constructor sendData failed", e);
    showToast("Не получилось отправить настройки. Попробуй ещё раз.");
  }
});

(function observePcPriceStrip() {
  const strip = document.getElementById("pcPriceStrip");
  if (!strip) return;
  const sync = () => {
    const h = strip.classList.contains("hidden") ? 0 : strip.getBoundingClientRect().height;
    document.documentElement.style.setProperty("--vc-price-strip-space", `${h}px`);
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(sync).observe(strip);
  else window.addEventListener("resize", sync);
  sync();
})();

// Deep-link из чата: «✨ Сгенерировать фото» открывает вебапп с
// &tab=photo_constructor при включённом PHOTO_CONSTRUCTOR_ENABLED — сразу
// переключаемся на экран (тот же приём, что у video/mj/avatar-конструкторов).
// Бот шлёт строго snake_case, не camelCase.
try {
  if (new URLSearchParams(window.location.search).get("tab") === "photo_constructor") {
    switchTab("photoConstructor");
    document.getElementById("pcPriceStrip")?.classList.remove("hidden");
  }
} catch { /* не критично */ }

pcApplyPrefill(pcParsePrefillFromUrl());
renderPcRefs();
renderPcContinueBtn();
