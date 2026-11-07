/**
 * 浏览器冒烟测试：node tests/ui_smoke.js（需要先启动服务，以及本机 Edge）。
 * 通过 CDP 驱动无头 Edge：注册 → 拖放部署 → 战斗 1 → 剧情选项 → 关卡选择 →
 * 信号/校准/漂流卡匣 → 战斗 2 → 逐列预告与键盘部署；并检查窄窗口滚动。
 */

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8099";
const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "ai-game-edge-"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(120);
  }
  throw new Error(`超时：${label}${lastError ? ` (${lastError.message})` : ""}`);
}

async function main() {
  const edge = spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      return response.ok;
    }, "浏览器调试端口");

    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("没有可用的页面目标");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("CDP WebSocket 连接失败"));
    });

    let nextId = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    };

    function command(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`${method} 超时`));
          }
        }, 15000);
      });
    }

    async function evaluate(expression) {
      const result = await command("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "页面脚本异常");
      }
      return result.result.value;
    }

    async function screenshot(name) {
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      const file = path.join(os.tmpdir(), name);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`截图 ${file}`);
    }

    async function visible(id) {
      return !(await evaluate(`document.getElementById(${JSON.stringify(id)}).hidden`));
    }

    async function click(selector) {
      const ok = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element || element.disabled) return false;
        element.click();
        return true;
      })()`);
      if (!ok) throw new Error(`无法点击 ${selector}`);
    }

    await command("Page.enable");
    await command("Runtime.enable");
    await command("Page.navigate", { url: BASE });
    await waitFor(
      async () => (await evaluate("document.readyState")) === "complete",
      "页面加载"
    );
    await waitFor(async () => !(await evaluate("document.getElementById('auth').hidden")), "登录页显示");
    await screenshot("ai-game-login.png");

    const username = "ui" + Date.now().toString(36);
    await evaluate(`
      document.getElementById('username').value = ${JSON.stringify(username)};
      document.getElementById('password').value = 'test-pass-123';
      document.getElementById('register-btn').click();
      true;
    `);
    await waitFor(async () => await visible("game"), "注册后进入游戏");
    await waitFor(async () => await visible("story-view"), "前置剧情显示");
    console.log("ok 注册与剧情界面");

    await command("Emulation.setDeviceMetricsOverride", {
      width: 760,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(300);
    const storyOverflow = await evaluate("document.documentElement.scrollWidth > window.innerWidth + 1");
    if (storyOverflow) throw new Error("窄窗口剧情界面出现横向溢出");
    await screenshot("ai-game-story-narrow.png");
    await command("Emulation.clearDeviceMetricsOverride");
    await sleep(200);
    console.log("ok 窄窗口下剧情与跳过按钮布局");

    await click("#story-next");
    await waitFor(
      async () => (await visible("battle-view")) &&
        (await evaluate("document.querySelectorAll('#hand .card').length")) > 0,
      "战斗界面载入"
    );
    console.log("ok 进入战斗界面");

    const interaction = await evaluate(`(() => {
      const cardSelect = getComputedStyle(document.querySelector('#hand .card')).userSelect;
      const slotSelect = getComputedStyle(document.querySelector('#player-row .slot')).userSelect;
      const energy = Number(document.getElementById('energy').textContent);
      const hand = document.querySelectorAll('#hand .card').length;
      const units = document.querySelectorAll('#player-row .slot.unit').length;
      const unit = [...document.querySelectorAll('#hand .card[data-type="unit"]')]
        .find((element) => Number(element.querySelector('.card-cost').textContent) <= energy);
      if (!unit) return { skip: true };
      unit.click();
      const empty = document.querySelector('#player-row .slot.empty');
      if (!empty) return { skip: true };
      empty.click();
      return {
        skip: false, cardSelect, slotSelect, energy, hand, units,
        selected: document.querySelectorAll('#hand .card.selected').length,
        toast: document.getElementById('toast').textContent,
      };
    })()`);
    if (interaction.skip) throw new Error("没有可用于点击部署测试的单位牌或空列");
    if (interaction.cardSelect !== "none" || interaction.slotSelect !== "none") {
      throw new Error(`拖动时不应选中文字：${JSON.stringify(interaction)}`);
    }
    await sleep(200);
    const clickAfter = await evaluate(`({
      energy: Number(document.getElementById('energy').textContent),
      hand: document.querySelectorAll('#hand .card').length,
      units: document.querySelectorAll('#player-row .slot.unit').length,
      toast: document.getElementById('toast').textContent,
    })`);
    if (clickAfter.energy !== interaction.energy || clickAfter.hand !== interaction.hand ||
        clickAfter.units !== interaction.units || !clickAfter.toast.includes("请拖动单位牌")) {
      throw new Error(`点击卡牌再点空列不应部署：${JSON.stringify({ interaction, clickAfter })}`);
    }
    await evaluate("document.querySelector('#hand .card.selected').click(); true;");
    console.log("ok 鼠标点击卡牌再点空列不会部署，拖动不会选中文字");

    const drag = await evaluate(`(() => {
      const energy = Number(document.getElementById('energy').textContent);
      const card = [...document.querySelectorAll('#hand .card[data-type="unit"]')]
        .map((element) => ({ element, cost: Number(element.querySelector('.card-cost').textContent) }))
        .filter((item) => item.cost <= energy)
        .sort((a, b) => a.cost - b.cost)[0]?.element;
      const slot = document.querySelector('#player-row .slot.empty');
      if (!card || !slot) return { ok: false };
      const data = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      return {
        ok: true,
        uid: Number(card.dataset.uid),
        column: Number(slot.dataset.column),
        highlighted: document.querySelectorAll('#player-row .slot.drop-ok').length,
        hand: document.querySelectorAll('#hand .card').length,
      };
    })()`);
    if (!drag.ok) throw new Error("没有可拖动的单位牌或空列");
    if (drag.highlighted !== 4) throw new Error(`可放置空列应高亮 4 个，实际 ${drag.highlighted}`);
    await screenshot("ai-game-drag-state.png");
    console.log("ok 拖动时高亮己方空列");

    const dropped = await evaluate(`(() => {
      const card = document.querySelector('#hand .card[data-uid="${drag.uid}"]');
      const slot = document.querySelector('#player-row .slot[data-column="${drag.column}"]');
      if (!card || !slot) return false;
      const data = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      slot.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      slot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
      return true;
    })()`);
    if (!dropped) throw new Error("拖放事件发送失败");
    await waitFor(
      async () => (await evaluate("document.querySelectorAll('#player-row .slot.unit').length")) > 0,
      "拖放部署成功"
    );
    console.log("ok 单位牌拖放到己方空列");

    const occupiedDrop = await evaluate(`(() => {
      const energy = Number(document.getElementById('energy').textContent);
      const hand = document.querySelectorAll('#hand .card').length;
      const card = [...document.querySelectorAll('#hand .card[data-type="unit"]')]
        .find((element) => Number(element.querySelector('.card-cost').textContent) <= energy);
      const slot = document.querySelector('#player-row .slot.unit');
      if (!card || !slot) return { skip: true };
      const data = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      slot.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      const hovered = document.querySelectorAll('#player-row .slot.drop-hover').length;
      slot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
      return { skip: false, energy, hand, hovered };
    })()`);
    if (occupiedDrop.skip) throw new Error("没有可用于占用列测试的单位牌");
    await sleep(300);
    const occupiedAfter = await evaluate(`({
      energy: Number(document.getElementById('energy').textContent),
      hand: document.querySelectorAll('#hand .card').length,
      toast: document.getElementById('toast').textContent,
    })`);
    if (occupiedAfter.energy !== occupiedDrop.energy || occupiedAfter.hand !== occupiedDrop.hand) {
      throw new Error(`拖到占用列不应改变手牌或能量：${JSON.stringify({ occupiedDrop, occupiedAfter })}`);
    }
    if (occupiedDrop.hovered !== 0 || !occupiedAfter.toast.includes("单位只能部署")) {
      throw new Error(`占用列缺少反馈：${JSON.stringify({ occupiedDrop, occupiedAfter })}`);
    }
    console.log("ok 拖到占用列不会部署并给出反馈");

    const outsideDrop = await evaluate(`(() => {
      const energy = Number(document.getElementById('energy').textContent);
      const hand = document.querySelectorAll('#hand .card').length;
      const card = [...document.querySelectorAll('#hand .card[data-type="unit"]')]
        .find((element) => Number(element.querySelector('.card-cost').textContent) <= energy);
      const slot = document.querySelector('#enemy-row .slot');
      if (!card || !slot) return { skip: true };
      const data = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      slot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
      return { skip: false, energy, hand };
    })()`);
    if (outsideDrop.skip) throw new Error("没有可用于无效区域测试的单位牌");
    await sleep(300);
    const outsideAfter = await evaluate(`({
      energy: Number(document.getElementById('energy').textContent),
      hand: document.querySelectorAll('#hand .card').length,
      toast: document.getElementById('toast').textContent,
    })`);
    if (outsideAfter.energy !== outsideDrop.energy || outsideAfter.hand !== outsideDrop.hand) {
      throw new Error(`拖到敌方区域不应改变手牌或能量：${JSON.stringify({ outsideDrop, outsideAfter })}`);
    }
    if (!outsideAfter.toast.includes("单位只能部署")) throw new Error(`拖到无效区域缺少反馈：${outsideAfter.toast}`);
    console.log("ok 拖到无效区域不会部署并给出反馈");

    await deployAll();
    const energyDrop = await evaluate(`(() => {
      const energy = Number(document.getElementById('energy').textContent);
      const hand = document.querySelectorAll('#hand .card').length;
      const card = [...document.querySelectorAll('#hand .card[data-type="unit"]')]
        .find((element) => Number(element.querySelector('.card-cost').textContent) > energy);
      const slot = document.querySelector('#player-row .slot.empty');
      if (!card || !slot) return { skip: true, energy, hand };
      const data = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      const highlighted = document.querySelectorAll('#player-row .slot.drop-ok').length;
      const toastBefore = document.getElementById('toast').textContent;
      slot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
      return { skip: false, energy, hand, highlighted, toastBefore };
    })()`);
    if (energyDrop.skip) throw new Error(`能量不足测试缺少单位牌或空列：${JSON.stringify(energyDrop)}`);
    await sleep(300);
    const energyAfter = await evaluate(`({
      energy: Number(document.getElementById('energy').textContent),
      hand: document.querySelectorAll('#hand .card').length,
      toast: document.getElementById('toast').textContent,
    })`);
    if (energyDrop.highlighted !== 0 || !energyDrop.toastBefore.includes("能量不足")) {
      throw new Error(`能量不足时不应高亮可放置列：${JSON.stringify({ energyDrop, energyAfter })}`);
    }
    if (energyAfter.energy !== energyDrop.energy || energyAfter.hand !== energyDrop.hand) {
      throw new Error(`能量不足时不应改变手牌或能量：${JSON.stringify({ energyDrop, energyAfter })}`);
    }
    if (!energyAfter.toast.includes("能量不足")) {
      throw new Error(`能量不足缺少反馈：${energyAfter.toast}`);
    }
    console.log("ok 能量不足时拖放不会部署并给出反馈");

    const turnBeforeCommand = await evaluate("document.getElementById('turn').textContent");
    await click("#end-turn");
    await waitFor(async () => {
      const turn = await evaluate("document.getElementById('turn').textContent");
      return turn !== turnBeforeCommand && !(await evaluate("!document.getElementById('result-panel').hidden"));
    }, "等待技能测试回合");
    await waitFor(
      async () => (await evaluate("document.querySelectorAll('#enemy-row .slot.unit').length")) > 0,
      "敌方单位部署"
    );

    const repairBefore = await evaluate(`({
      energy: Number(document.getElementById('energy').textContent),
      hand: document.querySelectorAll('#hand .card').length,
      dragging: (() => {
        const card = [...document.querySelectorAll('#hand .card[data-type="command"]')]
          .find((element) => element.querySelector('.card-name').textContent.includes("紧急维修"));
        if (!card) return null;
        const data = new DataTransfer();
        card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
        return document.querySelectorAll('#hand .card.dragging').length;
      })(),
    })`);
    if (repairBefore.dragging !== 1) throw new Error("紧急维修无法开始拖动");
    const repairDrop = await evaluate(`(() => {
      const card = [...document.querySelectorAll('#hand .card[data-type="command"]')]
        .find((element) => element.querySelector('.card-name').textContent.includes("紧急维修"));
      const target = document.querySelector('#enemy-row .slot[data-column="1"]');
      if (!card || !target) return false;
      const data = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
      return true;
    })()`);
    if (!repairDrop) throw new Error("技能牌拖放事件发送失败");
    await sleep(250);
    const repairAfter = await evaluate(`({
      energy: Number(document.getElementById('energy').textContent),
      hand: document.querySelectorAll('#hand .card').length,
      toast: document.getElementById('toast').textContent,
    })`);
    if (repairAfter.energy !== repairBefore.energy || repairAfter.hand !== repairBefore.hand) {
      throw new Error(`维修牌拖到敌方不应结算：${JSON.stringify({ repairBefore, repairAfter })}`);
    }
    if (!repairAfter.toast.includes("紧急维修")) {
      throw new Error(`维修牌拖错目标缺少反馈：${repairAfter.toast}`);
    }

    const spark = await evaluate(`(() => {
      const energy = Number(document.getElementById('energy').textContent);
      const card = [...document.querySelectorAll('#hand .card[data-type="command"]')]
        .find((element) => element.querySelector('.card-name').textContent.includes("闪电脉冲") &&
          Number(element.querySelector('.card-cost').textContent) <= energy);
      const target = document.querySelector('#enemy-row .slot.unit');
      if (!card || !target) return { skip: true };
      const before = {
        energy,
        cost: Number(card.querySelector('.card-cost').textContent),
        hand: document.querySelectorAll('#hand .card').length,
        log: document.getElementById('log').textContent,
        uid: Number(card.dataset.uid),
        column: Number(target.dataset.column),
      };
      const data = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      before.highlighted = document.querySelectorAll('#enemy-row .slot.drop-ok').length;
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
      return { skip: false, before };
    })()`);
    if (spark.skip) throw new Error("第二回合手牌没有可用的闪电脉冲或敌方目标");
    if (spark.before.highlighted < 1) throw new Error("拖动闪电脉冲未高亮敌方单位");
    await waitFor(async () => {
      const energy = await evaluate("Number(document.getElementById('energy').textContent)");
      return energy < spark.before.energy;
    }, "闪电脉冲结算");
    const sparkAfter = await evaluate(`({
      energy: Number(document.getElementById('energy').textContent),
      hand: document.querySelectorAll('#hand .card').length,
      log: document.getElementById('log').textContent,
    })`);
    if (sparkAfter.hand >= spark.before.hand || sparkAfter.energy !== spark.before.energy - spark.before.cost) {
      throw new Error(`闪电脉冲未消耗手牌或能量：${JSON.stringify({ spark, sparkAfter })}`);
    }
    if (!sparkAfter.log.includes("闪电脉冲")) throw new Error(`闪电脉冲未写入战斗日志：${sparkAfter.log}`);
    console.log("ok 紧急维修/闪电脉冲技能牌可拖动并按目标结算");

    async function deployAll() {
      for (let index = 0; index < 6; index += 1) {
        const handBefore = await evaluate("document.querySelectorAll('#hand .card').length");
        const deployed = await evaluate(`(() => {
          const energy = Number(document.getElementById('energy').textContent);
          const empty = [...document.querySelectorAll('#player-row .slot.empty')].pop();
          const card = [...document.querySelectorAll('#hand .card[data-type="unit"]')]
            .find((element) => Number(element.querySelector('.card-cost').textContent) <= energy);
          if (!card || !empty) return false;
          const data = new DataTransfer();
          card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
          empty.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
          empty.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
          card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
          return true;
        })()`);
        if (!deployed) break;
        await waitFor(
          async () => (await evaluate("document.querySelectorAll('#hand .card').length")) < handBefore,
          "单位部署"
        );
      }
      return (await evaluate("document.querySelectorAll('#player-row .slot.unit').length")) > 0;
    }

    async function winBattle() {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        let resultShown = false;
        for (let index = 0; index < 25; index += 1) {
          if (await evaluate("!document.getElementById('result-panel').hidden")) {
            resultShown = true;
            break;
          }
          await deployAll();
          if (await evaluate("!document.getElementById('result-panel').hidden")) {
            resultShown = true;
            break;
          }
          const before = await evaluate("document.getElementById('turn').textContent");
          await evaluate("document.getElementById('end-turn').click(); true;");
          await waitFor(async () => {
            const resultOpen = await evaluate("!document.getElementById('result-panel').hidden");
            const turn = await evaluate("document.getElementById('turn').textContent");
            return resultOpen || turn !== before;
          }, `第 ${index + 1} 次结束回合`);
        }
        if (!resultShown) throw new Error("战斗没有在预期回合内结束");
        const title = await evaluate("document.getElementById('result-title').textContent");
        if (title === "战斗胜利") return;
        await click("#result-action");
        await waitFor(
          async () => await evaluate("document.getElementById('result-panel').hidden"),
          "重试战斗"
        );
      }
      throw new Error("多次重试仍未获胜");
    }

    await winBattle();
    const overDrag = await evaluate(`(() => {
      const card = document.querySelector('#hand .card[data-type="unit"]');
      if (!card) return { skip: true };
      const data = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      return {
        skip: false,
        draggable: card.getAttribute('draggable'),
        dragging: document.querySelectorAll('.card.dragging').length,
        highlighted: document.querySelectorAll('#player-row .slot.drop-ok').length,
      };
    })()`);
    if (!overDrag.skip && (
      overDrag.draggable !== "false" || overDrag.dragging !== 0 || overDrag.highlighted !== 0
    )) {
      throw new Error(`战斗结束后不应允许拖放：${JSON.stringify(overDrag)}`);
    }
    await screenshot("ai-game-result.png");
    console.log("ok 战斗 1 胜利，结束后拖放被禁用");

    await click("#result-action");
    await waitFor(async () => await visible("story-view"), "战斗后剧情");
    await click("#story-next");
    await waitFor(
      async () => (await evaluate("document.querySelectorAll('#story-options .story-option').length")) === 2,
      "剧情选项"
    );
    await screenshot("ai-game-story-options.png");
    await click('.story-option[data-option="battle1_signal"]');
    await waitFor(
      async () => (await evaluate("document.querySelectorAll('#story-options .story-option').length")) === 0,
      "选项确认"
    );
    await click("#story-next");
    await waitFor(async () => await visible("map-view"), "关卡选择界面");
    await screenshot("ai-game-map.png");
    console.log("ok 剧情选项后进入关卡选择");

    await command("Emulation.setDeviceMetricsOverride", {
      width: 760,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(300);
    const overflow = await evaluate("document.documentElement.scrollWidth > window.innerWidth + 1");
    if (overflow) throw new Error("窄窗口出现横向溢出");
    await screenshot("ai-game-map-narrow.png");
    await command("Emulation.clearDeviceMetricsOverride");
    await sleep(200);
    console.log("ok 窄窗口下关卡选择布局");

    await click('.map-node[data-id="signal"]');
    await waitFor(async () => await visible("story-view"), "信号前置剧情");
    const signalStory = await evaluate("document.getElementById('story-text').textContent");
    if (!signalStory.includes("追着这个信号")) throw new Error(`剧情未按标记回应：${signalStory}`);
    await click("#story-next");
    await click("#story-next");
    await waitFor(async () => await visible("signal-view"), "信号奇遇界面");
    await click('.signal-action[data-action="upgrade"]');
    await waitFor(
      async () => (await evaluate("document.querySelectorAll('#signal-targets .target').length")) > 0,
      "信号目标"
    );
    await click('#signal-targets .target[data-card="striker"]');
    await waitFor(async () => await visible("signal-preview"), "信号预览");
    await screenshot("ai-game-signal-preview.png");
    await click("#signal-confirm");
    await waitFor(async () => await visible("story-view"), "信号后剧情");
    await click("#story-next");
    await waitFor(async () => await visible("map-view"), "信号后选关");
    await click('.map-node[data-id="calibration"]');
    await waitFor(async () => await visible("story-view"), "校准前置剧情");
    await click("#story-next");
    await waitFor(async () => await visible("adventure-view"), "校准界面");
    const calibrationTitle = await evaluate("document.getElementById('adventure-title').textContent");
    if (calibrationTitle !== "校准平台") throw new Error(`校准界面标题错误：${calibrationTitle}`);
    await click('.target-action[data-card="striker"][data-effect="hp"]');
    await waitFor(async () => await visible("adventure-preview"), "校准预览");
    const calibrationPreview = await evaluate("document.getElementById('preview-text').textContent");
    if (!calibrationPreview.includes("最大生命")) throw new Error(`校准预览错误：${calibrationPreview}`);
    await screenshot("ai-game-calibration-preview.png");
    await click("#adventure-confirm");
    await waitFor(async () => await visible("story-view"), "校准后剧情");
    await click("#story-next");
    await waitFor(async () => await visible("map-view"), "校准后选关");
    await click('.map-node[data-id="drift_capsule"]');
    await waitFor(async () => await visible("story-view"), "卡匣前置剧情");
    await click("#story-next");
    await waitFor(async () => await visible("drift-view"), "漂流卡匣界面");
    const cardCount = await evaluate("document.querySelectorAll('#drift-offers .offer').length");
    if (cardCount !== 3) throw new Error(`卡匣应有 3 张候选，实际 ${cardCount}`);
    const goldBeforeReroll = await evaluate("Number(document.getElementById('hud-gold').textContent)");
    await click("#drift-reroll");
    await waitFor(async () => {
      const gold = await evaluate("Number(document.getElementById('hud-gold').textContent)");
      return gold < goldBeforeReroll;
    }, "卡匣重抽扣费");
    const rerollDisabled = await evaluate("document.getElementById('drift-reroll').disabled");
    if (!rerollDisabled) throw new Error("重抽一次后按钮应禁用");
    await screenshot("ai-game-drift.png");
    await click("#drift-offers .offer .buy-btn");
    await waitFor(async () => await visible("story-view"), "卡匣选择后剧情");
    await click("#story-next");
    await waitFor(async () => await visible("map-view"), "卡匣后选关");
    await click('.map-node[data-id="battle2"]');
    await waitFor(async () => await visible("story-view"), "战斗 2 前置剧情");
    await click("#story-next");
    await waitFor(
      async () => (await visible("battle-view")) &&
        (await evaluate("document.querySelectorAll('#hand .card').length")) > 0,
      "战斗 2 界面"
    );
    console.log("ok 信号、校准、漂流卡匣与关卡串联");

    await command("Emulation.setDeviceMetricsOverride", {
      width: 760,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(300);
    const battleOverflow = await evaluate("document.documentElement.scrollWidth > window.innerWidth + 1");
    if (battleOverflow) throw new Error("窄窗口战斗界面出现横向溢出");
    await screenshot("ai-game-battle2-narrow.png");
    await command("Emulation.clearDeviceMetricsOverride");
    await sleep(200);
    console.log("ok 窄窗口下战斗与预告布局");

    const forecast = await evaluate(`(() => {
      const cells = [...document.querySelectorAll('#forecast-row .forecast-cell')];
      return {
        cells: cells.length,
        text: document.getElementById('forecast-row').textContent,
        current: document.querySelectorAll('.forecast-item.current').length,
        next: document.querySelectorAll('.forecast-item.next').length,
      };
    })()`);
    if (forecast.cells !== 4) throw new Error(`预告应固定四列，实际 ${forecast.cells}`);
    if (!forecast.text.includes("防守机偶") || !forecast.text.includes("突击哨兵")) {
      throw new Error(`战斗 2 预告缺少内容：${forecast.text}`);
    }
    if (forecast.current < 1 || forecast.next < 1) {
      throw new Error(`预告应区分当前与下一回合：${JSON.stringify(forecast)}`);
    }
    await screenshot("ai-game-battle2-forecast.png");
    console.log("ok 敌方四列预告区分当前与下一回合");

    const keyboard = await evaluate(`(() => {
      const energy = Number(document.getElementById('energy').textContent);
      const card = [...document.querySelectorAll('#hand .card[data-type="unit"]')]
        .find((element) => Number(element.querySelector('.card-cost').textContent) <= energy);
      if (!card) return false;
      card.focus();
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    if (!keyboard) throw new Error("没有可用键盘选择的单位");
    await waitFor(
      async () => (await evaluate("document.querySelectorAll('#hand .card.selected').length")) === 1,
      "键盘选择单位"
    );
    const keyboardDeploy = await evaluate(`(() => {
      const slot = document.querySelector('#player-row .slot.empty');
      if (!slot) return false;
      slot.focus();
      slot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    if (!keyboardDeploy) throw new Error("没有可用键盘部署的空列");
    await waitFor(
      async () => (await evaluate("document.querySelectorAll('#player-row .slot.unit').length")) > 0,
      "键盘部署"
    );
    console.log("ok 键盘选择单位并部署");

    const beforeTurn = await evaluate("document.getElementById('turn').textContent");
    await click("#end-turn");
    await waitFor(
      async () => (await evaluate("document.getElementById('turn').textContent")) !== beforeTurn,
      "结束回合"
    );
    const nextForecast = await evaluate("document.getElementById('forecast-row').textContent");
    if (nextForecast.includes("防守机偶") || !nextForecast.includes("突击哨兵")) {
      throw new Error(`下一回合预告不正确：${nextForecast}`);
    }
    await screenshot("ai-game-battle2-next-turn.png");
    console.log("ok 进入下一回合后预告更新");

    ws.close();
    console.log("浏览器冒烟测试全部通过");
  } finally {
    try {
      execFileSync("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
    } catch (_) {
      /* 浏览器可能已退出 */
    }
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true });
    } catch (_) {
      /* 临时目录可能仍被占用 */
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
