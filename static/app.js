"use strict";

const $ = (id) => document.getElementById(id);

let state = null;
let battle = null;
let username = "";
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
let relayTarget = null;
let signalAction = null;
let signalTarget = null;
let draggingUid = null;
let dragDropped = false;
let busy = false;
let loadingBattle = false;
let toastTimer = null;

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
};
const MAP_STATUS = { completed: "已完成", available: "可进入", locked: "未解锁", closed: "已关闭" };

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

async function api(path, body) {
  const options = body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, options);
  let data = null;
  try { data = await response.json(); } catch (_) { /* 非 JSON 响应 */ }
  if (!response.ok) {
    if (response.status === 401) {
      state = null;
      battle = null;
      render();
    }
    throw new Error(data && data.detail ? data.detail : `请求失败（${response.status}）`);
  }
  return data;
}

function apply(data) {
  if (!data) return;
  if (data.state) state = data.state;
  if (Object.prototype.hasOwnProperty.call(data, "battle")) battle = data.battle;
  if (data.username) username = data.username;
  render();
}

function hideViews() {
  ["story-view", "map-view", "battle-view", "recruit-view", "signal-view", "adventure-view", "drift-view", "recycle-view", "shop-view", "trial-view", "relay-view", "training-view", "complete-view"].forEach((id) => {
    $(id).hidden = true;
  });
}

function render() {
  const loggedIn = !!state;
  $("auth").hidden = loggedIn;
  $("game").hidden = !loggedIn;
  if (!loggedIn) {
    $("auth-error").textContent = "";
    return;
  }

  $("hud-gold").textContent = state.gold;
  $("hud-user").textContent = username;
  if (state.complete) {
    $("hud-node").textContent = "路线完成";
  } else if (state.phase === "map") {
    $("hud-node").textContent = `路线选择（${state.progress}/${state.runLength}）`;
  } else if (state.node) {
    $("hud-node").textContent = `${state.node.name}（${state.progress}/${state.runLength}）`;
  } else {
    $("hud-node").textContent = "";
  }

  hideViews();
  if (state.complete) {
    $("complete-view").hidden = false;
    return;
  }
  if (state.phase === "map") {
    renderMap();
    return;
  }
  if (state.phase === "before_story" || state.phase === "after_story") {
    renderStory();
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
  }
}

/* ---------- 剧情 ---------- */

function renderPortrait(story) {
  const holder = $("story-portrait");
  holder.innerHTML = "";
  const fallback = () => {
    holder.innerHTML = `<svg class="portrait-figure" viewBox="0 0 140 190" aria-hidden="true">
      <circle cx="70" cy="76" r="46"></circle>
      <path class="shoulders" d="M24 190v-36c0-22 20-36 46-36s46 14 46 36v36"></path>
      <rect x="44" y="48" width="52" height="58" rx="20"></rect>
      <path d="M52 68h36M52 82h36M70 48V32M58 32h24M58 118h24"></path>
      <circle class="eye" cx="60" cy="68" r="2.5"></circle>
      <circle class="eye" cx="80" cy="68" r="2.5"></circle>
    </svg>`;
  };
  if (story.portrait) {
    const image = document.createElement("img");
    image.alt = "";
    image.src = story.portrait;
    image.addEventListener("error", fallback);
    holder.appendChild(image);
  } else {
    fallback();
  }
}

function renderStory() {
  const story = state.story;
  if (!story) {
    render();
    return;
  }
  $("story-view").hidden = false;
  const background = String(story.background || "").replace(/[^A-Za-z0-9_-]/g, "");
  $("story-panel").className = "story-panel" + (background ? ` bg-${background}` : "");
  $("story-node").textContent = `${state.node.name} · ${state.phase === "after_story" ? "后日谈" : "前日谈"}`;
  renderPortrait(story);
  $("story-speaker").textContent = story.speaker;
  $("story-text").textContent = story.text;
  $("story-progress").textContent = `${story.line} / ${story.total}`;

  const options = story.options || [];
  $("story-options").innerHTML = options.length
    ? `<span class="story-options-hint">请选择：</span>` + options
        .map((option) => `<button class="story-option" data-option="${esc(option.id)}">${esc(option.text)}</button>`)
        .join("")
    : "";
  $("story-options").hidden = options.length === 0;
  $("story-next").disabled = options.length > 0;
  $("story-skip").disabled = options.length > 0;
}

