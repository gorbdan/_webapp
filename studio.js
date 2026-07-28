// Студия нейромультиков. ТЗ: docs/specs/2026-07-20_cartoon_studio.md (репо
// бота). API уже реализован и задеплоен (functions/api/studio/[[action]].js,
// PR gorbdan/_webapp#16) — этот файл только вызывает готовый контракт.
// Общие утилиты (tg, showToast, formatDate, normalizeUrl) — из app.js,
// загруженного раньше в том же документе (обычные скрипты, общий scope).

const STUDIO_API = "/api/studio/";

async function studioCall(action, body = {}) {
  if (!tg) {
    showToast("Открой студию внутри Telegram.");
    return null;
  }
  try {
    const res = await fetch(STUDIO_API + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: tg.initData, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      showToast(studioErrorText(data.error));
      return data;
    }
    return data;
  } catch (e) {
    console.error(`studio ${action} failed`, e);
    showToast("Не получилось связаться со студией. Попробуй ещё раз.");
    return null;
  }
}

const STUDIO_ERROR_TEXT = {
  not_found: "Проект не найден — возможно, его удалили.",
  invalid_init_data: "Сессия устарела — перезайди в вебапп.",
  scene_limit: "Достигнут лимит сцен для этого мультика.",
  clip_without_frame: "Сначала сгенерируй кадр для этой сцены.",
  empty_idea: "Опиши идею — поле не должно быть пустым.",
  need_two_clips: "Нужно минимум 2 готовых клипа, чтобы склеить мультик.",
  scene_not_found: "Сцена не найдена — обнови экран.",
  bad_job_type: "Неизвестный тип задания.",
  prices_not_ready: "Студия ещё не готова — попробуй через минуту.",
  server_misconfigured: "Студия временно недоступна.",
  bad_image: "Слишком большое фото — попробуй другое.",
  upload_failed: "Не получилось загрузить фото.",
  bad_request: "Что-то пошло не так с запросом.",
};

function studioErrorText(code) {
  return STUDIO_ERROR_TEXT[code] || "Что-то пошло не так. Попробуй ещё раз.";
}

// ── Состояние ────────────────────────────────────────────────

const studioState = {
  view: "list", // list | idea | board | final
  projects: [],
  project: null,
  scenes: [],
  activeJobs: [],
  prices: null,
  pollTimer: null,
  sceneModalId: null,
  idea: { mode: "ai", aspect: "9:16", useAvatar: false, refUrls: [] },
};

const studioViews = {
  list: document.getElementById("studioViewList"),
  idea: document.getElementById("studioViewIdea"),
  board: document.getElementById("studioViewBoard"),
  final: document.getElementById("studioViewFinal"),
};
const studioCartEl = document.getElementById("studioCart");

function showStudioView(name) {
  studioState.view = name;
  Object.entries(studioViews).forEach(([key, el]) => el.classList.toggle("hidden", key !== name));
  studioCartEl.classList.toggle("hidden", name !== "board");
  if (name !== "board") stopStudioPolling();
}

// ── Список проектов ──────────────────────────────────────────

const STUDIO_STATUS_LABEL = { draft: "Черновик", stitching: "Склеивается…", done: "Готово" };

async function loadStudioProjects() {
  const data = await studioCall("project.list");
  if (!data || !data.ok) return;
  studioState.projects = data.projects || [];
  renderStudioProjects();
}

function renderStudioProjects() {
  const wrap = document.getElementById("studioProjects");
  const empty = document.getElementById("studioProjectsEmpty");
  wrap.innerHTML = "";
  if (!studioState.projects.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  for (const p of studioState.projects) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "studio-project-card";

    const info = document.createElement("div");
    const title = document.createElement("p");
    title.className = "studio-project-name";
    title.textContent = p.title || "Без названия";
    info.appendChild(title);
    const updated = formatDate(p.updated_at);
    if (updated) {
      const meta = document.createElement("p");
      meta.className = "studio-project-meta";
      meta.textContent = `Обновлено ${updated}`;
      info.appendChild(meta);
    }

    const status = document.createElement("span");
    status.className = `studio-project-status studio-project-status--${p.status}`;
    status.textContent = STUDIO_STATUS_LABEL[p.status] || p.status;

    card.appendChild(info);
    card.appendChild(status);
    card.addEventListener("click", () => openStudioProject(p.id));
    wrap.appendChild(card);
  }
}

