// Конструктор видео (Хаб генерации, MVP). ТЗ: docs/specs/2026-08-13_webapp_generation_hub.md
// (репо бота). Открывается напрямую с персональной ссылки бота
// (&tab=video_constructor&cfg=<base64 JSON>) вместо сегодняшней чат-панели
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
// ⚠️ Формат `cfg` — СВЕРЕНО с реальным бэкендом (SirNike.py,
// _video_constructor_cfg_payload(), строка ~1274), не с черновиком спеки:
// {
//   "video_models": [
//     {
//       "code": "seedance2", "label": "Seedance 2",
//       "blurb": "максимум качества и движения, наш выбор",
//       "aspects": ["16:9","9:16","1:1","4:3"],
//       "modes": ["480p","720p","1080p"],      // может быть 1 элемент — тогда без тумблера «Качество»
//       "durations": [5,10,15],
//       "face_grid": true,
//       "prices": {"480p": {"5":20,"10":45,"15":65}, "720p": {...}, "1080p": {...}}
//       // ключ prices может быть и "default", если modes пуст — на практике не бывает
//     }, ...
//   ]
// }
// Нет отдельного default_model — бот всегда кладёт seedance2 первым (он
// включён без фичефлага), поэтому дефолт конструктора = первая модель списка.
//
// ⚠️ Бэкенд умеет различать в payload.quality ТОЛЬКО "fast" (-> реальный
// режим "480p", если он есть у модели) и всё остальное (-> "720p", если он
// есть у модели, иначе первый доступный режим) — см.
// _apply_webapp_generation_video в SirNike.py. Поэтому тумблер «Качество»
// в конструкторе — всегда бинарный 🔥Pro/⚡Fast, а не список реальных modes;
// показываем его только если у модели есть "480p" (иначе бэкенд всё равно
// не даст выбрать ничего, кроме 720p/дефолта — незачем врать тумблером).

const FALLBACK_CFG = {
  video_models: [
    {
      code: "seedance2", label: "Seedance 2",
      blurb: "максимум качества и движения, наш выбор",
      aspects: ["16:9", "9:16", "1:1", "4:3"], modes: ["480p", "720p", "1080p"], durations: [5, 10, 15],
      face_grid: true,
      prices: { "480p": { "5": 15, "10": 28, "15": 40 }, "720p": { "5": 20, "10": 45, "15": 65 }, "1080p": { "5": 30, "10": 60, "15": 85 } },
    },
    {
      code: "seedance2_fast", label: "Seedance 2 Fast (бета)",
      blurb: "быстрее и дешевле, попроще картинка",
      aspects: ["16:9", "9:16", "1:1", "4:3"], modes: ["720p"], durations: [5, 10, 15],
      face_grid: true,
      prices: { "720p": { "5": 12, "10": 22, "15": 32 } },
    },
    {
      code: "kling3", label: "Kling 3.0 🆕",
      blurb: "оживляет фото, плавная камера",
      aspects: ["16:9", "9:16", "1:1", "4:3"], modes: ["720p", "1080p"], durations: [5, 10],
      face_grid: false,
      prices: { "720p": { "5": 30, "10": 55 }, "1080p": { "5": 40, "10": 75 } },
    },
    {
      code: "veo31", label: "Veo 3.1 (Google) 🆕",
      blurb: "кинореализм, до 8 сек",
      aspects: ["16:9", "9:16"], modes: ["720p"], durations: [4, 6, 8],
      face_grid: false,
      prices: { "720p": { "4": 28, "6": 42, "8": 56 } },
    },
    {
      code: "wan27", label: "Wan 2.7 (Alibaba) 🆕",
      blurb: "живая мимика и жесты",
      aspects: ["16:9", "9:16"], modes: ["480p", "720p", "1080p"], durations: [5, 10],
      face_grid: false,
      prices: { "480p": { "5": 18, "10": 32 }, "720p": { "5": 24, "10": 44 }, "1080p": { "5": 32, "10": 58 } },
    },
    {
      code: "gemini_omni", label: "Gemini Omni Flash 🆕",
      blurb: "звук генерируется сам, быстрая генерация",
      aspects: ["16:9", "9:16"], modes: ["480p", "720p", "1080p"], durations: [5, 10],
      face_grid: false,
      prices: { "480p": { "5": 20, "10": 36 }, "720p": { "5": 28, "10": 50 }, "1080p": { "5": 36, "10": 64 } },
    },
    {
      code: "seedance25", label: "Seedance 2.5 💎",
      blurb: "премиум: до 30 сек без склейки, 50 референсов",
      aspects: ["16:9", "9:16"], modes: ["480p", "720p"], durations: [5, 10, 15],
      face_grid: false,
      prices: { "480p": { "5": 40, "10": 75, "15": 105 }, "720p": { "5": 60, "10": 110, "15": 155 } },
    },
  ],
};

