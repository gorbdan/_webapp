// Доски (mood-борды), MVP «Доска = коллекция референсов».
// ТЗ: docs/specs/2026-08-09_mood_boards.md (репо бота, раздел «MVP»).
// Хранение — ТОЛЬКО localStorage устройства (осознанное упрощение MVP, без
// синка между устройствами и без D1 — см. спеку). Общие утилиты (tg,
// showToast, normalizeUrl, thumbUrl, APP_VERSION, render/renderCards,
// switchTab, activeCategory/activeFilter/query, searchInput) — из app.js;
// аплоадер фото на imgbb — studioCall("upload", ...) + studioCompressImageToBase64
// из studio.js, ПЕРЕИСПОЛЬЗУЕМ уже готовую и задеплоенную Cloudflare Function
// Студии нейромультиков (docs/specs/2026-07-20_cartoon_studio.md), новый
// аплоадер не пишем. Все три файла — обычные (не module) скрипты в одном
// документе, общий top-level scope (см. комментарий в начале studio.js).
//
// Контракт с ботом (SirNike.py, apply_webapp_board_refs_payload) СОГЛАСОВАН
// по факту уже реализованного на бэкенде парсера — payload:
//   { action: "board_refs", title: "<имя доски>", board_refs: ["<url>", ...] }
// (алиасы на стороне бота: action "connect_board"/"br", поля "t"/"br" —
// вебапп шлёт полные имена, короткие не нужны при таком размере payload).
//
// Full «✨ Понять мой стиль» (2026-08-09) — отдельный экшен, ТЗ бэкенду
// docs/specs/2026-08-09_mood_boards_full.md (репо бота):
//   { action: "board_style_analyze", board_id, title, board_refs: ["<url>", ...] }
// Ответ (текст описания стиля + подтверждение/отключение) живёт целиком в
// чате бота — вебапп не пытается получить его синхронно обратно (нет
// публичного HTTP-моста бот↔вебапп для этого). `board.styleRequested` —
// чисто локальный косметический флаг для копирайта баннера/статуса
// (какая доска когда-либо отправлялась на AI-анализ), реальное состояние
// «стиль подмешивается» живёт на боте.

const BOARDS_STORAGE_KEY = "sirnike_mood_boards_v1";
const BOARDS_MAX_BOARDS = 5;
const BOARDS_MAX_PHOTOS_PER_BOARD = 10;
const BOARDS_MAX_REFS_PER_GEN = 8;
const BOARDS_MIN_PHOTOS_FOR_STYLE = 2; // меньше — недостаточно для «стиля подборки»

let boardsState = loadBoardsState();
let boardOverlayBoardId = null; // какая доска сейчас открыта в оверлее (Экран 2)

// ── Хранилище ────────────────────────────────────────────────

function loadBoardsState() {
  try {
    const raw = JSON.parse(localStorage.getItem(BOARDS_STORAGE_KEY) || "{}");
    const boards = Array.isArray(raw.boards) ? raw.boards.filter((b) => b && b.id) : [];
    const activeId = typeof raw.activeId === "string" ? raw.activeId : null;
    return { boards, activeId: boards.some((b) => b.id === activeId) ? activeId : null };
  } catch {
    return { boards: [], activeId: null };
  }
}

function saveBoardsState() {
  try {
    localStorage.setItem(BOARDS_STORAGE_KEY, JSON.stringify(boardsState));
  } catch (e) {
    console.error("boards: localStorage save failed", e);
  }
}

