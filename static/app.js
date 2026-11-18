"use strict";

const $ = (id) => document.getElementById(id);

let state = null;
let battle = null;
let username = "";
let screen = "auth";
let saveSlots = [];
let activeSlot = 1;
let selectedUid = null;
let recycleMode = false;
let discardSelection = new Set();
let adventureTarget = null;
let adventureEffect = null;
let enhanceKind = "adventure";
let recycleTarget = null;
let trialPick = null;
let trainingPick = null;
let relayAction = null;
let supplyPick = null;
let supplyPayment = null;
let supplyRemoveUid = null;
let shopTarget = null;
let relayTarget = null;
let signalAction = null;
let signalTarget = null;
let draggingUid = null;
let dragDropped = false;
let busy = false;
let loadingBattle = false;
let toastTimer = null;
let storyTypingTimer = null;
let storyLineKey = "";
let storyCharacters = [];
let storyVisibleCharacters = 0;
let transitionKey = null;
let transitionToken = null;
let transitionStatus = null;
let transitionTimer = null;

const NODE_TYPES = {
  battle: "战斗",
  recruit: "招募",
  signal: "信号",
  adventure: "维修",
  calibration: "校准",
  drift: "卡匣",
  recycle: "回收",
  shop: "商船",
  trial: "试炼",
  drones: "无人机",
  training: "训练",
  relay: "中继",
  supply: "补给",
};
const MAP_STATUS = { completed: "已完成", available: "可进入", locked: "未解锁", closed: "已关闭" };
const TRANSITION_CLIPS = { map: "clip-01", map2: "clip-02", map3: "clip-04", complete: "clip-03" };
let autoMap2 = false;
let autoMap3 = false;

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(text) {
  const toast = $("toast");
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function missingPayload() {
  const message = "游戏状态缺少必要数据，请刷新页面后重试。";
  showToast(message);
  state = null;
  battle = null;
  render();
  $("auth-error").textContent = message;
}

let dialogReturn = null;

function showDialog(panel, focusTarget) {
  if (panel.hidden) {
    dialogReturn = document.activeElement;
    panel.hidden = false;
  }
  if (focusTarget && !panel.contains(document.activeElement)) focusTarget.focus();
}

function hideDialog(panel) {
  if (panel.hidden) return;
  panel.hidden = true;
  const target = dialogReturn && document.body.contains(dialogReturn) ? dialogReturn : $("end-turn");
  if (target && !target.disabled) target.focus();
  dialogReturn = null;
}

function trapDialogFocus(event) {
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll(
    "button:not([disabled]), [tabindex='0']"
  )];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function api(path, body, method) {
  const options = method
    ? { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }
    : body === undefined
      ? { method: "GET" }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let response;
  let data = null;
  try {
    response = await fetch(path, { ...options, signal: controller.signal });
    try { data = await response.json(); } catch (_) { /* 非 JSON 响应 */ }
  } catch (error) {
    throw new Error(error.name === "AbortError" ? "请求超时，请重试" : "网络连接失败");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    if (response.status === 401) {
      state = null;
      battle = null;
      username = "";
      screen = "auth";
      render();
    }
    const detail = data && data.detail;
    throw new Error(typeof detail === "string" ? detail : `请求失败（${response.status}）`);
  }
  if (data === null) throw new Error("服务器响应格式异常");
  return data;
}

function apply(data) {
  if (!data) return;
  if (data.state) {
    if (!data.state.story) {
      if (storyTypingTimer !== null) clearInterval(storyTypingTimer);
      storyTypingTimer = null;
      storyLineKey = "";
      storyCharacters = [];
      storyVisibleCharacters = 0;
    }
    const previousNode = state && state.node ? state.node.id : null;
    const nextNode = data.state.node ? data.state.node.id : null;
    if (previousNode !== nextNode) {
      selectedUid = null;
      discardSelection.clear();
      adventureTarget = null;
      adventureEffect = null;
      recycleTarget = null;
      trialPick = null;
      trainingPick = null;
      shopTarget = null;
      supplyPick = null;
      supplyPayment = null;
      supplyRemoveUid = null;
      relayAction = null;
      relayTarget = null;
      signalAction = null;
      signalTarget = null;
    }
    state = data.state;
    if (state.phase !== "complete") {
      autoMap2 = false;
      autoMap3 = false;
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, "battle")) {
    battle = data.battle;
    if (!battle) {
      selectedUid = null;
      recycleMode = false;
      discardSelection.clear();
    }
  }
  if (data.username) username = data.username;
  render();
}

function hideViews() {
  ["menu-view", "save-slots-view", "cg-view", "transition-view", "story-view", "map-view", "battle-view", "elite-reward-view", "recruit-view", "signal-view", "adventure-view", "drift-view", "recycle-view", "shop-view", "trial-view", "supply-view", "relay-view", "training-view", "complete-view"].forEach((id) => {
    $(id).hidden = true;
  });
}

function renderSaveSlots() {
  const active = saveSlots.find((slot) => slot.slotId === activeSlot);
  $("continue-btn").disabled = !active || active.empty || active.corrupt;
  $("title-user").textContent = username;
  $("save-slots").innerHTML = saveSlots.map((slot) => {
    const title = slot.corrupt ? "存档无法读取" : slot.empty ? "空存档槽" : esc(slot.mapTitle || "未命名路线");
    const detail = slot.corrupt ? "数据已保留，可删除此存档槽。" : slot.empty
      ? "尚未开始冒险。"
      : `${esc(slot.chapter)}<br>进度 ${slot.progress}/${slot.runLength} · ${esc(slot.nodeName)}${slot.complete ? " · 已通关" : ""}`;
    const time = slot.updatedAt ? new Date(slot.updatedAt * 1000).toLocaleString() : "";
    const actions = slot.corrupt
      ? `<button class="ghost" data-slot-action="delete" data-slot="${slot.slotId}">删除存档</button>`
      : slot.empty
        ? `<button data-slot-action="new" data-slot="${slot.slotId}">开始新游戏</button>`
        : `<button data-slot-action="continue" data-slot="${slot.slotId}">继续</button><button class="ghost" data-slot-action="new" data-slot="${slot.slotId}">新游戏</button><button class="ghost" data-slot-action="delete" data-slot="${slot.slotId}">删除</button>`;
    return `<article class="save-slot${slot.empty ? " empty" : ""}${slot.corrupt ? " corrupt" : ""}${slot.slotId === activeSlot ? " active" : ""}">
      <h2>存档 ${slot.slotId}${slot.slotId === activeSlot ? " · 最近使用" : ""}</h2><p class="slot-chapter">${title}</p>
      <p class="slot-progress">${detail}</p><time class="slot-time">${time ? `保存于 ${esc(time)}` : ""}</time>
      <div class="slot-actions">${actions}</div></article>`;
  }).join("");
}

function render() {
  if (screen !== "game" || !state || state.phase !== "transition") clearTransition();
  if (screen !== "game" || !state || !["map_story", "before_story", "after_story"].includes(state.phase)) {
    if (storyTypingTimer !== null) clearInterval(storyTypingTimer);
    storyTypingTimer = null;
    storyLineKey = "";
    storyCharacters = [];
    storyVisibleCharacters = 0;
  }
  const loggedIn = !!username;
  $("auth").hidden = loggedIn;
  $("game").hidden = !loggedIn;
  updateViewportGuard(loggedIn && screen === "game" && state?.phase !== "transition");
  if (!loggedIn) {
    $("auth-error").textContent = "";
    return;
  }

  $("hud-user").textContent = username;
  $("menu-btn").hidden = screen === "menu";
  if (screen !== "game") {
    $("hud-gold").textContent = "—";
    $("hud-node").textContent = "";
  }
  hideViews();
  if (screen === "menu") {
    $("menu-view").hidden = false;
    renderSaveSlots();
    return;
  }
  if (screen === "slots") {
    $("save-slots-view").hidden = false;
    renderSaveSlots();
    return;
  }
  if (screen === "gallery") {
    $("cg-view").hidden = false;
    return;
  }
  if (screen !== "game" || !state) {
    screen = "menu";
    $("menu-view").hidden = false;
    renderSaveSlots();
    return;
  }

  $("hud-gold").textContent = Number.isFinite(state.gold) ? state.gold : "—";
  const progress = Number.isInteger(state.progress) && Number.isInteger(state.runLength) && state.runLength > 0
    ? `（${state.progress}/${state.runLength}）` : "";
  if (state.complete) {
    $("hud-node").textContent = "路线完成";
  } else if (state.phase === "map_story") {
    $("hud-node").textContent = `${state.mapMeta?.chapter || "新章节"} 序幕`;
  } else if (state.phase === "map") {
    $("hud-node").textContent = `路线选择${progress}`;
  } else if (state.node) {
    $("hud-node").textContent = `${state.node.name || "当前节点"}${progress}`;
  } else {
    $("hud-node").textContent = "";
  }

  if (state.complete) {
    renderComplete();
    return;
  }
  if (state.phase === "transition") {
    renderTransition();
    return;
  }
  if (state.phase === "map") {
    renderMap();
    return;
  }
  if (state.phase === "map_story" || state.phase === "before_story" || state.phase === "after_story") {
    renderStory();
    return;
  }
  if (state.phase === "elite_reward") {
    renderEliteReward();
    return;
  }
  if (state.node && state.node.type === "battle") {
    renderBattle();
    return;
  }
  if (state.node && state.node.type === "recruit") {
    renderRecruit();
    return;
  }
  if (state.node && state.node.type === "signal") {
    renderSignal();
    return;
  }
  if (state.node && state.node.type === "adventure") {
    renderAdventure("adventure");
    return;
  }
  if (state.node && state.node.type === "calibration") {
    renderAdventure("calibration");
    return;
  }
  if (state.node && state.node.type === "drones") {
    renderAdventure("drones");
    return;
  }
  if (state.node && state.node.type === "relay") {
    renderRelay();
    return;
  }
  if (state.node && state.node.type === "training") {
    renderTraining();
    return;
  }
  if (state.node && state.node.type === "drift") {
    renderDrift();
    return;
  }
  if (state.node && state.node.type === "recycle") {
    renderRecycle();
    return;
  }
  if (state.node && state.node.type === "shop") {
    renderShop();
    return;
  }
  if (state.node && state.node.type === "trial") {
    renderTrial();
    return;
  }
  if (state.node && state.node.type === "supply") {
    renderSupply();
  }
}

function updateViewportGuard(loggedIn = !!state) {
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  const portrait = mobile && window.innerHeight > window.innerWidth;
  const width = mobile ? 667 : 1024;
  const height = mobile ? 375 : 600;
  $("orientation-guard").hidden = !loggedIn || !portrait;
  $("orientation-guard").querySelector("p").textContent = state && state.story
    ? "为了完整呈现场景、立绘和对白，请横向旋转设备。"
    : "机偶回路的战术界面需要横向空间。";
  $("size-guard").hidden = !loggedIn || portrait || window.innerWidth >= width && window.innerHeight >= height;
}

function refreshPagedLists(root = document) {
  root.querySelectorAll(".offers, .targets").forEach((list) => {
    const items = [...list.children];
    let controls = list.nextElementSibling;
    if (!controls || !controls.classList.contains("page-controls")) {
      controls = document.createElement("div");
      controls.className = "page-controls";
      list.after(controls);
    }
    const compact = window.matchMedia("(max-width: 760px) and (orientation: landscape)").matches;
    const width = items[0]?.classList.contains("card-offer") || items[0]?.classList.contains("card-target") ? (compact ? 118 : 196) : (compact ? 190 : 250);
    const pageSize = Math.max(1, Math.floor((list.clientWidth || window.innerWidth) / width));
    const pageCount = Math.ceil(items.length / pageSize);
    const page = Math.max(0, Math.min(Number(list.dataset.page || 0), pageCount - 1));
    list.dataset.page = String(page);
    items.forEach((item, index) => { item.hidden = index < page * pageSize || index >= (page + 1) * pageSize; });
    controls.hidden = pageCount < 2;
    controls.innerHTML = pageCount < 2 ? "" : `<button type="button" class="ghost" data-page-step="-1" aria-label="上一页" ${page === 0 ? "disabled" : ""}>‹</button><span aria-live="polite">${page + 1} / ${pageCount}</span><button type="button" class="ghost" data-page-step="1" aria-label="下一页" ${page + 1 === pageCount ? "disabled" : ""}>›</button>`;
  });
}

/* ---------- 剧情 ---------- */

function finishStoryTyping() {
  if (storyTypingTimer !== null) clearInterval(storyTypingTimer);
  storyTypingTimer = null;
  storyVisibleCharacters = storyCharacters.length;
  $("story-text").textContent = storyCharacters.join("");
  const options = state.story.options || [];
  $("story-options").hidden = options.length === 0;
  $("story-continue-hint").hidden = options.length > 0;
}

function advanceStoryFromScene() {
  if (busy || !state || !state.story) return;
  if (storyVisibleCharacters < storyCharacters.length) finishStoryTyping();
  else if (!state.story.options?.length) advanceStory(false);
}

function renderStory() {
  const story = state.story;
  if (!story) {
    missingPayload();
    return;
  }
  $("story-view").hidden = false;
  $("story-panel").className = "story-panel";
  $("story-node").textContent = story.title || `${state.node.name} · ${state.phase === "after_story" ? "后日谈" : "前日谈"}`;
  $("story-speaker").textContent = story.speaker;
  $("story-text").setAttribute("aria-label", story.text);
  $("story-progress").textContent = `${story.line} / ${story.total}`;

  const lineKey = `${state.node.id}:${state.phase}:${story.line}:${story.text}`;
  if (lineKey !== storyLineKey) {
    if (storyTypingTimer !== null) clearInterval(storyTypingTimer);
    storyTypingTimer = null;
    storyLineKey = lineKey;
    storyCharacters = Array.from(story.text || "");
    storyVisibleCharacters = 0;
    $("story-text").textContent = "";
    if (storyCharacters.length && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      storyTypingTimer = setInterval(() => {
        storyVisibleCharacters += 1;
        $("story-text").textContent = storyCharacters.slice(0, storyVisibleCharacters).join("");
        if (storyVisibleCharacters >= storyCharacters.length) finishStoryTyping();
      }, 25);
    } else {
      finishStoryTyping();
    }
  }

  const options = story.options || [];
  $("story-options").innerHTML = options.length
    ? `<span class="story-options-hint">请选择：</span>` + options
        .map((option) => `<button class="story-option" data-option="${esc(option.id)}">${esc(option.text)}</button>`)
        .join("")
    : "";
  $("story-skip").disabled = options.length > 0;
  $("story-options").hidden = options.length === 0 || storyVisibleCharacters < storyCharacters.length;
  $("story-continue-hint").hidden = options.length > 0 && storyVisibleCharacters >= storyCharacters.length;
}

function clearTransition() {
  clearTimeout(transitionTimer);
  transitionTimer = null;
  if (transitionKey !== null) $("transition-frame").removeAttribute("src");
  transitionKey = null;
  transitionToken = null;
  transitionStatus = null;
}

function failTransition(message) {
  clearTimeout(transitionTimer);
  transitionTimer = null;
  transitionStatus = "failed";
  $("transition-error-text").textContent = message;
  $("transition-error").hidden = false;
}

function startTransitionPlayback(target) {
  clearTimeout(transitionTimer);
  transitionStatus = "loading";
  transitionToken = crypto.randomUUID();
  $("transition-error").hidden = true;
  const clip = TRANSITION_CLIPS[target];
  $("transition-frame").src = `/assets/transitions/seagate/${clip}.html?gameTransition=${encodeURIComponent(transitionToken)}`;
  transitionTimer = setTimeout(() => failTransition("转场动画加载超时。可以重试动画，或继续游戏。"), 30000);
}

function renderTransition() {
  const target = state.transitionTarget;
  const clip = TRANSITION_CLIPS[target];
  $("transition-view").hidden = false;
  if (!clip) {
    if (transitionStatus !== "failed") {
      $("transition-continue").disabled = true;
      failTransition("转场目标无效，无法继续播放。");
    }
    return;
  }
  $("transition-continue").disabled = false;
  const key = `${state.mapType}:${target}`;
  if (key !== transitionKey) {
    transitionKey = key;
    startTransitionPlayback(target);
  }
}

async function completeTransition() {
  if (busy || !["playing", "failed"].includes(transitionStatus)) return;
  busy = true;
  transitionStatus = "finishing";
  clearTimeout(transitionTimer);
  try {
    const data = await api("/api/story/advance", { transition: true });
    apply(data);
  } catch (error) {
    try {
      const latest = await api("/api/state");
      if (latest.state?.phase !== "transition") {
        apply(latest);
        return;
      }
    } catch (_) { /* 网络仍不可用时保留转场重试入口 */ }
    failTransition(error.message);
  } finally {
    busy = false;
  }
}

function onTransitionMessage(event) {
  const message = event.data;
  if (event.origin !== location.origin || event.source !== $("transition-frame").contentWindow
      || !message || message.token !== transitionToken) return;
  if (message.type === "seagate-transition-ready" && transitionStatus === "loading") {
    transitionStatus = "playing";
    clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => failTransition("转场动画未能正常结束。可以重试动画，或继续游戏。"), 30000);
  } else if (message.type === "seagate-transition-ended" && transitionStatus === "playing") {
    completeTransition();
  } else if (message.type === "seagate-transition-error" && ["loading", "playing"].includes(transitionStatus)) {
    failTransition(message.detail || "转场动画资源加载失败。可以重试动画，或继续游戏。");
  }
}

