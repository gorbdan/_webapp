// Конструктор видео (Хаб генерации, MVP). ТЗ: docs/specs/2026-08-13_webapp_generation_hub.md
// (репо бота). Открывается напрямую с персональной ссылки бота
// (?tab=videoConstructor&cfg=<base64 JSON>) вместо сегодняшней чат-панели
// video_kb — весь подбор настроек тут, один payload в конце
// (action: "start_generation"/"sg"), карточка подтверждения и запуск —
// остаются в чате (см. docstring в начале файла boards.js — тот же принцип:
// sendData закрывает Mini App, генерация идёт минутами, у бота нет
// публичного HTTP, поэтому статус/результат физически не может жить в
// вебаппе). Общие утилиты (tg, showToast, thumbUrl, APP_VERSION, switchTab,
// isOpenedViaInlineButton) — из app.js; аплоадер фото на imgbb —
// studioCall/studioCompressImageToBase64 из studio.js, переиспользуем, не
// строим заново (тот же приём, что уже в boards.js).
//
// ⚠️ Формат `cfg` (список активных моделей/форматов/качества/длительностей/
// цен, которые бот пробрасывает через персональный URL) — бэкенд ещё
// реализует его в параллельной сессии (см. docs/briefs/backend.md). Схема
// ниже — предложение фронтенда, СВЕРИТЬ с тем, что реально пришлёт бэкенд
// (см. docs/BOT_CONTRACT.md, раздел про Конструктор, когда появится) и
// поправить parseConstructorConfig при расхождении. До тех пор — FALLBACK_CONFIG
// ниже даёт рабочий экран для вёрстки и локальной проверки.
//
// Ожидаемая форма cfg (после base64-JSON-декода):
// {
//   "models": [
//     {
//       "id": "seedance2", "label": "Seedance 2", "badge": null,
//       "blurb": "Максимум качества и движения — наш выбор",
//       "formats": ["16:9","9:16","1:1","4:3"],
//       "quality": ["pro","fast"],            // [] или отсутствует — блок «Качество» скрыт
//       "durations": [5,10,15],               // ИЛИ {"custom": [2,10]} — свободный ввод (Wan 2.7)
//       "face_grid": true,                    // поддержка тумблера детектора лиц
//       "prices": {"pro": {"5":20,"10":45,"15":65}, "fast": {"5":15,"10":30,"15":45}}
//       // без качества — prices плоский: {"5":20,"10":45,"15":65}
//     }
//   ],
//   "default_model": "seedance2"
// }

const FALLBACK_CONFIG = {
  models: [
    {
      id: "seedance2", label: "Seedance 2", badge: null,
      blurb: "Максимум качества и движения — наш выбор",
      formats: ["16:9", "9:16", "1:1", "4:3"], quality: ["pro", "fast"], durations: [5, 10, 15],
      face_grid: true,
      prices: { pro: { "5": 20, "10": 45, "15": 65 }, fast: { "5": 15, "10": 30, "15": 45 } },
    },
    {
      id: "seedance2_fast", label: "Seedance 2 Fast", badge: null,
      blurb: "Быстрее и дешевле, чуть проще движение",
      formats: ["16:9", "9:16", "1:1", "4:3"], quality: [], durations: [5, 10, 15],
      face_grid: true,
      prices: { "5": 12, "10": 22, "15": 32 },
    },
    {
      id: "kling3", label: "Kling 3.0", badge: "🆕",
      blurb: "Кинематографичная динамика кадра",
      formats: ["16:9", "9:16", "1:1", "4:3"], quality: [], durations: [5, 10],
      face_grid: false,
      prices: { "5": 30, "10": 55 },
    },
    {
      id: "veo31", label: "Veo 3.1", badge: "🆕",
      blurb: "Реалистичная физика и звук",
      formats: ["16:9", "9:16"], quality: [], durations: [5, 10],
      face_grid: false,
      prices: { "5": 35, "10": 65 },
    },
    {
      id: "wan27", label: "Wan 2.7", badge: "🆕",
      blurb: "Гибкая длительность под задачу",
      formats: ["16:9", "9:16"], quality: [], durations: { custom: [2, 10] },
      face_grid: false,
      prices: { per_second: 4 },
    },
    {
      id: "gemini_omni", label: "Gemini Omni", badge: "🆕",
      blurb: "Универсальная модель для сложных сцен",
      formats: ["16:9", "9:16"], quality: [], durations: [5, 10],
      face_grid: false,
      prices: { "5": 28, "10": 50 },
    },
    {
      id: "seedance25", label: "Seedance 2.5", badge: "💎",
      blurb: "Премиум-модель, максимум детализации",
      formats: ["16:9", "9:16"], quality: [], durations: [5, 10],
      face_grid: false,
      prices: { "5": 60, "10": 110 },
    },
  ],
  default_model: "seedance2",
};

