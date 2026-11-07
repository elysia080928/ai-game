"use strict";

const $ = (id) => document.getElementById(id);

let state = null;
let battle = null;
let username = "";
let selectedUid = null;
let recycleMode = false;
let discardSelection = new Set();
let adventureTarget = null;
let busy = false;
let loadingBattle = false;
let toastTimer = null;

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
  ["story-view", "battle-view", "recruit-view", "adventure-view", "complete-view"].forEach((id) => {
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
  } else if (state.node) {
    $("hud-node").textContent = `${state.node.name}（${state.nodeIndex + 1}/${state.totalNodes}）`;
  } else {
    $("hud-node").textContent = "";
  }

  hideViews();
  if (state.complete) {
    $("complete-view").hidden = false;
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
  if (state.node && state.node.type === "adventure") {
    renderAdventure();
  }
}

/* ---------- 剧情 ---------- */

function renderStory() {
  const story = state.story;
  if (!story) {
    render();
    return;
  }
  $("story-view").hidden = false;
  $("story-node").textContent = `${state.node.name} · ${state.phase === "after_story" ? "后日谈" : "前日谈"}`;
  $("story-speaker").textContent = story.speaker;
  $("story-text").textContent = story.text;
  $("story-progress").textContent = `${story.line} / ${story.total}`;
}

async function advanceStory(skip) {
  try {
    const data = await api("/api/story/advance", { skip });
    apply(data);
  } catch (error) {
    showToast(error.message);
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
  if (!unit) {
    return `<div class="slot empty" data-side="${side}" data-column="${column}"><span>空列</span></div>`;
  }
  return `<div class="slot unit ${side}" data-side="${side}" data-column="${column}" data-uid="${unit.uid}">
      <div class="unit-name">${esc(unit.name)}</div>
      <div class="unit-stats"><span class="atk">⚔ ${unit.atk}</span><span class="hp">❤ ${unit.hp}/${unit.maxHp}</span></div>
    </div>`;
}

function cardHtml(card, selected) {
  const stats = card.type === "unit"
    ? `⚔ ${card.atk}　❤ ${card.hp}`
    : esc(card.effectText || (card.heal != null ? `恢复 ${card.heal}` : card.damage != null ? `造成 ${card.damage} 伤害` : ""));
  return `<div class="card${selected ? " selected" : ""}" data-uid="${card.uid}" data-type="${card.type}">
      <div class="card-cost">${card.cost}</div>
      <div class="card-name">${esc(card.name)}</div>
      <div class="card-stats">${stats}</div>
      <div class="card-level">Lv.${card.level}</div>
    </div>`;
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

  const forecast = battle.forecast || [];
  $("forecast").innerHTML = forecast.length
    ? forecast.map((item) => `<span class="chip">回合 ${item.turn} · ${item.column} 列 · ${esc(item.name)}</span>`).join("")
    : "<span class='chip muted'>敌方暂无后续部署</span>";

  $("enemy-row").innerHTML = battle.board.enemy.map((unit, index) => unitHtml(unit, "enemy", index + 1)).join("");
  $("player-row").innerHTML = battle.board.player.map((unit, index) => unitHtml(unit, "player", index + 1)).join("");

  $("hand").innerHTML = battle.hand.length
    ? battle.hand.map((card) => cardHtml(card, card.uid === selectedUid)).join("")
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

async function onSlotClick(event) {
  const slot = event.target.closest(".slot");
  if (!slot || !battle || busy) return;
  if (battle.phase !== "player") return;
  const side = slot.dataset.side;
  const column = Number(slot.dataset.column);
  const uid = slot.dataset.uid ? Number(slot.dataset.uid) : null;

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

/* ---------- 奇遇 ---------- */

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
          <div class="target-meta">强化后攻击 ${card.atk + adventure.attackBonus}</div>
        </div>`).join("")
    : "<p class='hint'>没有可强化的单位。</p>";

  const preview = $("adventure-preview");
  if (adventureTarget) {
    preview.hidden = false;
    $("preview-text").textContent = `${adventureTarget.name}：攻击 ${adventureTarget.atk} → ${adventureTarget.atk + adventure.attackBonus}（仅本趟冒险保留）`;
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

  $("end-turn").addEventListener("click", () => act("/api/battle/end", {}));
  $("recycle-btn").addEventListener("click", () => {
    recycleMode = !recycleMode;
    if (recycleMode) selectedUid = null;
    renderBattle();
  });
  $("player-row").addEventListener("click", onSlotClick);
  $("enemy-row").addEventListener("click", onSlotClick);

  $("hand").addEventListener("click", (event) => {
    const element = event.target.closest(".card");
    if (!element || !battle || battle.phase !== "player" || busy) return;
    const uid = Number(element.dataset.uid);
    selectedUid = selectedUid === uid ? null : uid;
    if (selectedUid != null) recycleMode = false;
    renderBattle();
  });

  $("discard-hand").addEventListener("click", (event) => {
    const element = event.target.closest(".card");
    if (!element) return;
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

  $("targets").addEventListener("click", (event) => {
    const element = event.target.closest(".target");
    if (!element || !state.adventure) return;
    adventureTarget = state.adventure.targets.find((card) => card.cardId === element.dataset.card) || null;
    renderAdventure();
  });
  $("adventure-confirm").addEventListener("click", () => {
    if (!adventureTarget) return;
    const cardId = adventureTarget.cardId;
    adventureTarget = null;
    act("/api/adventure/choose", { cardId });
  });
  $("adventure-cancel").addEventListener("click", () => {
    adventureTarget = null;
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