async function openStudioProject(projectId) {
  const data = await studioCall("project.get", { project_id: projectId });
  if (!data || !data.ok) return;
  studioState.project = data.project;
  studioState.scenes = data.scenes || [];
  studioState.activeJobs = data.active_jobs || [];
  if (studioState.project.status === "done") {
    renderStudioFinal();
    showStudioView("final");
    return;
  }
  await ensureStudioPrices();
  renderStudioBoard();
  showStudioView("board");
  maybeStartStudioPolling();
}

async function refreshStudioProject() {
  if (!studioState.project) return;
  const data = await studioCall("project.get", { project_id: studioState.project.id });
  if (!data || !data.ok) return;
  const prevErrorIds = new Set(studioState.scenes.filter((s) => s.status === "error").map((s) => s.id));
  studioState.project = data.project;
  studioState.scenes = data.scenes || [];
  studioState.activeJobs = data.active_jobs || [];

  if (studioState.project.status === "done") {
    stopStudioPolling();
    renderStudioFinal();
    showStudioView("final");
    return;
  }
  if (studioState.view === "board") renderStudioBoard();
  if (studioState.sceneModalId) renderStudioSceneModal();

  const newErrors = studioState.scenes.filter((s) => s.status === "error" && !prevErrorIds.has(s.id));
  if (newErrors.length) {
    showToast(`Не получилось сгенерировать сцену: ${studioErrorText(newErrors[0].error) === "Что-то пошло не так. Попробуй ещё раз." ? (newErrors[0].error || "ошибка") : studioErrorText(newErrors[0].error)}`);
  }
}

async function ensureStudioPrices() {
  if (studioState.prices) return studioState.prices;
  const data = await studioCall("prices.get");
  if (data && data.ok) studioState.prices = data.prices;
  return studioState.prices;
}

// ── Экран идеи ───────────────────────────────────────────────

function resetStudioIdeaForm() {
  studioState.idea = { mode: "ai", aspect: "9:16", useAvatar: false, refUrls: [] };
  document.getElementById("studioIdeaInput").value = "";
  document.querySelectorAll("#studioModeSeg .segment").forEach((b) => b.classList.toggle("active", b.dataset.mode === "ai"));
  document.querySelectorAll("#studioAspectSeg .segment").forEach((b) => b.classList.toggle("active", b.dataset.aspect === "9:16"));
  document.getElementById("studioUseAvatar").checked = false;
  renderStudioRefs();
}

function renderStudioRefs() {
  const wrap = document.getElementById("studioRefs");
  wrap.innerHTML = "";
  studioState.idea.refUrls.forEach((url, idx) => {
    const thumb = document.createElement("div");
    thumb.className = "studio-ref-thumb";
    const img = document.createElement("img");
    img.src = normalizeUrl(url);
    img.alt = "Референс";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "×";
    rm.setAttribute("aria-label", "Убрать фото");
    rm.addEventListener("click", () => {
      studioState.idea.refUrls.splice(idx, 1);
      renderStudioRefs();
    });
    thumb.appendChild(img);
    thumb.appendChild(rm);
    wrap.appendChild(thumb);
  });
}

// Сжимаем до ~1024px JPEG на клиенте — Function ограничивает base64 2.5MB
// и не умеет ужимать сама (см. functions/api/studio/[[action]].js, uploadRef).
function studioCompressImageToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const maxDim = 1024;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        resolve(dataUrl.split(",")[1] || "");
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

document.getElementById("studioNewBtn").addEventListener("click", () => {
  resetStudioIdeaForm();
  showStudioView("idea");
});