const VC_FORMAT_LABELS = { "16:9": "📺 16:9", "9:16": "📱 9:16", "1:1": "⬛ 1:1", "4:3": "🖼 4:3" };
const VC_QUALITY_LABELS = { pro: "🔥 Pro", fast: "⚡ Fast" };
const VC_MAX_PHOTOS = 9;
const VC_DESCRIPTION_MAX_BYTES = 3500; // тот же порог, что у set_prompt (docs/BOT_CONTRACT.md)

let vcConfig = FALLBACK_CONFIG;
let vcState = {
  model: null,
  aspect: null,
  quality: null,
  duration: null,
  customDuration: null,
  faceGrid: true,
  description: "",
  photos: [], // локально загруженные (imgbb URL), без фото активной доски — те мёрджатся при отправке
};

function parseConstructorConfig() {
  try {
    const raw = new URLSearchParams(window.location.search).get("cfg");
    if (!raw) return FALLBACK_CONFIG;
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const json = new TextDecoder("utf-8").decode(bytes);
    const parsed = JSON.parse(json);
    if (!parsed || !Array.isArray(parsed.models) || parsed.models.length === 0) return FALLBACK_CONFIG;
    return parsed;
  } catch (e) {
    console.error("constructor: cfg parse failed, using fallback", e);
    return FALLBACK_CONFIG;
  }
}

function vcGetModel(id) {
  return vcConfig.models.find((m) => m.id === id) || vcConfig.models[0];
}

function vcHasCustomDuration(model) {
  return model.durations && !Array.isArray(model.durations) && Array.isArray(model.durations.custom);
}

// ── Инициализация состояния под выбранную модель ───────────────────────

function vcResetStateForModel(modelId) {
  const model = vcGetModel(modelId);
  vcState.model = model.id;
  if (!model.formats.includes(vcState.aspect)) vcState.aspect = model.formats[0];
  vcState.quality = model.quality && model.quality.length ? model.quality[0] : null;
  if (vcHasCustomDuration(model)) {
    const [min] = model.durations.custom;
    vcState.duration = null;
    vcState.customDuration = vcState.customDuration || min;
  } else {
    vcState.duration = model.durations[0];
    vcState.customDuration = null;
  }
  vcState.faceGrid = !!model.face_grid;
}

// ── Рендер ───────────────────────────────────────────────────────────

function renderVcModelGrid() {
  const grid = document.getElementById("vcModelGrid");
  const blurb = document.getElementById("vcModelBlurb");
  if (!grid) return;
  grid.innerHTML = "";
  vcConfig.models.forEach((m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vc-model-chip" + (vcState.model === m.id ? " active" : "");
    btn.textContent = m.badge ? `${m.label} ${m.badge}` : m.label;
    btn.addEventListener("click", () => {
      if (vcState.model === m.id) return;
      vcResetStateForModel(m.id);
      renderVcAll();
    });
    grid.appendChild(btn);
  });
  const current = vcGetModel(vcState.model);
  if (blurb) blurb.textContent = current.blurb || "";
}

function renderVcSegment(containerId, options, activeValue, labelFn, onPick) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = "";
  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "segment" + (opt === activeValue ? " active" : "");
    btn.textContent = labelFn(opt);
    btn.addEventListener("click", () => {
      onPick(opt);
      renderVcAll();
    });
    el.appendChild(btn);
  });
}

function renderVcAspect() {
  const model = vcGetModel(vcState.model);
  renderVcSegment("vcAspectSeg", model.formats, vcState.aspect, (v) => VC_FORMAT_LABELS[v] || v, (v) => {
    vcState.aspect = v;
  });
}

function renderVcQuality() {
  const model = vcGetModel(vcState.model);
  const block = document.getElementById("vcQualityBlock");
  const hasQuality = model.quality && model.quality.length > 0;
  block.classList.toggle("hidden", !hasQuality);
  if (!hasQuality) return;
  renderVcSegment("vcQualitySeg", model.quality, vcState.quality, (v) => VC_QUALITY_LABELS[v] || v, (v) => {
    vcState.quality = v;
  });
}