async function advanceStory(skip) {
  if (busy) return;
  busy = true;
  try {
    const data = await api("/api/story/advance", { skip });
    apply(data);
  } catch (error) {
    showToast(error.message);
  } finally {
    busy = false;
  }
}

async function chooseStoryOption(optionId) {
  if (busy) return;
  busy = true;
  try {
    const data = await api("/api/story/choose", { optionId });
    apply(data);
  } catch (error) {
    showToast(error.message);
  } finally {
    busy = false;
  }
}

/* ---------- 关卡选择 ---------- */

function mapNodeButton(node) {
  if (!node) return "";
  const type = NODE_TYPES[node.type] || node.type;
  const status = MAP_STATUS[node.status] || node.status;
  const disabled = node.status === "available" ? "" : "disabled";
  const icons = {
    battle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 3 4 1 11 14-2 2L5 7 4 3Zm16 0-4 1L5 18l2 2L19 7l1-4ZM3 16l5 5m8-5 5 5"/></svg>',
    recruit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 7 9-4 9 4v13H3V7Zm0 0 9 4 9-4M12 11v9M8 5l9 4v5"/></svg>',
    signal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16a8 8 0 0 1 16 0M7 16a5 5 0 0 1 10 0M10 16a2 2 0 0 1 4 0"/><path d="M12 19v1"/></svg>',
    adventure: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4a6 6 0 0 0-7 8L3 17a3 3 0 0 0 4 4l5-5a6 6 0 0 0 8-7l-4 4-4-4 2-5Z"/></svg>',
    calibration: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17h18M5 17V9m7 8V5m7 12v-6"/><path d="M3 21h18"/></svg>',
    drift: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16M9 5v14"/></svg>',
    recycle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V5h6v3M10 12v4M14 12v4"/></svg>',
    shop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 15 5 6h11l4-6H2ZM12 15V2L4 12h8m2-8 6 8h-6"/></svg>',
    trial: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21 9 9h6l1 12M6 9V4h3V2h6v2h3v5H6ZM6 21h12M11 14h2"/></svg>',
    drones: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="9" width="8" height="7" rx="2"/><path d="m8 10-4-4m12 4 4-4M2 6h5m10 0h5M12 9V5m-3 14 3 2 3-2"/></svg>',
    relay: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 21 5-13 5 13M8 17h8M6 10a8 8 0 0 1 0-7m12 7a8 8 0 0 0 0-7M12 8c-6-3-3-7 0-4 3-3 6 1 0 4Z"/></svg>',
    training: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="13" r="8"/><circle cx="11" cy="13" r="4"/><path d="m11 13 9-10m-4 0h4v4"/></svg>',
    supply: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h16v11H4V9Zm2 0V5h12v4M9 13h6M12 13v4"/></svg>',
    boss: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 1v4m0 14v4M3 3l3 4m12 10 3 4M21 3l-3 4M6 17l-3 4"/><path d="m12 8 3 4-3 4-3-4 3-4Z"/></svg>'
  };
  const icon = node.role === "boss" ? icons.boss : icons[node.type] || icons.adventure;
  return `<button class="map-node status-${esc(node.status)} type-${esc(node.type)}"
      data-id="${esc(node.id)}" ${disabled}
      aria-label="${esc(node.name)}，${esc(type)}，${esc(status)}">
      <span class="map-node-icon">${icon}</span>
      <span class="map-node-label"><span class="map-node-name">${esc(node.name)}</span><span class="map-node-status">${esc(status)}</span></span>
    </button>`;
}

function renderComplete() {
  $("complete-view").hidden = false;
  if (state.mapType === "map1" && state.canStartMap2 && !autoMap2) {
    autoMap2 = true;
    act("/api/game/map2", {});
    return;
  }
  if (state.mapType === "map2" && state.canStartMap3 && !autoMap3) {
    autoMap3 = true;
    act("/api/game/map3", {});
    return;
  }
  const meta = state.mapMeta || {};
  const finalMap = state.mapType === "map3";
  $("complete-title").textContent = finalMap ? "静海档案完成" : `${meta.title || "回路边境"}完成`;
  $("complete-text").textContent = finalMap
    ? "你走完了海渊档案的最后一段路。"
    : `你已经走通了${meta.title || "回路边境"}的完整路线。`;
  const canContinue = state.canStartMap2 || state.canStartMap3;
  $("map2-btn").hidden = !canContinue;
  $("map2-btn").textContent = state.canStartMap3 ? "进入第三张地图" : "进入第二张地图";
}