document.getElementById("studioIdeaBack").addEventListener("click", () => {
  showStudioView("list");
});

document.querySelectorAll("#studioModeSeg .segment").forEach((btn) => {
  btn.addEventListener("click", () => {
    studioState.idea.mode = btn.dataset.mode;
    document.querySelectorAll("#studioModeSeg .segment").forEach((b) => b.classList.toggle("active", b === btn));
  });
});

document.querySelectorAll("#studioAspectSeg .segment").forEach((btn) => {
  btn.addEventListener("click", () => {
    studioState.idea.aspect = btn.dataset.aspect;
    document.querySelectorAll("#studioAspectSeg .segment").forEach((b) => b.classList.toggle("active", b === btn));
  });
});

document.getElementById("studioUseAvatar").addEventListener("change", (e) => {
  studioState.idea.useAvatar = e.target.checked;
});

document.getElementById("studioUploadRefBtn").addEventListener("click", () => {
  if (studioState.idea.refUrls.length >= 4) {
    showToast("Максимум 4 своих фото.");
    return;
  }
  document.getElementById("studioRefFile").click();
});

document.getElementById("studioRefFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const base64 = await studioCompressImageToBase64(file);
    if (!base64) throw new Error("empty base64");
    const data = await studioCall("upload", { image_base64: base64 });
    if (data && data.ok && data.url) {
      studioState.idea.refUrls.push(data.url);
      renderStudioRefs();
    }
  } catch (e2) {
    console.error("studio ref upload failed", e2);
    showToast("Не получилось обработать фото.");
  }
});

document.getElementById("studioCreateBtn").addEventListener("click", async () => {
  const idea = document.getElementById("studioIdeaInput").value.trim();
  if (!idea) {
    showToast("Опиши идею мультика.");
    return;
  }
  const btn = document.getElementById("studioCreateBtn");
  btn.disabled = true;
  const created = await studioCall("project.create", {
    title: idea.slice(0, 60),
    idea,
    mode: studioState.idea.mode,
    aspect: studioState.idea.aspect,
    use_avatar: studioState.idea.useAvatar,
    ref_urls: studioState.idea.refUrls,
  });
  if (!created || !created.ok) {
    btn.disabled = false;
    return;
  }
  studioState.project = created.project;
  studioState.scenes = created.scenes || [];
  studioState.activeJobs = created.active_jobs || [];
  await ensureStudioPrices();

  if (studioState.idea.mode === "ai") {
    const enq = await studioCall("enqueue", {
      project_id: created.project.id,
      jobs: [{ type: "scenario", payload: { idea } }],
    });
    if (enq && enq.ok) studioState.activeJobs = [...studioState.activeJobs, ...(enq.jobs || [])];
  }
  btn.disabled = false;
  renderStudioBoard();
  showStudioView("board");
  maybeStartStudioPolling();
});

// ── Раскадровка ──────────────────────────────────────────────

const STUDIO_SCENE_STATUS_LABEL = {
  empty: "Пусто",
  frame_queued: "Кадр…",
  frame_ready: "Кадр ✅",
  clip_queued: "Клип…",
  clip_ready: "Клип ✅",
  error: "Ошибка",
};

function studioSceneStatusClass(status) {
  if (status === "frame_ready" || status === "clip_ready") return "ready";
  if (status === "frame_queued" || status === "clip_queued") return "queued";
  if (status === "error") return "error";
  return "empty";
}

function studioSortedScenes() {
  return studioState.scenes.slice().sort((a, b) => a.ord - b.ord);
}

function findStudioScene(id) {
  return studioState.scenes.find((s) => s.id === id) || null;
}

