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
const statsEl = document.getElementById("stats");
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

function renderStats() {
  const all = flattenLibrary();
  const videos = all.filter(isVideoItem).length;
  const photos = all.length - videos;
  statsEl.innerHTML = "";

  [
    ["Категорий", library.length],
    ["Фото", photos],
    ["Видео", videos],
  ].forEach(([label, value]) => {
    const item = document.createElement("div");
    item.className = "stat";
    item.innerHTML = `<strong>${value}</strong><span>${label}</span>`;
    statsEl.appendChild(item);
  });
}

function makeChip(label, count, value, emoji = "") {
  const button = document.createElement("button");
  button.className = `chip ${activeCategory === value ? "active" : ""}`;
  button.type = "button";
  button.innerHTML = `<span>${emoji} ${label}</span><span class="chip-count">${count}</span>`;
  button.onclick = () => {
    activeCategory = value;
    render();
  };
  return button;
}

function renderCategories() {
  categoriesEl.innerHTML = "";
  categoriesEl.appendChild(makeChip("Все", flattenLibrary().length, "all", ""));

  const newCount = flattenLibrary().filter(isNewItem).length;
  if (newCount > 0) {
    const novinkiChip = makeChip("Новинки", newCount, "all", "🆕");
    novinkiChip.classList.toggle("active", activeCategory === "all" && activeFilter === "new");
    novinkiChip.onclick = () => {
      activeCategory = "all";
      if (activeFilter === "new") {
        activeFilter = "all";
        document.querySelectorAll(".segment").forEach((b) => {
          b.classList.toggle("active", b.dataset.filter === "all");
        });
      } else {
        activeFilter = "new";
        document.querySelectorAll(".segment").forEach((b) => b.classList.remove("active"));
      }
      render();
    };
    categoriesEl.appendChild(novinkiChip);
  }

  library.forEach((cat, idx) => {
    const count = Array.isArray(cat?.items) ? cat.items.length : 0;
    categoriesEl.appendChild(makeChip(cat.title || "Категория", count, idx, cat.emoji || "□"));
  });
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
    let rawPayload = JSON.stringify({
      action: payload.action,
      title: payload.title,
      prompt: payload.prompt,
      v: APP_VERSION,
    });
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
  image.src = rawUrl ? thumbUrl(rawUrl) : FALLBACK_IMAGE;
  image.onload = () => markLoaded(image);
  image.onerror = () => {
    const orig = normalizeUrl(rawUrl);
    if (image.src !== orig && orig) image.src = orig;
    else image.src = FALLBACK_IMAGE;
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

    const body = document.createElement("div");
    body.className = "card-body";

    const head = document.createElement("div");
    head.className = "card-head";

    const category = document.createElement("span");
    category.className = "category-label";
    category.textContent = `${item._categoryEmoji} ${item._categoryTitle}`;

    const previewText = item.description || item.hint || "";
    const prompt = document.createElement("p");
    prompt.className = "prompt-preview";
    prompt.textContent = previewText || (item.prompt || "").substring(0, 120).trim() + "…";

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const detailsBtn = document.createElement("button");
    detailsBtn.className = "ghost-btn";
    detailsBtn.type = "button";
    detailsBtn.textContent = "Инструкция";
    detailsBtn.onclick = () => openDetails(item);

    const useBtn = document.createElement("button");
    useBtn.className = "primary-btn";
    useBtn.type = "button";
    useBtn.textContent = "Использовать";
    useBtn.onclick = () => sendPrompt(item, useBtn);

    if (isNewItem(item)) card.classList.add("card--new");

    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      openDetails(item);
    });

    if (item.title) {
      const title = document.createElement("h3");
      title.className = "title";
      title.textContent = item.title;
      head.appendChild(title);
    }
    head.appendChild(category);
    actions.appendChild(detailsBtn);
    actions.appendChild(useBtn);
    body.appendChild(head);
    body.appendChild(prompt);
    body.appendChild(actions);
    card.appendChild(createPreviewBlock(item));
    card.appendChild(body);
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
  renderStats();
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

(async function init() {
  applyTheme(getTheme());
  await loadLibrary();
  if (!library.length) {
    emptyEl.textContent = "Не удалось загрузить библиотеку. Проверь prompt_library.json.";
    emptyEl.classList.remove("hidden");
    return;
  }
  render();
})();