function renderMap() {
  const map = state.map;
  if (!map) {
    missingPayload();
    return;
  }
  $("map-view").hidden = false;
  const byId = Object.fromEntries(map.nodes.map((node) => [node.id, node]));
  const available = map.nodes.filter((node) => node.status === "available");
  const maxColumn = Math.max(...map.nodes.map((node) => node.column));
  const columnCounts = {};
  map.nodes.forEach((node) => { columnCounts[node.column] = (columnCounts[node.column] || 0) + 1; });
  const positions = new Map();
  map.nodes.forEach((node) => {
    const x = 85 + (maxColumn ? node.column / maxColumn : 0) * 1035;
    const y = 330 + (node.row - (columnCounts[node.column] - 1) / 2) * 140;
    positions.set(node.id, { x, y });
  });
  const currentId = state.completed[state.completed.length - 1];
  const current = currentId ? byId[currentId] : null;
  const path = (a, b, status) => `<path class="map-path ${esc(status || "")}" d="M ${a.x} ${a.y} C ${a.x + (b.x - a.x) * .55} ${a.y}, ${b.x - (b.x - a.x) * .55} ${b.y}, ${b.x} ${b.y}"/>`;
  const paths = map.edges
    .map((edge) => path(positions.get(edge.from), positions.get(edge.to), edge.status))
    .join("");
  const nodes = map.nodes.map((node) => {
    const { x, y } = positions.get(node.id);
    const isCurrent = current && node.id === current.id;
    return `<div class="map-stop${isCurrent ? " is-current" : ""}${node.role === "boss" ? " is-boss" : ""}"
      style="--x:${x / 12}%;--y:${y / 6.4}%;--mobile-x:${y / 6.4}%;--mobile-y:${x / 12}%"
      title="${esc(node.name)} · ${esc(MAP_STATUS[node.status])}${isCurrent ? " · 当前位置" : ""}">
      ${isCurrent ? '<span class="map-pawn" role="img" aria-label="当前位置"><svg viewBox="0 0 30 40" aria-hidden="true"><circle cx="15" cy="8" r="5"/><path d="M11 15h8l2 16H9l2-16ZM7 31h16v5H7z"/></svg></span>' : ""}
      ${mapNodeButton(node)}</div>`;
  }).join("");
  const mapType = map.mapType || state.mapType || "map1";
  const meta = state.mapMeta || {};
  $("game").dataset.mapType = mapType;
  const mapLabel = mapType === "map3" ? "第三章 · 静海档案" : mapType === "map2" ? "第二章 · 深层回路" : "第一章 · 回路边境";
  $("map-eyebrow").textContent = meta.chapter || mapLabel.split(" · ")[0];
  $("map-title").textContent = meta.title || mapLabel.split(" · ")[1];
  $("map-subtitle").textContent = meta.subtitle || "THE BORDERLANDS";
  $("map-page-left").innerHTML = `
    <div class="map-board map-type-${esc(mapType)}" role="group" aria-label="${esc(meta.title || "回路边境")}冒险地图，选择亮起的事件图标前进">
      <div class="map-terrain" aria-hidden="true"></div>
      <div class="map-route-field">
      <svg class="map-paths map-paths-desktop" viewBox="0 0 1200 640" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>
      <svg class="map-paths map-paths-mobile" viewBox="0 0 640 1200" preserveAspectRatio="none" aria-hidden="true"><g transform="matrix(0 1 1 0 0 0)">${paths}</g></svg>
      ${nodes}
      <span class="map-destination" aria-hidden="true">${esc(meta.destination || "镜像核心")}</span>
      </div>
    </div>`;
  $("map-page-right").innerHTML = `
    <div class="map-legend">
      <span><i class="legend-open" aria-hidden="true"></i>可前往</span>
      <span><i class="legend-traveled" aria-hidden="true">✓</i>已走过</span>
      <span><i class="legend-locked" aria-hidden="true"></i>未解锁</span>
      <span><i class="legend-closed" aria-hidden="true">×</i>已关闭</span>
    </div>
    <p class="map-hint" id="map-hint" role="status"></p>`;
  $("map-route").textContent = `已行进 ${Number.isInteger(state.progress) ? state.progress : "—"} / ${Number.isInteger(state.runLength) ? state.runLength : "—"}`;
  const hint = state.completed.length === 0 && state.node?.role === "start"
    ? "选择起点，开启本章旅程。"
    : available.length > 1
    ? "选择一条分支；确认后其余分支会关闭。"
    : "选择下一个节点，进入其前置剧情。";
  $("map-hint").textContent = state.pendingChallenge
    ? `${hint} 下一场战斗挂载：${state.pendingChallenge.name}。`
    : hint;
}

async function selectMapNode(nodeId) {
  if (busy) return;
  busy = true;
  try {
    const data = await api("/api/map/select", { nodeId });
    apply(data);
  } catch (error) {
    showToast(error.message);
  } finally {
    busy = false;
  }
}

/* ---------- 战斗 ---------- */

async function ensureBattle() {
  if (loadingBattle) return;
  loadingBattle = true;
  try {
    const data = await api("/api/battle/start", {});
    apply(data);
  } catch (error) {
    showToast(error.message);
    $("hand").innerHTML = "<p class='hint'>战斗载入失败。</p><button type='button' class='primary' id='battle-retry'>重新载入</button>";
    $("battle-retry").addEventListener("click", ensureBattle);
  } finally {
    loadingBattle = false;
  }
}

async function act(path, body) {
  if (busy) return;
  busy = true;
  try {
    const data = await api(path, body);
    selectedUid = null;
    if (path === "/api/battle/recycle") recycleMode = false;
    if (path.startsWith("/api/shop/")) shopTarget = null;
    if (path.startsWith("/api/supply/")) {
      supplyPick = null;
      supplyPayment = null;
      supplyRemoveUid = null;
    }
    apply(data);
  } catch (error) {
    showToast(error.message);
  } finally {
    busy = false;
  }
}

const UNIT_DOSSIERS = {
  bean: "定位提案 · 低费轻型机体，适合抢先占位。",
  shell: "定位提案 · 坚实耐久，适合稳住所在列。",
  scout: "定位提案 · 轻型侦察单位，适合低费部署。",
  worker: "定位提案 · 均衡型机体，适合补充战线。",
  striker: "定位提案 · 攻防均衡，适合承担主攻。",
  heavy: "定位提案 · 高攻高耐久，适合压制战线。",
  guard: "定位提案 · 均衡守备，适合保护关键列。",
  flyer: "定位提案 · 轻型空中支援，适合补充火力。",
  twin_rail: "占据连续两列；每次攻击分别打击两列。",
  arc_drone: "每次攻击当前列与右侧相邻列。",
  double_claw: "每次攻击同一列两次。",
  phase_flyer: "飞越没有对空能力的目标；只能被对空单位攻击。",
  burst_beetle: "被摧毁时，对左右相邻敌军各造成 1 点伤害。",
  shield_moth: "护盾可抵消一次伤害，并使该次伤害减少 1。",
  rail_guard: "相邻友军受到敌方攻击时，可代为拦截一次。",
  small_sentry: "定位提案 · 低威胁前哨，适合占据空列。",
  defender: "定位提案 · 高耐久守备单位，适合拖慢推进。",
  assault_sentry: "定位提案 · 高攻击轻装单位，优先施加压力。",
  fork_sentry: "每次攻击当前列与右侧相邻列。",
  wide_bulwark: "占据连续两列，以宽幅机体封锁战线。",
  double_striker: "每次攻击同一列两次。",
  reach_turret: "具备对空能力，可以攻击飞行单位。",
  phase_hunter: "飞越没有对空能力的目标；只能被对空单位攻击。",
  mine_beetle: "被摧毁时，对正对列单位造成 2 点伤害。",
  signal_jammer: "首次部署后，使玩家下回合能量 -1（每场战斗一次）。",
  drift_hunter: "敌方阶段结束时尝试向右移动一列。",
  null_anchor: "锁定相邻列，使相邻友军无法被代为拦截。",
  siege_carrier: "占据连续两列，以宽幅机体推进战线。",
  mirror_core: "每次攻击覆盖全部列；护盾可抵消两次伤害。",
  mirror_drone: "部署时复制正对单位的攻击模式。",
};

function unitHtml(unit, side, column) {
  if (unit && unit.column !== column) return "";
  const width = unit ? (unit.width || 1) : 1;
  const span = unit && width > 1 ? `${unit.column}-${unit.column + width - 1}` : `${column}`;
  const charges = unit
    ? [
        unit.shield ? `护盾 ${unit.shield}` : "",
        unit.guard ? `拦截 ${unit.guard}` : "",
        unit.shift ? "右移" : "",
        unit.anchor ? "锚定" : "",
      ].filter(Boolean).join("，")
    : "";
  const notes = unit ? UNIT_DOSSIERS[unit.cardId] || "定位提案 · 常规机体，按当前属性执行攻击。" : "";
  const label = unit
    ? `${span} 列，${unit.name}，等级 ${unit.level ?? 1}，攻击 ${unit.atk}，生命 ${unit.hp}${charges ? `，${charges}` : ""}`
    : `${column} 列，空列`;
  if (!unit) {
    return `<div class="slot empty" data-side="${side}" data-column="${column}" tabindex="0" aria-label="${esc(label)}" style="grid-column: ${column};"><span>空列</span></div>`;
  }
  const style = ` style="grid-column: ${unit.column} / span ${width};"`;
  const previous = $(`${side}-row`).querySelector(`[data-uid="${unit.uid}"]`);
  const damaged = previous && unit.hp < Number(previous.dataset.hp);
  const boosted = previous && unit.atk > Number(previous.dataset.atk);
  return `<div class="slot unit ${side}${width > 1 ? " wide" : ""}${unit.hp < unit.maxHp ? " is-damaged" : ""}${damaged ? " just-damaged" : ""}${boosted ? " just-boosted" : ""}" data-side="${side}" data-column="${unit.column}" data-width="${width}" data-uid="${unit.uid}" data-hp="${unit.hp}" data-atk="${unit.atk}" tabindex="0" aria-label="${esc(label)}"${style}>
      <div class="unit-core" aria-hidden="true">${pixelArtHtml(unit)}</div>
      <section class="unit-dossier" aria-label="机偶档案">
        <div class="unit-profile">
          <span class="unit-atk">攻 ${unit.atk}</span>
          <span class="unit-heading"><span class="unit-name">${esc(unit.name)}</span><small class="unit-level">LV.${String(unit.level ?? 1).padStart(2, "0")}</small></span>
          <span class="unit-durability">耐 ${unit.hp}/${unit.maxHp}</span>
        </div>
        <div class="unit-mechanic">${esc(notes)}</div>
        <div class="unit-status"><span>UNIT ID · ${String(unit.uid).padStart(3, "0")}</span><span>${unit.hp > 0 ? "ONLINE" : "OFFLINE"}</span></div>
      </section>
    </div>`;
}

function traitText(card, short = false) {
  const traits = [];
  if (!short && (card.width || 1) > 1) traits.push(`占 ${card.width} 列`);
  if (card.attackPattern === "split_attack") traits.push(short ? "攻击两列" : "攻击当前列与右侧列");
  else if (card.attackPattern === "double_strike") traits.push(short ? "同列攻击两次" : "对同列攻击两次");
  else if (card.attackPattern === "sweep") traits.push("横扫全部单位");
  if ((card.abilities || []).includes("flying")) traits.push("飞行");
  if (!short && (card.abilities || []).includes("reach")) traits.push("可攻击飞行单位");
  if (card.shield) traits.push(short ? `护盾 ${card.shield}` : `护盾 ${card.shield} 次（首次伤害 -1）`);
  if (card.guard) traits.push(short ? `拦截 ${card.guard}` : `相邻拦截 ${card.guard} 次`);
  if (card.shift) traits.push(short ? "回合结束右移" : "敌方阶段结束时右移一格");
  if (card.anchor) traits.push(short ? "相邻无法拦截" : "相邻玩家单位无法被拦截");
  if (card.onDeploy === "energy_penalty") traits.push(short ? "部署时：下回合能量 -1" : "部署时下回合能量 -1");
  else if (card.onDeploy === "copy_opposite") traits.push(short ? "部署时复制对位攻击模式" : "部署时复制对位单位的攻击模式");
  if (card.onDestroy === "burst_adjacent") traits.push(short ? "死亡时相邻各 1 伤害" : "死亡时左右相邻各 1 伤害");
  else if (card.onDestroy === "hit_opposite") traits.push("死亡时对位 2 伤害");
  return traits.join(" · ");
}

const CARD_ART = {
  bean: "sci-robot-small", shell: "shell-bot", scout: "sci-drone",
  repair: "sci-medkit", spark: "lightning-bolt-pickup", worker: "companion-robot",
  striker: "neon-mech", heavy: "sci-robot", guard: "guard-mech", flyer: "sci-fighter",
  twin_rail: "twin-rail-rover", arc_drone: "arc-drone", double_claw: "crab",
  phase_flyer: "phase-shuttle", burst_beetle: "beetle", shield_moth: "butterfly",
  rail_guard: "sci-turret", generator: "sci-generator",
  small_sentry: "enemy-small_sentry", defender: "enemy-defender", assault_sentry: "enemy-assault_sentry",
  fork_sentry: "enemy-fork_sentry", wide_bulwark: "enemy-wide_bulwark", double_striker: "enemy-double_striker",
  reach_turret: "enemy-reach_turret", phase_hunter: "enemy-phase_hunter", mine_beetle: "enemy-mine_beetle",
  signal_jammer: "enemy-signal_jammer", drift_hunter: "enemy-drift_hunter", null_anchor: "enemy-null_anchor",
  siege_carrier: "enemy-siege_carrier", mirror_core: "enemy-mirror_core", mirror_drone: "enemy-mirror_drone"
};

function pixelArtHtml(card) {
  const art = CARD_ART[card.cardId] || CARD_ART.bean;
  return `<img class="pixel-art pixel-art-image sprite-${art}" src="/assets/cards/${art}.png?v=20261116-mech-art" alt="" aria-hidden="true" draggable="false">`;
}

