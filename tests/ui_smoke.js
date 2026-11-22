/**
 * 浏览器冒烟测试：node tests/ui_smoke.js（需要先启动服务，以及本机 Edge）。
 * MAP_UI_ONLY=1 仅检查三章地图的四种窗口尺寸和地图菜单操作。
 * MOBILE_UI_ONLY=1 使用触摸输入检查手机旋转、教学、部署、弃牌与存档恢复。
 * 通过 CDP 驱动无头 Edge：注册 → 标题/存档/设置 → 拖放/技能/宽体部署 → 随机地图与刷新持久化 →
 * 精英路线与三选一奖励；并检查桌面、窄窗与手机布局。
 */

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8099";
const BROWSER = process.env.BROWSER_PATH
  || process.env.EDGE_PATH
  || process.env.CHROME_PATH
  || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "ai-game-browser-"));

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
  const browser = spawn(
    BROWSER,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
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
    let dialogResolver = null;
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Page.javascriptDialogOpening" && dialogResolver) {
        dialogResolver();
        dialogResolver = null;
      }
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    };

    function command(method, params = {}, timeout = 15000) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`${method} 超时`));
          }
        }, timeout);
      });
    }

    async function evaluate(expression, timeout = 15000) {
      const result = await command("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }, timeout);
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "页面脚本异常");
      }
      return result.result.value;
    }

    async function finishStoryText() {
      await evaluate("if (state.story) finishStoryTyping(); true;");
    }

    async function advanceVisibleStory() {
      const optionsVisible = await evaluate(
        "!document.getElementById('story-options').hidden && document.querySelectorAll('#story-options .story-option').length > 0"
      );
      if (optionsVisible) await click("#story-options .story-option");
      else {
        await click("#story-panel");
      }
    }

    let storySkipVerified = false;
    async function storyUntil(viewId) {
      for (let index = 0; index < 64; index += 1) {
        if (await visible(viewId)) return;
        if (await visible("transition-view")) {
          await command("Page.setWebLifecycleState", { state: "active" });
          await command("Page.bringToFront");
          await waitFor(() => evaluate("document.visibilityState === 'visible'"), "转场时浏览器页面可见");
          const transition = await evaluate(`(() => {
            const view = document.getElementById('transition-view').getBoundingClientRect();
            const frame = document.getElementById('transition-frame');
            const rect = frame.getBoundingClientRect();
            return {target: state.transitionTarget, src: frame.src,
              fullScreen: view.left === 0 && view.top === 0 && view.width === innerWidth && view.height === innerHeight &&
                rect.left === 0 && rect.top === 0 && rect.width === innerWidth && rect.height === innerHeight,
              topbarHidden: getComputedStyle(document.querySelector('#game > .topbar')).display === 'none',
              otherViewsHidden: [...document.querySelectorAll('.stage > .view:not(#transition-view)')].every((view) => view.hidden)};
          })()`);
          const expected = { map: "clip-01", map2: "clip-02", map3: "clip-04", complete: "clip-03" }[transition.target];
          if (!expected || !transition.src.includes(expected + ".html") || !transition.fullScreen ||
              !transition.topbarHidden || !transition.otherViewsHidden) {
            throw new Error(`转场映射或全屏遮挡异常：${JSON.stringify(transition)}`);
          }
          try {
            await waitFor(async () => {
              const finished = await evaluate("state.phase !== 'transition' || !document.getElementById('transition-error').hidden");
              if (!finished && await evaluate("document.visibilityState !== 'visible'")) {
                await command("Page.setWebLifecycleState", { state: "active" });
                await command("Page.bringToFront");
              }
              return finished;
            }, `${expected} 播放结束`, 12000);
          } catch (error) {
            const details = await evaluate(`(() => {
              const frame = document.getElementById('transition-frame');
              const doc = frame.contentDocument;
              return {phase:state.phase, status:transitionStatus, time:frame.contentWindow.seaGate?.time,
                duration:frame.contentWindow.seaGate?.duration, visibility:doc.visibilityState, hidden:doc.hidden,
                canvas:doc.getElementById('stage')?.getBoundingClientRect().toJSON(), token:transitionToken};
            })()`);
            throw new Error(`${error.message} ${JSON.stringify(details)}`);
          }
          if (await visible("transition-error")) throw new Error(await evaluate("document.getElementById('transition-error-text').textContent"));
          continue;
        }
        const canVerifySkip = !storySkipVerified && await evaluate(
          "state.phase === 'after_story' && state.story?.line === 1 && state.story?.total > 1"
        );
        if (canVerifySkip) {
          storySkipVerified = true;
          const oldLine = await evaluate("state.story.line");
          await click("#story-skip");
          await waitFor(() => evaluate(
            `!busy && (state.phase !== 'after_story' || !state.story || state.story.line > ${oldLine})`
          ), "跳过剧情段落");
          const hasOptions = await evaluate("!!state.story?.options?.length");
          if (hasOptions) {
            await finishStoryText();
            const optionState = await evaluate(`({
              visible: !document.getElementById('story-options').hidden,
              skipDisabled: document.getElementById('story-skip').disabled,
              line: state.story.line,
            })`);
            if (!optionState.visible || !optionState.skipDisabled) throw new Error("跳过剧情后没有停在不可跳过的选择项");
            await click("#story-panel");
            if (await evaluate("state.story.line") !== optionState.line) throw new Error("点击剧情画面绕过了待选选项");
          }
        } else {
          await advanceVisibleStory();
        }
        await sleep(250);
      }
      if (!(await visible(viewId))) throw new Error(`剧情未进入 ${viewId}`);
    }

    async function screenshot(name, selector) {
      const clip = selector && await evaluate(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height, scale: 1 };
      })()`);
      const { data } = await command("Page.captureScreenshot", {
        format: "png", optimizeForSpeed: true, ...(clip ? { clip, captureBeyondViewport: true } : {}),
      }, 45000);
      const file = path.join(os.tmpdir(), name);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`截图 ${file}`);
    }

    async function visible(id) {
      return !(await evaluate(`document.getElementById(${JSON.stringify(id)}).hidden`));
    }

    async function waitForStory(label) {
      await waitFor(async () => await visible("story-view") || await visible("opening-cg-view"), label);
      if (!(await visible("opening-cg-view"))) return;
      await waitFor(() => evaluate(`(() => {
        const image = document.querySelector('.opening-cg-image');
        return image.complete && image.naturalWidth > 0;
      })()`), "开场 CG 图片加载");
      const openingCg = await evaluate(`(() => {
        const image = document.querySelector('.opening-cg-image');
        const view = document.getElementById('opening-cg-view').getBoundingClientRect();
        const imageRect = image.getBoundingClientRect();
        const dialogue = document.querySelector('.opening-cg-dialogue').getBoundingClientRect();
        const button = document.getElementById('opening-cg-continue').getBoundingClientRect();
        return {
          loaded: image.complete && image.naturalWidth > 0,
          fit: getComputedStyle(image).objectFit,
          fitsViewport: Math.abs(view.width - innerWidth) < 1 && Math.abs(view.height - innerHeight) < 1 &&
            imageRect.left >= view.left && imageRect.right <= view.right &&
            dialogue.bottom <= view.bottom + 1 && button.bottom <= view.bottom + 1 &&
            document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1,
          track: document.body.dataset.musicTrack,
          cgAsset: [...document.querySelectorAll('audio')].some(audio =>
            audio.dataset.track === 'cg' && audio.src.includes('/assets/music/CG.mp3')),
          looping: [...document.querySelectorAll('audio')].every(audio => audio.loop),
        };
      })()`);
      if (!openingCg.loaded || openingCg.fit !== "contain" || !openingCg.fitsViewport || openingCg.track !== "cg" ||
          !openingCg.cgAsset || !openingCg.looping) {
        throw new Error(`开场 CG 或配乐状态异常：${JSON.stringify(openingCg)}`);
      }
      await assertMusicTrack("cg");
      await click("#opening-cg-continue");
      await waitFor(() => visible("story-view"), `${label}后进入序幕`);
    }

    async function assertMusicTrack(track) {
      await waitFor(() => evaluate(`[...document.querySelectorAll('audio')].some(audio =>
        audio.dataset.track === ${JSON.stringify(track)} && !audio.paused)`), `${track} 背景音乐开始播放`);
      const state = await evaluate(`(() => ({
        track: document.body.dataset.musicTrack,
        assigned: [...document.querySelectorAll('audio')].some(audio => audio.dataset.track === ${JSON.stringify(track)}),
        playing: [...document.querySelectorAll('audio')].some(audio => audio.dataset.track === ${JSON.stringify(track)} && !audio.paused),
        looping: [...document.querySelectorAll('audio')].every(audio => audio.loop),
        volume: [...document.querySelectorAll('audio')].every(audio => Math.abs(audio.volume - Number($('master-volume').value) / 100) < 0.001),
      }))()`);
      if (state.track !== track || !state.assigned || !state.playing || !state.looping || !state.volume) {
        throw new Error(`背景音乐状态异常：${JSON.stringify(state)}，期望 ${track}`);
      }
    }

    async function checkStoryCgBackgrounds() {
      const backgrounds = [
        "cg/篝火星河.png", "black", "cg/林间篝火.png",
        "cg/篝火抱膝.png", "cg/篝火暖手.png",
      ];
      const result = await evaluate(`(() => {
        const savedState = state;
        const scenes = ${JSON.stringify(backgrounds)};
        const details = scenes.map((background) => {
          state = {
            ...savedState,
            phase: 'after_story',
            story: {title:'篝火剧情',speaker:'爱',text:'请输入文本',line:1,total:1,background},
          };
          renderStory();
          const panel = document.getElementById('story-panel');
          const style = getComputedStyle(panel);
          return {
            background,
            className: panel.className,
            image: style.backgroundImage,
            size: style.backgroundSize,
            color: style.backgroundColor,
            portraitHidden: getComputedStyle(document.querySelector('.story-portrait')).display === 'none',
            text: document.getElementById('story-text').getAttribute('aria-label'),
          };
        });
        state = savedState;
        render();
        return details;
      })()`);
      if (result.length !== backgrounds.length || result.some((scene, index) => {
        if (scene.text !== "请输入文本" || !scene.className.includes("story-cg") || !scene.portraitHidden) return true;
        if (scene.background === "black") return scene.image !== "none" || scene.color !== "rgb(0, 0, 0)";
        return !scene.image.includes(encodeURI(scene.background)) || scene.size !== "contain";
      })) {
        throw new Error(`剧情 CG/黑屏页面渲染异常：${JSON.stringify(result)}`);
      }
    }

    async function playClipToEnd(filename) {
      return evaluate(`(async () => {
        const token = crypto.randomUUID();
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:2000';
        document.body.appendChild(frame);
        try {
          return await new Promise((resolve, reject) => {
            const messages = [];
            const finish = (error, result) => {
              clearTimeout(timer);
              window.removeEventListener('message', onMessage);
              error ? reject(error) : resolve(result);
            };
            const onMessage = (event) => {
              if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.token !== token) return;
              messages.push(event.data.type);
              if (event.data.type === 'seagate-transition-error') finish(new Error(event.data.detail));
              if (event.data.type === 'seagate-transition-ended') {
                finish(null, { messages, duration: frame.contentWindow.seaGate?.duration, clip: frame.contentWindow.seaGate?.clip });
              }
            };
            const timer = setTimeout(() => finish(new Error('动画结束通知超时：' + JSON.stringify({
              filename: ${JSON.stringify(filename)}, messages, time: frame.contentWindow.seaGate?.time,
              visibility: frame.contentDocument?.visibilityState,
            }))), 60000);
            window.addEventListener('message', onMessage);
            frame.src = '/assets/transitions/seagate/' + ${JSON.stringify(filename)} + '.html?gameTransition=' + encodeURIComponent(token);
          });
        } finally {
          frame.remove();
        }
      })()`, 65000);
    }

    async function reloadAndContinue(viewId, label) {
      await command("Page.reload", {});
      await waitFor(() => visible("menu-view"), "刷新后标题菜单");
      await click("#continue-btn");
      if (viewId === "story-view") await waitForStory(label);
      else await waitFor(() => visible(viewId), label);
    }

    async function checkResultLayout(outcome, size) {
      const asset = outcome === "win" ? "victory" : "defeat";
      const centers = outcome === "win" ? [[.389, .725], [.617, .725]] : [[.376, .70], [.628, .70]];
      const details = await evaluate(`(async () => {
        const panel = $('result-panel');
        const image = $('result-image');
        await image.decode();
        const viewport = [innerWidth, innerHeight];
        const box = panel.getBoundingClientRect();
        const art = image.getBoundingClientRect();
        const expectedWidth = Math.min(innerWidth, innerHeight * 16 / 9);
        const near = (actual, expected) => Math.abs(actual - expected) < 1;
        const buttons = ['result-action', 'result-return'].map((id, index) => {
          const button = $(id);
          const rect = button.getBoundingClientRect();
          const [x, y] = ${JSON.stringify(centers)}[index];
          return !!button.getAttribute('aria-label') &&
            document.elementFromPoint(art.x + art.width * x, art.y + art.height * y) === button &&
            near(rect.x + rect.width / 2, art.x + art.width * x) &&
            near(rect.y + rect.height / 2, art.y + art.height * y);
        });
        return {
          viewport,
          shell: !panel.hidden && panel.parentElement === $('game') && box.x === 0 && box.y === 0 &&
            near(box.width, innerWidth) && near(box.height, innerHeight) &&
            getComputedStyle(panel).backgroundColor === 'rgb(6, 19, 46)' &&
            [[0, 0], [innerWidth - 1, 0], [0, innerHeight - 1], [innerWidth - 1, innerHeight - 1]]
              .every(([x, y]) => panel.contains(document.elementFromPoint(x, y))),
          art: image.src.endsWith('/battle-result-${asset}.png') && image.naturalWidth / image.naturalHeight === 16 / 9 &&
            near(art.width, expectedWidth) && near(art.height, expectedWidth * 9 / 16) &&
            near(art.left, (innerWidth - art.width) / 2) && near(art.top, (innerHeight - art.height) / 2),
          hidden: ['#game > .topbar', '#battle-view', '#hand-dock'].every((selector) =>
            getComputedStyle(document.querySelector(selector)).visibility === 'hidden'),
          toastHidden: $('toast').hidden,
          overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
          buttons,
        };
      })()`);
      if ((size && size.some((value, index) => value !== details.viewport[index])) ||
          !details.shell || !details.art || !details.hidden || !details.toastHidden || details.overflow || !details.buttons.every(Boolean)) {
        throw new Error(`全屏${asset}结算布局异常：${JSON.stringify(details)}`);
      }
    }

    async function click(selector) {
      if (process.env.MOBILE_UI_ONLY === "1") {
        await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest',inline:'nearest'}); true;`);
        await sleep(240);
        const point = await evaluate(`(() => {
          const element=document.querySelector(${JSON.stringify(selector)});
          if (!element || element.disabled) return null;
          const rect=element.getBoundingClientRect();
          const x=(Math.max(0,rect.left)+Math.min(innerWidth,rect.right))/2;
          const y=(Math.max(0,rect.top)+Math.min(innerHeight,rect.bottom))/2;
          return element.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
        })()`);
        if (!point) {
          await screenshot("ai-game-mobile-blocked.png");
          const details=await evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)}),r=element?.getBoundingClientRect();return {rect:r?.toJSON(),hit:r && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,400),selected:selectedUid,tutorial:battle?.tutorial}})()`);
          throw new Error(`触摸目标被遮挡或不可用：${selector} ${JSON.stringify(details)}`);
        }
        await command("Input.dispatchTouchEvent", {type:"touchStart",touchPoints:[{...point,id:1}]});
        await command("Input.dispatchTouchEvent", {type:"touchEnd",touchPoints:[]});
        await sleep(120);
        return;
      }
      const ok = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element || element.disabled) return false;
        element.click();
        return true;
      })()`);
      if (!ok) throw new Error(`无法点击 ${selector}`);
    }

    async function clickTrusted(selector) {
      const point = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element || element.disabled) return null;
        const rect = element.getBoundingClientRect();
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
      })()`);
      if (!point) throw new Error(`无法真实点击 ${selector}`);
      await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    }

    async function clickDialog(selector, accept) {
      const opened = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          dialogResolver = null;
          reject(new Error(`等待确认框超时：${selector}`));
        }, 15000);
        dialogResolver = () => { clearTimeout(timer); resolve(); };
      });
      const clicked = click(selector);
      await opened;
      await command("Page.handleJavaScriptDialog", { accept });
      await clicked;
    }

    await command("Page.enable");
    await command("Runtime.enable");
    await command("Emulation.setFocusEmulationEnabled", { enabled: true });
    await command("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await command("Page.navigate", { url: BASE });
    await waitFor(
      async () => (await evaluate("document.readyState")) === "complete",
      "页面加载"
    );
    const browserSelection = await evaluate(`(() => ({
      game: getComputedStyle($('game')).userSelect,
      image: getComputedStyle($('story-portrait-image')).webkitUserDrag,
      draggableImages: [...$('game').querySelectorAll('img')].some(image => image.draggable),
    }))()`);
    if (browserSelection.game !== "none" || browserSelection.image !== "none" || browserSelection.draggableImages) {
      throw new Error(`游戏界面仍可蓝框选字或拖动 PNG：${JSON.stringify(browserSelection)}`);
    }
    if (process.env.MOBILE_UI_ONLY === "1") {
      await checkMobileUi();
      ws.close();
      return;
    }
    if (process.env.MAP_UI_ONLY === "1") {
      await checkMapPreviews();
      ws.close();
      return;
    }
    async function checkMobileUi() {
      const sizes=[[667,375],[812,375],[844,390],[896,414],[932,430]];
      const captureMobileLayouts=process.env.MOBILE_SKIP_LAYOUT_SCREENSHOTS!=='1';
      const errors=[];
      await command("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:1});
      await command("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:3,mobile:true});
      await evaluate(`document.getElementById('username').value='mobile_'+Date.now().toString(36);document.getElementById('password').value='mobile-test-123';true;`);
      await click("#register-btn");
      await waitFor(()=>visible("menu-view"),"手机注册与主菜单");
      await command("Emulation.setDeviceMetricsOverride",{width:667,height:375,deviceScaleFactor:2,mobile:true});
      await click("#continue-btn");
      await waitForStory("手机继续冒险");
      for (const [width,height] of sizes) {
        await command("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:2,mobile:true});
        await sleep(250);
        const layout=await evaluate(`({width:innerWidth,height:innerHeight,touch:navigator.maxTouchPoints,coarse:matchMedia('(pointer:coarse)').matches,guard:!document.getElementById('size-guard').hidden||!document.getElementById('orientation-guard').hidden,hidden:getComputedStyle(document.querySelector('.stage')).visibility==='hidden',overflow:document.documentElement.scrollWidth>innerWidth+1})`);
        await screenshot(`ai-game-mobile-story-${width}.png`);
        if (layout.guard||layout.hidden||layout.overflow||!layout.touch||!layout.coarse) errors.push(`${width}x${height}: ${JSON.stringify(layout)}`);
      }
      if(errors.length) throw new Error('手机横屏检查失败：'+errors.join('; '));
      console.log("ok 五种手机横屏尺寸、DPR 2/3 与触屏输入环境");
      await command("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:3,mobile:true});
      await waitFor(()=>visible("orientation-guard"),"手机竖屏旋转提示");
      await screenshot("ai-game-mobile-portrait.png");
      await command("Emulation.setDeviceMetricsOverride",{width:667,height:375,deviceScaleFactor:2,mobile:true});
      await waitFor(()=>evaluate("document.getElementById('orientation-guard').hidden && document.getElementById('size-guard').hidden"),"旋转后恢复游戏");
      await storyUntil("map-view");
      await click("#map-view .map-node:not(:disabled)");
      await storyUntil("battle-view");
      await click("#tutorial-next");
      async function playCard(cardId,side,column) {
        if (!await evaluate("document.getElementById('hand-dock').classList.contains('is-open')")) await click("#hand-toggle");
        const uid=await evaluate(`battle.hand.find(card=>card.cardId===${JSON.stringify(cardId)})?.uid`);
        if(uid==null) throw new Error(`手机手牌缺少 ${cardId}`);
        await click(`#hand [data-uid="${uid}"]`);
        await click(`#${side}-row [data-column="${column}"]`);
        await waitFor(()=>evaluate("!busy"),"手机出牌结算");
      }
      await playCard("shell","player",2);
      await waitFor(()=>evaluate("battle.tutorial?.index===2"),"触屏轻触部署教学单位");
      await click("#end-turn");
      await waitFor(()=>evaluate("battle.tutorial?.index===3 && !busy"),"手机结束回合");
      await reloadAndContinue("battle-view","手机刷新恢复战斗");
      if(!await evaluate("battle.tutorial?.index===3")) throw new Error("手机刷新丢失教学进度");
      await playCard("spark","enemy",2);
      await waitFor(()=>evaluate("battle.tutorial?.index===4 && !busy"),"触屏指令牌命中敌人");
      await click("#tutorial-next");
      await waitFor(()=>evaluate("!battle.tutorial && !busy"),"手机完成教学");
      await playCard("worker","player",4);
      if(!await evaluate("battle.board.player[3]?.cardId==='worker'")) throw new Error("手机自由部署失败");
      console.log("ok 真实触摸点按完成剧情、选关、教学、单位/指令出牌及刷新恢复");
      for(const [width,height] of sizes) {
        await command("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:2,mobile:true});
        await sleep(250);
        const fit=await evaluate(`(() => {const elements=['battle-table','end-turn','hand-toggle'].map(id=>document.getElementById(id));return elements.every(el=>{const r=el.getBoundingClientRect();return getComputedStyle(el).visibility==='visible' && r.top>=0 && r.left>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1}) && document.documentElement.scrollWidth<=innerWidth+1})()`);
        if(captureMobileLayouts) await screenshot(`ai-game-mobile-battle-${width}.png`);
        if(!fit) throw new Error(`手机战斗 ${width}x${height} 被遮挡或越界`);
      }
      await evaluate(`globalThis.mobileDiscardOriginal={phase:battle.phase,required:battle.discardRequired,hand:battle.hand};battle.phase='discard';battle.discardRequired=1;battle.hand=Array.from({length:11},(_,index)=>({...mobileDiscardOriginal.hand[0],uid:30000+index}));renderBattle();true;`);
      for(const [width,height] of sizes) {
        await command("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:2,mobile:true});
        await sleep(250);
        await click('#discard-hand [data-uid="30000"]');
        const fit=await evaluate(`(() => {const button=document.getElementById('discard-confirm'),r=button.getBoundingClientRect();return getComputedStyle(document.getElementById('discard-panel')).backgroundColor==='rgba(0, 0, 0, 0)' && !button.disabled && r.bottom<=innerHeight && r.top>=0 && document.getElementById('discard-hand').clientHeight>=176 && document.querySelector('#discard-hand .card').offsetHeight===176})()`);
        if(!fit) throw new Error(`手机弃牌 ${width}x${height} 卡面或确认按钮异常`);
        if(captureMobileLayouts) await screenshot(`ai-game-mobile-discard-${width}.png`);
        await click('#discard-hand [data-uid="30000"]');
      }
      await command("Emulation.setDeviceMetricsOverride",{width:667,height:375,deviceScaleFactor:2,mobile:true});
      await evaluate("battle.discardRequired=2;renderDiscard();true;");
      for (const uid of [30000,30001,30002]) await click(`#discard-hand [data-uid="${uid}"]`);
      if(!await evaluate("discardSelection.size===2 && !discardSelection.has(30000) && discardSelection.has(30001) && discardSelection.has(30002)")) throw new Error("弃牌选择未限制数量或未取消最早选择");
      await click('#discard-hand [data-uid="30001"]');
      await click('#discard-hand [data-uid="30002"]');
      await evaluate("battle.discardRequired=1;renderDiscard();true;");
      const swipe=await evaluate(`(() => {const hand=document.getElementById('discard-hand');hand.scrollTop=0;const r=hand.getBoundingClientRect();return {x:r.left+r.width/2,y:r.bottom-12,top:r.top+12}})()`);
      await command("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:swipe.x,y:swipe.y,id:1}]});
      for(let step=1;step<=12;step+=1) {
        await command("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x:swipe.x,y:swipe.y+(swipe.top-swipe.y)*step/12,id:1}]});
        await sleep(20);
      }
      await command("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
      await sleep(300);
      if(!await evaluate("document.getElementById('discard-hand').scrollTop>20")) throw new Error("手机弃牌列表不能触摸滑动");
      await click('#discard-hand [data-uid="30010"]');
      if(!await evaluate("discardSelection.has(30010) && !document.getElementById('discard-confirm').disabled")) throw new Error("手机无法选择最后一张弃牌");
      await evaluate("battle.phase=mobileDiscardOriginal.phase;battle.discardRequired=mobileDiscardOriginal.required;battle.hand=mobileDiscardOriginal.hand;discardSelection.clear();delete globalThis.mobileDiscardOriginal;renderBattle();true;");
      console.log("ok 五种手机战斗/11 张弃牌布局、触摸选择与列表滑动");
      await click("#menu-btn");
      await waitFor(()=>visible("menu-view"),"手机返回菜单");
      await click("#continue-btn");
      await waitFor(()=>visible("battle-view"),"手机继续存档");
      if(!await evaluate("battle.board.player[3]?.cardId==='worker'")) throw new Error("手机返回菜单丢失战斗");
      async function checkResultViewports(outcome) {
        for (const [width, height, mobile] of [[1920, 1080, false], [1280, 800, false], [2560, 1080, false], [667, 375, true], [844, 390, true]]) {
          await command("Emulation.setTouchEmulationEnabled", { enabled: mobile });
          await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
          await waitFor(() => evaluate("$('orientation-guard').hidden && $('size-guard').hidden"), "结算视口切换");
          await checkResultLayout(outcome, [width, height]);
        }
        console.log(`ok ${outcome} 结算覆盖三种桌面与两种手机横屏视口`);
      }

      async function winMobileBattle(useReturn=false) {
        for(let turn=0;turn<30;turn+=1) {
          if(await evaluate("battle.phase==='over'")) break;
          if(await evaluate("battle.phase==='discard'")) {
            const uids=await evaluate("battle.hand.slice(0,battle.discardRequired).map(card=>card.uid)");
            for(const uid of uids) await click(`#discard-hand [data-uid="${uid}"]`);
            await click("#discard-confirm");
            await waitFor(()=>evaluate("!busy && battle.phase!=='discard'"),"手机实际弃牌结算");
          }
          for(let deployment=0;deployment<4;deployment+=1) {
            const move=await evaluate(`(() => {for(const card of battle.hand.filter(card=>card.type==='unit'&&card.cost<=battle.energy).sort((first,second)=>first.cost-second.cost||second.atk-first.atk)){for(let column=1;column<=5-(card.width||1);column+=1){if(Array.from({length:card.width||1},(_,offset)=>!battle.board.player[column-1+offset]).every(Boolean))return {cardId:card.cardId,column}}}return null})()`);
            if(!move) break;
            await playCard(move.cardId,"player",move.column);
          }
          await click("#end-turn");
          await waitFor(()=>evaluate("!busy"),"手机回合结算");
        }
        if(!await evaluate("battle.result==='win'")) throw new Error("手机触屏战斗未获胜");
        if (useReturn) {
          await checkResultViewports("win");
          await reloadAndContinue("result-panel", "刷新后恢复胜利结算");
        }
        await checkResultLayout("win");
        if(captureMobileLayouts) await screenshot("ai-game-mobile-result-victory.png");
        if (useReturn) {
          await click("#result-return");
        } else {
          for (const id of ["result-return", "result-action"]) {
            await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            if (await evaluate("document.activeElement.id") !== id) throw new Error("结算键盘焦点未在按钮间循环");
          }
          await command("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
          await command("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
        }
        await storyUntil("map-view");
        if (await visible("result-panel")) throw new Error("胜利后结算层未关闭");
      }
      async function loseMobileBattle() {
        for(let turn=0;turn<40;turn+=1) {
          if(await evaluate("battle.phase==='over'")) break;
          if(await evaluate("battle.phase==='discard'")) {
            const uids=await evaluate("battle.hand.slice(0,battle.discardRequired).map(card=>card.uid)");
            for(const uid of uids) await click(`#discard-hand [data-uid="${uid}"]`);
            await click("#discard-confirm");
            await waitFor(()=>evaluate("!busy && battle.phase!=='discard'"),"手机弃牌后结束失败战斗");
            continue;
          }
          const before=await evaluate("battle.turn");
          await click("#end-turn");
          await waitFor(()=>evaluate(`!busy && (battle.phase==='over' || battle.phase==='discard' || battle.turn!==${before})`),"手机推进失败战斗");
        }
        if(!await evaluate("battle.phase==='over' && battle.result==='lose'")) throw new Error("手机失败流程未触发战败");
      }
      await winMobileBattle(true);
      for(const [width,height] of sizes) {
        await command("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:2,mobile:true});
        await sleep(250);
        const fit=await evaluate(`(() => {const node=document.querySelector('#map-view .map-node:not(:disabled)'),r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) && document.documentElement.scrollWidth<=innerWidth+1 && document.documentElement.scrollHeight<=innerHeight+1})()`);
        if(!fit) throw new Error(`手机地图 ${width}x${height} 节点被遮挡或页面溢出`);
        if(captureMobileLayouts) await screenshot(`ai-game-mobile-map-${width}.png`);
      }
      await command("Emulation.setDeviceMetricsOverride",{width:844,height:390,deviceScaleFactor:3,mobile:true});
      await click("#map-view .map-node:not(:disabled)");
      await storyUntil("battle-view");
      await loseMobileBattle();
      await checkResultViewports("lose");
      await reloadAndContinue("result-panel", "刷新后恢复失败结算");
      await checkResultLayout("lose");
      const failedNode=await evaluate("state.node.id");
      if(captureMobileLayouts) await screenshot("ai-game-mobile-result-defeat.png");
      await evaluate(`$('result-action').addEventListener('click', () => {
        const retry = $('result-action');
        const returnButton = $('result-return');
        window.resultClickLocked = retry.disabled && returnButton.disabled;
        retry.click();
        returnButton.click();
      }, { once: true });`);
      await click("#result-action");
      await waitFor(()=>evaluate("!busy && battle.phase==='player' && battle.turn===1"),"手机失败结算重试");
      if (await visible("result-panel") || !await evaluate("window.resultClickLocked")) throw new Error("结算重试没有关闭结算层或拦截连点");
      if(await evaluate("battle.result!==null || battle.board.player.some(Boolean)")) throw new Error("失败重试沿用了上一场临时战斗状态");
      await loseMobileBattle();
      await click("#result-return");
      await waitFor(()=>visible("map-view"),"手机失败结算返回地图");
      if (await visible("result-panel")) throw new Error("失败返回地图后结算层未关闭");
      if(!await evaluate(`state.map.available.includes(${JSON.stringify(failedNode)}) && !state.completed.includes(${JSON.stringify(failedNode)})`)) throw new Error("失败返回地图错误推进或关闭了当前节点");
      await click(`#map-view .map-node[data-id="${failedNode}"]`);
      await storyUntil("battle-view");
      if(await evaluate("battle.tutorial")) await click("#tutorial-skip");
      await waitFor(()=>evaluate("!battle.tutorial && !busy"),"失败返回后重选战斗节点");
      await winMobileBattle();
      await click("#map-view .map-node:not(:disabled)");
      await storyUntil("supply-view");
      const deckBefore=await evaluate("state.deck.length");
      await reloadAndContinue("supply-view","手机刷新保留补给候选");
      for(let round=1;round<=2;round+=1) {
        if(!await evaluate("document.querySelectorAll('#supply-offers .offer').length===3")) throw new Error("手机补给不是三选一");
        await click("#supply-offers .buy-btn");
        await waitFor(()=>evaluate(`!busy && state.deck.length===${deckBefore+round}`),"手机领取补给");
      }
      if(await evaluate("state.phase==='node' && state.supply?.stage==='option'")) await click("#supply-option-skip");
      await waitFor(()=>visible("map-view"),"手机补给结算回地图");
      console.log("ok 触摸完成两场战斗、五尺寸地图、补给两轮三选一与刷新恢复");
      await click("#logout-btn");
      await waitFor(()=>visible("auth"),"手机退出登录");
      console.log("手机触屏专项测试全部通过（浏览器模拟，非实体手机）");
    }

    for (const [filename, index] of [["clip-01", 0], ["clip-02", 1], ["clip-04", 3], ["clip-03", 2]]) {
      const playback = await playClipToEnd(filename);
      if (playback.duration !== 4.5 || playback.clip !== index ||
          JSON.stringify(playback.messages) !== JSON.stringify(["seagate-transition-ready", "seagate-transition-ended"])) {
        throw new Error(`${filename} 未完整播放或结束通知异常：${JSON.stringify(playback)}`);
      }
      console.log(`ok ${filename} 完整播放并在 ${playback.duration}s 正常结束`);
    }
    await waitFor(async () => !(await evaluate("document.getElementById('auth').hidden")), "登录页显示");
    await screenshot("ai-game-login.png");

    const username = "ui" + Date.now().toString(36);
    await evaluate(`
      document.getElementById('username').value = ${JSON.stringify(username)};
      document.getElementById('password').value = 'test-pass-123';
      true;
    `);
    await clickTrusted("#register-btn");
    await waitFor(async () => await visible("game"), "注册后进入游戏");
    await waitFor(async () => await visible("menu-view"), "注册后显示标题菜单");
    await assertMusicTrack("menu");
    await screenshot("ai-game-title-menu.png", "#menu-view");
    const menuArt = await evaluate(`({
      background: getComputedStyle(document.getElementById('menu-view')).backgroundImage,
      placeholders: document.querySelectorAll('.title-reactor,.title-station,.title-drone').length,
    })`);
    if (!menuArt.background.includes("main-menu-bg.png") || menuArt.placeholders) {
      throw new Error(`主菜单背景图或占位机偶不符合预期：${JSON.stringify(menuArt)}`);
    }
    if (await evaluate("document.getElementById('continue-btn').disabled")) throw new Error("新账号第 1 槽已有初始冒险，但继续游戏不可用");
    for (const [width, height, mobile] of [[1024, 600, false], [667, 375, true]]) {
      await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      await sleep(150);
      const menuLayout = await evaluate(`(() => {
        const menu = document.getElementById('menu-view').getBoundingClientRect();
        const actions = document.querySelector('.title-actions').getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
          actionsFit: actions.left >= 0 && actions.right <= innerWidth + 1 && actions.bottom <= innerHeight + 1,
          menuVisible: menu.width > 0 && menu.height > 0,
          guardHidden: document.getElementById('orientation-guard').hidden && document.getElementById('size-guard').hidden };
      })()`);
      if (menuLayout.overflow || !menuLayout.actionsFit || !menuLayout.menuVisible || !menuLayout.guardHidden) {
        throw new Error(`标题菜单 ${width}x${height} 布局异常：${JSON.stringify(menuLayout)}`);
      }
    }
    await command("Emulation.clearDeviceMetricsOverride");
    await click("#settings-open");
    await waitFor(() => evaluate("!document.getElementById('settings-panel').hidden"), "设置弹窗");
    await evaluate("document.getElementById('master-volume').value = '37'; document.getElementById('master-volume').dispatchEvent(new Event('input', { bubbles: true })); true;");
    if (await evaluate("localStorage.getItem('ai-game-master-volume') !== '37' || document.getElementById('volume-value').textContent !== '37%'")) {
      throw new Error("音量设置没有写入浏览器或显示错误");
    }
    await click("#settings-close");
    await command("Page.reload");
    await waitFor(() => evaluate("!document.getElementById('menu-view').hidden"), "重载后恢复标题菜单");
    if (await evaluate("document.getElementById('master-volume').value !== '37' || document.getElementById('volume-value').textContent !== '37%'")) {
      throw new Error("重载后音量滑块没有恢复已保存值");
    }
    await click("#gallery-open");
    await waitFor(() => evaluate("document.querySelector('.gallery-empty h2')?.textContent.includes('尚无')"), "CG 空状态加载");
    if (!(await visible("cg-view"))) {
      throw new Error("CG 空状态未显示");
    }
    await click("#cg-view [data-menu-back]");
    await click("#slots-open");
    const initialSlots = await evaluate("[...document.querySelectorAll('#save-slots .save-slot')].map((slot) => slot.classList.contains('empty'))");
    if (JSON.stringify(initialSlots) !== JSON.stringify([false, true, true])) throw new Error(`新账号存档槽状态异常：${JSON.stringify(initialSlots)}`);
    await clickTrusted('#save-slots [data-slot-action="new"][data-slot="2"]');
    await waitForStory("空槽新游戏");
    await click("#menu-btn");
    await waitFor(async () => await visible("menu-view"), "返回主菜单");
    await click("#slots-open");
    await waitFor(() => evaluate("document.querySelectorAll('#save-slots .save-slot').length === 3 && !document.querySelector('#save-slots .save-slot:nth-child(2)').classList.contains('empty')"), "新槽写入");
    await clickDialog('#save-slots [data-slot-action="new"][data-slot="2"]', false);
    if (!(await visible("save-slots-view"))) throw new Error("取消覆盖后离开了存档选择界面");
    await clickDialog('#save-slots [data-slot-action="new"][data-slot="2"]', true);
    await waitForStory("确认覆盖已有存档");
    await click("#menu-btn");
    await waitFor(async () => await visible("menu-view"), "覆盖后返回主菜单");
    await click("#slots-open");
    await clickDialog('#save-slots [data-slot-action="delete"][data-slot="2"]', false);
    if (await evaluate("document.querySelector('#save-slots .save-slot:nth-child(2)').classList.contains('empty')")) throw new Error("取消删除仍然清除了存档");
    await clickDialog('#save-slots [data-slot-action="delete"][data-slot="2"]', true);
    await waitFor(() => evaluate("document.querySelector('#save-slots .save-slot:nth-child(2)').classList.contains('empty')"), "删除指定存档槽");
    await click("#save-slots-view [data-menu-back]");
    await clickTrusted("#continue-btn");
    await waitFor(() => visible("opening-cg-view"), "首次进入预置冒险开场 CG");
    await waitFor(() => evaluate(`(() => {
      const image = document.querySelector('.opening-cg-image');
      return image.complete && image.naturalWidth > 0;
    })()`), "预置冒险 CG 图片加载");
    await assertMusicTrack("cg");
    await screenshot("ai-game-opening-cg.png", "#opening-cg-view");
    await command("Page.reload");
    await waitFor(() => visible("menu-view"), "刷新后返回标题菜单");
    await clickTrusted("#continue-btn");
    await waitFor(() => visible("opening-cg-view"), "刷新后恢复开场 CG");
    await click("#opening-cg-continue");
    await waitFor(() => evaluate("document.getElementById('opening-cg-view').hidden"), "开场 CG 解锁完成");
    await waitForStory("CG 后继续初始冒险");
    await assertMusicTrack("story");
    await checkStoryCgBackgrounds();
    await click("#menu-btn");
    await waitFor(() => visible("menu-view"), "开场 CG 后返回主菜单");
    await click("#gallery-open");
    await waitFor(() => evaluate("document.querySelectorAll('.gallery-card').length === 1"), "开场 CG 写入画廊");
    const galleryCard = await evaluate(`(() => {
      const card = document.querySelector('.gallery-card');
      const image = card?.querySelector('img');
      return { title: card?.dataset.cgTitle, loaded: !!image && image.complete && image.naturalWidth > 0 };
    })()`);
    if (galleryCard.title !== "晴空伸手" || !galleryCard.loaded) throw new Error(`开场 CG 画廊卡片异常：${JSON.stringify(galleryCard)}`);
    await click(".gallery-card");
    await waitFor(() => evaluate("!document.getElementById('cg-preview').hidden"), "CG 大图预览");
    await waitFor(() => evaluate("document.getElementById('cg-preview-image').complete && document.getElementById('cg-preview-image').naturalWidth > 0"), "CG 大图加载");
    await click("#cg-preview-close");
    await waitFor(() => evaluate("document.getElementById('cg-preview').hidden"), "关闭 CG 大图预览");
    await click("#cg-view [data-menu-back]");
    const openingProgress = await evaluate("({phase: state.phase, line: state.story?.line, title: state.story?.title})");
    if (openingProgress.phase !== "map_story" || openingProgress.line !== 1 || !openingProgress.title.includes("序幕")) {
      throw new Error(`开场 CG 后未进入章节开场剧情：${JSON.stringify(openingProgress)}`);
    }
    await command("Page.reload", {});
    await waitFor(() => visible("menu-view"), "刷新后返回标题菜单");
    await clickTrusted("#continue-btn");
    await waitFor(() => visible("story-view"), "继续已看过开场 CG 的存档");
    if (await visible("opening-cg-view")) throw new Error("继续已看过开场 CG 的存档时重复播放了 CG");
    await assertMusicTrack("story");
    if (await evaluate("state.phase !== 'map_story' || state.story?.line !== 1")) {
      throw new Error("刷新后未恢复章节开场剧情位置");
    }
    console.log("ok 标题菜单、三槽新开/取消删除/删除、CG 空状态和音量保存");
    const storyVisual = await evaluate(`(() => {
      const panel = document.getElementById('story-panel');
      const portrait = document.getElementById('story-portrait-image');
      const rect = panel.getBoundingClientRect();
      const overlay = getComputedStyle(panel, '::after');
      return {
        className: panel.className,
        background: getComputedStyle(panel).backgroundImage,
        overlayCoversWidth: parseFloat(overlay.width) >= innerWidth - 1 && overlay.boxShadow === 'none',
        screenReaderAdvanceHint: panel.getAttribute('role') === 'region' &&
          panel.getAttribute('aria-describedby') === 'story-continue-hint' &&
          !document.querySelector('#story-continue-hint').hasAttribute('aria-hidden') &&
          document.querySelector('#story-continue-hint .story-sr-only').textContent.includes('空格或回车') &&
          document.querySelector('#story-continue-hint [aria-hidden="true"]').textContent === '点击画面继续',
        portrait: portrait.currentSrc,
        portraitLoaded: portrait.complete && portrait.naturalWidth > 0,
        transparentCorner: (() => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          context.drawImage(portrait, 0, 0, 1, 1, 0, 0, 1, 1);
          return context.getImageData(0, 0, 1, 1).data[3] === 0;
        })(),
        fullViewport: Math.abs(rect.width - innerWidth) < 1 && Math.abs(rect.height - innerHeight) < 1,
      };
    })()`);
    const ignoredStoryBackground = await evaluate(`(() => {
      const panel = document.getElementById('story-panel');
      const original = state.story.background;
      state.story.background = 'station';
      renderStory();
      const result = panel.className === 'story-panel' && getComputedStyle(panel).backgroundImage.includes('/assets/story/snowy-grassland.png');
      state.story.background = original;
      renderStory();
      return result;
    })()`);
    if (storyVisual.className !== "story-panel" || !storyVisual.background.includes("/assets/story/snowy-grassland.png") ||
        !storyVisual.overlayCoversWidth || !storyVisual.screenReaderAdvanceHint || !storyVisual.portrait.endsWith("/assets/story/heroine-sprite.png") || !storyVisual.portraitLoaded || !storyVisual.transparentCorner || !storyVisual.fullViewport || !ignoredStoryBackground) {
      throw new Error(`剧情固定素材、统一背景或全屏画面异常：${JSON.stringify({ storyVisual, ignoredStoryBackground })}`);
    }
    await waitFor(() => evaluate(`(() => {
      const text = document.getElementById('story-text').textContent;
      return text.length > 0 && text.length < state.story.text.length;
    })()`), "剧情开始逐字显示");
    await click("#story-panel");
    if (await evaluate("document.getElementById('story-text').textContent !== state.story.text || state.story.line !== 1")) {
      throw new Error("打字期间点击没有只补全当前句");
    }

    if (process.env.CARD_UI_ONLY !== "1") {
      await command("Emulation.setDeviceMetricsOverride", {
        width: 1024,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(300);
      const storyOverflow = await evaluate("document.documentElement.scrollWidth > window.innerWidth + 1 || document.documentElement.scrollHeight > window.innerHeight + 1 || document.getElementById('size-guard').hidden === false");
      if (storyOverflow) throw new Error("最低桌面尺寸下剧情界面溢出或误显示尺寸提示");
      await screenshot("ai-game-story-narrow.png");
      await command("Emulation.setDeviceMetricsOverride", {
        width: 375, height: 812, deviceScaleFactor: 1, mobile: true,
      });
      await sleep(200);
      if (!(await visible("orientation-guard")) || !(await evaluate("document.querySelector('#orientation-guard p').textContent.includes('场景、立绘和对白')"))) {
        const diagnostic = await evaluate("JSON.stringify({hidden:document.getElementById('orientation-guard').hidden, text:document.querySelector('#orientation-guard p').textContent, phase:state?.phase, width:innerWidth, height:innerHeight, screen})");
        throw new Error(`剧情竖屏没有显示横屏提示：${diagnostic}`);
      }
      await command("Emulation.setDeviceMetricsOverride", {
        width: 667, height: 375, deviceScaleFactor: 1, mobile: true,
      });
      await sleep(200);
      const landscapeStory = await evaluate(`(() => {
        const view = document.getElementById('story-panel').getBoundingClientRect();
        const dialogue = document.querySelector('.story-dialogue').getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1,
          fullWidth: Math.abs(view.width - innerWidth) < 1,
          dialogueVisible: dialogue.height > 0 && dialogue.bottom <= innerHeight + 1,
          guardsHidden: document.getElementById('orientation-guard').hidden && document.getElementById('size-guard').hidden,
        };
      })()`);
      if (landscapeStory.overflow || !landscapeStory.fullWidth || !landscapeStory.dialogueVisible || !landscapeStory.guardsHidden) {
        throw new Error(`手机横屏剧情布局异常：${JSON.stringify(landscapeStory)}`);
      }
      await command("Emulation.clearDeviceMetricsOverride");
      await command("Page.setWebLifecycleState", { state: "active" });
      await command("Page.bringToFront");
      await waitFor(() => evaluate("document.visibilityState === 'visible'"), "恢复浏览器页面可见状态");
      await sleep(200);
      console.log("ok 最低桌面剧情布局、手机竖屏旋转提示与横屏适配");
    }

    await evaluate("document.getElementById('story-panel').focus(); true;");
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await waitFor(() => evaluate("state.phase === 'map_story' && state.story?.line === 2"), "章节开场剧情按回车推进");
    await storyUntil("map-view");
    await assertMusicTrack("event");
    const openingMap = await evaluate(`({
      phase: state.phase,
      available: state.map.available,
      start: state.node.id,
      battleHidden: document.getElementById('battle-view').hidden,
    })`);
    if (openingMap.phase !== "map" || openingMap.available.length !== 1 ||
        openingMap.available[0] !== openingMap.start || !openingMap.battleHidden) {
      throw new Error(`章节开场后未停在起点选图：${JSON.stringify(openingMap)}`);
    }
    await click('.map-node[data-id="' + openingMap.start + '"]');
    await waitFor(async () => await visible("story-view"), "起点战前剧情");
    await storyUntil("battle-view");
    await waitFor(
      async () => (await visible("battle-view")) &&
        (await evaluate("document.querySelectorAll('#hand .card').length")) > 0,
      "战斗界面载入"
    );
    await assertMusicTrack("battle");
    console.log("ok 固定剧情素材、全屏版式、逐字显示、点击补全文字与回车推进");
    await waitFor(
      () => evaluate("document.getElementById('hand-toggle').getAttribute('aria-expanded') === 'true'"),
      "起手抽牌自动展开手牌"
    );
    await waitFor(() => evaluate("document.querySelectorAll('.draw-orb').length > 0"), "起手抽牌光点飞行");
    const initialHandCount = await evaluate(`({
      label: Number(document.getElementById('hand-count').textContent),
      cards: document.querySelectorAll('#hand .card').length,
      state: battle.hand.length,
    })`);
    if (initialHandCount.label !== initialHandCount.cards || initialHandCount.cards !== initialHandCount.state) {
      throw new Error(`手牌计数与显示牌数不一致：${JSON.stringify(initialHandCount)}`);
    }
    const battleLogLayout = await evaluate(`(() => {
      const log = document.getElementById('log');
      log.textContent = '回收双轨机偶，释放相邻两列';
      const table = document.getElementById('battle-table').getBoundingClientRect();
      const controls = document.querySelector('.battle-bottom').getBoundingClientRect();
      return { display: getComputedStyle(log).display, controlsTop: controls.top, tableBottom: table.bottom };
    })()`);
    if (battleLogLayout.display !== "none" || battleLogLayout.controlsTop < battleLogLayout.tableBottom) {
      throw new Error(`战斗记录仍显示或挤占战场布局：${JSON.stringify(battleLogLayout)}`);
    }
    await evaluate("document.getElementById('hand-count').textContent = '0'; true;");
    await click("#hand-toggle");
    await waitFor(() => evaluate("getComputedStyle(document.getElementById('hand')).visibility === 'hidden'"), "手牌抽屉收起");
    await click("#hand-toggle");
    await waitFor(() => evaluate("document.getElementById('hand').clientHeight >= 190"), "手牌抽屉展开");
    const handStats = await evaluate(`(() => {
      const card = document.querySelector('#hand .card[data-type="unit"]');
      const metrics = card?.querySelector('.card-metrics');
      const face = card?.querySelector('.card-face');
      const metricsRect = metrics?.getBoundingClientRect();
      const faceRect = face?.getBoundingClientRect();
      const cardParts = [...card?.querySelectorAll('.card-topline,.card-name,.card-art,.card-stats,.card-metrics') || []]
        .map((part) => ({ name: part.className, top: part.getBoundingClientRect().top, bottom: part.getBoundingClientRect().bottom, height: part.getBoundingClientRect().height }));
      return { expanded: document.getElementById('hand-toggle').getAttribute('aria-expanded') === 'true',
        handCount: Number(document.getElementById('hand-count').textContent),
        attack: metrics?.querySelector('.attack b')?.textContent, health: metrics?.querySelector('.health b')?.textContent,
        metricsHeight: metricsRect?.height, metricsVisible: metricsRect?.height > 0 && metricsRect.bottom <= faceRect.bottom + 1,
        cardHeight: card?.getBoundingClientRect().height, faceHeight: faceRect?.height, cardParts };
    })()`);
    await click("#battle-table");
    await sleep(40);
    const visibleWhileClosing = await evaluate("getComputedStyle(document.getElementById('hand')).visibility === 'visible'");
    await waitFor(() => evaluate("getComputedStyle(document.getElementById('hand')).visibility === 'hidden'"), "手牌抽屉收起");
    await click("#hand-toggle");
    await waitFor(() => evaluate("document.getElementById('hand').clientHeight >= 190"), "手牌抽屉重新展开");
    const closedByDrag = await evaluate(`(() => {
      const dock = document.getElementById('hand-dock');
      const card = document.querySelector('#hand .card[data-type="unit"]');
      card.draggable = true;
      card.setAttribute('aria-disabled', 'false');
      const data = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      const closed = !dock.classList.contains('is-open');
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
      return closed;
    })()`);
    if (!handStats.expanded || handStats.handCount !== initialHandCount.cards || !handStats.metricsVisible ||
        !visibleWhileClosing || !closedByDrag ||
        !handStats.attack || !handStats.health || handStats.metricsHeight < 18) {
      throw new Error(`手牌抽屉或攻/生命显示异常：${JSON.stringify({ handStats, visibleWhileClosing, closedByDrag })}`);
    }
    console.log("ok 手牌抽屉开合、拖动自动收起与单位攻/生命数值");
    console.log("ok 进入战斗界面");

    if (!(await visible("tutorial-panel"))) throw new Error("第一场战斗没有显示新手教程");
    if (process.env.TUTORIAL_UI_ONLY === "1") {
      async function expectStep(index) {
        await waitFor(() => evaluate(`battle.tutorial?.index === ${index} && !busy`), `教学步骤 ${index}`);
      }
      async function dragCard(cardId, side, column) {
        await evaluate(`(() => {
          const dock = document.getElementById('hand-dock');
          if (!dock.classList.contains('is-open')) document.getElementById('hand-toggle').click();
          return true;
        })()`);
        await waitFor(() => evaluate(`(() => {
          const hand = document.getElementById('hand');
          const card = document.querySelector('#hand [data-uid="' + battle.hand.find(c => c.cardId === ${JSON.stringify(cardId)}).uid + '"]');
          const style = getComputedStyle(hand);
          return hand.getBoundingClientRect().height >= card.getBoundingClientRect().height +
            parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        })()`), "手牌抽屉完全展开");
        const points = await evaluate(`(() => {
          const card = battle.hand.find(c => c.cardId === ${JSON.stringify(cardId)});
          const source = document.querySelector('#hand [data-uid="' + card.uid + '"]');
          source.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const a = source.getBoundingClientRect();
          const b = document.querySelector('#${side}-row [data-column="${column}"]').getBoundingClientRect();
          return { x: a.x + a.width / 2, y: a.y + a.height / 2, tx: b.x + b.width / 2, ty: b.y + b.height / 2 };
        })()`);
        await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: points.x, y: points.y });
        await command("Input.dispatchMouseEvent", { type: "mousePressed", x: points.x, y: points.y, button: "left", clickCount: 1 });
        for (let i = 1; i <= 12; i += 1) {
          await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: points.x + (points.tx - points.x) * i / 12, y: points.y + (points.ty - points.y) * i / 12, button: "left", buttons: 1 });
          await sleep(30);
        }
        await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: points.tx, y: points.ty, buttons: 1 });
        await sleep(100);
        await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: points.tx, y: points.ty, button: "left", clickCount: 1 });
        await sleep(200);
      }
      await expectStep(0);
      await screenshot("ai-game-tutorial-start.png");
      if (!(await evaluate("['enemy-hp','player-hp','energy','hand-toggle'].every(id => document.getElementById(id).classList.contains('tutorial-target'))"))) throw new Error("开场教程没有标出领袖生命、能量和手牌位置");
      await click("#tutorial-next");
      await expectStep(1);
      if (!(await evaluate("document.getElementById('end-turn').disabled"))) throw new Error("教学未禁止提前结束回合");
      for (const [width, height] of [[1024, 600], [667, 375]]) {
        await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        await sleep(200);
        const layout = await evaluate(`(() => {
          const coach = document.getElementById('tutorial-panel').getBoundingClientRect();
          const hand = document.getElementById('hand').getBoundingClientRect();
          const board = document.getElementById('player-row').getBoundingClientRect();
          const card = document.querySelector('#hand [draggable="true"]').getBoundingClientRect();
          return { overflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1,
            overlap: coach.bottom > board.top || board.bottom > hand.top, cardHeight: card.height,
            clipped: coach.top < 0 || hand.bottom > innerHeight + 1, boardHeight: board.height,
            coachTop: coach.top, stageScroll: document.querySelector('.stage').scrollTop };
        })()`);
        if (layout.overflow || layout.overlap || layout.clipped || layout.cardHeight < 80 || layout.boardHeight < 28) throw new Error(`教学布局 ${width}x${height}: ${JSON.stringify(layout)}`);
        await screenshot(`ai-game-tutorial-${width}.png`);
      }
      await command("Emulation.clearDeviceMetricsOverride");
      await sleep(300);
      await dragCard("shell", "player", 2);
      await expectStep(2);
      await click("#end-turn");
      await expectStep(3);
      await reloadAndContinue("battle-view", "刷新恢复教学");
      await waitFor(() => evaluate("typeof battle !== 'undefined' && battle?.tutorial?.index === 3"), "恢复教学步骤");
      await dragCard("spark", "enemy", 2);
      await expectStep(4);
      await screenshot("ai-game-tutorial-finish.png");
      await click("#tutorial-next");
      await waitFor(() => evaluate("!battle.tutorial && !busy"), "教学完成后自由战斗");
      await dragCard("worker", "player", 4);
      if (!(await evaluate("!battle.tutorial && battle.board.player[3]?.cardId === 'worker'"))) throw new Error("教学结束后没有恢复自由部署");
      console.log("ok 实际鼠标拖动完成精简教学、刷新恢复、小屏布局与自由部署");
      ws.close();
      return;
    }
    await click("#tutorial-skip");
    await waitFor(async () => !(await visible("tutorial-panel")), "跳过教程");
    console.log("ok 第一关新手教程与跳过");

    const battleBeforeReload = await evaluate(`JSON.stringify({
      turn: battle.turn, energy: battle.energy, hp: battle.hp,
      hand: battle.hand.map((card) => card.uid).sort((a, b) => a - b),
      deck: battle.deckCount,
      board: battle.board.player.map((unit) => (unit ? unit.uid : null)),
    })`);
    await reloadAndContinue("battle-view", "刷新后恢复战斗");
    await waitFor(
      async () => await evaluate("typeof battle !== 'undefined' && !!battle && document.querySelectorAll('#hand .card').length > 0"),
      "刷新后恢复战斗数据"
    );
    const battleAfterReload = await evaluate(`JSON.stringify({
      turn: battle.turn, energy: battle.energy, hp: battle.hp,
      hand: battle.hand.map((card) => card.uid).sort((a, b) => a - b),
      deck: battle.deckCount,
      board: battle.board.player.map((unit) => (unit ? unit.uid : null)),
    })`);
    if (battleAfterReload !== battleBeforeReload) {
      throw new Error(`刷新后战斗被重抽或重置：${battleBeforeReload} -> ${battleAfterReload}`);
    }
    console.log("ok 刷新后战斗进度与起手牌保持不变");
    await click("#hand-toggle");
    await sleep(250);

    const desktopBattle = await evaluate(`(() => {
      return {
        theme: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      };
    })()`);
    if (desktopBattle.theme !== "#050608") {
      throw new Error(`战斗黑色主题或手牌布局异常：${JSON.stringify(desktopBattle)}`);
    }
    await screenshot("ai-game-battle-desktop.png", "#battle-view");
    await command("Emulation.setDeviceMetricsOverride", {
      width: 1837, height: 964, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(250);
    await command("Emulation.setDeviceMetricsOverride", {
      width: 1024, height: 600, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(250);
    const compactDesktop = await evaluate(`(() => [...document.querySelectorAll('#hand .card[data-type="unit"]')].every((card) => {
      const metrics = card.querySelector('.card-metrics').getBoundingClientRect();
      const face = card.querySelector('.card-face').getBoundingClientRect();
      return metrics.height > 0 && metrics.bottom <= face.bottom + 1;
    }))()`);
    if (!compactDesktop) throw new Error("1024×600 桌面视口下卡牌攻/生命数值被裁切");
    await command("Emulation.clearDeviceMetricsOverride");
    await sleep(100);
    await command("Emulation.setDeviceMetricsOverride", {
      width: 667,
      height: 375,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(250);
    const phoneBattle = await evaluate(`(() => {
      const view = document.getElementById('battle-view').getBoundingClientRect();
      const hand = document.getElementById('hand');
      const handRect = hand.getBoundingClientRect();
      const controls = document.querySelector('.battle-bottom').getBoundingClientRect();
      const cards = [...document.querySelectorAll('#hand .card')];
      const metricsVisible = cards.every((card) => {
        const face = card.querySelector('.card-face').getBoundingClientRect();
        const metrics = card.querySelector('.card-metrics').getBoundingClientRect();
        const rect = card.getBoundingClientRect();
        return metrics.height > 0 && metrics.bottom <= face.bottom + 1 && rect.bottom <= handRect.bottom + 1;
      });
      const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1 || document.documentElement.scrollHeight > window.innerHeight + 1,
        guardVisible: !document.getElementById('orientation-guard').hidden || !document.getElementById('size-guard').hidden,
        handFits: handRect.left >= view.left - 2 && handRect.right <= view.right + 2,
        handScrollable: hand.scrollWidth > hand.clientWidth + 1,
        readableCards: cards.every((card) => card.getBoundingClientRect().width >= 76),
        metricsVisible,
      };
    })()`);
    if (phoneBattle.overflow || phoneBattle.guardVisible || !phoneBattle.handFits || !phoneBattle.handScrollable ||
        !phoneBattle.readableCards || !phoneBattle.metricsVisible) {
      throw new Error(`手机战斗界面布局异常：${JSON.stringify(phoneBattle)}`);
    }
    await screenshot("ai-game-battle-phone.png", "#battle-view");
    await command("Emulation.clearDeviceMetricsOverride");
    await sleep(200);
    const completionLayout = await evaluate(`(() => {
      const view = document.getElementById('complete-view');
      view.hidden = false;
      const button = document.getElementById('restart-btn').getBoundingClientRect();
      const panel = document.querySelector('.complete-panel').getBoundingClientRect();
      const result = { buttonHeight: button.height, buttonWidth: button.width, panelHeight: panel.height };
      view.hidden = true;
      return result;
    })()`);
    if (completionLayout.buttonHeight > 60 || completionLayout.buttonHeight < 40 || completionLayout.buttonWidth < 120) {
      throw new Error(`完成页重开按钮尺寸异常：${JSON.stringify(completionLayout)}`);
    }
    const handCards = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('#hand .card')];
      return {
        count: cards.length,
        complete: cards.every((card) => card.querySelector('.card-face .pixel-art-image')?.complete &&
          card.querySelector('.card-face .pixel-art-image')?.naturalWidth > 0 &&
          card.querySelector('.card-face .card-cost') && card.querySelector('.card-face .card-level')),
      };
    })()`);
    if (!handCards.count || !handCards.complete) throw new Error(`战斗手牌缺少完整像素卡面：${JSON.stringify(handCards)}`);

    await evaluate(`(() => {
      const saved = {
        state, signalAction, signalTarget, adventureTarget, adventureEffect,
        enhanceKind, recycleTarget, relayAction, relayTarget, trialPick,
      };
      window.__cardUiSaved = saved;
      const baseCards = state.deck;
      const units = baseCards.filter((card) => card.type === 'unit').map((card) => ({
        ...card, canUpgrade: true, canLevel: true,
        atkPreview: { atk: card.atk + 1 }, hpPreview: { maxHp: card.maxHp + 1 },
        levelPreview: { atk: card.atk + 1, maxHp: card.maxHp + 1 },
        upgradePreview: { atk: card.atk + 1, maxHp: card.maxHp + 1 },
        repairPreview: { maxHp: card.maxHp + 1 },
      }));
      const candidates = baseCards.slice(0, 3).map((card) => ({
        ...card, currentLevel: card.level, targetLevel: card.level + 1, isUpgrade: true,
      }));
      state = {
        ...state, gold: 99,
        eliteReward: { candidates, deckFull: false },
        recruit: { offers: units.slice(0, 3).map((card) => ({
          cardId: card.cardId, name: card.name, level: card.level, maxLevel: 2, price: 10,
        })), purchased: false },
        signal: { hpBonus: 1, targets: units, hasRepairTarget: true, hasUpgradeTarget: true },
        calibration: { atkBonus: 1, hpBonus: 2, levelBonus: 1, targets: units },
        recycle: { targets: baseCards.map((card) => ({ ...card, price: 5, removable: true })) },
        relay: { targets: units, atkBonus: 1, kept: false },
        drift: { candidates, rerolls: 0, rerollLimit: 1, rerollPrice: 10, canReroll: true },
        shop: { purchased: false, offers: [
          { id: 'new', kind: 'new', cardId: units[0].cardId, name: units[0].name, price: 16, buyable: true },
          { id: 'upgrade', kind: 'upgrade', cardId: units[1].cardId, name: units[1].name, price: 8, buyable: true },
          { id: 'boost', kind: 'boost', cardId: units[2].cardId, name: units[2].name, price: 6, buyable: true, effectText: '攻击 +1' },
        ] },
        trial: { status: 'success', trials: [], candidates, hasCandidates: true, failureGold: 5 },
      };
      signalAction = 'upgrade';
      signalTarget = null;
      adventureTarget = null;
      adventureEffect = null;
      recycleTarget = null;
      relayAction = 'cut';
      relayTarget = null;
      trialPick = null;
      window.__inspectCardSurface = (surface, shouldRender = true) => {
        if (shouldRender) hideViews();
        const renderers = {
          elite: renderEliteReward,
          recruit: renderRecruit,
          signal: renderSignal,
          calibration: () => renderAdventure('calibration'),
          recycle: renderRecycle,
          relay: renderRelay,
          drift: renderDrift,
          shop: renderShop,
          trial: renderTrial,
        };
        if (shouldRender) renderers[surface]();
        const allFaces = [...document.querySelectorAll('.card-face')];
        const faces = allFaces.filter((face) => face.getBoundingClientRect().width > 0);
        const rects = faces.map((face) => face.getBoundingClientRect());
        return {
          surface, count: faces.length,
          complete: faces.every((face) => face.querySelector('.pixel-art-image')?.complete &&
            face.querySelector('.pixel-art-image')?.naturalWidth > 0 &&
            face.querySelector('.card-name')?.textContent.trim() &&
            face.querySelector('.card-cost') && face.querySelector('.card-metrics')),
          portrait: rects.every((rect) => rect.height > rect.width),
          pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          actionCount: document.querySelectorAll('#targets .target-action').length,
          unitCount: state.calibration.targets.length,
        };
      };
      return true;
    })()`);

    for (const [surface, selector] of [
      ["elite", "#elite-reward-view"], ["recruit", "#recruit-view"], ["signal", "#signal-view"],
      ["calibration", "#adventure-view"], ["recycle", "#recycle-view"], ["relay", "#relay-view"],
      ["drift", "#drift-view"], ["shop", "#shop-view"], ["trial", "#trial-view"],
    ]) {
      await evaluate(`window.__inspectCardSurface(${JSON.stringify(surface)})`);
      await waitFor(async () => await evaluate(`
        [...document.querySelectorAll(${JSON.stringify(selector)} + ' .pixel-art-image')]
          .every((image) => image.complete && image.naturalWidth > 0)
      `), `${surface} 卡图加载`);
      const check = await evaluate(`window.__inspectCardSurface(${JSON.stringify(surface)}, false)`);
      if (!check.count || !check.complete || !check.portrait || check.pageOverflow) {
        throw new Error(`卡牌界面渲染异常：${JSON.stringify(check)}`);
      }
      if (surface === "calibration" && check.actionCount !== check.unitCount * 3) {
        throw new Error(`每张强化卡面应提供三项强化选择：${JSON.stringify(check)}`);
      }
      if (surface === "calibration") {
        await sleep(250);
        await screenshot("ai-game-card-enhancement.png", selector);
      }
      if (surface === "elite") {
        await sleep(250);
        await screenshot("ai-game-card-reward.png", selector);
      }
    }
    const artAssets = await evaluate(`Promise.all([...new Set(Object.values(CARD_ART))].map((id) =>
      new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ id, loaded: true });
        image.onerror = () => resolve({ id, loaded: false });
        image.src = '/assets/cards/' + id + '.png';
      })
    ))`);
    const missingArt = artAssets.filter((asset) => !asset.loaded);
    if (missingArt.length) throw new Error(`卡牌素材缺失：${JSON.stringify(missingArt)}`);
    await command("Emulation.setDeviceMetricsOverride", {
      width: 667, height: 375, deviceScaleFactor: 1, mobile: true,
    });
    await evaluate("window.__inspectCardSurface('calibration')");
    await waitFor(async () => await evaluate(`
      [...document.querySelectorAll('#adventure-view .pixel-art-image')]
        .every((image) => image.complete && image.naturalWidth > 0)
    `), "手机强化卡图加载");
    const phoneEnhancement = await evaluate("window.__inspectCardSurface('calibration', false)");
    if (!phoneEnhancement.count || !phoneEnhancement.complete || phoneEnhancement.pageOverflow) {
      throw new Error(`手机强化卡牌布局异常：${JSON.stringify(phoneEnhancement)}`);
    }
    await screenshot("ai-game-card-enhancement-phone.png", "#adventure-view");
    await command("Emulation.clearDeviceMetricsOverride");
    await evaluate(`(() => {
      const saved = window.__cardUiSaved;
      state = saved.state;
      signalAction = saved.signalAction;
      signalTarget = saved.signalTarget;
      adventureTarget = saved.adventureTarget;
      adventureEffect = saved.adventureEffect;
      enhanceKind = saved.enhanceKind;
      recycleTarget = saved.recycleTarget;
      relayAction = saved.relayAction;
      relayTarget = saved.relayTarget;
      trialPick = saved.trialPick;
      delete window.__inspectCardSurface;
      delete window.__cardUiSaved;
      hideViews();
      renderBattle();
    })()`);
    console.log("ok 战斗、奖励、招募与强化卡面在桌面/手机视口渲染完整");

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

    const wideDrag = await evaluate(`(() => {
      const fakeUid = 999999;
      battle.hand.push({
        uid: fakeUid, cardId: "twin_rail", type: "unit", name: "双轨机偶", cost: 1,
        atk: 2, hp: 4, width: 2, attackPattern: "split_attack", abilities: ["wide_2"], level: 1,
      });
      renderBattle();
      const card = document.querySelector('#hand .card[data-uid="' + fakeUid + '"]');
      if (!card) {
        battle.hand = battle.hand.filter((item) => item.uid !== fakeUid);
        renderBattle();
        return { skip: true };
      }
      const data = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      const slot = document.querySelector('#player-row .slot.drop-ok');
      if (!slot) {
        card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
        battle.hand = battle.hand.filter((item) => item.uid !== fakeUid);
        renderBattle();
        return { skip: true };
      }
      slot.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      const columns = [...document.querySelectorAll('#player-row .slot.drop-hover')]
        .map((element) => Number(element.dataset.column));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
      battle.hand = battle.hand.filter((item) => item.uid !== fakeUid);
      renderBattle();
      return { skip: false, columns };
    })()`);
    if (wideDrag.skip) throw new Error("无法构造宽体拖动预览");
    const span = [...wideDrag.columns].sort((a, b) => a - b);
    if (span.length !== 2 || span[1] !== span[0] + 1) {
      throw new Error(`宽体拖动应同时高亮相邻两列：${JSON.stringify(wideDrag)}`);
    }
    console.log("ok 宽体单位拖动同时高亮相邻两列");

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
      const resultOpen = await evaluate("!document.getElementById('result-panel').hidden");
      const turn = await evaluate("document.getElementById('turn').textContent");
      return resultOpen || turn !== turnBeforeCommand;
    }, "等待技能测试回合");
    const endedEarly = await evaluate("!document.getElementById('result-panel').hidden");
    let noEnemy = false;
    if (!endedEarly) {
      try {
        await waitFor(
          async () => (await evaluate("document.querySelectorAll('#enemy-row .slot.unit').length")) > 0,
          "敌方单位部署",
          5000
        );
      } catch (_) {
        noEnemy = true;
      }
    }

    if (!endedEarly && !noEnemy) {
    await waitFor(() => evaluate("!busy && battle?.phase === 'player'"), "等待技能牌拖动目标回合");
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
    } else {
      console.log("ok 战斗已提前结束或无敌方目标，跳过回合技能测试");
    }

    if (process.env.CARD_UI_ONLY === "1") {
      ws.close();
      console.log("卡牌界面定向测试通过");
      return;
    }

    async function deployAll() {
      await waitFor(() => evaluate("!busy && battle?.phase === 'player'"), "部署回合就绪");
      for (let index = 0; index < 6; index += 1) {
        const handBefore = await evaluate("document.querySelectorAll('#hand .card').length");
        const deployed = await evaluate(`(() => {
          const energy = Number(document.getElementById('energy').textContent);
          const candidates = [...document.querySelectorAll('#hand .card[data-type="unit"]')]
            .filter((element) => Number(element.querySelector('.card-cost').textContent) <= energy);
          let card = null;
          let start = null;
          for (const element of candidates) {
            const width = Number(element.dataset.width || 1);
            for (let column = 5 - width; column >= 1; column -= 1) {
              const free = [...Array(width)].every((_, offset) =>
                !battle.board.player[column - 1 + offset]);
              if (free) { card = element; start = column; break; }
            }
            if (card) break;
          }
          const slot = start && document.querySelector(
            '#player-row .slot.empty[data-column="' + start + '"]');
          if (!card || !slot) return false;
          const data = new DataTransfer();
          card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
          slot.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
          slot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
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
          if (await evaluate("battle.phase === 'discard'")) {
            const required = await evaluate("battle.discardRequired");
            const uids = await evaluate(`battle.hand.slice().sort((a,b)=>b.cost-a.cost).slice(0,${required}).map(card=>card.uid)`);
            for (const uid of uids) await click(`#discard-hand .card[data-uid="${uid}"]`);
            await click("#discard-confirm");
            await waitFor(() => evaluate("!busy && battle.phase !== 'discard'"), "确认弃牌");
          }
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
            return resultOpen || turn !== before || await evaluate("battle.phase === 'discard'");
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
    await checkResultLayout("win");
    await screenshot("ai-game-result.png");
    console.log("ok 战斗 1 胜利，结束后拖放被禁用");

    await click("#result-action");
    await waitFor(async () => await visible("story-view"), "战斗后剧情");
    await storyUntil("map-view");
    console.log("ok 战斗胜利后进入随机地图");

    async function checkMapPreviews() {
      const labelOverlaps = [];
      const fixtures = JSON.parse(execFileSync(process.env.PYTHON || "python", ["-c", `
import json
from app import game
states = []
for kind in ('map1', 'map2', 'map3'):
    s = game.new_state(97, kind)
    s['phase'] = 'map'
    s['completed'] = [s['nodeId']]
    s['gold'] = 12345
    states.append(game.public_state(s))
print(json.dumps(states))
      `], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }));
      await evaluate(`(async () => {
        const auth = await api('/api/register', {username:'map'+Date.now().toString(36),password:'test-pass-123'});
        username = auth.username;
        return true;
      })()`);
      for (const fixture of fixtures) {
        await evaluate(`screen='game'; battle=null; apply({state:${JSON.stringify(fixture)}}); true;`);
        for (const [width, height] of [[1920,1080],[1366,768],[1024,600],[667,375]]) {
          await command('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:width===667});
          await command('Emulation.setEmulatedMedia', {features:width===667 ? [{name:'hover',value:'none'},{name:'pointer',value:'coarse'}] : []});
          await command('Emulation.setTouchEmulationEnabled', {enabled:width===667,maxTouchPoints:1});
          await sleep(250);
          await checkMapLayout();
          if (width===667 && !await evaluate(`(() => {
            const nodes=[...document.querySelectorAll('.map-node')];
            return [...document.querySelectorAll('.map-node:not(:disabled) .map-node-label')].every(label => {
              const p=label.getBoundingClientRect();
              return getComputedStyle(label).visibility==='visible' && nodes.filter(node=>!node.contains(label)).every(node=>{
                const q=node.querySelector('.map-node-icon').getBoundingClientRect();
                return p.right<=q.left || p.left>=q.right || p.bottom<=q.top || p.top>=q.bottom;
              });
            });
          })()`)) {
            await screenshot(`ai-game-${fixture.mapType}-touch-overlap.png`);
            labelOverlaps.push(fixture.mapType);
          }
          await screenshot(`ai-game-${fixture.mapType}-${width}.png`);
        }
      }
      await command('Emulation.setEmulatedMedia', {features:[]});
      await command('Emulation.setTouchEmulationEnabled', {enabled:false});
      await command('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      await command('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      if (!await evaluate(`(() => {
        const node=document.querySelector('.map-node:not(:disabled)');
        node.focus({preventScroll:true});
        return node.matches(':focus-visible') && getComputedStyle(node.querySelector('.map-node-label')).visibility==='visible';
      })()`)) throw Error('地图节点键盘焦点或名称缺失');
      await evaluate(`document.activeElement.blur(); true;`);
      await command('Emulation.setDeviceMetricsOverride', {width:1366,height:768,deviceScaleFactor:1,mobile:false});
      const point=await evaluate(`(() => {const r=document.querySelector('.map-node:not(:disabled)').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await command('Input.dispatchMouseEvent', {type:'mouseMoved',...point});
      await sleep(200);
      if (!await evaluate(`getComputedStyle(document.querySelector('.map-node:not(:disabled) .map-node-label')).visibility==='visible'`)) throw Error('地图节点悬停名称缺失');
      await command('Emulation.setDeviceMetricsOverride', {width:667,height:375,deviceScaleFactor:1,mobile:false});
      await evaluate(`state.gold=987; state.progress=6; state.pendingChallenge={name:'信号同步：下一场战斗首回合额外出现突击哨兵'}; render(); true;`);
      await checkMapLayout();
      if (!await evaluate(`$('hud-gold').textContent==='987' && $('map-route').textContent.includes('6 /') && $('map-hint').textContent.includes('信号同步')`)) throw Error('地图资源或挑战提示未更新');
      await screenshot('ai-game-map-challenge-phone.png');
      await click('#menu-btn');
      await waitFor(() => visible('menu-view'), '地图返回主菜单');
      await waitFor(() => evaluate(`!$('continue-btn').disabled && !busy`), '菜单存档加载完成');
      await click('#continue-btn');
      await waitFor(() => visible('story-view'), '菜单继续游戏');
      if (!await evaluate(`getComputedStyle(document.querySelector('#game > .topbar')).display==='none'`)) throw Error('剧情页面错误继承地图顶栏');
      await storyUntil('map-view');
      await click('.map-node:not(:disabled)');
      await waitFor(() => visible('story-view'), '选择节点进入剧情');
      await storyUntil('battle-view');
      if (!await evaluate(`getComputedStyle(document.querySelector('#game > .topbar')).position==='sticky' && getComputedStyle(document.querySelector('.hud-resources')).display==='contents' && getComputedStyle($('map-route')).display==='none'`)) throw Error('战斗页面未恢复普通顶栏');
      await evaluate(`screen='game'; apply({state:${JSON.stringify(fixtures[0])}}); true;`);
      await click('#logout-btn');
      await waitFor(() => visible('auth'), '地图退出登录');
      if (labelOverlaps.length) throw Error('触屏节点名称被相邻图标遮挡：' + labelOverlaps.join(', '));
      console.log('ok 三章全屏地图、四种窗口、资源更新、挑战提示与菜单操作');
    }

    async function mapDomState() {
      return evaluate(`(() => {
        const map = state.map;
        const nodes = [...document.querySelectorAll('.map-node')];
        const available = [...document.querySelectorAll('.map-node:not(:disabled)')];
        const svg = [...document.querySelectorAll('.map-paths')]
          .find((element) => getComputedStyle(element).display !== 'none');
        const paths = [...svg.querySelectorAll('.map-path')];
        const openPaths = [...svg.querySelectorAll('.map-path.open')];
        const connected = available.every((node) => {
          const rect = node.getBoundingClientRect();
          const target = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          return openPaths.some((path) => {
            const point = path.getPointAtLength(path.getTotalLength());
            const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM());
            return Math.hypot(screen.x - target.x, screen.y - target.y) < 2;
          });
        });
        return {
          phase: state.phase,
          runLength: state.runLength,
          count: nodes.length,
          total: map.nodes.length,
          edges: map.edges.length,
          paths: paths.length,
          available: available.length,
          availableIds: available.map((node) => node.dataset.id),
          connected: connected || (state.completed.length === 0 && available.length === 1 &&
            state.map.nodes.find((item) => item.id === available[0]?.dataset.id)?.role === 'start'),
          targetSize: available.every((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width >= 44 && rect.height >= 44;
          }),
          lockedDisabled: map.nodes.filter((node) => node.status !== 'available')
            .every((node) => document.querySelector('.map-node[data-id="' + node.id + '"]').disabled),
          oldFixed: !!document.querySelector('.map-node[data-id="battle1"]'),
          columns: [...new Set(map.nodes.map((node) => node.column))].sort((a, b) => a - b),
          rows: [...new Set(map.nodes.map((node) => node.row))].sort((a, b) => a - b),
          statuses: [...new Set(map.nodes.map((node) => node.status))],
          seed: map.seed,
          mapType: state.mapType,
          boardMap2: document.querySelector('.map-board').classList.contains('map-type-map2'),
          boardMap3: document.querySelector('.map-board').classList.contains('map-type-map3'),
          terrainImage: getComputedStyle(document.querySelector('.map-terrain')).backgroundImage,
          eyebrow: document.getElementById('map-eyebrow').textContent,
          cartouche: document.querySelector('.map-cartouche').textContent,
          destination: document.querySelector('.map-destination').textContent,
          fullscreen: (() => {
            const r = document.querySelector('.map-board').getBoundingClientRect();
            return Math.abs(r.x)<1 && Math.abs(r.y)<1 && Math.abs(r.width-innerWidth)<1 && Math.abs(r.height-innerHeight)<1;
          })(),
          hudVisible: ['hud-gold','hud-user','menu-btn','logout-btn','map-route'].every(id => {
            const el = document.getElementById(id), r = el.getBoundingClientRect();
            return r.width>0 && r.height>0 && r.left>=0 && r.right<=innerWidth+1 && r.top>=0 && r.bottom<=innerHeight+1;
          }),
          goldUpdated: document.getElementById('hud-gold').textContent === String(state.gold),
          noOverflow: document.documentElement.scrollWidth<=innerWidth && document.documentElement.scrollHeight<=innerHeight,
          nodesClear: nodes.every(node => {
            const r=node.getBoundingClientRect();
            const pieces=[node, node.closest('.map-stop').querySelector('.map-pawn')].filter(Boolean);
            const panels=[...document.querySelectorAll('.hud-resources,.hud-account,.map-head,#map-page-right')];
            return pieces.every(piece => {
              const p=piece.getBoundingClientRect();
              return p.left>=0 && p.right<=innerWidth && p.top>=0 && p.bottom<=innerHeight && panels.every(panel => {
                const q=panel.getBoundingClientRect();
                return p.right<=q.left || p.left>=q.right || p.bottom<=q.top || p.top>=q.bottom;
              });
            }) && node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
          }),
        };
      })()`);
    }

    async function checkMapLayout() {
      const check = await mapDomState();
      if (check.phase !== "map" || check.count !== check.total ||
          check.total <= check.runLength || check.paths !== check.edges ||
          check.available < 1 || !check.connected || !check.targetSize ||
          !check.lockedDisabled || check.oldFixed || !check.fullscreen || !check.hudVisible ||
          !check.goldUpdated || !check.noOverflow || !check.nodesClear ||
          check.columns.length !== check.runLength) {
        throw new Error(`随机地图节点、连线或点击区域异常：${JSON.stringify(check)}`);
      }
      if (check.mapType === "map1" &&
          (check.boardMap2 || !check.terrainImage.includes("borderlands-map"))) {
        throw new Error(`第一张地图背景或标题异常：${JSON.stringify(check)}`);
      }
      if (check.mapType === "map2" &&
          (!check.boardMap2 || !check.terrainImage.includes("borderlands-map"))) {
        throw new Error(`第二张地图背景或标题异常：${JSON.stringify(check)}`);
      }
      if (check.mapType === "map3" &&
          (!check.boardMap3 || !check.terrainImage.includes("borderlands-map"))) {
        throw new Error(`第三张地图背景或标题异常：${JSON.stringify(check)}`);
      }
      return check;
    }

    let mapCheck = await checkMapLayout();
    if (!mapCheck.statuses.includes("locked") || mapCheck.rows.length < 2) {
      throw new Error(`随机地图缺少锁定节点或分支行：${JSON.stringify(mapCheck)}`);
    }
    console.log("ok 随机地图按服务端节点与真实连线渲染");

    const mapSnapshot = await evaluate(
      "JSON.stringify({phase:state.phase,nodeId:state.node.id,completed:state.completed,map:state.map,runLength:state.runLength})"
    );
    await reloadAndContinue("map-view", "刷新后回到选关");
    await waitFor(async () => {
      try {
        return (await evaluate(
          "typeof state !== 'undefined' && !!state && state.phase === 'map' && !document.getElementById('map-view').hidden"
        )) === true;
      } catch (_) {
        return false;
      }
    }, "刷新后恢复地图数据");
    const mapSnapshotAfter = await evaluate(
      "JSON.stringify({phase:state.phase,nodeId:state.node.id,completed:state.completed,map:state.map,runLength:state.runLength})"
    );
    if (mapSnapshotAfter !== mapSnapshot) throw new Error("刷新后地图或遭遇被重新抽取");
    mapCheck = await checkMapLayout();
    console.log("ok 刷新后地图、节点与遭遇保持不变");

    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const keyboardMap = await evaluate(`(() => {
      const node = document.querySelector('.map-node:not(:disabled)');
      node.focus({ preventScroll: true });
      const visible = getComputedStyle(node.querySelector('.map-node-label')).visibility === 'visible';
      const focus = node.matches(':focus-visible');
      node.blur();
      return visible && focus;
    })()`);
    if (!keyboardMap) throw new Error("键盘聚焦地图节点时缺少名称或焦点提示");
    await waitFor(async () => await evaluate("document.getElementById('toast').hidden"), "战斗提示收起");
    await screenshot("ai-game-map.png", "#map-view");

    await command("Emulation.setDeviceMetricsOverride", {
      width: 1024,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(300);
    const overflow = await evaluate("document.documentElement.scrollWidth > window.innerWidth + 1");
    if (overflow) throw new Error("窄窗口出现横向溢出");
    await checkMapLayout();
    await screenshot("ai-game-map-narrow.png", "#map-view");
    await command("Emulation.clearDeviceMetricsOverride");
    await sleep(200);
    console.log("ok 窄窗口下随机地图布局");

    await command("Emulation.setEmulatedMedia", {
      features: [{ name: "hover", value: "none" }, { name: "pointer", value: "coarse" }],
    });
    await command("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await command("Emulation.setDeviceMetricsOverride", {
      width: 667,
      height: 375,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(300);
    const phoneMap = await evaluate(`(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      labels: [...document.querySelectorAll('.map-node:not(:disabled) .map-node-label')]
        .every((label) => getComputedStyle(label).visibility === 'visible'),
      targetSize: [...document.querySelectorAll('.map-node:not(:disabled)')]
        .every((node) => { const rect = node.getBoundingClientRect(); return rect.width >= 44 && rect.height >= 44; }),
    }))()`);
    if (phoneMap.overflow || !phoneMap.labels || !phoneMap.targetSize || !(await evaluate("document.getElementById('orientation-guard').hidden && document.getElementById('size-guard').hidden"))) {
      throw new Error(`手机地图布局、节点标签或点击区域异常：${JSON.stringify(phoneMap)}`);
    }
    await checkMapLayout();
    await screenshot("ai-game-map-phone.png", "#map-view");
    await command("Emulation.clearDeviceMetricsOverride");
    await command("Emulation.setEmulatedMedia", { features: [] });
    await command("Emulation.setTouchEmulationEnabled", { enabled: false });
    await sleep(200);
    console.log("ok 横屏手机地图节点可点击且页面不滚动");

    const routeInfo = await evaluate(`(() => {
      const nodes = Object.fromEntries(state.map.nodes.map((node) => [node.id, node]));
      const adjacency = {};
      for (const edge of state.map.edges) (adjacency[edge.from] ||= []).push(edge.to);
      const find = (start, goal) => {
        const queue = [[start, [start]]];
        const seen = new Set([start]);
        while (queue.length) {
          const [id, path] = queue.shift();
          if (id === goal) return path;
          for (const child of adjacency[id] || []) {
            if (!seen.has(child)) { seen.add(child); queue.push([child, path.concat(child)]); }
          }
        }
        return null;
      };
      const elite = state.map.nodes.find((node) => node.role === 'elite').id;
      const boss = state.map.nodes.find((node) => node.role === 'boss').id;
      const start = state.completed[state.completed.length - 1];
      const route = find(start, elite).slice(1).concat(find(elite, boss).slice(1));
      return {
        elite,
        boss,
        start,
        route,
        types: route.map((id) => nodes[id].type),
        available: state.map.available,
      };
    })()`);
    if (!routeInfo.route.length || routeInfo.route[routeInfo.route.length - 1] !== routeInfo.boss) {
      throw new Error(`无法规划完整路线：${JSON.stringify(routeInfo)}`);
    }
    const firstSiblings = routeInfo.available.filter((id) => id !== routeInfo.route[0]);
    const visited = [routeInfo.start];
    const eventViews = {
      recruit: "recruit-view", signal: "signal-view", adventure: "adventure-view",
      calibration: "adventure-view", drones: "adventure-view", drift: "drift-view",
      recycle: "recycle-view", shop: "shop-view", trial: "trial-view",
      relay: "relay-view", training: "training-view",
    };
    const leaveButtons = {
      recruit: "#recruit-leave", signal: "#signal-leave", adventure: "#adventure-leave",
      calibration: "#adventure-leave", drones: "#adventure-leave", drift: "#drift-leave",
      recycle: "#recycle-leave", shop: "#shop-leave", trial: "#trial-leave",
      relay: "#relay-leave", training: "#training-leave",
    };

    async function storyToNode() {
      for (let index = 0; index < 16; index += 1) {
        if ((await evaluate("state.phase")) === "node") return;
        if (await visible("story-view")) await advanceVisibleStory();
        await sleep(250);
      }
      throw new Error("剧情未进入节点界面");
    }

    for (let step = 0; step < routeInfo.route.length; step += 1) {
      const target = routeInfo.route[step];
      await waitFor(async () => await visible("map-view"), "选关界面");
      await click('.map-node[data-id="' + target + '"]');
      await storyToNode();
      const node = await evaluate("state.node");
      visited.push(node.id);
      if (node.type === "battle") {
        const deckBeforeElite = node.role === "elite" ? await evaluate("state.deck.length") : null;
        await storyUntil("battle-view");
        await winBattle();
        await click("#result-action");
        if (node.role === "elite") {
          await waitFor(async () => await visible("elite-reward-view"), "精英奖励界面");
          const reward = await evaluate(`({
            offers: document.querySelectorAll('#elite-offers .offer').length,
            deck: state.deck.map((card) => card.uid),
            candidates: [...document.querySelectorAll('#elite-offers .offer-name')].map((node) => node.textContent),
            note: document.getElementById('elite-note').textContent,
          })`);
          if (reward.offers !== 3 || reward.deck.length !== deckBeforeElite) {
            throw new Error(`精英奖励界面异常：${JSON.stringify({ deckBeforeElite, reward })}`);
          }
          await screenshot("ai-game-elite-reward.png", "#elite-reward-view");
          await click("#elite-offers .offer .buy-btn");
          await waitFor(async () => await visible("story-view"), "领取精英奖励后剧情");
          const afterReward = await evaluate("({deck:state.deck, phase:state.phase, elite:state.eliteReward})");
          const uids = afterReward.deck.map((card) => card.uid);
          if (afterReward.deck.length !== reward.deck.length + 1 ||
              new Set(uids).size !== uids.length || reward.deck.includes(uids[uids.length - 1]) ||
              afterReward.elite !== null) {
            throw new Error(`精英奖励未作为独立实体加入牌组：${JSON.stringify({ reward, afterReward })}`);
          }
          await storyUntil("map-view");
          const eliteStatus = await evaluate(
            `state.map.nodes.find((node) => node.id === ${JSON.stringify(routeInfo.elite)}).status`
          );
          if (eliteStatus !== "completed") throw new Error(`精英节点状态错误：${eliteStatus}`);
          console.log("ok 精英战胜利后三选一奖励进入独立卡牌实体");
        } else if (node.role === "boss") {
          await waitFor(async () => (await evaluate("state.phase")) !== "node", "终点战结算");
          const done = await evaluate(`({
            phase: state.phase,
            mapType: state.mapType,
            completed: state.completed,
            runLength: state.runLength,
          })`);
          if (done.mapType !== "map1" || done.completed.length !== done.runLength ||
              visited.length !== done.runLength || visited.some((id) => !done.completed.includes(id))) {
            throw new Error(`第一张地图路线完成状态异常：${JSON.stringify({ visited, done })}`);
          }
          await storyUntil("map-view");
          const entered = await evaluate(`({
            phase: state.phase, mapType: state.mapType, canStartMap2: state.canStartMap2,
            gold: state.gold, deck: state.deck.length, available: state.map.available,
            start: state.node.id, battleHidden: document.getElementById('battle-view').hidden,
          })`);
          if (entered.mapType !== "map2" || entered.canStartMap2 || entered.gold < 0 ||
              entered.deck <= 8 || entered.phase !== "map" || entered.available.length !== 1 ||
              entered.available[0] !== entered.start || !entered.battleHidden) {
            throw new Error(`自动进入第二张地图状态异常：${JSON.stringify(entered)}`);
          }
    console.log("ok 第一张地图通关后自动进入第二张地图");
        } else {
          await storyUntil("map-view");
        }
      } else if (node.type === "supply") {
        await storyUntil("supply-view");
        const deckBefore = await evaluate("state.deck.length");
        for (let round = 1; round <= 2; round += 1) {
          const offers = await evaluate("document.querySelectorAll('#supply-offers .offer').length");
          if (offers !== 3) throw new Error(`补给候选数量异常：${offers}`);
          await click("#supply-offers .buy-btn");
          await waitFor(() => evaluate(`!busy && state.deck.length === ${deckBefore + round}`), "领取补给卡");
        }
        if (await evaluate("state.phase === 'node' && state.supply?.stage === 'option'")) {
          await click("#supply-option-skip");
        }
        await waitFor(() => visible("map-view"), "补给结算回地图");
        console.log("ok 补给站两轮三选一、永久加卡与附加事件离开");
      } else {
        const viewId = eventViews[node.type];
        if (!viewId || !leaveButtons[node.type]) throw new Error(`未知奇遇类型：${node.type}`);
        await storyUntil(viewId);
        await click(leaveButtons[node.type]);
        await waitFor(async () => await visible("story-view"), "奇遇离开后剧情");
        await storyUntil("map-view");
      }
      if (step === 0 && firstSiblings.length) {
        const closed = await evaluate(`(${JSON.stringify(firstSiblings)}).every((id) => {
          const node = document.querySelector('.map-node[data-id="' + id + '"]');
          return node && node.classList.contains('status-closed') && node.disabled;
        })`);
        if (!closed) throw new Error(`未选分支未关闭：${JSON.stringify(firstSiblings)}`);
      }
    }

    console.log("ok 随机分支选择、单路收束与完整路线");

    await click('.map-node[data-id="' + await evaluate("state.node.id") + '"]');
    await waitFor(async () => await visible("story-view"), "第二张地图起点战前剧情");
    await storyUntil("battle-view");
    await winBattle();
    await click("#result-action");
    await storyUntil("map-view");
    const map2Check = await checkMapLayout();
    if (map2Check.mapType !== "map2" || map2Check.runLength !== 15 ||
        map2Check.columns.length !== 15 || !map2Check.boardMap2 ||
        !map2Check.eyebrow.includes("第二章") || !map2Check.cartouche.includes("回声长廊") ||
        !map2Check.destination.includes("回声闸门")) {
      throw new Error(`第二张地图界面异常：${JSON.stringify(map2Check)}`);
    }
    await screenshot("ai-game-map2.png", "#map-view");
    const map2Snapshot = await evaluate(
      "JSON.stringify({phase:state.phase,mapType:state.mapType,seed:state.map.seed,map:state.map})"
    );
    await reloadAndContinue("map-view", "刷新后回到第二张地图");
    await waitFor(async () => {
      try {
        return (await evaluate(
          "typeof state !== 'undefined' && !!state && state.phase === 'map' && state.mapType === 'map2' && !document.getElementById('map-view').hidden"
        )) === true;
      } catch (_) {
        return false;
      }
    }, "刷新后恢复第二张地图数据");
    const map2After = await evaluate(
      "JSON.stringify({phase:state.phase,mapType:state.mapType,seed:state.map.seed,map:state.map})"
    );
    if (map2After !== map2Snapshot) throw new Error("刷新后第二张地图被重新抽取");
    await checkMapLayout();
    console.log("ok 第二张地图共用地图控件、仅背景变化并在刷新后保持");

    ws.close();
    console.log("浏览器冒烟测试全部通过");
  } finally {
    try {
      execFileSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
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