function renderStudioBoard() {
  const project = studioState.project;
  document.getElementById("studioBoardTitle").textContent = project.title || "Без названия";

  const grid = document.getElementById("studioScenes");
  grid.innerHTML = "";
  const scenes = studioSortedScenes();

  if (!scenes.length) {
    const msg = document.createElement("p");
    msg.className = "studio-hint";
    msg.style.cssText = "grid-column:1/-1;text-align:center;padding:24px 0;";
    msg.textContent = studioState.activeJobs.some((j) => j.type === "scenario")
      ? "🪄 ИИ придумывает сцены…"
      : "Сцен пока нет — добавь первую.";
    grid.appendChild(msg);
  } else {
    scenes.forEach((scene, idx) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "studio-scene-card";

      const thumb = document.createElement("div");
      thumb.className = "studio-scene-thumb";
      const num = document.createElement("span");
      num.className = "studio-scene-num";
      num.textContent = String(idx + 1);
      thumb.appendChild(num);

      if (scene.clip_url) {
        const video = document.createElement("video");
        video.src = normalizeUrl(scene.clip_url);
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        thumb.appendChild(video);
      } else if (scene.frame_url) {
        const img = document.createElement("img");
        img.src = normalizeUrl(scene.frame_url);
        img.alt = "";
        thumb.appendChild(img);
      }

      const status = document.createElement("span");
      status.className = `studio-scene-status studio-scene-status--${studioSceneStatusClass(scene.status)}`;
      status.textContent = STUDIO_SCENE_STATUS_LABEL[scene.status] || scene.status;
      thumb.appendChild(status);

      const foot = document.createElement("div");
      foot.className = "studio-scene-foot";
      foot.textContent = scene.frame_prompt || "Промт кадра не задан";

      card.appendChild(thumb);
      card.appendChild(foot);
      card.addEventListener("click", () => openStudioScene(scene.id));
      grid.appendChild(card);
    });
  }

  const addBtn = document.getElementById("studioAddScene");
  const maxScenes = studioState.prices?.max_scenes || 5;
  addBtn.classList.toggle("hidden", !(project.mode === "manual" && scenes.length < maxScenes));

  const readyClips = scenes.filter((s) => s.status === "clip_ready" && s.clip_url).length;
  const stitchBtn = document.getElementById("studioStitchBtn");
  stitchBtn.classList.toggle("hidden", readyClips < 2 || project.status === "stitching");
  stitchBtn.disabled = project.status === "stitching";
  stitchBtn.textContent = project.status === "stitching" ? "Склеиваю…" : "🎬 Склеить мультик";

  renderStudioCart();
}

document.getElementById("studioBoardBack").addEventListener("click", () => {
  stopStudioPolling();
  showStudioView("list");
  loadStudioProjects();
});

document.getElementById("studioAddScene").addEventListener("click", async () => {
  if (!studioState.project) return;
  const data = await studioCall("scene.upsert", {
    project_id: studioState.project.id,
    scene: { frame_prompt: "", video_prompt: "" },
  });
  if (data && data.ok) await refreshStudioProject();
});

document.getElementById("studioStitchBtn").addEventListener("click", async () => {
  const btn = document.getElementById("studioStitchBtn");
  btn.disabled = true;
  const data = await studioCall("enqueue", { project_id: studioState.project.id, jobs: [{ type: "stitch" }] });
  if (data && data.ok) {
    studioState.project.status = "stitching";
    studioState.activeJobs = [...studioState.activeJobs, ...(data.jobs || [])];
    renderStudioBoard();
    startStudioPolling();
  } else {
    btn.disabled = false;
  }
});

// ── Корзина-смета ────────────────────────────────────────────

function studioHasReferences(project) {
  if (project.use_avatar) return true;
  try {
    return (JSON.parse(project.ref_urls || "[]") || []).length > 0;
  } catch {
    return false;
  }
}

function studioFramePrice() {
  const prices = studioState.prices;
  if (!prices || !studioState.project) return 0;
  return prices.frame_cost + (studioHasReferences(studioState.project) ? prices.reference_cost : 0);
}

function studioClipPrice(scene) {
  const prices = studioState.prices;
  const model = prices?.models?.[scene.model];
  if (!model) return 0;
  return Math.max(1, Math.round((scene.duration || 5) * model.cost_per_second));
}