function cardFaceHtml(card) {
  const isUnit = card.type === "unit";
  const description = isUnit
    ? traitText(card) || "机偶单位 · 自动攻击对位目标"
    : card.effectText || (card.heal != null ? `恢复 ${card.heal} 点领袖生命` : card.damage != null ? `造成 ${card.damage} 点伤害` : "战术指令");
  const level = card.level ?? card.targetLevel ?? 1;
  const stats = isUnit
    ? `<span class="card-stat attack"><small>攻</small><b>${card.atk ?? "—"}</b></span>
        <span class="card-level">LV<br>${level}</span>
        <span class="card-stat health"><small>耐</small><b>${card.hp ?? card.maxHp ?? "—"}</b></span>`
    : `<span class="card-command-effect">${esc(card.heal != null ? `修复 +${card.heal}` : card.damage != null ? `脉冲 ${card.damage}` : description)}</span>
        <span class="card-level">LV ${level}</span>`;
  return `<div class="card-face ${isUnit ? "unit-card" : "command-card"}">
      <div class="card-topline"><span class="card-type">${isUnit ? "机体 / UNIT" : "指令 / PROTOCOL"}</span><span class="card-cost">${card.cost ?? "—"}</span></div>
      <div class="card-name offer-name">${esc(card.name || "未识别机偶")}</div>
      <div class="card-art">${pixelArtHtml(card)}</div>
      <div class="card-stats">${esc(description)}</div>
      <div class="card-metrics">${stats}</div>
    </div>`;
}

function offerCardView(offer, type = "unit") {
  const owned = state.deck.find((card) => card.cardId === offer.cardId);
  return { ...owned, ...offer, type: offer.type || owned?.type || type,
    level: offer.targetLevel || offer.level || owned?.level || 1 };
}

function cardHtml(card, selected, draggable = false) {
  const trait = card.type === "unit" ? traitText(card) : "";
  const detail = card.type === "unit"
    ? `，攻击 ${card.atk}，生命 ${card.hp}${trait ? `，${trait}` : ""}`
    : `，${card.effectText || (card.heal != null ? `恢复 ${card.heal}` : card.damage != null ? `造成 ${card.damage} 伤害` : "指令牌")}`;
  return `<div class="card${selected ? " selected" : ""}" data-uid="${card.uid}" data-type="${card.type}"
      data-width="${card.width || 1}" tabindex="0" role="button" draggable="${draggable ? "true" : "false"}"
      aria-label="${esc(card.name)}，费用 ${card.cost}，等级 ${card.level}${detail}">
      ${cardFaceHtml(card)}
    </div>`;
}

function renderForecast() {
  const forecast = battle.forecast || [];
  const cells = [0, 1, 2, 3].map((slot) => {
    const item = forecast.find((entry) => entry.slots?.includes(slot + 1) || entry.slot === slot);
    const lead = item && item.slot === slot;
    const occupied = item && !lead;
    const content = item ? (() => {
      const width = item.width || 1;
      const range = width > 1 ? `${item.column}-${item.column + width - 1} 列` : `${item.column} 列`;
      const trait = traitText(item, true);
      if (!lead) return "";
      return `<div class="forecast-item next${width > 1 ? " wide" : ""}">
          <span class="forecast-when">候补 · ${range}</span>
          <span class="forecast-name">${esc(item.name)}</span>
          <span class="forecast-stats">攻 ${item.atk} · 耐 ${item.hp}${trait ? ` · ${trait}` : ""}</span>
        </div>`;
    })() : "";
    return `<div class="forecast-cell${item ? " occupied" : " empty"}" data-slot="${slot}" data-column="${slot + 1}">
      <span class="forecast-col">候补位 ${slot + 1}</span>${content || (occupied ? "<span class='forecast-empty'>同卡占位</span>" : "<span class='forecast-empty'>—</span>")}
      </div>`;
  }).join("");
  $("forecast-row").innerHTML = cells;
}

function renderTutorial() {
  const step = battle.tutorial;
  $("battle-view").classList.toggle("tutorial-active", Boolean(step));
  document.querySelectorAll(".tutorial-target").forEach((element) => element.classList.remove("tutorial-target"));
  $("tutorial-panel").hidden = !step;
  if (!step) return;
  $("tutorial-title").textContent = step.title;
  $("tutorial-text").textContent = step.text;
  $("tutorial-progress").textContent = `${step.index + 1} / ${step.total}`;
  $("tutorial-next").hidden = step.action !== "continue";
  $("tutorial-next").textContent = step.button || "继续";
  $("end-turn").disabled = step.action !== "end";
  $("recycle-btn").disabled = step.action !== "recycle";
  if (step.action !== "recycle") recycleMode = false;
  $("recycle-btn").classList.toggle("active", recycleMode);
  for (const card of battle.hand) {
    const element = $("hand").querySelector(`[data-uid="${card.uid}"]`);
    const enabled = card.cardId === step.cardId;
    element.draggable = enabled;
    element.setAttribute("aria-disabled", String(!enabled));
    element.classList.toggle("tutorial-muted", !enabled);
    element.classList.toggle("tutorial-target", enabled);
  }
  if (step.column) {
    const parent = step.side === "forecast" ? $("forecast-row") : $(`${step.side}-row`);
    for (let column = step.column; column < step.column + (step.width || 1); column += 1) {
      parent.querySelector(`[data-column="${column}"]`)?.classList.add("tutorial-target");
    }
  }
  if (step.action === "end") $("end-turn").classList.add("tutorial-target");
  if (step.action === "recycle") $("recycle-btn").classList.add("tutorial-target");
  for (const id of step.uiTargets || []) $(id)?.classList.add("tutorial-target");
}

function renderBattle() {
  const active = document.activeElement;
  const focusInfo = active && $("battle-view").contains(active)
    ? { ...active.dataset, id: active.id }
    : null;
  const dialogsClosed = $("discard-panel").hidden && $("result-panel").hidden;
  $("battle-view").hidden = false;
  if (!battle) {
    $("hand").innerHTML = "<p class='hint'>正在载入战斗…</p>";
    ensureBattle();
    return;
  }

  $("enemy-hp").textContent = battle.hp.enemy;
  $("player-hp").textContent = battle.hp.player;
  for (const side of ["enemy", "player"]) {
    const leader = $(`${side}-hp`).parentElement;
    const hp = battle.hp[side];
    const maxHp = state.node?.leaderMaxHp?.[side] ?? Number(leader.dataset.maxHp);
    const damaged = leader.dataset.hp !== undefined && hp < Number(leader.dataset.hp);
    leader.dataset.hp = hp;
    leader.dataset.maxHp = maxHp;
    leader.classList.toggle("is-critical", hp <= maxHp / 3);
    leader.classList.toggle("just-damaged", damaged);
    leader.setAttribute("aria-label", `${side === "enemy" ? "敌方" : "己方"}领袖，生命 ${hp} / ${maxHp}`);
    leader.querySelector(".leader-max").textContent = `/ ${maxHp}`;
    leader.querySelector(".leader-cells").innerHTML = Array.from({length: maxHp}, (_, i) => `<i${i < hp ? ' class="filled"' : ""}></i>`).join("");
  }
  $("turn").textContent = battle.turn;
  $("energy").textContent = battle.energy;
  $("deck-count").textContent = battle.deckCount;
  $("hand-count").textContent = battle.hand.length;

  renderForecast();

  $("enemy-row").innerHTML = battle.board.enemy.map((unit, index) => unitHtml(unit, "enemy", index + 1)).join("");
  $("player-row").innerHTML = battle.board.player.map((unit, index) => unitHtml(unit, "player", index + 1)).join("");

  $("hand").innerHTML = battle.hand.length
    ? battle.hand.map((card) => cardHtml(
        card,
        card.uid === selectedUid,
        battle.phase === "player",
      )).join("")
    : "<p class='hint'>手牌为空</p>";

  $("hand-dock").classList.toggle("has-cards", battle.hand.length > 0);

  $("log").innerHTML = battle.log.map(esc).join("<br>");

  $("end-turn").disabled = battle.phase !== "player";
  $("recycle-btn").disabled = battle.phase !== "player";
  $("recycle-btn").classList.toggle("active", recycleMode);

  if (focusInfo && dialogsClosed) {
    let target = null;
    if (focusInfo.uid) {
      target = [...$("hand").querySelectorAll("[data-uid]")]
        .find((element) => element.dataset.uid === focusInfo.uid);
    }
    if (!target && focusInfo.side) {
      target = document.querySelector(
        `#${focusInfo.side}-row .slot[data-column="${focusInfo.column}"]`
      );
    }
    if (!target && focusInfo.id) target = $(focusInfo.id);
    if (!target && !$("end-turn").disabled) target = $("end-turn");
    if (target && !target.closest("[hidden]")) target.focus({ preventScroll: true });
  }

  renderDiscard();
  renderResult();
  renderTutorial();
}

function renderDiscard() {
  const panel = $("discard-panel");
  if (!battle || battle.phase !== "discard") {
    hideDialog(panel);
    discardSelection.clear();
    return;
  }
  for (const uid of [...discardSelection]) {
    if (!battle.hand.some((card) => card.uid === uid)) discardSelection.delete(uid);
  }
  const activeUid = document.activeElement?.dataset?.uid;
  $("discard-needed").textContent = battle.discardRequired;
  $("discard-hand").innerHTML = battle.hand
    .map((card) => cardHtml(card, discardSelection.has(card.uid)))
    .join("");
  $("discard-confirm").disabled = discardSelection.size !== battle.discardRequired;
  $("discard-confirm").textContent = `确认弃牌（${discardSelection.size}/${battle.discardRequired}）`;
  const cards = [...panel.querySelectorAll("[data-uid]")];
  const target = cards.find((element) => element.dataset.uid === activeUid)
    || cards[0]
    || $("discard-confirm");
  showDialog(panel, target);
}

function renderResult() {
  const panel = $("result-panel");
  if (!battle || battle.phase !== "over") {
    hideDialog(panel);
    return;
  }
  const action = $("result-action");
  if (battle.result === "win") {
    $("result-title").textContent = "战斗胜利";
    $("result-text").textContent = "确认结果后会结算本节点的奖励并继续。";
    action.textContent = "确认结果";
    action.dataset.action = "confirm";
  } else {
    $("result-title").textContent = "战斗失败";
    $("result-text").textContent = "重试会从这场战斗的开头开始，保留进入战斗前的牌组与金币。";
    action.textContent = "重试";
    action.dataset.action = "retry";
  }
  showDialog(panel, action);
}

function clearDragState() {
  draggingUid = null;
  dragDropped = false;
  document.querySelectorAll(".card.dragging").forEach((element) => element.classList.remove("dragging"));
  document.querySelectorAll(".slot.drop-ok, .slot.drop-hover").forEach((element) => {
    element.classList.remove("drop-ok", "drop-hover");
  });
}

function markDropSlot(side, column) {
  const slot = document.querySelector(`#${side}-row .slot[data-column="${column}"]`);
  if (slot) slot.classList.add("drop-ok");
}

function unitCanPlace(card, start) {
  const width = card.width || 1;
  if (start < 1 || start + width - 1 > 4) return false;
  for (let column = start; column < start + width; column += 1) {
    if (battle.board.player[column - 1]) return false;
  }
  return true;
}

function unitDropStart(card, column) {
  if (unitCanPlace(card, column)) return column;
  const width = card.width || 1;
  return width > 1 && unitCanPlace(card, column - 1) ? column - 1 : null;
}

function markDropTargets(card) {
  if (battle.tutorial) {
    const step = battle.tutorial;
    if (step.cardId === card.cardId) {
      for (let column = step.column; column < step.column + (step.width || 1); column += 1) markDropSlot(step.side, column);
    }
    return;
  }
  if (card.cost > battle.energy) {
    showToast("能量不足");
    return;
  }
  if (card.type === "unit") {
    const width = card.width || 1;
    let count = 0;
    for (let start = 1; start + width - 1 <= 4; start += 1) {
      if (!unitCanPlace(card, start)) continue;
      for (let column = start; column < start + width; column += 1) {
        markDropSlot("player", column);
      }
      count += 1;
    }
    if (!count) showToast("己方没有足够连续空列");
    return;
  }
  if (card.heal != null) {
    let count = 0;
    battle.board.player.forEach((unit, index) => {
      if (unit && unit.hp < unit.maxHp) {
        markDropSlot("player", index + 1);
        count += 1;
      }
    });
    if (!count) showToast("没有需要维修的己方单位");
    return;
  }
  if (card.damage != null) {
    let count = 0;
    battle.board.enemy.forEach((unit, index) => {
      if (unit) {
        markDropSlot("enemy", index + 1);
        count += 1;
      }
    });
    if (!count) showToast("敌方场上没有单位");
  }
}

