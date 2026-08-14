// Улучшить фото (Хаб генерации, Full). ТЗ: docs/specs/
// 2026-08-14_menu_simplification_and_enhance_constructor.md (репо бота).
// Простейший из конструкторов — промт и модель фиксированы на бэкенде
// (ENHANCE_PHOTO_PROMPT, gemini), юзер только грузит РОВНО одно фото.
// Тот же принцип, что photo_constructor.js/mj_constructor.js: экран
// собирает данные, tg.sendData() шлёт ОДИН payload start_generation/sg,
// карточка подтверждения и запуск остаются в чате (переиспользует уже
// существующий photo_draft_text/photo_draft_kb — тот же текст, что видит
// юзер сегодня после ручной отправки фото боту).
//
// ⚠️ Второе загруженное фото ЗАМЕНЯЕТ первое, не добавляется (в отличие от
// остальных конструкторов, где фото — массив до N) — бэкенд берёт только
// refs[0], массив тут концептуально не нужен, но ecState.refs остаётся
// массивом для переиспользования общего рендер-паттерна vc-ref-thumb.
let ecState = { refs: [] };

function renderEcRefs() {
  const wrap = document.getElementById("ecRefs");
  if (!wrap) return;
  wrap.innerHTML = "";
  ecState.refs.forEach((url, idx) => {
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
      ecState.refs.splice(idx, 1);
      renderEcRefs();
      renderEcContinueBtn();
    });
    thumb.appendChild(img);
    thumb.appendChild(rm);
    wrap.appendChild(thumb);
  });
  const uploadBtn = document.getElementById("ecUploadBtn");
  uploadBtn && (uploadBtn.textContent = ecState.refs.length ? "📷 Заменить фото" : "📷 Добавить фото");
}

function renderEcContinueBtn() {
  const btn = document.getElementById("ecContinueBtn");
  if (!btn) return;
  btn.disabled = ecState.refs.length === 0;
}

const ecPhotoFile = document.getElementById("ecPhotoFile");
document.getElementById("ecUploadBtn")?.addEventListener("click", () => ecPhotoFile?.click());
ecPhotoFile?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const base64 = await studioCompressImageToBase64(file);
    if (!base64) throw new Error("empty base64");
    const data = await studioCall("upload", { image_base64: base64 });
    if (data && data.ok && data.url) {
      ecState.refs = [data.url]; // замена, не добавление — см. докстрок
      renderEcRefs();
      renderEcContinueBtn();
    }
  } catch (err) {
    console.error("enhance constructor photo upload failed", err);
    showToast("Не получилось обработать фото.");
  }
});

function buildEcStartGenerationPayload() {
  return JSON.stringify({
    action: "start_generation",
    product: "enhance",
    refs: ecState.refs.slice(0, 1),
    v: typeof APP_VERSION !== "undefined" ? APP_VERSION : "enhance-constructor-v1",
  });
}

document.getElementById("ecContinueBtn")?.addEventListener("click", () => {
  if (!tg) {
    showToast("Открой «Улучшить фото» внутри Telegram, чтобы продолжить.");
    return;
  }
  if (typeof isOpenedViaInlineButton === "function" && isOpenedViaInlineButton()) {
    showToast("Из этого входа фото не отправится. Открой библиотеку кнопкой в меню и попробуй ещё раз.");
    return;
  }
  if (!ecState.refs.length) return;
  try {
    tg.sendData(buildEcStartGenerationPayload());
    setTimeout(() => tg.close(), 900);
  } catch (e) {
    console.error("enhance constructor sendData failed", e);
    showToast("Не получилось отправить фото. Попробуй ещё раз.");
  }
});

(function observeEcPriceStrip() {
  const strip = document.getElementById("ecPriceStrip");
  if (!strip) return;
  const sync = () => {
    const h = strip.classList.contains("hidden") ? 0 : strip.getBoundingClientRect().height;
    document.documentElement.style.setProperty("--vc-price-strip-space", `${h}px`);
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(sync).observe(strip);
  else window.addEventListener("resize", sync);
  sync();
})();

// Deep-link: «Улучшить фото» на «Создать» (клиентский переход, app.js) ИЛИ
// прямая ссылка от бота (&tab=enhance_constructor, если решите добавить
// точку входа из чата помимо сетки «Создать» — сегодня не требуется по
// спеке, но обрабатываем на случай будущей точки входа, тот же приём, что
// у всех остальных конструкторов).
try {
  if (new URLSearchParams(window.location.search).get("tab") === "enhance_constructor") {
    switchTab("enhanceConstructor");
    document.getElementById("ecPriceStrip")?.classList.remove("hidden");
  }
} catch { /* не критично */ }

renderEcRefs();
renderEcContinueBtn();