// Сцены, готовые встать в очередь ПРЯМО СЕЙЧАС (для «Сгенерить» пакетом) —
// кадр без активного job'а того же типа + промт задан; клип аналогично, и
// если кадра ещё нет, но он тоже войдёт в этот батч — depends_on свяжет их
// на сервере (см. enqueue() в [[action]].js, ревизия п.3 ТЗ).
function studioPendingBatch() {
  const liveKeys = new Set(studioState.activeJobs.map((j) => `${j.type}:${j.scene_id || ""}`));
  const jobs = [];
  let total = 0;
  for (const scene of studioState.scenes) {
    const needsFrame = scene.status === "empty" && (scene.frame_prompt || "").trim() && !liveKeys.has(`frame:${scene.id}`);
    if (needsFrame) {
      jobs.push({ type: "frame", scene_id: scene.id });
      total += studioFramePrice();
    }
    const hasVideoPrompt = (scene.video_prompt || "").trim().length > 0;
    const clipLive = liveKeys.has(`clip:${scene.id}`) || scene.status === "clip_queued";
    const needsClip = hasVideoPrompt && !clipLive && scene.status !== "clip_ready" && (scene.frame_url || needsFrame);
    if (needsClip) {
      jobs.push({ type: "clip", scene_id: scene.id, payload: { model: scene.model, duration: scene.duration } });
      total += studioClipPrice(scene);
    }
  }
  return { jobs, total };
}

function renderStudioCart() {
  const { jobs, total } = studioPendingBatch();
  document.getElementById("studioCartSum").innerHTML = `Итого: <b>${total} 🍇</b>`;
  const btn = document.getElementById("studioCartGenerate");
  btn.disabled = jobs.length === 0;
  btn._studioPendingJobs = jobs;
}

document.getElementById("studioCartGenerate").addEventListener("click", async () => {
  const btn = document.getElementById("studioCartGenerate");
  const jobs = btn._studioPendingJobs || [];
  if (!jobs.length || !studioState.project) return;
  btn.disabled = true;
  const data = await studioCall("enqueue", { project_id: studioState.project.id, jobs });
  if (data && data.ok) {
    studioState.activeJobs = [...studioState.activeJobs, ...(data.jobs || [])];
    renderStudioBoard();
    startStudioPolling();
  } else {
    btn.disabled = false;
  }
});

// ── Модалка сцены ────────────────────────────────────────────

function openStudioScene(sceneId) {
  studioState.sceneModalId = sceneId;
  renderStudioSceneModal();
  const modal = document.getElementById("sceneModal");
  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "");
}

function renderStudioSceneModal() {
  const scene = findStudioScene(studioState.sceneModalId);
  if (!scene) return;
  const idx = studioSortedScenes().findIndex((s) => s.id === scene.id);

  document.getElementById("sceneModalMeta").textContent =
    `Сцена ${idx + 1} · ${STUDIO_SCENE_STATUS_LABEL[scene.status] || scene.status}`;

  const media = document.getElementById("sceneModalMedia");
  media.innerHTML = "";
  if (scene.clip_url) {
    const video = document.createElement("video");
    video.src = normalizeUrl(scene.clip_url);
    video.controls = true;
    video.playsInline = true;
    video.className = "preview loaded";
    media.appendChild(video);
  } else if (scene.frame_url) {
    const img = document.createElement("img");
    img.src = normalizeUrl(scene.frame_url);
    img.className = "preview loaded";
    img.alt = "";
    media.appendChild(img);
  }

  document.getElementById("sceneFramePrompt").value = scene.frame_prompt || "";
  const frameBtn = document.getElementById("sceneFrameGenerate");
  const frameBusy = scene.status === "frame_queued";
  frameBtn.disabled = frameBusy;
  frameBtn.textContent = frameBusy ? "Генерирую кадр…" : scene.frame_url ? "🚀 Перегенерить кадр" : "🚀 Сгенерить кадр";

  const videoFields = document.getElementById("sceneVideoFields");
  const showVideoFields = Boolean(scene.frame_url);
  videoFields.classList.toggle("hidden", !showVideoFields);
  document.getElementById("sceneFrameNewerHint").classList.toggle("hidden", !scene.frame_newer_than_clip);

  if (showVideoFields) {
    document.getElementById("sceneVideoPrompt").value = scene.video_prompt || "";
    renderSceneModelPills(scene);
    renderSceneDurationPills(scene);
    document.getElementById("sceneClipPrice").textContent = `${studioClipPrice(scene)} 🍇`;
    const clipBtn = document.getElementById("sceneClipGenerate");
    const clipBusy = scene.status === "clip_queued";
    clipBtn.disabled = clipBusy;
    clipBtn.textContent = clipBusy ? "Генерирую клип…" : scene.clip_url ? "🚀 Перегенерить клип" : "🚀 Сгенерить клип";
  }
}