async function advanceStory(skip) {
  try {
    const data = await api("/api/story/advance", { skip });
    apply(data);
  } catch (error) {
    showToast(error.message);
  }
}

async function chooseStoryOption(optionId) {
  try {
    const data = await api("/api/story/choose", { optionId });
    apply(data);
  } catch (error) {
    showToast(error.message);
  }
}

/* ---------- 关卡选择 ---------- */

function mapNodeButton(node) {
  if (!node) return "";
  const type = NODE_TYPES[node.type] || node.type;
  const status = MAP_STATUS[node.status] || node.status;
  const disabled = node.status === "available" ? "" : "disabled";
  const icons = {
    battle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.8 3.5 5.7 5.7-2.2 2.2-2-2-6.7 6.7-2.9-.7.7-2.9 6.7-6.7-2-2 2.7-2.3Z"/><path d="m4 20 3.1-3.1M14.5 5.5l4 4"/></svg>',
    recruit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16"/><circle cx="12" cy="12" r="8"/></svg>',
    signal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16a8 8 0 0 1 16 0M7 16a5 5 0 0 1 10 0M10 16a2 2 0 0 1 4 0"/><path d="M12 19v1"/></svg>',
    adventure: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.2 5.2L20 10l-5.8 1.8L12 17l-2.2-5.2L4 10l5.8-1.8L12 3Z"/><path d="m18 16 .8 1.8L21 18.5l-2.2.7L18 21l-.8-1.8-2.2-.7 2.2-.7L18 16Z"/></svg>',
    calibration: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17h18M5 17V9m7 8V5m7 12v-6"/><path d="M3 21h18"/></svg>',
    drift: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16M9 5v14"/></svg>',
    recycle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V5h6v3M10 12v4M14 12v4"/></svg>',
    shop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16l-1.5 13h-13L4 7Z"/><path d="M8 7V5a4 4 0 0 1 8 0v2M9 12h6"/></svg>',
    trial: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M6 21h12M7 7l5-4 5 4M9 7v5a3 3 0 0 0 6 0V7"/><path d="M9 15h6"/></svg>'
  };
  return `<button class="map-node status-${esc(node.status)} type-${esc(node.type)}"
      data-id="${esc(node.id)}" ${disabled}
      aria-label="${esc(node.name)}，${esc(type)}，${esc(status)}">
      <span class="map-node-icon">${icons[node.type] || icons.adventure}</span>
      <span class="map-node-copy"><span class="map-node-type">${esc(type)}</span><span class="map-node-name">${esc(node.name)}</span><span class="map-node-status">${esc(status)}</span></span>
    </button>`;
}