async function dropFromDrag(uid, side, column) {
  if (!battle || busy || battle.phase !== "player") {
    showToast("当前不能操作");
    return;
  }
  const card = battle.hand.find((item) => item.uid === uid);
  if (!card) return;
  if (card.cost > battle.energy) {
    showToast("能量不足");
    return;
  }
  const target = (side === "player" ? battle.board.player : battle.board.enemy)[column - 1];
  if (card.type === "unit") {
    if (side !== "player" || target) {
      showToast("单位只能部署到己方空列");
      return;
    }
    const start = unitDropStart(card, column);
    if (start == null) {
      showToast("这里放不下这张卡");
      return;
    }
    await act("/api/battle/deploy", { uid, column: start });
    return;
  }
  if (card.heal != null) {
    if (side !== "player" || !target) {
      showToast("请把紧急维修拖到受伤的己方单位");
      return;
    }
    if (target.hp >= target.maxHp) {
      showToast("该单位不需要维修");
      return;
    }
    await act("/api/battle/command", { uid, targetUid: target.uid });
    return;
  }
  if (card.damage != null) {
    if (side !== "enemy" || !target) {
      showToast("请把闪电脉冲拖到敌方单位");
      return;
    }
    await act("/api/battle/command", { uid, targetUid: target.uid });
    return;
  }
  showToast("这张牌不能拖动使用");
}

function onDragOver(event) {
  if (draggingUid == null) return;
  const info = slotInfo(event);
  if (!info) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".slot.drop-hover").forEach((slot) => slot.classList.remove("drop-hover"));
  const slot = event.target.closest(".slot");
  if (!slot?.classList.contains("drop-ok")) return;
  const card = battle.hand.find((item) => item.uid === draggingUid);
  if (!card || card.type !== "unit") {
    slot.classList.add("drop-hover");
    return;
  }
  const start = unitDropStart(card, info.column);
  if (start == null) {
    slot.classList.add("drop-hover");
    return;
  }
  for (let column = start; column < start + (card.width || 1); column += 1) {
    document.querySelector(`#${info.side}-row .slot[data-column="${column}"]`)
      ?.classList.add("drop-hover");
  }
}

function onDragLeave(event) {
  const slot = event.target.closest(".slot");
  if (slot) slot.classList.remove("drop-hover");
}

function onDrop(event) {
  const info = slotInfo(event);
  if (!info || draggingUid == null) return;
  event.preventDefault();
  dragDropped = true;
  const uid = draggingUid;
  clearDragState();
  dropFromDrag(uid, info.side, info.column);
}

async function slotAction(side, column, uid) {
  if (!battle || busy || battle.phase !== "player") return;

  if (recycleMode) {
    if (side !== "player" || uid == null) return;
    const unit = battle.board.player[column - 1];
    if (!unit) return;
    if (!confirm(`回收 ${unit.name}？返还 ${unit.refund} 点能量。`)) return;
    await act("/api/battle/recycle", { column });
    return;
  }

  if (selectedUid == null) return;
  const card = battle.hand.find((item) => item.uid === selectedUid);
  if (!card) return;

  if (card.type === "unit") {
    if (side === "player" && uid == null) {
      if (card.cost > battle.energy) {
        showToast("能量不足");
        return;
      }
      const start = unitDropStart(card, column);
      if (start == null) {
        showToast("这里放不下这张卡");
        return;
      }
      await act("/api/battle/deploy", { uid: card.uid, column: start });
    }
    return;
  }
  if (side === "player" && uid != null && card.heal != null) {
    await act("/api/battle/command", { uid: card.uid, targetUid: uid });
  } else if (side === "enemy" && uid != null && card.damage != null) {
    await act("/api/battle/command", { uid: card.uid, targetUid: uid });
  }
}

function slotInfo(event) {
  const slot = event.target.closest(".slot");
  if (!slot) return null;
  return {
    side: slot.dataset.side,
    column: Number(slot.dataset.column),
    uid: slot.dataset.uid ? Number(slot.dataset.uid) : null,
  };
}

function onSlotClick(event) {
  const info = slotInfo(event);
  if (!info || !battle) return;
  if (!recycleMode && selectedUid != null) {
    const card = battle.hand.find((item) => item.uid === selectedUid);
    if (card?.type === "unit" && info.side === "player" && info.uid == null) {
      if (window.matchMedia("(hover: none), (pointer: coarse)").matches) {
        slotAction(info.side, info.column, info.uid);
      } else {
        showToast("请拖动单位牌到空列部署");
      }
      return;
    }
  }
  slotAction(info.side, info.column, info.uid);
}

function onSlotKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  const info = slotInfo(event);
  if (!info) return;
  event.preventDefault();
  slotAction(info.side, info.column, info.uid);
}

function selectCard(uid) {
  if (battle.tutorial && battle.hand.find((card) => card.uid === uid)?.cardId !== battle.tutorial.cardId) {
    showToast("先完成高亮操作，也可以跳过引导");
    return;
  }
  selectedUid = selectedUid === uid ? null : uid;
  if (selectedUid != null) recycleMode = false;
  renderBattle();
}

/* ---------- 精英战奖励 ---------- */

function renderEliteReward() {
  const reward = state.eliteReward;
  if (!reward) {
    missingPayload();
    return;
  }
  $("elite-reward-view").hidden = false;
  $("elite-offers").innerHTML = reward.candidates.map((card) => `
    <div class="offer card-offer">
      ${cardFaceHtml(card)}
      <div class="offer-meta">${card.duplicate ? "同名卡 · 独立实体" : "新加入牌组"}</div>
      <button class="buy-btn" data-id="${esc(card.cardId)}" ${reward.deckFull ? "disabled" : ""}>${reward.deckFull ? "牌组已满" : "领取"}</button>
    </div>`).join("");
  $("elite-note").textContent = reward.deckFull
    ? "牌组已满（最多 20 张），无法加入新卡，可以离开。"
    : "选择一张加入牌组，或放弃奖励直接离开。";
}

/* ---------- 招募 ---------- */

function renderRecruit() {
  const recruit = state.recruit;
  if (!recruit) {
    missingPayload();
    return;
  }
  $("recruit-view").hidden = false;
  $("offers").innerHTML = recruit.offers.length
    ? recruit.offers.map((offer) => {
        const affordable = state.gold >= offer.price;
        const owned = offer.level > 0;
        const nextLevel = Math.min(offer.level + 1, offer.maxLevel);
        const meta = owned
          ? `已有 Lv.${offer.level}${offer.level < offer.maxLevel ? ` → Lv.${nextLevel}` : "（满级）"}`
          : "新卡";
        const card = offerCardView(offer);
        return `<div class="offer card-offer">
            ${cardFaceHtml(card)}
            <div class="offer-meta">${meta}</div>
            <div class="offer-price">${offer.price} 金币</div>
            <button class="buy-btn" data-id="${esc(offer.cardId)}" ${recruit.purchased || !affordable ? "disabled" : ""}>
              ${recruit.purchased ? "已购买" : "购买"}
            </button>
          </div>`;
      }).join("")
    : "<p class='hint'>没有可购买的卡牌。</p>";
  $("recruit-note").textContent = recruit.purchased ? "本次招募已完成，可以离开。" : `当前金币：${state.gold}`;
}

/* ---------- 信号奇遇 ---------- */

function signalTargets() {
  const data = state.signal;
  if (!data) return [];
  if (signalAction === "upgrade") return data.targets.filter((card) => card.canUpgrade);
  return data.targets;
}

function renderSignal() {
  const data = state.signal;
  if (!data) {
    missingPayload();
    return;
  }
  $("signal-view").hidden = false;
  $("signal-actions").innerHTML = `
    <button class="signal-action${signalAction === "repair" ? " selected" : ""}" data-action="repair" ${data.hasRepairTarget ? "" : "disabled"}>
      <b>修复协议</b><span>${data.hasRepairTarget ? `选择一张单位，最大生命 +${data.hpBonus}` : "没有可修复的单位"}</span>
    </button>
    <button class="signal-action${signalAction === "upgrade" ? " selected" : ""}" data-action="upgrade" ${data.hasUpgradeTarget ? "" : "disabled"}>
      <b>同步升级</b><span>${data.hasUpgradeTarget ? "选择一张未满级单位，升一级并保留改造" : "没有未满级的单位"}</span>
    </button>`;

  const targets = signalTargets();
  $("signal-targets").innerHTML = signalAction == null
    ? "<p class='hint'>先选择一项效果。</p>"
    : targets.length
      ? targets.map((card) => `
        <div class="target card-target${signalTarget && signalTarget.uid === card.uid ? " selected" : ""}" data-card="${esc(card.cardId)}" data-uid="${esc(card.uid)}" role="button" tabindex="0">
          ${cardFaceHtml(card)}
          <div class="card-target-note">${card.atkBonus || card.hpBonus ? `改造：攻 +${card.atkBonus || 0} / 耐 +${card.hpBonus || 0}` : "暂无改造"}</div>
        </div>`).join("")
      : "<p class='hint'>没有符合这项效果的单位。</p>";

  const preview = $("signal-preview");
  if (signalTarget && signalAction) {
    preview.hidden = false;
    if (signalAction === "repair") {
      $("signal-preview-text").textContent =
        `${signalTarget.name}：最大生命 ${signalTarget.maxHp} → ${signalTarget.repairPreview.maxHp}（仅本趟冒险保留）`;
    } else {
      const next = signalTarget.upgradePreview;
      $("signal-preview-text").textContent =
        `${signalTarget.name}：Lv.${signalTarget.level} → Lv.${signalTarget.level + 1}，攻击 ${signalTarget.atk} → ${next.atk}，生命 ${signalTarget.maxHp} → ${next.maxHp}（改造保留）`;
    }
  } else {
    preview.hidden = true;
  }
}

/* ---------- 维修奇遇 ---------- */

function renderAdventure(kind) {
  enhanceKind = kind;
  const data = state[kind];
  if (!data) {
    missingPayload();
    return;
  }
  $("adventure-view").dataset.kind = kind;
  $("adventure-view").hidden = false;
  $("adventure-title").textContent = kind === "calibration"
    ? "校准平台"
    : kind === "drones" ? "维修无人机群" : "废弃维修站";
  $("adventure-hint").textContent = kind === "calibration"
    ? "选择一张已有单位，三选一：攻击强化、生命强化或直接升一级；先预览再确认，也可以离开。"
    : kind === "drones"
      ? "选择一台无人机：攻击 +1、最大生命 +1，或下一场战斗起手抽牌 +1；先预览再确认，也可以离开。"
      : "选择一张已有单位，二选一：攻击 +1 或最大生命 +2；先预览再确认，也可以离开。";
  const cards = data.targets.map((card) => `
        <div class="target card-target${adventureTarget && adventureTarget.uid === card.uid ? " selected" : ""}" data-card="${esc(card.cardId)}" data-uid="${esc(card.uid)}">
          ${cardFaceHtml(card)}
          <div class="card-target-note">${card.atkBonus || card.hpBonus ? `改造：攻 +${card.atkBonus || 0} / 耐 +${card.hpBonus || 0}` : "选择强化方式"}</div>
          <div class="target-actions">
            <button class="target-action" data-card="${esc(card.cardId)}" data-uid="${esc(card.uid)}" data-effect="atk">
              攻击 +${data.atkBonus}<small>${card.atk} → ${card.atkPreview.atk}</small>
            </button>
            <button class="target-action" data-card="${esc(card.cardId)}" data-uid="${esc(card.uid)}" data-effect="hp">
              最大生命 +${data.hpBonus}<small>${card.maxHp} → ${card.hpPreview.maxHp}</small>
            </button>
            ${kind === "calibration" ? `
            <button class="target-action" data-card="${esc(card.cardId)}" data-uid="${esc(card.uid)}" data-effect="level" ${card.canLevel ? "" : "disabled"}>
              等级 +${data.levelBonus}<small>${card.canLevel ? `Lv.${card.level} → Lv.${card.level + data.levelBonus}` : "已满级"}</small>
            </button>` : ""}
          </div>
        </div>`).join("");
  const droneDraw = kind === "drones" ? `
        <div class="target drone-draw${adventureEffect === "draw" ? " selected" : ""}">
          <div class="target-name">侦察无人机 <small>下一场战斗</small></div>
          <div class="target-meta">起手抽牌 +${data.drawBonus}</div>
          <div class="target-actions">
            <button class="target-action" data-effect="draw" data-card="">选择</button>
          </div>
        </div>` : "";
  $("targets").innerHTML = (droneDraw + cards) || "<p class='hint'>没有可强化的单位。</p>";

  const preview = $("adventure-preview");
  if (adventureEffect === "draw") {
    preview.hidden = false;
    $("preview-text").textContent = `下一场战斗起手抽牌 +${data.drawBonus}（仅本趟冒险保留）`;
  } else if (adventureTarget && adventureEffect) {
    preview.hidden = false;
    const next = adventureEffect === "atk"
      ? adventureTarget.atkPreview
      : adventureEffect === "hp" ? adventureTarget.hpPreview : adventureTarget.levelPreview;
    let detail;
    if (adventureEffect === "atk") detail = `攻击 ${adventureTarget.atk} → ${next.atk}`;
    else if (adventureEffect === "hp") detail = `最大生命 ${adventureTarget.maxHp} → ${next.maxHp}`;
    else detail = `Lv.${adventureTarget.level} → Lv.${adventureTarget.level + data.levelBonus}，攻击 ${adventureTarget.atk} → ${next.atk}，生命 ${adventureTarget.maxHp} → ${next.maxHp}`;
    $("preview-text").textContent = `${adventureTarget.name}：${detail}（仅本趟冒险保留）`;
  } else {
    preview.hidden = true;
  }
}