function renderSceneModelPills(scene) {
  const wrap = document.getElementById("sceneModelPills");
  wrap.innerHTML = "";
  const models = studioState.prices?.models || {};
  Object.entries(models).forEach(([code, model]) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = `studio-pill ${scene.model === code ? "active" : ""}`;
    pill.textContent = model.label || code;
    pill.addEventListener("click", async () => {
      if (scene.model === code || !studioState.project) return;
      scene.model = code;
      const durations = model.durations || [5];
      if (!durations.includes(scene.duration)) scene.duration = durations[0];
      await studioCall("scene.upsert", {
        project_id: studioState.project.id,
        scene: { id: scene.id, model: scene.model, duration: scene.duration },
      });
      renderStudioSceneModal();
    });
    wrap.appendChild(pill);
  });
}

function renderSceneDurationPills(scene) {
  const wrap = document.getElementById("sceneDurationPills");
  wrap.innerHTML = "";
  const durations = studioState.prices?.models?.[scene.model]?.durations || [5];
  durations.forEach((d) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = `studio-pill ${scene.duration === d ? "active" : ""}`;
    pill.textContent = `${d}с`;
    pill.addEventListener("click", async () => {
      if (scene.duration === d || !studioState.project) return;
      scene.duration = d;
      await studioCall("scene.upsert", { project_id: studioState.project.id, scene: { id: scene.id, duration: d } });
      renderStudioSceneModal();
    });
    wrap.appendChild(pill);
  });
}

document.getElementById("sceneFramePrompt").addEventListener("blur", async (e) => {
  const scene = findStudioScene(studioState.sceneModalId);
  if (!scene || !studioState.project) return;
  const val = e.target.value.trim();
  if (val === (scene.frame_prompt || "")) return;
  scene.frame_prompt = val;
  await studioCall("scene.upsert", { project_id: studioState.project.id, scene: { id: scene.id, frame_prompt: val } });
});

document.getElementById("sceneVideoPrompt").addEventListener("blur", async (e) => {
  const scene = findStudioScene(studioState.sceneModalId);
  if (!scene || !studioState.project) return;
  const val = e.target.value.trim();
  if (val === (scene.video_prompt || "")) return;
  scene.video_prompt = val;
  await studioCall("scene.upsert", { project_id: studioState.project.id, scene: { id: scene.id, video_prompt: val } });
});

document.getElementById("sceneFrameGenerate").addEventListener("click", async () => {
  const scene = findStudioScene(studioState.sceneModalId);
  if (!scene || !studioState.project) return;
  const prompt = document.getElementById("sceneFramePrompt").value.trim();
  if (!prompt) {
    showToast("Опиши, что должно быть на кадре.");
    return;
  }
  if (prompt !== (scene.frame_prompt || "")) {
    scene.frame_prompt = prompt;
    await studioCall("scene.upsert", { project_id: studioState.project.id, scene: { id: scene.id, frame_prompt: prompt } });
  }
  const data = await studioCall("enqueue", {
    project_id: studioState.project.id,
    jobs: [{ type: "frame", scene_id: scene.id }],
  });
  if (data && data.ok) {
    scene.status = "frame_queued";
    studioState.activeJobs = [...studioState.activeJobs, ...(data.jobs || [])];
    renderStudioSceneModal();
    renderStudioBoard();
    startStudioPolling();
  }
});