const VC_FORMAT_LABELS = { "16:9": "📺 16:9", "9:16": "📱 9:16", "1:1": "⬛ 1:1", "4:3": "🖼 4:3" };
const VC_QUALITY_LABELS = { pro: "🔥 Pro", fast: "⚡ Fast" };
const VC_MAX_PHOTOS = 9;
const VC_DESCRIPTION_MAX_BYTES = 3500; // тот же порог, что у set_prompt (docs/BOT_CONTRACT.md)

let vcModels = [];
let vcState = {
  model: null,
  aspect: null,
  quality: null, // "pro" | "fast" | null (модель без тумблера качества)
  duration: null,
  faceGrid: true,
  description: "",
  photos: [], // локально загруженные (imgbb URL), без фото активной доски — те мёрджатся при отправке
};

// ── cfg -> внутренняя модель ────────────────────────────────────────────

function vcModelFromCfgEntry(m) {
  const modes = Array.isArray(m.modes) ? m.modes.filter(Boolean) : [];
  return {
    code: String(m.code || "").trim(),
    label: String(m.label || m.code || "").trim(),
    blurb: String(m.blurb || "").trim(),
    formats: Array.isArray(m.aspects) && m.aspects.length ? m.aspects : ["16:9", "9:16"],
    durations: Array.isArray(m.durations) && m.durations.length ? m.durations : [5],
    faceGrid: !!m.face_grid,
    hasQualityToggle: modes.includes("480p"),
    modes, // нужен целиком (не только hasQualityToggle) — см. vcPriceBucketKey
    prices: m.prices && typeof m.prices === "object" ? m.prices : {},
  };
}

function parseCfgFromUrl() {
  try {
    const raw = new URLSearchParams(window.location.search).get("cfg");
    if (!raw) return FALLBACK_CFG;
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const json = new TextDecoder("utf-8").decode(bytes);
    const parsed = JSON.parse(json);
    if (!parsed || !Array.isArray(parsed.video_models) || parsed.video_models.length === 0) return FALLBACK_CFG;
    return parsed;
  } catch (e) {
    console.error("constructor: cfg parse failed, using fallback", e);
    return FALLBACK_CFG;
  }
}

function vcGetModel(code) {
  return vcModels.find((m) => m.code === code) || vcModels[0];
}

// ── prefill (deep-link «✏️ Изменить» / библиотечное «Использовать») ────
// Симметрично buildStartGenerationPayload — бот кодирует ТУ ЖЕ форму полей
// в base64 JSON (build_generation_prefill/constructor_prefill_url,
// SirNike.py) и кладёт в &prefill= рядом с &tab=video_constructor.
// Повреждённый/отсутствующий prefill не должен ронять экран — try/catch,
// экран просто открывается пустым, как сегодня.
function vcParsePrefillFromUrl() {
  try {
    const raw = new URLSearchParams(window.location.search).get("prefill");
    if (!raw) return null;
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const json = new TextDecoder("utf-8").decode(bytes);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    console.error("constructor: prefill parse failed, ignoring", e);
    return null;
  }
}

function vcApplyPrefill(pf) {
  if (!pf || typeof pf !== "object") return;
  const modelCode = vcModels.some((m) => m.code === pf.video_model) ? pf.video_model : vcModels[0].code;
  vcResetStateForModel(modelCode);
  const model = vcGetModel(modelCode);
  if (typeof pf.aspect === "string" && model.formats.includes(pf.aspect)) vcState.aspect = pf.aspect;
  if (model.hasQualityToggle && (pf.quality === "pro" || pf.quality === "fast")) vcState.quality = pf.quality;
  const duration = typeof pf.duration === "string" ? Number(pf.duration) : pf.duration;
  if (typeof duration === "number" && model.durations.includes(duration)) vcState.duration = duration;
  if (model.faceGrid && typeof pf.face_grid === "boolean") vcState.faceGrid = pf.face_grid;
  if (typeof pf.description === "string") {
    vcState.description = pf.description;
    if (vcDescriptionInput) vcDescriptionInput.value = pf.description;
  }
  if (Array.isArray(pf.refs)) {
    vcState.photos = pf.refs.filter((u) => typeof u === "string" && u).slice(0, VC_MAX_PHOTOS);
  }
}

// ── Инициализация состояния под выбранную модель ───────────────────────

function vcResetStateForModel(code) {
  const model = vcGetModel(code);
  vcState.model = model.code;
  if (!model.formats.includes(vcState.aspect)) vcState.aspect = model.formats[0];
  vcState.quality = model.hasQualityToggle ? "pro" : null;
  if (!model.durations.includes(vcState.duration)) vcState.duration = model.durations[0];
  vcState.faceGrid = model.faceGrid;
}

// ── Цена — зеркало резолва _apply_webapp_generation_video на бэкенде ───