/* ---------- 漂流卡匣 ---------- */

function renderDrift() {
  const drift = state.drift;
  if (!drift) {
    missingPayload();
    return;
  }
  $("drift-view").hidden = false;
  $("drift-offers").innerHTML = drift.candidates.length
    ? drift.candidates.map((card) => `
        <div class="offer card-offer">
          ${cardFaceHtml(card)}
          <div class="offer-meta">${card.isUpgrade
            ? `已有 Lv.${card.currentLevel} → Lv.${card.targetLevel}`
            : `新卡 Lv.${card.targetLevel}`}</div>
          <button class="buy-btn" data-id="${esc(card.cardId)}">${card.isUpgrade ? "升级" : "带走"}</button>
        </div>`).join("")
    : "<p class='hint'>卡匣里没有可用的记录。</p>";
  const reroll = $("drift-reroll");
  reroll.textContent = `重抽（${drift.rerollPrice} 金币，剩余 ${drift.rerollLimit - drift.rerolls} 次）`;
  reroll.disabled = !drift.canReroll;
  $("drift-note").textContent = `当前金币：${state.gold}`;
}

/* ---------- 记忆回收站 ---------- */

function renderRecycle() {
  const data = state.recycle;
  if (!data) {
    missingPayload();
    return;
  }
  $("recycle-view").hidden = false;
  $("recycle-targets").innerHTML = data.targets.length
    ? data.targets.map((card) => `
        <div class="target card-target${recycleTarget && recycleTarget.uid === card.uid ? " selected" : ""}${card.removable ? "" : " disabled"}"
            data-card="${esc(card.cardId)}" data-uid="${esc(card.uid)}" ${card.removable ? 'role="button" tabindex="0"' : ""}>
          ${cardFaceHtml(card)}
          <div class="card-target-note">${card.removable ? `可拆解 · ${card.price} 金币` : "不可拆解 · 最后一张单位"}</div>
        </div>`).join("")
    : "<p class='hint'>牌组里没有卡牌。</p>";

  const preview = $("recycle-preview");
  if (recycleTarget) {
    preview.hidden = false;
    $("recycle-preview-text").textContent =
      `拆解 ${recycleTarget.name}（Lv.${recycleTarget.level}），获得 ${recycleTarget.price} 金币。此操作不可撤销。`;
  } else {
    preview.hidden = true;
  }
}

/* ---------- 断线商船 ---------- */

function renderShop() {
  const shop = state.shop;
  if (!shop) {
    missingPayload();
    return;
  }
  $("shop-view").hidden = false;
  $("shop-offers").innerHTML = shop.offers.map((offer) => {
    const meta = offer.kind === "new"
      ? "新单位"
      : offer.kind === "upgrade" ? "升级已有单位" : esc(offer.effectText);
    const targets = offer.targets || [];
    const target = targets.find((item) => item.uid === shopTarget) || targets[0] || null;
    const owned = target ? state.deck.find((item) => item.uid === target.uid) : null;
    const card = { ...offerCardView(offer), ...(owned || {}), ...(target || {}) };
    const targetPicker = targets.length > 1 ? `
        <div class="shop-targets">${targets.map((item, index) => `
          <button class="target-action shop-target${item.uid === target.uid ? " selected" : ""}"
              data-uid="${esc(item.uid)}" aria-pressed="${item.uid === target.uid}"
              title="卡牌实体 ${esc(item.uid)}">
            Lv.${item.level}<small>第 ${index + 1} 张</small>
          </button>`).join("")}
        </div>` : "";
    return `<div class="offer card-offer">
        ${cardFaceHtml(card)}
        <div class="offer-meta">${meta}</div>
        ${targetPicker}
        <div class="offer-price">${offer.price} 金币</div>
        <button class="buy-btn" data-id="${esc(offer.id)}" ${offer.buyable ? "" : "disabled"}>
          ${shop.purchased ? "已购买" : offer.buyable ? "购买" : esc(offer.reason)}
        </button>
      </div>`;
  }).join("");
  $("shop-note").textContent = shop.purchased
    ? "本次交易已完成，可以离开。"
    : `当前金币：${state.gold}`;
}

/* ---------- 观测塔 ---------- */

function renderTrial() {
  const trial = state.trial;
  if (!trial) {
    missingPayload();
    return;
  }
  $("trial-view").hidden = false;
  const choosing = trial.status === "choose";
  $("trial-options").innerHTML = trial.trials.map((item) => `
    <div class="target${trialPick === item.id ? " selected" : ""}${choosing ? "" : " disabled"}"
        data-trial="${esc(item.id)}" ${choosing ? 'role="button" tabindex="0"' : ""}>
      <div class="target-name">${esc(item.name)} <small>${item.progress} / ${item.target}</small></div>
      <div class="target-meta">${esc(item.description)}</div>
      <div class="target-meta">${item.passed ? "当前可达成" : "当前未达成"}</div>
    </div>`).join("");

  const success = trial.status === "success";
  const rewards = $("trial-rewards");
  rewards.hidden = !success;
  rewards.innerHTML = success
    ? trial.candidates.map((card) => `
        <div class="offer card-offer">
          ${cardFaceHtml(card)}
          <div class="offer-meta">${card.isUpgrade
            ? `已有 Lv.${card.currentLevel} → Lv.${card.targetLevel}`
            : `新卡 Lv.${card.targetLevel}`}</div>
          <button class="buy-btn" data-id="${esc(card.cardId)}">${card.isUpgrade ? "升级" : "带走"}</button>
        </div>`).join("")
    : "";

  $("trial-confirm").hidden = !choosing || trialPick == null;
  const claim = $("trial-claim");
  claim.hidden = trial.status !== "failed";
  claim.textContent = `领取 ${trial.failureGold} 金币`;
  if (choosing) $("trial-note").textContent = "选择一个试炼，再点“开始试炼”。";
  else if (success) $("trial-note").textContent = trial.hasCandidates
    ? "试炼成功：选择一张奖励。"
    : "试炼成功，但当前没有可用的奖励卡，可以直接离开。";
  else $("trial-note").textContent = "试炼失败：可以领取补偿金币，或直接离开。";
}

/* ---------- 机偶补给站 ---------- */

function renderSupply() {
  const supply = state.supply;
  if (!supply) {
    missingPayload();
    return;
  }
  $("supply-view").hidden = false;
  const option = supply.stage === "option";
  const swapping = option && supply.variant === "swap";
  const challenging = option && supply.variant === "challenge";
  $("supply-hint").textContent = swapping
    ? "免费两轮已结束。可以支付金币或移除一张牌，交换一张额外卡牌；每个补给站限一次。"
    : challenging
      ? "免费两轮已结束。可以接受一项挑战压力，下一场战斗获胜后获得额外三选一；战败则压力与奖励一起消失。"
      : "免费进行两轮三选一。每轮可以领取一张加入永久牌组，也可以放弃本轮；已领取的卡不会因放弃下一轮而撤销。";

  $("supply-offers").hidden = challenging;
  $("supply-offers").innerHTML = challenging ? "" : supply.candidates.map((card) => `
    <div class="offer card-offer${supplyPick === card.cardId ? " selected" : ""}" data-id="${esc(card.cardId)}">
      ${cardFaceHtml(card)}
      <button class="buy-btn" data-id="${esc(card.cardId)}">${option ? "选择" : "带走"}</button>
    </div>`).join("");

  const challenge = supply.challenge;
  $("supply-option-list").hidden = !challenging;
  $("supply-option-list").innerHTML = challenging
    ? (challenge.options.length
      ? challenge.options.map((item) => `
        <div class="target${supplyPick === item.id ? " selected" : ""}"
            data-challenge="${esc(item.id)}" role="button" tabindex="0">
          <div class="target-name">${esc(item.name)} <small>${item.reward ? `奖励 ${item.reward} 金币` : "额外三选一"}</small></div>
          <div class="target-meta">${esc(item.description)}</div>
        </div>`).join("")
      : "<p class='hint'>已有未结算的挑战，本次无法接受新的挑战。</p>")
    : "";

  $("supply-payment").hidden = !swapping;
  if (swapping) {
    const price = supply.swap.price;
    $("supply-pay-gold").textContent = `支付 ${price} 金币（持有 ${state.gold}）`;
    $("supply-pay-gold").disabled = state.gold < price;
    $("supply-pay-gold").classList.toggle("selected", supplyPayment === "gold");
    $("supply-pay-card").classList.toggle("selected", supplyPayment === "card");
  }
  const showRemoval = swapping && supplyPayment === "card";
  $("supply-remove-targets").hidden = !showRemoval;
  $("supply-remove-targets").innerHTML = showRemoval
    ? supply.swap.targets.map((card) => `
        <div class="target card-target${supplyRemoveUid === card.uid ? " selected" : ""}${card.removable ? "" : " disabled"}"
            data-uid="${esc(card.uid)}" ${card.removable ? 'role="button" tabindex="0"' : ""}>
          ${cardFaceHtml(card)}
          <div class="card-target-note">${card.removable ? "可移除" : "不可移除 · 起手保底"}</div>
        </div>`).join("")
    : "";

  let preview = "";
  if (challenging && challenge.targets.length) {
    preview = challenge.targets.map((target) => {
      const plan = target.plan.map((step) => `T${step.turn} ${step.column + 1}列 ${step.name}(${step.atk ?? "?"}/${step.hp ?? "?"})`).join("；");
      return `${target.name} · 敌方领袖 ${target.enemyHp ?? "?"}${plan ? ` · ${plan}` : ""}`;
    }).join(" / ");
  }
  $("supply-preview").hidden = !preview;
  $("supply-preview").textContent = preview;

  const claims = supply.claimed.filter(Boolean);
  $("supply-skip").hidden = option;
  $("supply-option-skip").hidden = !option;
  $("supply-option-skip").textContent = swapping ? "不交换" : "不接受挑战";
  $("supply-confirm").hidden = !option;
  $("supply-confirm").disabled = swapping
    ? !supplyPick || !supplyPayment || (supplyPayment === "card" && !supplyRemoveUid)
    : !supplyPick;
  $("supply-confirm").textContent = swapping ? "确认交换" : "接受挑战";

  if (option) {
    $("supply-note").textContent =
      `两轮免费补给已结束${claims.length ? ` · 已领取：${claims.join("、")}` : ""}。`;
  } else {
    $("supply-note").textContent =
      `第 ${supply.round} / ${supply.rounds} 轮${claims.length ? ` · 已领取：${claims.join("、")}` : ""}。` +
      "领取的卡为独立 1 级实体；放弃本轮不会撤销已领取的卡。";
  }
}