function renderMap() {
  const map = state.map;
  if (!map) {
    render();
    return;
  }
  $("map-view").hidden = false;
  const byId = Object.fromEntries(map.nodes.map((node) => [node.id, node]));
  const available = map.nodes.filter((node) => node.status === "available");
  const nextNames = available.map((node) => node.name).join(" / ");
  const selected = map.nodes.filter(
    (node) => node.branchGroup && map.route[node.branchGroup] === node.branch
  );
  const routeNames = selected.map((node) => node.name).join(" → ");
  $("map-page-left").innerHTML = `
    <h3 class="page-title">回路航线 <span>SECTOR 01</span></h3>
    <div class="map-flow route-track">
      ${mapNodeButton(byId.battle1)}
      <div class="route-rail route-rail-split"><span></span><span></span></div>
      <div class="branch-row route-branch">
        ${mapNodeButton(byId.recruit)}
        ${mapNodeButton(byId.signal)}
        ${mapNodeButton(byId.relay)}
      </div>
      <div class="route-rail route-rail-split"><span></span><span></span></div>
      <div class="branch-row route-branch">
        ${mapNodeButton(byId.adventure)}
        ${mapNodeButton(byId.calibration)}
        ${mapNodeButton(byId.drones)}
      </div>
      <div class="route-rail route-rail-split"><span></span><span></span></div>
      <div class="branch-row route-branch">
        ${mapNodeButton(byId.drift_capsule)}
        ${mapNodeButton(byId.recycle_station)}
      </div>
      <div class="route-rail route-rail-split"><span></span><span></span></div>
      <div class="branch-row route-branch">
        ${mapNodeButton(byId.shop)}
        ${mapNodeButton(byId.trial)}
        ${mapNodeButton(byId.training)}
      </div>
      <div class="route-rail"><span></span></div>
      ${mapNodeButton(byId.battle2)}
    </div>`;
  $("map-page-right").innerHTML = `
    <h3 class="page-title">航线记录 <span>RUN ${String(state.progress).padStart(2, "0")}</span></h3>
    <div class="route-readout"><strong>${esc(routeNames || "未选路线")}</strong><small>当前路径</small></div>
    <div class="map-route-list"><span class="route-dot complete"></span><span>起始信标</span><span class="route-line"></span><span class="route-dot active"></span><span>下一节点</span></div>
    <div class="route-next"><small>可进入</small><strong>${esc(nextNames || "无")}</strong></div>
    <div class="map-legend">
      <span class="legend available">可进入</span>
      <span class="legend completed">已完成</span>
      <span class="legend locked">未解锁</span>
      <span class="legend closed">已关闭</span>
    </div>
    <p class="map-copy">点击发光节点继续前进。分支会在选择后锁定。</p>`;
  $("map-route").textContent = routeNames
    ? `已选择路线：${routeNames}`
    : "尚未选择分支";
  const hint = available.length > 1
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
    const data = await api("/api/battle/reset", {});
    apply(data);
  } catch (error) {
    showToast(error.message);
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
    apply(data);
  } catch (error) {
    showToast(error.message);
  } finally {
    busy = false;
  }
}

function unitHtml(unit, side, column) {
  const label = unit
    ? `${column} 列，${unit.name}，攻击 ${unit.atk}，生命 ${unit.hp}`
    : `${column} 列，空列`;
  if (!unit) {
    return `<div class="slot empty" data-side="${side}" data-column="${column}" tabindex="0" aria-label="${esc(label)}"><span>空列</span></div>`;
  }
  return `<div class="slot unit ${side}" data-side="${side}" data-column="${column}" data-uid="${unit.uid}" tabindex="0" aria-label="${esc(label)}">
      <div class="unit-core" aria-hidden="true">${esc(unit.name.slice(0, 1))}</div>
      <div class="unit-name">${esc(unit.name)}</div>
      <div class="unit-stats"><span class="atk">⚔ ${unit.atk}</span><span class="hp">❤ ${unit.hp}/${unit.maxHp}</span></div>
    </div>`;
}

function cardHtml(card, selected, draggable = false) {
  const stats = card.type === "unit"
    ? `⚔ ${card.atk}　❤ ${card.hp}`
    : esc(card.effectText || (card.heal != null ? `恢复 ${card.heal}` : card.damage != null ? `造成 ${card.damage} 伤害` : ""));
  return `<div class="card${selected ? " selected" : ""}" data-uid="${card.uid}" data-type="${card.type}"
      tabindex="0" role="button" draggable="${draggable ? "true" : "false"}"
      aria-label="${esc(card.name)}，费用 ${card.cost}，等级 ${card.level}${card.type === "unit" ? `，攻击 ${card.atk}，生命 ${card.hp}` : ""}">
      <div class="card-art ${card.type}" aria-hidden="true"><span>${esc(card.name.slice(0, 1))}</span></div>
      <div class="card-cost">${card.cost}</div>
      <div class="card-name">${esc(card.name)}</div>
      <div class="card-stats">${stats}</div>
      <div class="card-level">Lv.${card.level}</div>
    </div>`;
}

function renderForecast() {
  const forecast = battle.forecast || [];
  if (!forecast.length) {
    $("forecast-row").innerHTML = `<div class="forecast-empty">没有待预告内容</div>`;
    return;
  }
  $("forecast-row").innerHTML = [1, 2, 3, 4].map((column) => {
    const items = forecast.filter((item) => item.column === column);
    const content = items.map((item) => {
      const current = item.turn === battle.turn;
      return `<div class="forecast-item ${current ? "current" : "next"}">
          <span class="forecast-when">${current ? "本回合" : "下回合"}</span>
          <span class="forecast-name">${esc(item.name)}</span>
          <span class="forecast-stats">⚔ ${item.atk} · ❤ ${item.hp}</span>
        </div>`;
    }).join("");
    return `<div class="forecast-cell${items.length ? "" : " empty"}" data-column="${column}">
        <span class="forecast-col">${column} 列</span>${content}
      </div>`;
  }).join("");
}