// Зеркалит resolve_webapp_video_quality (SirNike.py) буква в букву: «Fast» —
// САМЫЙ ЛЁГКИЙ доступный режим модели (первый в modes), «Pro»/дефолт —
// САМЫЙ КАЧЕСТВЕННЫЙ (последний в modes), НЕ фиксированный "720p". Раньше
// тут был захардкожен приоритет на "720p" для pro — у Seedance 2 (модели
// 480p/720p/1080p) это давало «Будет стоить ≈20», хотя бот реально резолвит
// pro в 1080p и спишет 30 — расхождение с ценой в карточке подтверждения,
// именно тот баг, что явно запрещён критерием приёмки спеки.
function vcPriceBucketKey(model) {
  const keys = Object.keys(model.prices || {});
  if (keys.length === 0) return null;
  const modes = Array.isArray(model.modes) && model.modes.length ? model.modes : keys;
  const target = model.hasQualityToggle && vcState.quality === "fast" ? modes[0] : modes[modes.length - 1];
  if (target && keys.includes(target)) return target;
  return keys[0];
}

function vcCalcPrice() {
  const model = vcGetModel(vcState.model);
  const bucketKey = vcPriceBucketKey(model);
  if (!bucketKey) return null;
  const bucket = model.prices[bucketKey] || {};
  const val = bucket[String(vcState.duration)];
  return typeof val === "number" ? val : null;
}

// ── Рендер ───────────────────────────────────────────────────────────

function renderVcModelGrid() {
  const grid = document.getElementById("vcModelGrid");
  const blurb = document.getElementById("vcModelBlurb");
  if (!grid) return;
  grid.innerHTML = "";
  vcModels.forEach((m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vc-model-chip" + (vcState.model === m.code ? " active" : "");
    btn.textContent = m.label;
    btn.addEventListener("click", () => {
      if (vcState.model === m.code) return;
      vcResetStateForModel(m.code);
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
  block.classList.toggle("hidden", !model.hasQualityToggle);
  if (!model.hasQualityToggle) return;
  renderVcSegment("vcQualitySeg", ["pro", "fast"], vcState.quality, (v) => VC_QUALITY_LABELS[v] || v, (v) => {
    vcState.quality = v;
  });
}

function renderVcDuration() {
  const model = vcGetModel(vcState.model);
  renderVcSegment("vcDurationSeg", model.durations, vcState.duration, (v) => `${v}с`, (v) => {
    vcState.duration = v;
  });
}

function renderVcFaceGrid() {
  const model = vcGetModel(vcState.model);
  const block = document.getElementById("vcFaceGridBlock");
  block.classList.toggle("hidden", !model.faceGrid);
  const toggle = document.getElementById("vcFaceGridToggle");
  if (toggle) toggle.checked = vcState.faceGrid;
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
    duration: vcState.duration,
    description: vcState.description.trim(),
    v: typeof APP_VERSION !== "undefined" ? APP_VERSION : "constructor-v1",
  };
  if (model.hasQualityToggle && vcState.quality) payload.quality = vcState.quality;
  if (model.faceGrid) payload.face_grid = vcState.faceGrid;
  if (refs.length) payload.refs = refs.slice(0, 9);
  if (boardId) payload.board_id = boardId;
  return JSON.stringify(payload);
}

document.getElementById("vcContinueBtn")?.addEventListener("click", () => {
  if (!tg) {
    showToast("Открой Конструктор внутри Telegram, чтобы продолжить.");
    return;
  }
  // sendData работает только с reply-клавиатуры/Menu Button — с инлайн-
  // кнопки (в т.ч. «✏️ Изменить» на карточке подтверждения) обязателен
  // answerWebAppQuery (см. sendGenerationPayloadViaAnswerWebAppQuery в app.js).
  if (typeof isOpenedViaInlineButton === "function" && isOpenedViaInlineButton()) {
    sendGenerationPayloadViaAnswerWebAppQuery(buildStartGenerationPayload());
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

vcModels = parseCfgFromUrl().video_models.map(vcModelFromCfgEntry);
vcResetStateForModel(vcModels[0].code);
vcApplyPrefill(vcParsePrefillFromUrl());
renderVcAll();

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
// &tab=video_constructor&cfg=... — сразу переключаемся на конструктор (тот
// же приём, что studio.js делает для ?tab=studio). ⚠️ Бэкенд шлёт именно
// "video_constructor" (snake_case, video_constructor_kb в SirNike.py), не
// "videoConstructor" — тот camelCase используется ТОЛЬКО как внутреннее имя
// экрана для switchTab()/APP_TITLES, не как значение query-параметра tab.
// (Живой баг, найденный при аудите этой ветки: сравнение шло с неверной
// строкой, и конструктор никогда не открывался автоматически по ссылке
// бота — юзер видел пустой каталог.) Прячем ценовую панель (vcPriceStrip),
// пока экран реально не активен — она стоит вне .tab-page и раньше
// показывалась безусловно на любой вкладке.
try {
  if (new URLSearchParams(window.location.search).get("tab") === "video_constructor") {
    switchTab("videoConstructor");
    document.getElementById("vcPriceStrip")?.classList.remove("hidden");
  }
} catch { /* не критично */ }
