/**
 * 浏览器冒烟测试：node tests/ui_smoke.js（需要先启动服务，以及本机 Edge）。
 * 通过 CDP 驱动无头 Edge：注册 → 剧情 → 战斗 → 部署 → 连续结束回合触发弃牌 → 完成弃牌。
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
    await waitFor(
      async () => !(await evaluate("document.getElementById('game').hidden")),
      "注册后进入游戏"
    );
    await waitFor(
      async () => !(await evaluate("document.getElementById('story-view').hidden")),
      "前置剧情显示"
    );
    await screenshot("ai-game-story.png");
    console.log("ok 注册与剧情界面");

    await evaluate("document.getElementById('story-next').click(); true;");
    await waitFor(
      async () =>
        !(await evaluate("document.getElementById('battle-view').hidden")) &&
        (await evaluate("document.querySelectorAll('#hand .card').length")) > 0,
      "战斗界面载入"
    );
    await screenshot("ai-game-battle.png");
    console.log("ok 进入战斗界面");

    async function deployAll() {
      for (let index = 0; index < 6; index += 1) {
        const handBefore = await evaluate("document.querySelectorAll('#hand .card').length");
        const clicked = await evaluate(`(() => {
          const energy = Number(document.getElementById('energy').textContent);
          const cards = [...document.querySelectorAll('#hand .card[data-type="unit"]')];
          const empty = [...document.querySelectorAll('#player-row .slot.empty')].pop();
          const card = cards.find((element) => Number(element.querySelector('.card-cost').textContent) <= energy);
          if (!card || !empty) return false;
          card.click();
          const target = [...document.querySelectorAll('#player-row .slot.empty')].pop();
          if (!target) return false;
          target.click();
          return true;
        })()`);
        if (!clicked) break;
        await waitFor(
          async () => (await evaluate("document.querySelectorAll('#hand .card').length")) < handBefore,
          "单位部署"
        );
      }
      return (await evaluate("document.querySelectorAll('#player-row .slot.unit').length")) > 0;
    }

    if (!(await deployAll())) throw new Error("第一回合没有部署成功");
    console.log("ok 点击卡牌并在空列部署单位");

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
    if (!resultShown) {
      resultShown = await evaluate("!document.getElementById('result-panel').hidden");
    }
    if (!resultShown) throw new Error("战斗没有在预期回合内结束");
    if ((await evaluate("document.getElementById('result-title').textContent")) !== "战斗胜利") {
      throw new Error(`预期战斗胜利，实际：${await evaluate("document.getElementById('result-title').textContent")}`);
    }
    await screenshot("ai-game-result.png");
    console.log("ok 结束回合直到战斗结算");

    await evaluate("document.getElementById('result-action').click(); true;");
    await waitFor(
      async () => !(await evaluate("document.getElementById('story-view').hidden")),
      "战斗后剧情"
    );
    await screenshot("ai-game-after-battle.png");
    console.log("ok 结果确认后进入后日谈");

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