/* ---------- 爱的中继站 ---------- */

function renderRelay() {
  const data = state.relay;
  if (!data) {
    missingPayload();
    return;
  }
  $("relay-view").hidden = false;
  $("relay-actions").innerHTML = `
    <button class="signal-action${relayAction === "keep" ? " selected" : ""}" data-choice="keep">
      <b>保留信号</b><span>获得持久剧情标记，不立即获得强化；后续对白会变化。</span>
    </button>
    <button class="signal-action${relayAction === "cut" ? " selected" : ""}" data-choice="cut">
      <b>切断回路</b><span>选择一张单位，攻击 +${data.atkBonus}；不会获得剧情标记。</span>
    </button>`;

  const showTargets = relayAction === "cut";
  $("relay-targets").innerHTML = showTargets
    ? data.targets.length
      ? data.targets.map((card) => `
        <div class="target card-target${relayTarget && relayTarget.uid === card.uid ? " selected" : ""}"
            data-card="${esc(card.cardId)}" data-uid="${esc(card.uid)}" role="button" tabindex="0">
          ${cardFaceHtml(card)}
          <div class="card-target-note">攻击 ${card.atk} → ${card.atkPreview.atk}</div>
        </div>`).join("")
      : "<p class='hint'>没有可强化的单位。</p>"
    : "";

  const preview = $("relay-preview");
  if (relayAction === "keep") {
    preview.hidden = false;
    $("relay-preview-text").textContent =
      "保留信号：设置持久剧情标记；不立即获得金币或强化。";
  } else if (relayAction === "cut" && relayTarget) {
    preview.hidden = false;
    $("relay-preview-text").textContent =
      `${relayTarget.name}：攻击 ${relayTarget.atk} → ${relayTarget.atkPreview.atk}（仅本趟冒险保留）。此操作不可撤销。`;
  } else {
    preview.hidden = true;
  }
  $("relay-note").textContent = relayAction
    ? "确认后立即结算，也可以离开。"
    : "先选择一种方案。";
}

/* ---------- 失控训练场 ---------- */

function renderTraining() {
  const data = state.training;
  if (!data) {
    missingPayload();
    return;
  }
  $("training-view").hidden = false;
  $("training-options").innerHTML = data.challenges.map((item) => `
    <div class="target${trainingPick === item.id ? " selected" : ""}"
        data-challenge="${esc(item.id)}" role="button" tabindex="0">
      <div class="target-name">${esc(item.name)} <small>奖励 ${item.reward} 金币</small></div>
      <div class="target-meta">${esc(item.description)}</div>
    </div>`).join("");
  $("training-confirm").hidden = trainingPick == null;
  $("training-note").textContent = trainingPick
    ? "接受后代价会挂载到下一场战斗，获胜后发放奖励。"
    : "选择一个挑战；接受后不能反悔。";
}

/* ---------- 启动与事件 ---------- */

async function loginOrRegister(path) {
  $("auth-error").textContent = "";
  const payload = { username: $("username").value.trim(), password: $("password").value };
  try {
    const data = await api(path, payload);
    $("password").value = "";
    username = data.username;
    state = null;
    battle = null;
    screen = "menu";
    await refreshSaveSlots();
  } catch (error) {
    $("auth-error").textContent = error.message;
  }
}

async function logout() {
  try {
    await api("/api/logout", {});
  } catch (_) { /* 已登出时忽略 */ }
  state = null;
  battle = null;
  username = "";
  screen = "auth";
  saveSlots = [];
  render();
}

async function refreshSaveSlots() {
  const data = await api("/api/save-slots");
  username = data.username;
  activeSlot = data.activeSlot;
  saveSlots = data.slots;
  render();
}

async function openMenu() {
  screen = "menu";
  render();
  try { await refreshSaveSlots(); } catch (error) { showToast(error.message); }
}

async function continueGame(slotId = activeSlot) {
  const slot = saveSlots.find((item) => item.slotId === slotId);
  if (!slot || slot.empty || slot.corrupt) {
    screen = "slots";
    render();
    return;
  }
  try {
    const data = await api(`/api/save-slots/${slotId}/select`, {});
    activeSlot = data.activeSlot;
    screen = "game";
    apply(data);
  } catch (error) { showToast(error.message); }
}

async function startNewGame(slotId) {
  const slot = saveSlots.find((item) => item.slotId === slotId);
  if (!slot || slot.corrupt) return;
  if (!slot.empty && !confirm(`开始新游戏将覆盖存档 ${slotId} 的全部进度与战斗状态，确定继续吗？`)) return;
  try {
    const data = await api("/api/game/new", { slotId, confirm: true });
    activeSlot = slotId;
    screen = "game";
    apply(data);
  } catch (error) { showToast(error.message); }
}

async function deleteSaveSlot(slotId) {
  const slot = saveSlots.find((item) => item.slotId === slotId);
  if (!slot || slot.empty) return;
  if (!confirm(`确定删除存档 ${slotId} 吗？此操作会永久清除该槽的冒险、战斗状态和备份。`)) return;
  try {
    const data = await api(`/api/save-slots/${slotId}`, undefined, "DELETE");
    activeSlot = data.activeSlot;
    saveSlots = data.slots;
    render();
  } catch (error) { showToast(error.message); }
}

function setVolume(value) {
  const volume = Math.max(0, Math.min(100, Number(value) || 0));
  $("master-volume").value = String(volume);
  $("volume-value").value = `${volume}%`;
  $("volume-value").textContent = `${volume}%`;
  try { localStorage.setItem("ai-game-master-volume", String(volume)); } catch (_) { /* 浏览器存储不可用时仍可调节 */ }
}

function openSettings() {
  showDialog($("settings-panel"), $("settings-close"));
}