function renderBattle() {
  $("battle-view").hidden = false;
  if (!battle) {
    $("hand").innerHTML = "<p class='hint'>正在载入战斗…</p>";
    ensureBattle();
    return;
  }

  $("enemy-hp").textContent = battle.hp.enemy;
  $("player-hp").textContent = battle.hp.player;
  $("turn").textContent = battle.turn;
  $("energy").textContent = battle.energy;
  $("deck-count").textContent = battle.deckCount;

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

  $("log").innerHTML = battle.log.map(esc).join("<br>");

  $("end-turn").disabled = battle.phase !== "player";
  $("recycle-btn").disabled = battle.phase !== "player";
  $("recycle-btn").classList.toggle("active", recycleMode);

  renderDiscard();
  renderResult();
}

function renderDiscard() {
  const panel = $("discard-panel");
  if (!battle || battle.phase !== "discard") {
    panel.hidden = true;
    discardSelection.clear();
    return;
  }
  panel.hidden = false;
  for (const uid of [...discardSelection]) {
    if (!battle.hand.some((card) => card.uid === uid)) discardSelection.delete(uid);
  }
  $("discard-needed").textContent = battle.discardRequired;
  $("discard-hand").innerHTML = battle.hand
    .map((card) => cardHtml(card, discardSelection.has(card.uid)))
    .join("");
  $("discard-confirm").disabled = discardSelection.size !== battle.discardRequired;
  $("discard-confirm").textContent = `确认弃牌（${discardSelection.size}/${battle.discardRequired}）`;
}

