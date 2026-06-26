const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}
const APP_VERSION = "2026-05-23-webapp-novinki-v1";
const NEW_DAYS_THRESHOLD = 7;

const FALLBACK_IMAGE = "https://dummyimage.com/960x1200/f1e8dc/6d6472&text=No+Preview";
const FAVORITES_KEY = "sirnike_prompt_favorites";
const THEME_KEY = "sirnike_prompt_theme";

const categoriesEl = document.getElementById("categories");
const cardsEl = document.getElementById("cards");
const emptyEl = document.getElementById("empty");
const searchInput = document.getElementById("searchInput");
const toastEl = document.getElementById("toast");
const themeToggle = document.getElementById("themeToggle");
const detailsModal = document.getElementById("detailsModal");
const modalClose = document.getElementById("modalClose");
const modalMedia = document.getElementById("modalMedia");
const modalMeta = document.getElementById("modalMeta");
const modalTitle = document.getElementById("modalTitle");
const modalPrompt = document.getElementById("modalPrompt");
const modalCopy = document.getElementById("modalCopy");
const modalUse = document.getElementById("modalUse");
const tabBar = document.getElementById("tabBar");
const balancePill = document.getElementById("balancePill");
const balanceCount = document.getElementById("balanceCount");
const balanceDisplay = document.getElementById("balanceDisplay");
const historyToCatalog = document.getElementById("historyToCatalog");
const categoryTrigger = document.getElementById("categoryTrigger");
const categoryTriggerLabel = document.getElementById("categoryTriggerLabel");
const categorySheet = document.getElementById("categorySheet");
const categorySheetClose = document.getElementById("categorySheetClose");

let library = [];
let activeCategory = "all";
let activeFilter = "all";
let query = "";
let selectedItem = null;
let selectedButton = null;
let favorites = readFavorites();

function readFavorites() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveFavorites() {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
}

function getTheme() {
  return localStorage.getItem(THEME_KEY) || (tg?.colorScheme === "dark" ? "dark" : "light");
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return encodeURI(raw);
  } catch {
    return raw;
  }
}

function thumbUrl(url, width = 400) {
  const raw = normalizeUrl(url);
  if (!raw || raw.includes("dummyimage.com")) return raw;
  return `https://wsrv.nl/?url=${encodeURIComponent(raw)}&w=${width}&output=webp&q=80&fit=cover`;
}