function renderVcDuration() {
  const model = vcGetModel(vcState.model);
  const el = document.getElementById("vcDurationSeg");
  if (!el) return;
  el.innerHTML = "";
  if (vcHasCustomDuration(model)) {
    const [min, max] = model.durations.custom;
    const wrap = document.createElement("div");
    wrap.className = "vc-custom-duration";
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.value = String(vcState.customDuration ?? min);
    input.addEventListener("input", () => {
      const val = Math.min(max, Math.max(min, parseInt(input.value, 10) || min));
      vcState.customDuration = val;
      renderVcPrice();
      renderVcContinueBtn();
    });
    const suffix = document.createElement("span");
    suffix.className = "vc-custom-duration-suffix";
    suffix.textContent = `с (${min}–${max})`;
    wrap.appendChild(input);
    wrap.appendChild(suffix);
    el.appendChild(wrap);
    return;
  }
  renderVcSegment("vcDurationSeg", model.durations, vcState.duration, (v) => `${v}с`, (v) => {
    vcState.duration = v;
  });
}

function renderVcFaceGrid() {
  const model = vcGetModel(vcState.model);
  const block = document.getElementById("vcFaceGridBlock");
  block.classList.toggle("hidden", !model.face_grid);
  const toggle = document.getElementById("vcFaceGridToggle");
  if (toggle) toggle.checked = vcState.faceGrid;
}

function vcCalcPrice() {
  const model = vcGetModel(vcState.model);
  const prices = model.prices || {};
  if (model.prices && model.prices.per_second) {
    const dur = vcState.customDuration || 0;
    return Math.round(model.prices.per_second * dur);
  }
  const bucket = vcState.quality ? prices[vcState.quality] : prices;
  if (!bucket) return null;
  const key = String(vcHasCustomDuration(model) ? vcState.customDuration : vcState.duration);
  const val = bucket[key];
  return typeof val === "number" ? val : null;
}

function renderVcPrice() {
  const amountEl = document.getElementById("vcPriceAmount");
  if (!amountEl) return;
  const price = vcCalcPrice();
  amountEl.textContent = price === null ? "цена уточнится в чате" : `≈ ${price} 🍇`;
}

function renderVcRefs() {
  const wrap = document.getElementById("vcRefs");
  if (!wrap) return;
  wrap.innerHTML = "";
  vcState.photos.forEach((url, idx) => {
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
      vcState.photos.splice(idx, 1);
      renderVcRefs();
      renderVcContinueBtn();
    });
    thumb.appendChild(img);
    thumb.appendChild(rm);
    wrap.appendChild(thumb);
  });
  const uploadBtn = document.getElementById("vcUploadBtn");
  const atLimit = vcState.photos.length >= VC_MAX_PHOTOS;
  if (uploadBtn) {
    uploadBtn.disabled = atLimit;
    uploadBtn.title = atLimit ? `Максимум ${VC_MAX_PHOTOS} фото` : "";
  }
}

function vcActiveBoardPhotos() {
  // Доски (docs/specs/2026-08-09_mood_boards.md) — если активна, её фото
  // мёрджатся в refs ДО отправки (см. спеку хаба генерации, «Новый контракт
  // payload», поле refs). getActiveBoard/getBoardById — из boards.js.
  if (typeof getActiveBoard !== "function") return { photos: [], boardId: null, name: "" };
  const board = getActiveBoard();
  if (!board) return { photos: [], boardId: null, name: "" };
  return { photos: board.photos || [], boardId: board.id, name: board.name };
}

function renderVcBoardNote() {
  const el = document.getElementById("vcBoardNote");
  if (!el) return;
  const { boardId, name } = vcActiveBoardPhotos();
  if (!boardId) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  el.textContent = `🖼️ Фото с доски «${name}» тоже добавятся к генерации`;
}

function vcDescriptionByteLength() {
  return new TextEncoder().encode(vcState.description).length;
}

function renderVcContinueBtn() {
  const btn = document.getElementById("vcContinueBtn");
  if (!btn) return;
  const { photos: boardPhotos } = vcActiveBoardPhotos();
  const hasInput = vcState.description.trim().length > 0 || vcState.photos.length > 0 || boardPhotos.length > 0;
  btn.disabled = !hasInput;
}

function renderVcAll() {
  renderVcModelGrid();
  renderVcAspect();
  renderVcQuality();
  renderVcDuration();
  renderVcFaceGrid();
  renderVcPrice();
  renderVcRefs();
  renderVcBoardNote();
  renderVcContinueBtn();
}

// ── Ввод описания ───────────────────────────────────────────────────

const vcDescriptionInput = document.getElementById("vcDescriptionInput");
vcDescriptionInput?.addEventListener("input", () => {
  let text = vcDescriptionInput.value;
  // Тот же порог и приём, что у set_prompt (docs/BOT_CONTRACT.md) — резать
  // по границе символа в UTF-8-байтах, не молча обрубать посреди символа.
  while (new TextEncoder().encode(text).length > VC_DESCRIPTION_MAX_BYTES) {
    text = text.slice(0, -1);
  }
  if (text !== vcDescriptionInput.value) vcDescriptionInput.value = text;
  vcState.description = text;
  renderVcContinueBtn();
});