document.getElementById("sceneClipGenerate").addEventListener("click", async () => {
  const scene = findStudioScene(studioState.sceneModalId);
  if (!scene || !studioState.project) return;
  const videoPrompt = document.getElementById("sceneVideoPrompt").value.trim();
  if (videoPrompt !== (scene.video_prompt || "")) {
    scene.video_prompt = videoPrompt;
    await studioCall("scene.upsert", { project_id: studioState.project.id, scene: { id: scene.id, video_prompt: videoPrompt } });
  }
  const data = await studioCall("enqueue", {
    project_id: studioState.project.id,
    jobs: [{ type: "clip", scene_id: scene.id, payload: { model: scene.model, duration: scene.duration } }],
  });
  if (data && data.ok) {
    scene.status = "clip_queued";
    studioState.activeJobs = [...studioState.activeJobs, ...(data.jobs || [])];
    renderStudioSceneModal();
    renderStudioBoard();
    startStudioPolling();
  }
});

document.getElementById("sceneDeleteBtn").addEventListener("click", async () => {
  const scene = findStudioScene(studioState.sceneModalId);
  if (!scene || !studioState.project) return;
  const data = await studioCall("scene.delete", { project_id: studioState.project.id, scene_id: scene.id });
  document.getElementById("sceneModal").close();
  if (data && data.ok) await refreshStudioProject();
});

document.getElementById("sceneModalClose").addEventListener("click", () => document.getElementById("sceneModal").close());
document.getElementById("sceneModal").addEventListener("click", (e) => {
  if (e.target.id === "sceneModal") document.getElementById("sceneModal").close();
});
document.getElementById("sceneModal").addEventListener("close", () => {
  studioState.sceneModalId = null;
});

// ── Финал ────────────────────────────────────────────────────

function renderStudioFinal() {
  const project = studioState.project;
  document.getElementById("studioFinalTitle").textContent = project.title || "Готово";
  document.getElementById("studioFinalVideo").src = normalizeUrl(project.final_url);

  const totalDuration = studioState.scenes.reduce(
    (sum, s) => sum + (s.status === "clip_ready" ? Number(s.duration) || 0 : 0),
    0,
  );
  const stats = document.getElementById("studioFinalStats");
  stats.innerHTML = "";
  [
    ["Сцен", String(studioState.scenes.length)],
    ["Длительность", `${totalDuration} сек`],
  ].forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "studio-detail-row";
    row.innerHTML = `<span>${label}</span><span>${value}</span>`;
    stats.appendChild(row);
  });
}

document.getElementById("studioFinalBack").addEventListener("click", () => {
  showStudioView("list");
  loadStudioProjects();
});

// ── Поллинг статусов job'ов ──────────────────────────────────

function maybeStartStudioPolling() {
  if (studioState.activeJobs.length > 0) startStudioPolling();
}

function startStudioPolling() {
  if (studioState.pollTimer) return;
  studioState.pollTimer = setInterval(async () => {
    if (!studioState.project) {
      stopStudioPolling();
      return;
    }
    await refreshStudioProject();
    if (!studioState.activeJobs.length) stopStudioPolling();
  }, 4000);
}

function stopStudioPolling() {
  if (studioState.pollTimer) {
    clearInterval(studioState.pollTimer);
    studioState.pollTimer = null;
  }
}

// ── Вход/выход из таба «Студия» ──────────────────────────────
// Отдельный листенер поверх switchTab() из app.js: та функция только
// переключает видимость .tab-page, ничего не знает про студию и её
// sticky-корзину (она вне #pageStudio по вёрстке — см. index.html).

tabBar.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  if (tab.dataset.tab !== "studio") {
    stopStudioPolling();
    studioCartEl.classList.add("hidden");
    return;
  }
  showStudioView(studioState.view);
  if (studioState.view === "board") maybeStartStudioPolling();
  if (studioState.view === "list" && !studioState.projects.length) loadStudioProjects();
});
