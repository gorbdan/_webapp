// Аватар-конструктор (Хаб генерации, Full). ТЗ:
// docs/specs/2026-08-13_webapp_generation_hub.md (репо бота), раздел
// «Аватар-конструктор» + docs/briefs/frontend.md, пункт «Full —
// конструкторы Midjourney и Аватар». Тот же принцип, что constructor.js/
// mj_constructor.js: экран собирает настройки, `tg.sendData()` шлёт ОДИН
// payload `start_generation`/`sg`, карточка подтверждения и запуск
// (`avatar_gen_start`) остаются в чате. Общие утилиты (tg, showToast,
// thumbUrl, APP_VERSION, switchTab, isOpenedViaInlineButton) — из app.js;
// аплоадер фото на imgbb — studioCall/studioCompressImageToBase64 из
// studio.js, переиспользуем, не строим заново.
//
// ⚠️ Потолок фото — MAX_AVATAR_PHOTOS=8 (SirNike.py) —
// `_apply_webapp_generation_avatar` сам обрезает лишнее (`refs[:8]`), но
// экран не даёт загрузить больше, чтобы не удивлять юзера тихой обрезкой.
// ⚠️ Невалидный/пустой тип аватара бэкенд сам откатывает на `female` — на
// экране дефолт тоже `female` (женский первым в сегменте, как в макете
// спеки), но бэкенд — источник истины при рассинхроне.
const AV_MAX_PHOTOS = 8;
const AV_KIND_OPTIONS = [
  { value: "female", label: "👩 Женский" },
  { value: "male", label: "👨 Мужской" },
  { value: "child", label: "🧒 Детский" },
];

let avState = { kind: "female", refs: [] };

function renderAvKindSeg() {
  const el = document.getElementById("avKindSeg");
  if (!el) return;
  el.innerHTML = "";
  AV_KIND_OPTIONS.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "segment" + (opt.value === avState.kind ? " active" : "");
    btn.textContent = opt.label;
    btn.addEventListener("click", () => {
      avState.kind = opt.value;
      renderAvKindSeg();
    });
    el.appendChild(btn);
  });
}

function renderAvRefs() {
  const wrap = document.getElementById("avRefs");
  if (!wrap) return;
  wrap.innerHTML = "";
  avState.refs.forEach((url, idx) => {
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
      avState.refs.splice(idx, 1);
      renderAvRefs();
      renderAvContinueBtn();
    });
    thumb.appendChild(img);
    thumb.appendChild(rm);
    wrap.appendChild(thumb);
  });
  const uploadBtn = document.getElementById("avUploadBtn");
  const atLimit = avState.refs.length >= AV_MAX_PHOTOS;
  if (uploadBtn) {
    uploadBtn.disabled = atLimit;
    uploadBtn.title = atLimit ? `Максимум ${AV_MAX_PHOTOS} фото` : "";
  }
}

function renderAvContinueBtn() {
  const btn = document.getElementById("avContinueBtn");
  if (!btn) return;
  btn.disabled = avState.refs.length === 0;
}

// ── prefill (deep-link «✏️ Изменить») ───────────────────────────────────
// Симметрично buildAvStartGenerationPayload — бот кодирует ТУ ЖЕ форму
// полей в base64 JSON (build_generation_prefill/constructor_prefill_url,
// SirNike.py) и кладёт в &prefill= рядом с &tab=avatar_constructor.
// Повреждённый/отсутствующий prefill не должен ронять экран — try/catch,
// экран просто открывается пустым, как сегодня.
function avParsePrefillFromUrl() {
  try {
    const raw = new URLSearchParams(window.location.search).get("prefill");
    if (!raw) return null;
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const json = new TextDecoder("utf-8").decode(bytes);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    console.error("avatar constructor: prefill parse failed, ignoring", e);
    return null;
  }
}

function avApplyPrefill(pf) {
  if (!pf || typeof pf !== "object") return;
  if (AV_KIND_OPTIONS.some((opt) => opt.value === pf.avatar_type)) avState.kind = pf.avatar_type;
  if (Array.isArray(pf.refs)) {
    avState.refs = pf.refs.filter((u) => typeof u === "string" && u).slice(0, AV_MAX_PHOTOS);
  }
}

const avPhotoFile = document.getElementById("avPhotoFile");
document.getElementById("avUploadBtn")?.addEventListener("click", () => {
  if (avState.refs.length >= AV_MAX_PHOTOS) {
    showToast(`Максимум ${AV_MAX_PHOTOS} фото.`);
    return;
  }
  avPhotoFile?.click();
});
avPhotoFile?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const base64 = await studioCompressImageToBase64(file);
    if (!base64) throw new Error("empty base64");
    const data = await studioCall("upload", { image_base64: base64 });
    if (data && data.ok && data.url) {
      avState.refs.push(data.url);
      renderAvRefs();
      renderAvContinueBtn();
    }
  } catch (err) {
    console.error("avatar constructor photo upload failed", err);
    showToast("Не получилось обработать фото.");
  }
});

function buildAvStartGenerationPayload() {
  return JSON.stringify({
    action: "start_generation",
    product: "avatar",
    avatar_type: avState.kind,
    refs: avState.refs,
    v: typeof APP_VERSION !== "undefined" ? APP_VERSION : "avatar-constructor-v1",
  });
}

document.getElementById("avContinueBtn")?.addEventListener("click", () => {
  if (!tg) {
    showToast("Открой Аватар внутри Telegram, чтобы продолжить.");
    return;
  }
  if (typeof isOpenedViaInlineButton === "function" && isOpenedViaInlineButton()) {
    showToast("Из этого входа Аватар не отправит данные. Открой «🪄 Аватар» кнопкой в меню и попробуй ещё раз.");
    return;
  }
  try {
    tg.sendData(buildAvStartGenerationPayload());
    setTimeout(() => tg.close(), 900);
  } catch (e) {
    console.error("avatar constructor sendData failed", e);
    showToast("Не получилось отправить настройки. Попробуй ещё раз.");
  }
});

(function observeAvPriceStrip() {
  const strip = document.getElementById("avPriceStrip");
  if (!strip) return;
  const sync = () => {
    const h = strip.classList.contains("hidden") ? 0 : strip.getBoundingClientRect().height;
    document.documentElement.style.setProperty("--vc-price-strip-space", `${h}px`);
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(sync).observe(strip);
  else window.addEventListener("resize", sync);
  sync();
})();

// Deep-link из бота: «🪄 Аватар» открывает вебапп с &tab=avatar_constructor —
// сразу переключаемся на экран (тот же приём, что у video/mj-конструкторов).
// Бот шлёт строго snake_case (avatar_constructor_kb в SirNike.py).
try {
  if (new URLSearchParams(window.location.search).get("tab") === "avatar_constructor") {
    switchTab("avatarConstructor");
    document.getElementById("avPriceStrip")?.classList.remove("hidden");
  }
} catch { /* не критично */ }

avApplyPrefill(avParsePrefillFromUrl());
renderAvKindSeg();
renderAvRefs();
renderAvContinueBtn();