function renderResult() {
  const panel = $("result-panel");
  if (!battle || battle.phase !== "over") {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
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

function markDropTargets(card) {
  if (card.cost > battle.energy) {
    showToast("能量不足");
    return;
  }
  if (card.type === "unit") {
    let count = 0;
    battle.board.player.forEach((unit, index) => {
      if (!unit) {
        markDropSlot("player", index + 1);
        count += 1;
      }
    });
    if (!count) showToast("己方没有空列");
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
    await act("/api/battle/deploy", { uid, column });
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
  if (slot?.classList.contains("drop-ok")) slot.classList.add("drop-hover");
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
      await act("/api/battle/deploy", { uid: card.uid, column });
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
      showToast("请拖动单位牌到空列部署");
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
  selectedUid = selectedUid === uid ? null : uid;
  if (selectedUid != null) recycleMode = false;
  renderBattle();
}

/* ---------- 招募 ---------- */

function renderRecruit() {
  const recruit = state.recruit;
  if (!recruit) {
    render();
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
        return `<div class="offer">
            <div class="offer-name">${esc(offer.name)}</div>
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
    render();
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
        <div class="target${signalTarget && signalTarget.cardId === card.cardId ? " selected" : ""}" data-card="${esc(card.cardId)}">
          <div class="target-name">${esc(card.name)} <small>Lv.${card.level}</small></div>
          <div class="target-meta">攻击 ${card.atk}　生命 ${card.hp}</div>
          <div class="target-meta">${card.atkBonus || card.hpBonus ? `改造：攻击 +${card.atkBonus || 0} / 生命 +${card.hpBonus || 0}` : "暂无改造"}</div>
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
    render();
    return;
  }
  $("adventure-view").hidden = false;
  $("adventure-title").textContent = kind === "calibration"
    ? "校准平台"
    : kind === "drones" ? "维修无人机群" : "废弃维修站";
  $("adventure-hint").textContent = kind === "calibration"
    ? "选择一张已有单位，三选一：攻击强化、生命强化或直接升一级；先预览再确认，也可以离开。"
    : kind === "drones"
      ? "选择一台无人机（攻击 +1 或最大生命 +1），再指定一张单位；先预览再确认，也可以离开。"
      : "选择一张已有单位，二选一：攻击 +1 或最大生命 +2；先预览再确认，也可以离开。";
  $("targets").innerHTML = data.targets.length
    ? data.targets.map((card) => `
        <div class="target${adventureTarget && adventureTarget.cardId === card.cardId ? " selected" : ""}" data-card="${esc(card.cardId)}">
          <div class="target-name">${esc(card.name)} <small>Lv.${card.level}</small></div>
          <div class="target-meta">攻击 ${card.atk}　生命 ${card.hp}</div>
          <div class="target-meta">${card.atkBonus || card.hpBonus ? `改造：攻击 +${card.atkBonus || 0} / 生命 +${card.hpBonus || 0}` : "暂无改造"}</div>
          <div class="target-actions">
            <button class="target-action" data-card="${esc(card.cardId)}" data-effect="atk">
              攻击 +${data.atkBonus}<small>${card.atk} → ${card.atkPreview.atk}</small>
            </button>
            <button class="target-action" data-card="${esc(card.cardId)}" data-effect="hp">
              最大生命 +${data.hpBonus}<small>${card.maxHp} → ${card.hpPreview.maxHp}</small>
            </button>
            ${kind === "calibration" ? `
            <button class="target-action" data-card="${esc(card.cardId)}" data-effect="level" ${card.canLevel ? "" : "disabled"}>
              等级 +${data.levelBonus}<small>${card.canLevel ? `Lv.${card.level} → Lv.${card.level + data.levelBonus}` : "已满级"}</small>
            </button>` : ""}
          </div>
        </div>`).join("")
    : "<p class='hint'>没有可强化的单位。</p>";

  const preview = $("adventure-preview");
  if (adventureTarget && adventureEffect) {
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
    render();
    return;
  }
  $("drift-view").hidden = false;
  $("drift-offers").innerHTML = drift.candidates.length
    ? drift.candidates.map((card) => `
        <div class="offer">
          <div class="offer-name">${esc(card.name)}</div>
          <div class="offer-meta">${card.isUpgrade
            ? `已有 Lv.${card.currentLevel} → Lv.${card.targetLevel}`
            : `新卡 Lv.${card.targetLevel}`}</div>
          <div class="offer-meta">费用 ${card.cost}　${card.type === "unit" ? `攻击 ${card.atk}　生命 ${card.hp}` : esc(card.effectText)}</div>
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
    render();
    return;
  }
  $("recycle-view").hidden = false;
  $("recycle-targets").innerHTML = data.targets.length
    ? data.targets.map((card) => `
        <div class="target${recycleTarget && recycleTarget.cardId === card.cardId ? " selected" : ""}${card.removable ? "" : " disabled"}"
            data-card="${esc(card.cardId)}" ${card.removable ? 'role="button" tabindex="0"' : ""}>
          <div class="target-name">${esc(card.name)} <small>Lv.${card.level}</small></div>
          <div class="target-meta">攻击 ${card.atk}　生命 ${card.hp}</div>
          <div class="target-meta">${card.removable ? `可拆解：+${card.price} 金币` : "不可拆解（最后一张单位牌）"}</div>
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
    render();
    return;
  }
  $("shop-view").hidden = false;
  $("shop-offers").innerHTML = shop.offers.map((offer) => {
    const meta = offer.kind === "new"
      ? "新单位"
      : offer.kind === "upgrade" ? "升级已有单位" : esc(offer.effectText);
    return `<div class="offer">
        <div class="offer-name">${esc(offer.name)}</div>
        <div class="offer-meta">${meta}</div>
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
    render();
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
        <div class="offer">
          <div class="offer-name">${esc(card.name)}</div>
          <div class="offer-meta">${card.isUpgrade
            ? `已有 Lv.${card.currentLevel} → Lv.${card.targetLevel}`
            : `新卡 Lv.${card.targetLevel}`}</div>
          <div class="offer-meta">费用 ${card.cost}　${card.type === "unit" ? `攻击 ${card.atk}　生命 ${card.hp}` : esc(card.effectText)}</div>
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

/* ---------- 爱的中继站 ---------- */

function renderRelay() {
  const data = state.relay;
  if (!data) {
    render();
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
        <div class="target${relayTarget && relayTarget.cardId === card.cardId ? " selected" : ""}"
            data-card="${esc(card.cardId)}" role="button" tabindex="0">
          <div class="target-name">${esc(card.name)} <small>Lv.${card.level}</small></div>
          <div class="target-meta">攻击 ${card.atk} → ${card.atkPreview.atk}　生命 ${card.maxHp}</div>
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
    render();
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
    apply(data);
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
  render();
}

function bindEvents() {
  $("login-btn").addEventListener("click", () => loginOrRegister("/api/login"));
  $("register-btn").addEventListener("click", () => loginOrRegister("/api/register"));
  $("password").addEventListener("keydown", (event) => {
    if (event.key === "Enter") loginOrRegister("/api/login");
  });
  $("logout-btn").addEventListener("click", logout);

  $("story-next").addEventListener("click", () => advanceStory(false));
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
    if (!element || !battle || battle.phase !== "player" || busy) {
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
    signalTarget = signalTargets().find((card) => card.cardId === element.dataset.card) || null;
    renderSignal();
  });
  $("signal-confirm").addEventListener("click", () => {
    if (!signalTarget || !signalAction) return;
    const cardId = signalTarget.cardId;
    const action = signalAction;
    signalTarget = null;
    signalAction = null;
    act("/api/signal/apply", { action, cardId });
  });
  $("signal-cancel").addEventListener("click", () => {
    signalTarget = null;
    renderSignal();
  });
  $("signal-leave").addEventListener("click", () => act("/api/signal/leave", {}));

  $("targets").addEventListener("click", (event) => {
    const button = event.target.closest(".target-action");
    if (!button || button.disabled || !state[enhanceKind]) return;
    adventureTarget = state[enhanceKind].targets.find((card) => card.cardId === button.dataset.card) || null;
    adventureEffect = button.dataset.effect;
    renderAdventure(enhanceKind);
  });
  $("adventure-confirm").addEventListener("click", () => {
    if (!adventureTarget || !adventureEffect) return;
    const cardId = adventureTarget.cardId;
    const effect = adventureEffect;
    adventureTarget = null;
    adventureEffect = null;
    act(`/api/${enhanceKind}/apply`, { cardId, effect });
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
    recycleTarget = state.recycle.targets.find((card) => card.cardId === element.dataset.card) || null;
    renderRecycle();
  });
  $("recycle-targets").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const element = event.target.closest(".target");
    if (!element || element.classList.contains("disabled") || !state.recycle) return;
    event.preventDefault();
    recycleTarget = state.recycle.targets.find((card) => card.cardId === element.dataset.card) || null;
    renderRecycle();
  });
  $("recycle-confirm").addEventListener("click", () => {
    if (!recycleTarget) return;
    const cardId = recycleTarget.cardId;
    recycleTarget = null;
    act("/api/recycle/apply", { cardId });
  });
  $("recycle-cancel").addEventListener("click", () => {
    recycleTarget = null;
    renderRecycle();
  });
  $("recycle-leave").addEventListener("click", () => act("/api/recycle/leave", {}));

  $("shop-offers").addEventListener("click", (event) => {
    const button = event.target.closest(".buy-btn");
    if (!button || button.disabled) return;
    act("/api/shop/buy", { offerId: button.dataset.id });
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
    relayTarget = state.relay.targets.find((card) => card.cardId === element.dataset.card) || null;
    renderRelay();
  });
  $("relay-targets").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const element = event.target.closest(".target");
    if (!element || !state.relay) return;
    event.preventDefault();
    relayTarget = state.relay.targets.find((card) => card.cardId === element.dataset.card) || null;
    renderRelay();
  });
  $("relay-confirm").addEventListener("click", () => {
    if (relayAction === "keep") {
      act("/api/relay/choose", { choice: "keep" });
    } else if (relayAction === "cut" && relayTarget) {
      act("/api/relay/cut", { cardId: relayTarget.cardId });
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

  $("restart-btn").addEventListener("click", () => {
    if (!confirm("重新开始会覆盖当前冒险进度，确定吗？")) return;
    act("/api/game/new", { confirm: true });
  });
}

async function init() {
  bindEvents();
  try {
    const data = await api("/api/state");
    apply(data);
  } catch (_) {
    state = null;
    render();
  }
}

init();