function isNewItem(item) {
  const raw = item?.added_at;
  if (!raw) return false;
  try {
    const addedMs = new Date(raw).getTime();
    if (!Number.isFinite(addedMs)) return false;
    return Date.now() - addedMs < NEW_DAYS_THRESHOLD * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function isVideoItem(item) {
  const tag = String(item?.type || item?.kind || item?.target || "").toLowerCase();
  return tag === "video" || Boolean(item?.video_url);
}

function itemId(item, categoryIndex, itemIndex) {
  return `${categoryIndex}:${itemIndex}:${item.title || "untitled"}`;
}

function flattenLibrary() {
  return library.flatMap((category, categoryIndex) => {
    const items = Array.isArray(category?.items) ? category.items : [];
    return items.map((item, itemIndex) => ({
      ...item,
      _id: itemId(item, categoryIndex, itemIndex),
      _categoryIndex: categoryIndex,
      _categoryTitle: category?.title || "Категория",
      _categoryEmoji: category?.emoji || "□",
      _itemIndex: itemIndex,
    }));
  });
}

function getVisibleItems() {
  const cleanQuery = query.trim().toLowerCase();
  return flattenLibrary().filter((item) => {
    if (activeCategory !== "all" && item._categoryIndex !== activeCategory) return false;
    if (activeFilter === "video" && !isVideoItem(item)) return false;
    if (activeFilter === "photo" && isVideoItem(item)) return false;
    if (activeFilter === "favorites" && !favorites.has(item._id)) return false;
    if (activeFilter === "new" && !isNewItem(item)) return false;
    if (!cleanQuery) return true;

    const haystack = `${item.title || ""} ${item.description || ""} ${item._categoryTitle}`.toLowerCase();
    return haystack.includes(cleanQuery);
  });
}

async function loadLibrary() {
  try {
    const res = await fetch(`./prompt_library.json?v=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("Invalid format");
    library = data;
  } catch (e) {
    console.error("Failed to load prompt library", e);
    library = [];
  }
}

function makeChip(label, count, value, emoji = "") {
  const button = document.createElement("button");
  button.className = `chip ${activeCategory === value ? "active" : ""}`;
  button.type = "button";
  button.innerHTML = `<span>${emoji} ${label}</span><span class="chip-count">${count}</span>`;
  button.onclick = () => {
    activeCategory = value;
    closeCategorySheet();
    render();
  };
  return button;
}

function renderCategories() {
  // Категории живут в выезжающей шторке. «Все»/«Новинки» по типу — в сегментах.
  // Пустые категории не показываем.
  categoriesEl.innerHTML = "";
  categoriesEl.appendChild(makeChip("Все категории", flattenLibrary().length, "all", "📁"));
  library.forEach((cat, idx) => {
    const count = Array.isArray(cat?.items) ? cat.items.length : 0;
    if (!count) return;
    categoriesEl.appendChild(makeChip(cat.title || "Категория", count, idx, cat.emoji || "□"));
  });
  updateCategoryTrigger();
}

function updateCategoryTrigger() {
  if (!categoryTriggerLabel) return;
  if (activeCategory === "all") {
    categoryTriggerLabel.textContent = "Все категории";
  } else {
    const cat = library[activeCategory];
    categoryTriggerLabel.textContent = cat
      ? `${cat.emoji || ""} ${cat.title || "Категория"}`.trim()
      : "Все категории";
  }
  categoryTrigger?.classList.toggle("cat-trigger--active", activeCategory !== "all");
}

function openCategorySheet() {
  if (!categorySheet) return;
  if (typeof categorySheet.showModal === "function") categorySheet.showModal();
  else categorySheet.setAttribute("open", "");
}

function closeCategorySheet() {
  if (!categorySheet) return;
  if (typeof categorySheet.close === "function" && categorySheet.open) categorySheet.close();
  else categorySheet.removeAttribute("open");
}

function sendPrompt(item, button) {
  const fallbackPrompt = (item.title || "").trim();
  const itemIsVideo = isVideoItem(item);
  const payload = {
    action: itemIsVideo ? "set_video_prompt" : "set_prompt",
    title: item.title || "Шаблон",
    prompt: (item.prompt || "").trim() || fallbackPrompt,
    v: APP_VERSION,
  };

  if (!tg) {
    showToast("Открой библиотеку внутри Telegram, чтобы применить шаблон.");
    return;
  }

  try {
    const baseObj = {
      action: payload.action,
      title: payload.title,
      prompt: payload.prompt,
      v: APP_VERSION,
    };
    if (item.image_prompt) baseObj.image_prompt = item.image_prompt;
    let rawPayload = JSON.stringify(baseObj);
    if (rawPayload.length > 3900) {
      rawPayload = JSON.stringify({
        action: itemIsVideo ? "set_video_prompt_ref" : "set_prompt_ref",
        title: payload.title,
        cat_idx: Number(item._categoryIndex),
        item_idx: Number(item._itemIndex),
        v: APP_VERSION,
      });
    }
    tg.sendData(rawPayload);
    if (button) {
      button.disabled = true;
      button.textContent = "Применено";
    }
    setTimeout(() => tg.close(), 900);
  } catch (e) {
    console.error("sendData failed", e);
    showToast("Не получилось применить шаблон. Попробуй еще раз.");
  }
}

async function copyPrompt(item) {
  const text = String(item?.description || item?.hint || item?.title || "").trim();
  if (!text) {
    showToast("Нет текста для копирования.");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("Скопировано.");
  } catch {
    showToast("Копирование недоступно в этом браузере.");
  }
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.add("hidden"), 2600);
}

function markLoaded(el) {
  el.classList.add("loaded");
  const wrap = el.closest(".preview-wrap");
  if (wrap) wrap.classList.add("loaded");
}

function createImagePreview(item) {
  const image = document.createElement("img");
  image.className = "preview";
  image.loading = "lazy";
  image.alt = item.title || "Пример";
  const rawUrl = item.example_url || item.poster_url;
  const orig = normalizeUrl(rawUrl);
  const proxied = rawUrl ? thumbUrl(rawUrl) : "";
  image.src = proxied || orig || FALLBACK_IMAGE;

  image.onload = () => {
    if (image.naturalWidth < 10 && image.src !== orig && orig) {
      image.src = orig;
      return;
    }
    markLoaded(image);
  };
  image.onerror = () => {
    if (image.src !== orig && orig) image.src = orig;
    else if (image.src !== FALLBACK_IMAGE) image.src = FALLBACK_IMAGE;
  };
  return image;
}

function createVideoPreview(item) {
  const videoUrl = normalizeUrl(item.video_url || item.preview_video_url);
  if (!videoUrl) return createImagePreview(item);

  const video = document.createElement("video");
  video.className = "preview";
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.loop = true;
  video.controls = false;
  video.src = videoUrl;

  const poster = normalizeUrl(item.poster_url || item.example_url);
  if (poster) video.poster = poster;

  video.addEventListener(
    "loadedmetadata",
    () => {
      const duration = Number(video.duration);
      if (!Number.isFinite(duration) || duration <= 0.35) return;

      const safeStart = Math.min(0.35, duration * 0.12);
      const safeEnd = Math.max(duration - 0.35, safeStart + 0.05);
      const randomTime = safeStart + Math.random() * (safeEnd - safeStart);

      try {
        video.currentTime = randomTime;
      } catch (e) {
        console.warn("Unable to seek video preview frame", e);
      }
    },
    { once: true }
  );
  video.addEventListener("seeked", () => { video.pause(); markLoaded(video); }, { once: true });
  video.addEventListener("loadeddata", () => markLoaded(video), { once: true });
  video.addEventListener("mouseenter", () => video.play().catch(() => {}));
  video.addEventListener("mouseleave", () => {
    video.pause();
    if (Number.isFinite(video.duration) && video.duration > 0.35) {
      const safeStart = Math.min(0.35, video.duration * 0.12);
      const safeEnd = Math.max(video.duration - 0.35, safeStart + 0.05);
      try {
        video.currentTime = safeStart + Math.random() * (safeEnd - safeStart);
      } catch {}
    }
  });
  video.addEventListener("error", () => video.replaceWith(createImagePreview(item)));
  return video;
}

function createPreview(item) {
  return isVideoItem(item) ? createVideoPreview(item) : createImagePreview(item);
}

function createFullPreview(item) {
  if (isVideoItem(item)) return createVideoPreview(item);
  const image = document.createElement("img");
  image.className = "preview loaded";
  image.alt = item.title || "Пример";
  image.src = normalizeUrl(item.example_url || item.poster_url) || FALLBACK_IMAGE;
  image.onerror = () => { image.src = FALLBACK_IMAGE; };
  return image;
}

function createPreviewBlock(item) {
  const wrap = document.createElement("div");
  wrap.className = "preview-wrap";

  const badge = document.createElement("span");
  badge.className = "type-badge";
  badge.textContent = isVideoItem(item) ? "Видео" : "Фото";

  const favorite = document.createElement("button");
  favorite.className = `favorite ${favorites.has(item._id) ? "active" : ""}`;
  favorite.type = "button";
  favorite.title = "В избранное";
  favorite.setAttribute("aria-label", "В избранное");
  favorite.innerHTML = favorites.has(item._id)
    ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
    : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
  favorite.onclick = (event) => {
    event.stopPropagation();
    if (favorites.has(item._id)) {
      favorites.delete(item._id);
    } else {
      favorites.add(item._id);
    }
    saveFavorites();
    renderCards();
  };

  wrap.appendChild(createPreview(item));
  wrap.appendChild(badge);
  if (isNewItem(item)) {
    const newBadge = document.createElement("span");
    newBadge.className = "new-badge";
    newBadge.textContent = "NEW";
    wrap.appendChild(newBadge);
  }
  wrap.appendChild(favorite);
  return wrap;
}

function makeCard(item) {
    const card = document.createElement("article");
    card.className = "card";
    if (isNewItem(item)) card.classList.add("card--new");

    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      openDetails(item);
    });

    const previewBlock = createPreviewBlock(item);
    const hasTitle = Boolean(item.title);
    const isPopular = Boolean(item.popular);

    if (hasTitle || isPopular) {
      const overlay = document.createElement("div");
      overlay.className = "card-overlay";
      if (isPopular) {
        const badge = document.createElement("span");
        badge.className = "popular-badge";
        badge.textContent = "Популярное";
        overlay.appendChild(badge);
      }
      if (hasTitle) {
        const title = document.createElement("h3");
        title.className = "overlay-title";
        title.textContent = item.title;
        overlay.appendChild(title);
      }
      previewBlock.appendChild(overlay);
    }

    card.appendChild(previewBlock);
    return card;
}

function makeSectionHeader(text) {
  const header = document.createElement("div");
  header.className = "section-header";
  header.textContent = text;
  return header;
}

function renderCards() {
  cardsEl.innerHTML = "";
  emptyEl.classList.add("hidden");

  const items = getVisibleItems();
  if (!items.length) {
    emptyEl.textContent = query
      ? "Ничего не нашлось. Попробуй другое слово или сбрось фильтр."
      : "В этом разделе пока нет шаблонов.";
    emptyEl.classList.remove("hidden");
    return;
  }

  // Show "Новинки" section at top when browsing "all" without new-filter active
  if (activeFilter !== "new" && !query) {
    const newItems = items.filter(isNewItem);
    const regularItems = items.filter((i) => !isNewItem(i));

    if (newItems.length > 0) {
      cardsEl.appendChild(makeSectionHeader("🆕 Новинки"));
      for (const item of newItems) cardsEl.appendChild(makeCard(item));
      if (regularItems.length > 0) cardsEl.appendChild(makeSectionHeader("Все шаблоны"));
      for (const item of regularItems) cardsEl.appendChild(makeCard(item));
      return;
    }
  }

  for (const item of items) cardsEl.appendChild(makeCard(item));
}

function openDetails(item) {
  selectedItem = item;
  selectedButton = null;
  modalMedia.innerHTML = "";
  modalMedia.appendChild(createFullPreview(item));
  modalMeta.textContent = `${item._categoryEmoji} ${item._categoryTitle} · ${isVideoItem(item) ? "Видео" : "Фото"}`;
  modalTitle.textContent = item.title || "";
  modalTitle.style.display = item.title ? "" : "none";
  const uploadHint = item.upload_hint || item.what_to_upload || "";
  modalPrompt.textContent = (item.description || item.hint || "") + (uploadHint ? `\n\n📎 Что загрузить: ${uploadHint}` : "");

  if (typeof detailsModal.showModal === "function") {
    detailsModal.showModal();
  } else {
    detailsModal.setAttribute("open", "");
  }
}

function render() {
  renderCategories();
  renderCards();
}

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".segment").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    activeFilter = button.dataset.filter || "all";
    render();
  });
});

searchInput.addEventListener("input", () => {
  query = searchInput.value;
  renderCards();
});

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
});

modalClose.addEventListener("click", () => detailsModal.close());
detailsModal.addEventListener("click", (event) => {
  if (event.target === detailsModal) detailsModal.close();
});
modalCopy.addEventListener("click", () => copyPrompt(selectedItem));
modalUse.addEventListener("click", () => sendPrompt(selectedItem, selectedButton));

categoryTrigger?.addEventListener("click", openCategorySheet);
categorySheetClose?.addEventListener("click", closeCategorySheet);
categorySheet?.addEventListener("click", (event) => {
  if (event.target === categorySheet) closeCategorySheet();
});

const APP_TITLES = { katalog: "Библиотека", history: "История", topup: "Пополнить" };

function switchTab(tabName) {
  document.querySelectorAll(".tab-page").forEach((p) => p.classList.add("hidden"));
  const target = document.getElementById("page" + tabName.charAt(0).toUpperCase() + tabName.slice(1));
  if (target) target.classList.remove("hidden");
  tabBar.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tabName));
  const titleEl = document.getElementById("appTitle");
  if (titleEl && APP_TITLES[tabName]) titleEl.textContent = APP_TITLES[tabName];
}

function decoratePackages() {
  // Должно совпадать с ботом: 1 фото = 5 изюминок, 1 видео 10 сек = 70.
  const COST_PER_PHOTO = 5;
  const COST_PER_VIDEO = 70;
  document.querySelectorAll("#packages .package").forEach((pkg) => {
    const info = pkg.querySelector(".package-info");
    if (!info || info.querySelector(".package-hint")) return;
    const amount = parseInt(pkg.dataset.amount, 10) || 0;
    const photos = Math.max(1, Math.floor(amount / COST_PER_PHOTO));
    const videos = Math.floor(amount / COST_PER_VIDEO);
    const hint = document.createElement("span");
    hint.className = "package-hint";
    // Акцент на видео: 🎬 первым, где пакета хватает на видео.
    hint.textContent = videos > 0 ? `🎬 ${videos} · 📸 ${photos}` : `📸 ${photos}`;
    info.appendChild(hint);
  });
}

tabBar.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  switchTab(tab.dataset.tab);
});

balancePill.addEventListener("click", () => switchTab("topup"));
if (historyToCatalog) historyToCatalog.addEventListener("click", () => switchTab("katalog"));

function readBalanceFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const val = parseInt(params.get("balance"), 10);
    return Number.isFinite(val) && val >= 0 ? val : 0;
  } catch { return 0; }
}

function setBalance(val) {
  const n = Math.max(0, Math.floor(val));
  if (balanceCount) balanceCount.textContent = n;
  if (balanceDisplay) balanceDisplay.textContent = n;
  if (document.getElementById("balanceUnit")) {
    const last2 = n % 100;
    const last1 = n % 10;
    let word = "изюминок";
    if (last2 >= 11 && last2 <= 19) word = "изюминок";
    else if (last1 === 1) word = "изюминка";
    else if (last1 >= 2 && last1 <= 4) word = "изюминки";
    document.getElementById("balanceUnit").textContent = word;
  }
}

function readHistoryFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("h");
    if (!raw) return [];
    // Бэкенд кодирует JSON в UTF-8 → base64. atob даёт байтовую строку,
    // поэтому декодируем именно как UTF-8, иначе кириллица превращается
    // в кракозябры (Ð´ÐµÐ²Ñ...).
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const json = new TextDecoder("utf-8").decode(bytes);
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const day = String(d.getDate()).padStart(2, "0");
    const mon = String(d.getMonth() + 1).padStart(2, "0");
    const hrs = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${day}.${mon} ${hrs}:${min}`;
  } catch { return ""; }
}

function renderHistory() {
  const grid = document.getElementById("historyGrid");
  const empty = document.getElementById("historyEmpty");
  const items = readHistoryFromUrl();
  if (!items.length) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  grid.innerHTML = "";
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "history-card";
    const imgWrap = document.createElement("div");
    imgWrap.className = "history-card-img";
    const img = document.createElement("img");
    img.src = item.u || FALLBACK_IMAGE;
    img.alt = item.p || "Генерация";
    img.loading = "lazy";
    img.onerror = () => { img.src = FALLBACK_IMAGE; };
    imgWrap.appendChild(img);
    card.appendChild(imgWrap);
    const body = document.createElement("div");
    body.className = "history-card-body";
    const prompt = document.createElement("p");
    prompt.className = "history-card-prompt";
    prompt.textContent = item.p || "Без описания";
    body.appendChild(prompt);
    const date = document.createElement("p");
    date.className = "history-card-date";
    date.textContent = formatDate(item.t);
    body.appendChild(date);
    card.appendChild(body);
    grid.appendChild(card);
  }
}

document.getElementById("packages").addEventListener("click", (e) => {
  const pkg = e.target.closest(".package");
  if (!pkg) return;
  if (!tg) {
    showToast("Открой библиотеку внутри Telegram, чтобы купить изюминки.");
    return;
  }
  tg.sendData(JSON.stringify({ action: "topup", v: APP_VERSION }));
  setTimeout(() => tg.close(), 600);
});

(async function init() {
  applyTheme(getTheme());
  setBalance(readBalanceFromUrl());
  decoratePackages();
  renderHistory();
  await loadLibrary();
  if (!library.length) {
    emptyEl.textContent = "Не удалось загрузить библиотеку. Проверь prompt_library.json.";
    emptyEl.classList.remove("hidden");
    return;
  }
  render();
})();
