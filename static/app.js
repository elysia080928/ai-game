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
let signalAction = null;
let signalTarget = null;
let draggingUid = null;
let dragDropped = false;
let busy = false;
let loadingBattle = false;
let toastTimer = null;

const NODE_TYPES = { battle: "战斗", recruit: "招募", signal: "信号", adventure: "维修" };
const MAP_STATUS = { completed: "已完成", available: "可进入", locked: "未解锁", closed: "已关闭" };
const ROUTE_NAMES = { recruit: "招募", signal: "信号奇遇" };

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
  ["story-view", "map-view", "battle-view", "recruit-view", "signal-view", "adventure-view", "complete-view"].forEach((id) => {
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
    renderAdventure();
  }
}

/* ---------- 剧情 ---------- */

function renderPortrait(story) {
  const holder = $("story-portrait");
  holder.innerHTML = "";
  const fallback = () => {
    holder.textContent = story.speaker ? story.speaker.slice(0, 1) : "…";
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
  return `<button class="map-node status-${esc(node.status)} type-${esc(node.type)}"
      data-id="${esc(node.id)}" ${disabled}
      aria-label="${esc(node.name)}，${esc(type)}，${esc(status)}">
      <span class="map-node-type">${esc(type)}</span>
      <span class="map-node-name">${esc(node.name)}</span>
      <span class="map-node-status">${esc(status)}</span>
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
  $("map-page-left").innerHTML = `
    <h3 class="page-title">第 1 幕 · 岔路</h3>
    <div class="map-flow">
      ${mapNodeButton(byId.battle1)}
      <div class="map-split">分叉</div>
      <div class="branch-row">
        ${mapNodeButton(byId.recruit)}
        ${mapNodeButton(byId.signal)}
      </div>
    </div>`;
  $("map-page-right").innerHTML = `
    <h3 class="page-title">第 2 幕 · 汇合</h3>
    <div class="map-flow">
      <div class="merge-label">两条路线在此汇合</div>
      ${mapNodeButton(byId.adventure)}
      <div class="map-arrow">▼</div>
      ${mapNodeButton(byId.battle2)}
    </div>`;
  $("map-route").textContent = map.route
    ? `已选择路线：${ROUTE_NAMES[map.route] || map.route}`
    : "尚未选择分支";
  const available = map.nodes.filter((node) => node.status === "available");
  $("map-hint").textContent = available.length > 1
    ? "选择一条分支；确认后另一条分支会关闭。"
    : "选择下一个节点，进入其前置剧情。";
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
        battle.phase === "player" && card.type === "unit",
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

function markDropTargets(card) {
  document.querySelectorAll("#player-row .slot.empty").forEach((slot) => {
    slot.classList.add("drop-ok");
  });
  if (card.cost > battle.energy) {
    document.querySelectorAll("#player-row .slot.drop-ok").forEach((slot) => slot.classList.remove("drop-ok"));
    showToast("能量不足，无法部署这个单位");
  }
}

async function deployFromDrag(uid, column) {
  if (!battle || battle.phase !== "player") {
    showToast("当前不能部署");
    return;
  }
  const card = battle.hand.find((item) => item.uid === uid);
  if (!card) return;
  if (battle.board.player[column - 1]) {
    showToast("该列已有单位");
    return;
  }
  if (card.cost > battle.energy) {
    showToast("能量不足");
    return;
  }
  await act("/api/battle/deploy", { uid, column });
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
  if (!info) return;
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

function renderAdventure() {
  const adventure = state.adventure;
  if (!adventure) {
    render();
    return;
  }
  $("adventure-view").hidden = false;
  $("targets").innerHTML = adventure.targets.length
    ? adventure.targets.map((card) => `
        <div class="target${adventureTarget && adventureTarget.cardId === card.cardId ? " selected" : ""}" data-card="${esc(card.cardId)}">
          <div class="target-name">${esc(card.name)} <small>Lv.${card.level}</small></div>
          <div class="target-meta">攻击 ${card.atk}　生命 ${card.hp}</div>
          <div class="target-meta">${card.atkBonus || card.hpBonus ? `改造：攻击 +${card.atkBonus || 0} / 生命 +${card.hpBonus || 0}` : "暂无改造"}</div>
          <div class="target-actions">
            <button class="target-action" data-card="${esc(card.cardId)}" data-effect="atk">
              攻击 +${adventure.atkBonus}<small>${card.atk} → ${card.atkPreview.atk}</small>
            </button>
            <button class="target-action" data-card="${esc(card.cardId)}" data-effect="hp">
              最大生命 +${adventure.hpBonus}<small>${card.maxHp} → ${card.hpPreview.maxHp}</small>
            </button>
          </div>
        </div>`).join("")
    : "<p class='hint'>没有可强化的单位。</p>";

  const preview = $("adventure-preview");
  if (adventureTarget && adventureEffect) {
    preview.hidden = false;
    const next = adventureEffect === "atk" ? adventureTarget.atkPreview : adventureTarget.hpPreview;
    const detail = adventureEffect === "atk"
      ? `攻击 ${adventureTarget.atk} → ${next.atk}`
      : `最大生命 ${adventureTarget.maxHp} → ${next.maxHp}`;
    $("preview-text").textContent = `${adventureTarget.name}：${detail}（仅本趟冒险保留）`;
  } else {
    preview.hidden = true;
  }
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
    if (!card || card.type !== "unit") {
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
    if (draggingUid != null && !dragDropped) showToast("未部署：请把单位放到己方空列");
    clearDragState();
  });

  $("player-row").addEventListener("dragover", (event) => {
    if (draggingUid == null) return;
    const info = slotInfo(event);
    if (!info) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    document.querySelectorAll("#player-row .slot.drop-hover").forEach((slot) => slot.classList.remove("drop-hover"));
    const slot = event.target.closest(".slot");
    if (slot?.classList.contains("drop-ok")) slot.classList.add("drop-hover");
  });
  $("player-row").addEventListener("dragleave", (event) => {
    const slot = event.target.closest(".slot");
    if (slot) slot.classList.remove("drop-hover");
  });
  $("player-row").addEventListener("drop", (event) => {
    const info = slotInfo(event);
    if (!info || draggingUid == null) return;
    event.preventDefault();
    dragDropped = true;
    const uid = draggingUid;
    clearDragState();
    deployFromDrag(uid, info.column);
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
    if (!button || !state.adventure) return;
    adventureTarget = state.adventure.targets.find((card) => card.cardId === button.dataset.card) || null;
    adventureEffect = button.dataset.effect;
    renderAdventure();
  });
  $("adventure-confirm").addEventListener("click", () => {
    if (!adventureTarget || !adventureEffect) return;
    const cardId = adventureTarget.cardId;
    const effect = adventureEffect;
    adventureTarget = null;
    adventureEffect = null;
    act("/api/adventure/apply", { cardId, effect });
  });
  $("adventure-cancel").addEventListener("click", () => {
    adventureTarget = null;
    adventureEffect = null;
    renderAdventure();
  });
  $("adventure-leave").addEventListener("click", () => act("/api/adventure/leave", {}));

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