function boardsUuid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return `b_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getBoardById(id) {
  return boardsState.boards.find((b) => b.id === id) || null;
}

function getActiveBoard() {
  return boardsState.activeId ? getBoardById(boardsState.activeId) : null;
}

function createBoard(name) {
  const board = {
    id: boardsUuid(),
    name: String(name || "").trim().slice(0, 60) || "Без названия",
    photos: [],
    createdAt: new Date().toISOString(),
  };
  boardsState.boards.unshift(board); // новая доска — первой в ряду, видна сразу без скролла
  saveBoardsState();
  return board;
}

function renameBoard(id, name) {
  const board = getBoardById(id);
  if (!board) return;
  const clean = String(name || "").trim().slice(0, 60);
  if (clean) board.name = clean;
  saveBoardsState();
}

function deleteBoard(id) {
  boardsState.boards = boardsState.boards.filter((b) => b.id !== id);
  if (boardsState.activeId === id) boardsState.activeId = null;
  saveBoardsState();
}

function setActiveBoardId(id) {
  boardsState.activeId = id;
  saveBoardsState();
}

function deactivateBoard() {
  boardsState.activeId = null;
  saveBoardsState();
}

function addPhotoToBoard(id, url) {
  const board = getBoardById(id);
  if (!board || !url) return false;
  if (board.photos.length >= BOARDS_MAX_PHOTOS_PER_BOARD) return false;
  board.photos.push(url);
  saveBoardsState();
  return true;
}

function removePhotoFromBoard(id, index) {
  const board = getBoardById(id);
  if (!board) return;
  board.photos.splice(index, 1);
  saveBoardsState();
}

// ── Диалоги (та же логика открытия/закрытия, что categorySheet в app.js) ──

function showBoardDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeBoardDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}

// ── Баннер активной доски (закреплён на ВСЕХ экранах каталога) ─────────

// Единая навигация (Full, docs/specs/2026-08-13_webapp_generation_hub_navigation_full.md,
// раздел 1.7): баннер активной доски теперь виден на ДВУХ экранах —
// «Стили» (#boardBanner, как раньше) и «Создать» (#createBoardBanner, новый
// в index.html, тот же текст/поведение). Один источник состояния
// (getActiveBoard), просто синкаем оба DOM-узла.
function renderBoardBanner() {
  const targets = [
    { banner: document.getElementById("boardBanner"), text: document.getElementById("boardBannerText") },
    { banner: document.getElementById("createBoardBanner"), text: document.getElementById("createBoardBannerText") },
  ];
  const board = getActiveBoard();
  targets.forEach(({ banner, text }) => {
    if (!banner || !text) return;
    if (!board) {
      banner.classList.add("hidden");
    } else {
      text.textContent = board.styleRequested
        ? `🖼️ Доска «${board.name}» активна — стиль ИИ подмешивается в каждую генерацию`
        : `🖼️ Доска «${board.name}» активна`;
      banner.classList.remove("hidden");
    }
  });
  syncBoardBannerSpace();
}

// Toolbar (поиск+фильтры) — тоже sticky top:0. Баннер стоит НАД ним и
// сдвигает его вниз на свою реальную высоту через CSS-переменную (тот же
// приём, что --studio-cart-space в studio.css/js), иначе баннер и toolbar
// перекрывали бы друг друга при скролле.
function syncBoardBannerSpace() {
  const banner = document.getElementById("boardBanner");
  const space = banner && !banner.classList.contains("hidden") ? banner.getBoundingClientRect().height : 0;
  document.documentElement.style.setProperty("--board-banner-space", `${space}px`);
}

(function observeBoardBanner() {
  const banner = document.getElementById("boardBanner");
  if (!banner) return;
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => syncBoardBannerSpace()).observe(banner);
  } else {
    window.addEventListener("resize", syncBoardBannerSpace);
  }
})();

// Единая навигация (Full): «Доски» — отдельный первоуровневый таб, не
// подраздел каталога (раздел 1.6 спеки). «Сменить» на баннере активной
// доски (на «Стили» и на «Создать») теперь переключает СЮДА клиентским
// роутингом, без сброса фильтров каталога (они больше не относятся к делу —
// доски больше не живут внутри каталога).
function goToBoardsSection() {
  if (typeof switchTab === "function") switchTab("boards");
  if (typeof renderBoardsPage === "function") renderBoardsPage();
}

document.getElementById("boardBannerSwitch")?.addEventListener("click", goToBoardsSection);
document.getElementById("createBoardBannerSwitch")?.addEventListener("click", goToBoardsSection);
document.getElementById("boardBannerDisable")?.addEventListener("click", () => {
  deactivateBoard();
  renderBoardBanner();
  renderCards();
  if (typeof renderBoardsPage === "function") renderBoardsPage();
  if (boardOverlayBoardId) renderBoardOverlayStatus();
});
document.getElementById("createBoardBannerDisable")?.addEventListener("click", () => {
  deactivateBoard();
  renderBoardBanner();
  renderCards();
  if (typeof renderBoardsPage === "function") renderBoardsPage();
  if (boardOverlayBoardId) renderBoardOverlayStatus();
});

// ── Таб «Доски» — список плиток на отдельном первоуровневом экране ──────
// (было — ряд «Мои доски» на главной каталога, убрано разделом 1.5 спеки
// единой навигации; сама логика плиток не изменилась, только адрес).

function renderBoardsPage() {
  const grid = document.getElementById("boardsPageGrid");
  if (!grid) return;
  grid.innerHTML = "";
  if (boardsState.boards.length === 0) {
    grid.appendChild(makeNewBoardTile(true));
  } else {
    boardsState.boards.forEach((board) => grid.appendChild(makeBoardTile(board)));
    grid.appendChild(makeNewBoardTile(false));
  }
}

function makeBoardTile(board) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "board-tile";
  tile.addEventListener("click", () => openBoardOverlay(board.id));

  const isActive = boardsState.activeId === board.id;
  const cover = document.createElement("div");
  cover.className = `board-tile-cover${isActive ? " board-tile-cover--active" : ""}`;

  const photos = board.photos.slice(0, 4);
  if (photos.length > 0) {
    cover.classList.add("board-tile-cover--collage");
    photos.forEach((url) => {
      const img = document.createElement("img");
      img.src = thumbUrl(url, 160);
      img.alt = "";
      img.loading = "lazy";
      cover.appendChild(img);
    });
  } else {
    cover.textContent = "🖼️";
  }

  if (isActive) {
    const badge = document.createElement("span");
    badge.className = "board-tile-badge";
    badge.textContent = "✓";
    cover.appendChild(badge);
  }

  const name = document.createElement("div");
  name.className = "board-tile-name";
  name.textContent = board.name;

  tile.appendChild(cover);
  tile.appendChild(name);
  return tile;
}

function makeNewBoardTile(withHint) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "board-tile";
  tile.addEventListener("click", () => {
    if (boardsState.boards.length >= BOARDS_MAX_BOARDS) {
      showToast(`Максимум ${BOARDS_MAX_BOARDS} досок.`);
      return;
    }
    openCreateBoardModal();
  });

  const cover = document.createElement("div");
  cover.className = "board-tile-cover board-tile-cover--new";
  cover.textContent = "+";
  tile.appendChild(cover);

  if (withHint) {
    const hint = document.createElement("div");
    hint.className = "board-tile-hint";
    hint.textContent = "Собери фото для своего стиля";
    tile.appendChild(hint);
  } else {
    const name = document.createElement("div");
    name.className = "board-tile-name";
    name.textContent = "Новая доска";
    tile.appendChild(name);
  }
  return tile;
}

// ── Экран 1a: модалка «Новая доска» ─────────────────────────────────────

const boardCreateModal = document.getElementById("boardCreateModal");
const boardCreateInput = document.getElementById("boardCreateInput");
const boardCreateConfirm = document.getElementById("boardCreateConfirm");

function openCreateBoardModal() {
  if (!boardCreateModal) return;
  boardCreateInput.value = "";
  boardCreateConfirm.disabled = true;
  showBoardDialog(boardCreateModal);
  setTimeout(() => boardCreateInput.focus(), 50);
}

function closeCreateBoardModal() {
  closeBoardDialog(boardCreateModal);
}

boardCreateInput?.addEventListener("input", () => {
  boardCreateConfirm.disabled = !boardCreateInput.value.trim();
});
boardCreateInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !boardCreateConfirm.disabled) boardCreateConfirm.click();
});

document.getElementById("boardCreateClose")?.addEventListener("click", closeCreateBoardModal);
document.getElementById("boardCreateCancel")?.addEventListener("click", closeCreateBoardModal);
boardCreateModal?.addEventListener("click", (e) => {
  if (e.target === boardCreateModal) closeCreateBoardModal();
});

boardCreateConfirm?.addEventListener("click", () => {
  const name = boardCreateInput.value.trim();
  if (!name) return;
  const board = createBoard(name);
  closeCreateBoardModal();
  renderCards();
  if (typeof renderBoardsPage === "function") renderBoardsPage();
  openBoardOverlay(board.id); // «После создания — сразу переход на Экран 2»
});

// ── Экран 2: доска (просмотр/редактирование) ────────────────────────────

const boardOverlay = document.getElementById("boardOverlay");
const boardTitleText = document.getElementById("boardTitleText");
const boardTitleInput = document.getElementById("boardTitleInput");
const boardStatusEl = document.getElementById("boardStatus");
const boardPhotoGrid = document.getElementById("boardPhotoGrid");
const boardEmptyState = document.getElementById("boardEmptyState");
const boardActivateContinueBtn = document.getElementById("boardActivateContinueBtn");
const boardStyleAnalyzeBtn = document.getElementById("boardStyleAnalyzeBtn");
const boardAddPhotoBtn = document.getElementById("boardAddPhotoBtn");
const boardPhotoFile = document.getElementById("boardPhotoFile");

function openBoardOverlay(id) {
  const board = getBoardById(id);
  if (!board || !boardOverlay) return;
  boardOverlayBoardId = id;
  renderBoardOverlay();
  boardOverlay.classList.remove("hidden");
}

function closeBoardOverlay() {
  boardOverlay?.classList.add("hidden");
  boardOverlayBoardId = null;
  goToBoardsSection();
}

function renderBoardOverlay() {
  const board = getBoardById(boardOverlayBoardId);
  if (!board) {
    closeBoardOverlay();
    return;
  }

  boardTitleText.textContent = board.name;
  boardTitleInput.value = board.name;
  boardTitleInput.classList.add("hidden");
  boardTitleText.classList.remove("hidden");

  renderBoardOverlayStatus();
  renderBoardPhotoGrid();

  const hasPhotos = board.photos.length > 0;
  boardEmptyState.classList.toggle("hidden", hasPhotos);
  boardPhotoGrid.classList.toggle("hidden", !hasPhotos);

  const isActive = boardsState.activeId === board.id;
  boardActivateContinueBtn.classList.toggle("hidden", isActive || !hasPhotos);
  boardStyleAnalyzeBtn.classList.toggle("hidden", isActive || board.photos.length < BOARDS_MIN_PHOTOS_FOR_STYLE);

  const atLimit = board.photos.length >= BOARDS_MAX_PHOTOS_PER_BOARD;
  boardAddPhotoBtn.disabled = atLimit;
  boardAddPhotoBtn.title = atLimit ? `Максимум ${BOARDS_MAX_PHOTOS_PER_BOARD} фото в доске` : "";
}

function renderBoardOverlayStatus() {
  const board = getBoardById(boardOverlayBoardId);
  if (!board || !boardStatusEl) return;
  boardStatusEl.innerHTML = "";
  const isActive = boardsState.activeId === board.id;

  if (isActive) {
    const wrap = document.createElement("div");
    wrap.className = "board-status-active";
    const span = document.createElement("span");
    span.textContent = board.styleRequested
      ? "🖼️ Доска активна — стиль ИИ подмешивается в каждую генерацию"
      : "🖼️ Доска активна — фото из неё пойдут в следующую генерацию";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link-btn";
    btn.textContent = "Отключить";
    btn.addEventListener("click", () => {
      deactivateBoard();
      renderBoardOverlay();
      renderBoardBanner();
      renderCards();
  if (typeof renderBoardsPage === "function") renderBoardsPage();
    });
    wrap.appendChild(span);
    wrap.appendChild(btn);
    boardStatusEl.appendChild(wrap);
  }
  // Не активна — статус-баннер пуст. Раньше здесь дублировалась кнопка
  // «Сделать доску активной» одновременно с «✨ Понять мой стиль» /
  // «✅ Подключить фото без анализа» внизу экрана (одно и то же действие
  // под двумя разными подписями на одном экране — реальная путаница,
  // живой баг-репорт 2026-08-09). Единственный вход в активацию теперь —
  // нижняя панель (boardActivateContinueBtn/boardStyleAnalyzeBtn).
}

function renderBoardPhotoGrid() {
  const board = getBoardById(boardOverlayBoardId);
  if (!board || !boardPhotoGrid) return;
  boardPhotoGrid.innerHTML = "";
  board.photos.forEach((url, idx) => {
    const cell = document.createElement("div");
    cell.className = "board-photo";
    const img = document.createElement("img");
    img.src = thumbUrl(url, 300);
    img.alt = "Фото доски";
    img.loading = "lazy";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "board-photo-remove";
    rm.textContent = "×";
    rm.setAttribute("aria-label", "Удалить фото");
    rm.addEventListener("click", () => {
      removePhotoFromBoard(board.id, idx);
      renderBoardOverlay();
      renderCards();
  if (typeof renderBoardsPage === "function") renderBoardsPage();
    });
    cell.appendChild(img);
    cell.appendChild(rm);
    boardPhotoGrid.appendChild(cell);
  });
}

document.getElementById("boardBackBtn")?.addEventListener("click", closeBoardOverlay);

boardActivateContinueBtn?.addEventListener("click", () => activateBoardAndContinue(boardOverlayBoardId));
boardStyleAnalyzeBtn?.addEventListener("click", () => analyzeBoardStyleAndContinue(boardOverlayBoardId));

boardAddPhotoBtn?.addEventListener("click", () => {
  const board = getBoardById(boardOverlayBoardId);
  if (!board) return;
  if (board.photos.length >= BOARDS_MAX_PHOTOS_PER_BOARD) {
    showToast(`Максимум ${BOARDS_MAX_PHOTOS_PER_BOARD} фото в доске.`);
    return;
  }
  boardPhotoFile.click();
});

// Загрузка фото доски — переиспользует уже готовый и задеплоенный
// Cloudflare Function-аплоадер на imgbb Студии нейромультиков
// (studioCall/studioCompressImageToBase64 из studio.js), новый не пишем
// (докстрока спеки, раздел «MVP»).
boardPhotoFile?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file || !boardOverlayBoardId) return;
  try {
    const base64 = await studioCompressImageToBase64(file);
    if (!base64) throw new Error("empty base64");
    const data = await studioCall("upload", { image_base64: base64 });
    if (data && data.ok && data.url) {
      addPhotoToBoard(boardOverlayBoardId, data.url);
      renderBoardOverlay();
      renderCards();
  if (typeof renderBoardsPage === "function") renderBoardsPage();
    }
  } catch (e2) {
    console.error("board photo upload failed", e2);
    showToast("Не получилось обработать фото.");
  }
});

// ── Название доски: инлайн-редактирование (тап по названию или ✏️) ──────

function startBoardTitleEdit() {
  if (!boardTitleText || !boardTitleInput) return;
  boardTitleInput.value = boardTitleText.textContent;
  boardTitleText.classList.add("hidden");
  boardTitleInput.classList.remove("hidden");
  boardTitleInput.focus();
  boardTitleInput.select();
}

function commitBoardTitleEdit() {
  const board = getBoardById(boardOverlayBoardId);
  if (!board) return;
  const name = boardTitleInput.value.trim();
  if (name) renameBoard(board.id, name);
  boardTitleText.textContent = getBoardById(board.id).name;
  boardTitleInput.classList.add("hidden");
  boardTitleText.classList.remove("hidden");
  renderCards();
  if (typeof renderBoardsPage === "function") renderBoardsPage();
}

boardTitleText?.addEventListener("click", startBoardTitleEdit);
document.getElementById("boardTitleEditBtn")?.addEventListener("click", startBoardTitleEdit);
boardTitleInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitBoardTitleEdit();
  } else if (e.key === "Escape") {
    boardTitleInput.classList.add("hidden");
    boardTitleText.classList.remove("hidden");
  }
});
boardTitleInput?.addEventListener("blur", () => {
  if (!boardTitleInput.classList.contains("hidden")) commitBoardTitleEdit();
});

// ── Меню «⋮»: Переименовать / Удалить доску ─────────────────────────────

const boardActionsSheet = document.getElementById("boardActionsSheet");

document.getElementById("boardMenuBtn")?.addEventListener("click", () => showBoardDialog(boardActionsSheet));
document.getElementById("boardActionsClose")?.addEventListener("click", () => closeBoardDialog(boardActionsSheet));
boardActionsSheet?.addEventListener("click", (e) => {
  if (e.target === boardActionsSheet) closeBoardDialog(boardActionsSheet);
});

document.getElementById("boardActionRename")?.addEventListener("click", () => {
  closeBoardDialog(boardActionsSheet);
  startBoardTitleEdit();
});

document.getElementById("boardActionDelete")?.addEventListener("click", () => {
  const board = getBoardById(boardOverlayBoardId);
  if (!board) return;
  closeBoardDialog(boardActionsSheet);
  const ok = window.confirm(`Удалить доску «${board.name}»? Фото удалятся безвозвратно.`);
  if (!ok) return;
  deleteBoard(board.id);
  closeBoardOverlay();
  renderBoardBanner();
});

// ── Экран 3: «Сделать активной и продолжить» → отправка боту ───────────

// Контракт СОГЛАСОВАН с уже реализованным на бэкенде парсером
// (apply_webapp_board_refs_payload, SirNike.py) — см. докстроку в начале файла.
function buildBoardActivatePayload(board) {
  return JSON.stringify({
    action: "board_refs",
    title: board.name,
    board_refs: board.photos.slice(0, BOARDS_MAX_REFS_PER_GEN),
    v: typeof APP_VERSION !== "undefined" ? APP_VERSION : "boards-mvp-1",
  });
}

// Full: «✨ Понять мой стиль» — отдельный экшен, НЕ board_refs. Анализ
// смотрит на всю доску (до 10 фото), не срезается до 8 (тот срез — потолок
// референсов ГЕНЕРАЦИИ, к анализу подборки не относится). Ответ (текст
// описания + подтверждение) приходит в чат бота — синхронного возврата в
// сам вебапп нет (у бота нет публичного HTTP для этого), поэтому здесь
// нет попытки показать текст описания внутри вебаппа — редактирование
// живёт в чате. См. docs/specs/2026-08-09_mood_boards_full.md (репо бота).
function buildBoardStyleAnalyzePayload(board) {
  return JSON.stringify({
    action: "board_style_analyze",
    board_id: board.id,
    title: board.name,
    board_refs: board.photos.slice(0, BOARDS_MAX_PHOTOS_PER_BOARD),
    v: typeof APP_VERSION !== "undefined" ? APP_VERSION : "boards-mvp-1",
  });
}

// tg.sendData() доставляет данные боту ТОЛЬКО когда вебапп открыт с
// reply-клавиатуры (KeyboardButton) — документированное ограничение
// Telegram. С инлайн-входа (main_menu_kb и т.д.) используем
// sendGenerationPayloadViaAnswerWebAppQuery (app.js) — тот же генеральный
// answerWebAppQuery-путь, что и у всех конструкторов (video/photo/avatar/
// mj/enhance, фикс 2026-08-19): payload кодируется в message_text
// (лимит Telegram ~4096 символов), не в callback_data (64 байта) — до 10
// URL фото доски укладывается с большим запасом. Бэкенд (via_bot JSON-
// интерцептор в handle_text, SirNike.py) уже понимает board_refs/bsa —
// ничего дополнительно чинить на бэке не нужно, только сюда добавить
// вызов вместо тупикового тоста (живая жалоба Ани 2026-08-19: «Понять мой
// стиль» работала только с кнопки снизу).
function activateBoardAndContinue(id) {
  const board = getBoardById(id);
  if (!board) return;
  if (!tg) {
    showToast("Открой библиотеку внутри Telegram, чтобы подключить доску.");
    return;
  }
  setActiveBoardId(id);
  renderBoardBanner();
  if (isOpenedViaInlineButton()) {
    sendGenerationPayloadViaAnswerWebAppQuery(buildBoardActivatePayload(board));
    return;
  }
  try {
    tg.sendData(buildBoardActivatePayload(board));
    setTimeout(() => tg.close(), 900);
  } catch (e) {
    console.error("board activate sendData failed", e);
    showToast("Не получилось подключить доску. Попробуй ещё раз.");
  }
}

// Full: тот же вход/гварды, что у activateBoardAndContinue, но другой
// экшен и другая пометка локального состояния.
function analyzeBoardStyleAndContinue(id) {
  const board = getBoardById(id);
  if (!board) return;
  if (!tg) {
    showToast("Открой библиотеку внутри Telegram, чтобы подключить доску.");
    return;
  }
  board.styleRequested = true;
  setActiveBoardId(id);
  saveBoardsState();
  renderBoardBanner();
  if (isOpenedViaInlineButton()) {
    sendGenerationPayloadViaAnswerWebAppQuery(buildBoardStyleAnalyzePayload(board));
    return;
  }
  try {
    tg.sendData(buildBoardStyleAnalyzePayload(board));
    setTimeout(() => tg.close(), 900);
  } catch (e) {
    console.error("board style analyze sendData failed", e);
    showToast("Не получилось отправить доску на анализ. Попробуй ещё раз.");
  }
}

// ── Экран 4: инфо-строка в карточке стиля (используется из app.js) ─────

function getActiveBoardNoteText() {
  const board = getActiveBoard();
  if (!board) return "";
  return board.styleRequested
    ? `🖼️ Стиль доски «${board.name}» тоже подмешается`
    : `🖼️ С доски «${board.name}» тоже подмешается`;
}

// ── Инициализация ────────────────────────────────────────────────────

renderBoardBanner();
renderBoardsPage();