document.getElementById("vcFaceGridToggle")?.addEventListener("change", (e) => {
  vcState.faceGrid = e.target.checked;
});

document.getElementById("vcFaceGridInfo")?.addEventListener("click", () => {
  showToast(
    vcState.faceGrid
      ? "Защита от отказа модерации ценой лёгкой сетки на кадре"
      : "Чистый кадр, но реальное фото может резаться модерацией"
  );
});

// ── Загрузка фото — переиспользует imgbb-аплоадер Студии/Досок ─────────

const vcPhotoFile = document.getElementById("vcPhotoFile");
document.getElementById("vcUploadBtn")?.addEventListener("click", () => {
  if (vcState.photos.length >= VC_MAX_PHOTOS) {
    showToast(`Максимум ${VC_MAX_PHOTOS} фото.`);
    return;
  }
  vcPhotoFile?.click();
});
vcPhotoFile?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const base64 = await studioCompressImageToBase64(file);
    if (!base64) throw new Error("empty base64");
    const data = await studioCall("upload", { image_base64: base64 });
    if (data && data.ok && data.url) {
      vcState.photos.push(data.url);
      renderVcRefs();
      renderVcContinueBtn();
    }
  } catch (err) {
    console.error("constructor photo upload failed", err);
    showToast("Не получилось обработать фото.");
  }
});

// ── Отправка в чат (Экран V2 собирается ботом) ──────────────────────

function buildStartGenerationPayload() {
  const model = vcGetModel(vcState.model);
  const { photos: boardPhotos, boardId } = vcActiveBoardPhotos();
  const refs = [...vcState.photos, ...boardPhotos];
  const payload = {
    action: "start_generation",
    product: "video",
    video_model: vcState.model,
    aspect: vcState.aspect,
    duration: vcHasCustomDuration(model) ? vcState.customDuration : vcState.duration,
    description: vcState.description.trim(),
    v: typeof APP_VERSION !== "undefined" ? APP_VERSION : "constructor-v1",
  };
  if (vcState.quality) payload.quality = vcState.quality;
  if (model.face_grid) payload.face_grid = vcState.faceGrid;
  if (refs.length) payload.refs = refs.slice(0, 9);
  if (boardId) payload.board_id = boardId;
  return JSON.stringify(payload);
}

document.getElementById("vcContinueBtn")?.addEventListener("click", () => {
  if (!tg) {
    showToast("Открой Конструктор внутри Telegram, чтобы продолжить.");
    return;
  }
  // Тот же принцип, что у Досок (boards.js) — sendData доставляет данные
  // ТОЛЬКО когда вебапп открыт с reply-клавиатуры, не с инлайн-кнопки.
  if (typeof isOpenedViaInlineButton === "function" && isOpenedViaInlineButton()) {
    showToast("Из этого входа Конструктор не отправит данные. Открой «🎬 Видео для Reels» кнопкой в меню снизу и попробуй ещё раз.");
    return;
  }
  try {
    tg.sendData(buildStartGenerationPayload());
    setTimeout(() => tg.close(), 900);
  } catch (e) {
    console.error("constructor sendData failed", e);
    showToast("Не получилось отправить настройки. Попробуй ещё раз.");
  }
});

// ── Инициализация ────────────────────────────────────────────────────

vcConfig = parseConstructorConfig();
vcResetStateForModel(vcConfig.default_model || vcConfig.models[0].id);
renderVcAll();
document.getElementById("vcPriceStrip")?.classList.remove("hidden");

// --vc-price-strip-space — тот же приём, что --studio-cart-space/
// --board-banner-space: JS-измеренная высота sticky-подвала, а не
// захардкоженная константа (реальная высота зависит от
// env(safe-area-inset-bottom) устройства).
(function observeVcPriceStrip() {
  const strip = document.getElementById("vcPriceStrip");
  if (!strip) return;
  const sync = () => {
    const h = strip.classList.contains("hidden") ? 0 : strip.getBoundingClientRect().height;
    document.documentElement.style.setProperty("--vc-price-strip-space", `${h}px`);
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(sync).observe(strip);
  else window.addEventListener("resize", sync);
  sync();
})();

// Deep-link из бота: «🎬 Видео для Reels» открывает вебапп с
// ?tab=videoConstructor&cfg=... — сразу переключаемся на конструктор (тот
// же приём, что studio.js делает для ?tab=studio, но конструктор в MVP не
// висит кнопкой в tab-bar, поэтому переключаем экран напрямую, не кликом).
try {
  if (new URLSearchParams(window.location.search).get("tab") === "videoConstructor") {
    switchTab("videoConstructor");
  }
} catch { /* не критично */ }