function bindEvents() {
  window.addEventListener("message", onTransitionMessage);
  $("transition-retry").addEventListener("click", () => startTransitionPlayback(state?.transitionTarget));
  $("transition-continue").addEventListener("click", completeTransition);
  window.addEventListener("resize", () => updateViewportGuard(!!username && screen === "game"));
  window.addEventListener("orientationchange", () => updateViewportGuard(!!username && screen === "game"));
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-page-step]");
    if (!button) return;
    const list = button.parentElement.previousElementSibling;
    if (!list || !list.matches(".offers, .targets")) return;
    list.dataset.page = String(Number(list.dataset.page || 0) + Number(button.dataset.pageStep));
    refreshPagedLists(list.parentElement);
  });
  const pagerObserver = new MutationObserver((records) => {
    const containers = new Set(records.map((record) => record.target.closest(".offers, .targets")).filter(Boolean));
    containers.forEach((list) => refreshPagedLists(list.parentElement));
  });
  document.querySelectorAll(".offers, .targets").forEach((list) => pagerObserver.observe(list, { childList: true }));
  window.addEventListener("resize", () => requestAnimationFrame(() => refreshPagedLists()));
  $("login-btn").addEventListener("click", () => loginOrRegister("/api/login"));
  $("register-btn").addEventListener("click", () => loginOrRegister("/api/register"));
  $("password").addEventListener("keydown", (event) => {
    if (event.key === "Enter") loginOrRegister("/api/login");
  });
  $("logout-btn").addEventListener("click", logout);
  $("menu-btn").addEventListener("click", openMenu);
  $("continue-btn").addEventListener("click", () => continueGame());
  $("slots-open").addEventListener("click", () => { screen = "slots"; render(); });
  $("gallery-open").addEventListener("click", () => { screen = "gallery"; render(); });
  $("settings-open").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", () => hideDialog($("settings-panel")));
  $("settings-panel").querySelector(".modal").addEventListener("keydown", trapDialogFocus);
  $("master-volume").addEventListener("input", (event) => setVolume(event.target.value));
  try { setVolume(localStorage.getItem("ai-game-master-volume") ?? 100); } catch (_) { setVolume(100); }
  $("save-slots").addEventListener("click", (event) => {
    const button = event.target.closest("[data-slot-action]");
    if (!button) return;
    const slotId = Number(button.dataset.slot);
    if (button.dataset.slotAction === "continue") continueGame(slotId);
    else if (button.dataset.slotAction === "new") startNewGame(slotId);
    else if (button.dataset.slotAction === "delete") deleteSaveSlot(slotId);
  });
  document.querySelectorAll("[data-menu-back]").forEach((button) => button.addEventListener("click", openMenu));
  $("settings-panel").addEventListener("click", (event) => {
    if (event.target === $("settings-panel")) hideDialog($("settings-panel"));
  });
  window.addEventListener("keydown", (event) => {
    if (!$('story-view').hidden && (event.key === " " || event.key === "Enter")) {
      if (event.target.closest?.("button, input, select, textarea, a, [contenteditable='true']")) return;
      event.preventDefault();
      advanceStoryFromScene();
    }
    if (event.key === "Escape" && !$("settings-panel").hidden) hideDialog($("settings-panel"));
  });
  $("discard-panel").querySelector(".modal").addEventListener("keydown", trapDialogFocus);
  $("result-panel").querySelector(".modal").addEventListener("keydown", trapDialogFocus);

  $("story-panel").addEventListener("click", (event) => {
    if (event.target.closest("#story-skip, .story-option")) return;
    advanceStoryFromScene();
  });
  $("story-skip").addEventListener("click", () => advanceStory(true));
  $("story-options").addEventListener("click", (event) => {
    const button = event.target.closest(".story-option");
    if (!button || button.disabled) return;
    chooseStoryOption(button.dataset.option);
  });

  $("map-view").addEventListener("click", (event) => {
    const button = event.target.closest(".map-node");
    if (!button || button.disabled) return;
    selectMapNode(button.dataset.id);
  });

  $("end-turn").addEventListener("click", () => act("/api/battle/end", {}));
  $("hand-toggle").addEventListener("click", () => {
    $("hand-count").textContent = $("hand").querySelectorAll(".card").length;
    const open = $("hand-dock").classList.toggle("is-open");
    $("hand-toggle").setAttribute("aria-expanded", String(open));
  });
  $("battle-table").addEventListener("click", () => {
    $("hand-dock").classList.remove("is-open");
    $("hand-toggle").setAttribute("aria-expanded", "false");
  });
  $("recycle-btn").addEventListener("click", () => {
    recycleMode = !recycleMode;
    if (recycleMode) selectedUid = null;
    renderBattle();
  });
  $("player-row").addEventListener("click", onSlotClick);
  $("enemy-row").addEventListener("click", onSlotClick);
  $("player-row").addEventListener("keydown", onSlotKeydown);
  $("enemy-row").addEventListener("keydown", onSlotKeydown);

  $("hand").addEventListener("click", (event) => {
    const element = event.target.closest(".card");
    if (!element || !battle || battle.phase !== "player" || busy) return;
    selectCard(Number(element.dataset.uid));
  });
  $("hand").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const element = event.target.closest(".card");
    if (!element || !battle || battle.phase !== "player" || busy) return;
    event.preventDefault();
    selectCard(Number(element.dataset.uid));
  });

  $("hand").addEventListener("dragstart", (event) => {
    const element = event.target.closest(".card");
    if (!element || element.getAttribute("aria-disabled") === "true" || !battle || battle.phase !== "player" || busy) {
      event.preventDefault();
      return;
    }
    const card = battle.hand.find((item) => item.uid === Number(element.dataset.uid));
    if (!card) {
      event.preventDefault();
      return;
    }
    draggingUid = card.uid;
    dragDropped = false;
    $("hand-dock").classList.remove("is-open");
    $("hand-toggle").setAttribute("aria-expanded", "false");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(card.uid));
    element.classList.add("dragging");
    markDropTargets(card);
  });
  $("hand").addEventListener("dragend", (event) => {
    const element = event.target.closest(".card");
    if (element) element.classList.remove("dragging");
    if (draggingUid != null && !dragDropped) showToast("未完成：请拖到高亮目标");
    clearDragState();
  });

  ["player-row", "enemy-row"].forEach((id) => {
    $(id).addEventListener("dragover", onDragOver);
    $(id).addEventListener("dragleave", onDragLeave);
    $(id).addEventListener("drop", onDrop);
  });

  $("discard-hand").addEventListener("click", (event) => {
    const element = event.target.closest(".card");
    if (!element) return;
    const uid = Number(element.dataset.uid);
    if (discardSelection.has(uid)) discardSelection.delete(uid);
    else discardSelection.add(uid);
    renderDiscard();
  });
  $("discard-hand").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const element = event.target.closest(".card");
    if (!element) return;
    event.preventDefault();
    const uid = Number(element.dataset.uid);
    if (discardSelection.has(uid)) discardSelection.delete(uid);
    else discardSelection.add(uid);
    renderDiscard();
  });
  $("discard-confirm").addEventListener("click", () => {
    if (!battle || discardSelection.size !== battle.discardRequired) return;
    act("/api/battle/discard", { uids: [...discardSelection] });
  });

  $("result-action").addEventListener("click", () => {
    const action = $("result-action").dataset.action;
    if (action === "confirm") act("/api/battle/confirm", {});
    else if (action === "retry") act("/api/battle/retry", {});
  });

  $("tutorial-next").addEventListener("click", () => act("/api/battle/tutorial", {}));
  $("tutorial-skip").addEventListener("click", () => act("/api/battle/tutorial", { skip: true }));

  $("elite-offers").addEventListener("click", (event) => {
    const button = event.target.closest(".buy-btn");
    if (!button || button.disabled) return;
    act("/api/elite/reward/choose", { cardId: button.dataset.id });
  });
  $("elite-leave").addEventListener("click", () => act("/api/elite/reward/leave", {}));

  $("offers").addEventListener("click", (event) => {
    const button = event.target.closest(".buy-btn");
    if (!button || button.disabled) return;
    act("/api/recruit/buy", { offerId: button.dataset.id });
  });
  $("recruit-leave").addEventListener("click", () => act("/api/recruit/leave", {}));

  $("signal-actions").addEventListener("click", (event) => {
    const button = event.target.closest(".signal-action");
    if (!button || button.disabled) return;
    signalAction = button.dataset.action;
    signalTarget = null;
    renderSignal();
  });
  $("signal-targets").addEventListener("click", (event) => {
    const element = event.target.closest(".target");
    if (!element) return;
    signalTarget = signalTargets().find((card) => card.uid === element.dataset.uid) || null;
    renderSignal();
  });
  $("signal-targets").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const element = event.target.closest(".target");
    if (!element) return;
    event.preventDefault();
    signalTarget = signalTargets().find((card) => card.uid === element.dataset.uid) || null;
    renderSignal();
  });
  $("signal-confirm").addEventListener("click", () => {
    if (!signalTarget || !signalAction) return;
    const cardId = signalTarget.cardId;
    const cardUid = signalTarget.uid;
    const action = signalAction;
    signalTarget = null;
    signalAction = null;
    act("/api/signal/apply", { action, cardId, cardUid });
  });
  $("signal-cancel").addEventListener("click", () => {
    signalTarget = null;
    renderSignal();
  });
  $("signal-leave").addEventListener("click", () => act("/api/signal/leave", {}));

  $("targets").addEventListener("click", (event) => {
    const button = event.target.closest(".target-action");
    if (!button || button.disabled || !state[enhanceKind]) return;
    adventureEffect = button.dataset.effect;
    adventureTarget = adventureEffect === "draw"
      ? null
      : state[enhanceKind].targets.find((card) => card.uid === button.dataset.uid) || null;
    renderAdventure(enhanceKind);
  });
  $("adventure-confirm").addEventListener("click", () => {
    if (!adventureEffect || (adventureEffect !== "draw" && !adventureTarget)) return;
    const cardId = adventureTarget ? adventureTarget.cardId : "";
    const cardUid = adventureTarget ? adventureTarget.uid : undefined;
    const effect = adventureEffect;
    adventureTarget = null;
    adventureEffect = null;
    act(`/api/${enhanceKind}/apply`, { cardId, cardUid, effect });
  });
  $("adventure-cancel").addEventListener("click", () => {
    adventureTarget = null;
    adventureEffect = null;
    renderAdventure(enhanceKind);
  });
  $("adventure-leave").addEventListener("click", () => act(`/api/${enhanceKind}/leave`, {}));

  $("drift-offers").addEventListener("click", (event) => {
    const button = event.target.closest(".buy-btn");
    if (!button || button.disabled) return;
    act("/api/drift/choose", { cardId: button.dataset.id });
  });
  $("drift-reroll").addEventListener("click", () => act("/api/drift/reroll", {}));
  $("drift-leave").addEventListener("click", () => act("/api/drift/leave", {}));

  $("recycle-targets").addEventListener("click", (event) => {
    const element = event.target.closest(".target");
    if (!element || element.classList.contains("disabled") || !state.recycle) return;
    recycleTarget = state.recycle.targets.find((card) => card.uid === element.dataset.uid) || null;
    renderRecycle();
  });
  $("recycle-targets").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const element = event.target.closest(".target");
    if (!element || element.classList.contains("disabled") || !state.recycle) return;
    event.preventDefault();
    recycleTarget = state.recycle.targets.find((card) => card.uid === element.dataset.uid) || null;
    renderRecycle();
  });
  $("recycle-confirm").addEventListener("click", () => {
    if (!recycleTarget) return;
    const cardId = recycleTarget.cardId;
    const cardUid = recycleTarget.uid;
    recycleTarget = null;
    act("/api/recycle/apply", { cardId, cardUid });
  });
  $("recycle-cancel").addEventListener("click", () => {
    recycleTarget = null;
    renderRecycle();
  });
  $("recycle-leave").addEventListener("click", () => act("/api/recycle/leave", {}));

  $("shop-offers").addEventListener("click", (event) => {
    const target = event.target.closest(".shop-target");
    if (target && !target.disabled) {
      shopTarget = target.dataset.uid;
      renderShop();
      return;
    }
    const button = event.target.closest(".buy-btn");
    if (!button || button.disabled) return;
    const offer = state.shop.offers.find((item) => item.id === button.dataset.id);
    const targetId = (offer?.targets || []).find((item) => item.uid === shopTarget)?.uid
      ?? offer?.targets?.[0]?.uid;
    act("/api/shop/buy", targetId == null
      ? { offerId: button.dataset.id }
      : { offerId: button.dataset.id, cardUid: targetId });
  });
  $("shop-leave").addEventListener("click", () => act("/api/shop/leave", {}));

  const pickTrial = (event) => {
    const element = event.target.closest(".target");
    if (!element || element.classList.contains("disabled") || !state.trial) return;
    trialPick = element.dataset.trial;
    renderTrial();
  };
  $("trial-options").addEventListener("click", pickTrial);
  $("trial-options").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    pickTrial(event);
  });
  $("trial-confirm").addEventListener("click", () => {
    if (!trialPick) return;
    act("/api/trial/choose", { trialId: trialPick });
  });
  $("trial-rewards").addEventListener("click", (event) => {
    const button = event.target.closest(".buy-btn");
    if (!button || button.disabled) return;
    act("/api/trial/choose-card", { cardId: button.dataset.id });
  });
  $("trial-claim").addEventListener("click", () => act("/api/trial/claim", {}));
  $("trial-leave").addEventListener("click", () => act("/api/trial/leave", {}));

  $("supply-offers").addEventListener("click", (event) => {
    const offer = event.target.closest(".card-offer");
    if (!offer || !state.supply) return;
    if (state.supply.stage === "option") {
      supplyPick = offer.dataset.id;
      renderSupply();
      return;
    }
    act("/api/supply/choose", { round: state.supply.round - 1, cardId: offer.dataset.id });
  });
  $("supply-skip").addEventListener("click", () => {
    if (!state.supply) return;
    act("/api/supply/skip", { round: state.supply.round - 1 });
  });
  $("supply-option-list").addEventListener("click", (event) => {
    const target = event.target.closest(".target");
    if (!target || !state.supply) return;
    supplyPick = target.dataset.challenge;
    renderSupply();
  });
  $("supply-pay-gold").addEventListener("click", () => {
    supplyPayment = "gold";
    supplyRemoveUid = null;
    renderSupply();
  });
  $("supply-pay-card").addEventListener("click", () => {
    supplyPayment = "card";
    supplyRemoveUid = null;
    renderSupply();
  });
  $("supply-remove-targets").addEventListener("click", (event) => {
    const target = event.target.closest(".target");
    if (!target || target.classList.contains("disabled")) return;
    supplyRemoveUid = target.dataset.uid;
    renderSupply();
  });
  $("supply-confirm").addEventListener("click", () => {
    if (!state.supply || !supplyPick) return;
    if (state.supply.stage !== "option") return;
    if (state.supply.variant === "swap") {
      act("/api/supply/swap", {
        cardId: supplyPick,
        payment: supplyPayment,
        removeUid: supplyPayment === "card" ? supplyRemoveUid : null,
      });
    } else {
      act("/api/supply/challenge", { challengeId: supplyPick });
    }
  });
  $("supply-option-skip").addEventListener("click", () => {
    if (!state.supply) return;
    act(state.supply.variant === "swap" ? "/api/supply/swap/skip" : "/api/supply/challenge/skip", {});
  });

  const chooseRelay = (event) => {
    const button = event.target.closest(".signal-action");
    if (!button || !state.relay) return;
    relayAction = button.dataset.choice;
    if (relayAction !== "cut") relayTarget = null;
    renderRelay();
  };
  $("relay-actions").addEventListener("click", chooseRelay);
  $("relay-targets").addEventListener("click", (event) => {
    const element = event.target.closest(".target");
    if (!element || !state.relay) return;
    relayTarget = state.relay.targets.find((card) => card.uid === element.dataset.uid) || null;
    renderRelay();
  });
  $("relay-targets").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const element = event.target.closest(".target");
    if (!element || !state.relay) return;
    event.preventDefault();
    relayTarget = state.relay.targets.find((card) => card.uid === element.dataset.uid) || null;
    renderRelay();
  });
  $("relay-confirm").addEventListener("click", () => {
    if (relayAction === "keep") {
      act("/api/relay/choose", { choice: "keep" });
    } else if (relayAction === "cut" && relayTarget) {
      act("/api/relay/cut", { cardId: relayTarget.cardId, cardUid: relayTarget.uid });
    }
  });
  $("relay-cancel").addEventListener("click", () => {
    relayAction = null;
    relayTarget = null;
    renderRelay();
  });
  $("relay-leave").addEventListener("click", () => act("/api/relay/leave", {}));

  const pickTraining = (event) => {
    const element = event.target.closest(".target");
    if (!element || !state.training) return;
    trainingPick = element.dataset.challenge;
    renderTraining();
  };
  $("training-options").addEventListener("click", pickTraining);
  $("training-options").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    pickTraining(event);
  });
  $("training-confirm").addEventListener("click", () => {
    if (!trainingPick) return;
    const challengeId = trainingPick;
    trainingPick = null;
    act("/api/training/choose", { challengeId });
  });
  $("training-leave").addEventListener("click", () => act("/api/training/leave", {}));

  const restartGame = () => {
    if (!confirm("重新开始会覆盖当前冒险进度，确定吗？")) return;
    act("/api/game/new", { confirm: true });
  };
  $("restart-btn").addEventListener("click", restartGame);
  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.altKey && !event.repeat && event.key.toLowerCase() === "p" && state) {
      event.preventDefault();
      restartGame();
    }
  });
  $("map2-btn").addEventListener("click", () => {
    const third = state.canStartMap3;
    if (!confirm(`进入${third ? "第三" : "第二"}张地图会组建新的初始牌组，确定吗？`)) return;
    act(third ? "/api/game/map3" : "/api/game/map2", {});
  });
}

async function init() {
  bindEvents();
  try {
    await refreshSaveSlots();
    screen = "menu";
    render();
  } catch (error) {
    state = null;
    username = "";
    screen = "auth";
    render();
    if (!error.message.includes("未登录")) $("auth-error").textContent = error.message;
  }
}

init();
