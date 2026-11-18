/** Battle layout regression. Run against an isolated DATA_DIR server on port 8099. */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

const base = process.env.BASE_URL || 'http://127.0.0.1:8099';
const port = Number(process.env.CDP_PORT || 9233);
const output = path.resolve(process.env.SCREENSHOT_DIR || '.verify-battle-layout');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'battle-layout-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = spawn(process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let ws;
  try {
    let targets;
    for (let i = 0; i < 60; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; }
      catch { await sleep(150); }
    }
    assert(targets?.length, 'Browser CDP unavailable');
    ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    const errors = [];
    let confirmNext = false;
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(Error(`${method} timeout`)); }, 15000);
      pending.set(key, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
    ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const call = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) call.reject(Error(msg.error.message)); else call.resolve(msg.result);
      }
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args);
      if (msg.method === 'Page.javascriptDialogOpening' && confirmNext) {
        confirmNext = false;
        command('Page.handleJavaScriptDialog', { accept: true });
      }
    };
    const evaluate = async expression => {
      const r = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const wait = async expression => {
      for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await sleep(100); }
      throw Error(`Timed out: ${expression}`);
    };
    const resize = async (width, height) => {
      await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await sleep(280);
    };
    const capture = async name => {
      const r = await command('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(r.data, 'base64'));
    };
    const click = async selector => {
      const p = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
      await sleep(260);
    };
    const drag = async (cardId, side, column) => {
      if (!await evaluate(`document.getElementById('hand-dock').classList.contains('is-open')`)) await click('#hand-toggle');
      const p = await evaluate(`(() => {
        const card = battle.hand.find(c => c.cardId === ${JSON.stringify(cardId)});
        const el = document.querySelector('#hand [data-uid="'+card.uid+'"]');
        el.scrollIntoView({block:'nearest',inline:'nearest'});
        const a=el.getBoundingClientRect(), b=document.querySelector('#${side}-row [data-column="${column}"]').getBoundingClientRect();
        return {x:a.x+a.width/2,y:a.y+a.height/2,tx:b.x+b.width/2,ty:b.y+b.height/2};
      })()`);
      await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 16; i++) {
        await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x:p.x+(p.tx-p.x)*i/16, y:p.y+(p.ty-p.y)*i/16, button:'left', buttons:1 });
        await sleep(25);
      }
      await command('Input.dispatchMouseEvent', { type:'mouseMoved',x:p.tx,y:p.ty,button:'left',buttons:1 });
      await command('Input.dispatchMouseEvent', { type:'mouseReleased',x:p.tx,y:p.ty,button:'left',clickCount:1 });
      await wait('!busy');
    };
    await command('Page.enable');
    await command('Runtime.enable');
    await resize(1440, 900);
    await command('Page.navigate', { url:base });
    await wait(`typeof renderBattle === 'function' && document.readyState === 'complete'`);
    const content = JSON.parse(fs.readFileSync(path.join(__dirname, '../content/game.json'), 'utf8'));
    const unitIds = Object.keys(content.cards).filter(id => content.cards[id].type === 'unit');
    const enemyIds = Object.keys(content.enemies);
    const artCheck = await evaluate(`(async () => {
      const root = document.createElement('div');
      root.className = 'card-offer';
      root.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none';
      document.body.append(root);
      try {
        const ids = ${JSON.stringify(unitIds.concat(enemyIds))};
        root.innerHTML = ids.map(cardId => cardFaceHtml({cardId, type:'unit'})).join('');
        const images = [...root.querySelectorAll('img')];
        await Promise.all(images.map(img => img.decode()));
        return images.length === 30 && images.every((img, i) => {
          const css = getComputedStyle(img);
          const expected = ${JSON.stringify(enemyIds)}.includes(ids[i]) ? 'enemy-' + ids[i] : CARD_ART[ids[i]];
          return expected && new URL(img.src).pathname === '/assets/cards/' + expected + '.png' &&
            img.naturalWidth > 0 && css.transform === 'none' && !/sepia|hue-rotate|saturate/.test(css.filter);
        }) && getComputedStyle(document.querySelector('.title-drone')).transform === 'none';
      } finally { root.remove(); }
    })()`);
    assert(artCheck, 'All 30 unit sprites must load without rotation, mirroring or recoloring');
    console.log('ok all 30 unit sprites load in shared battle/event card art');
    // Real API state in a fresh browser profile; never overwrite an existing account/save.
    await evaluate(`(async () => {
      const account = 'layout_' + Date.now().toString(36);
      const auth = await api('/api/register', {username:account,password:'layout-test-only-123'});
      let data = await api('/api/save-slots/1/select', {});
      for (let i=0;i<30 && data.state.phase!=='node';i++) {
        const s=data.state;
        if(s.phase==='transition') data=await api('/api/story/advance',{transition:true});
        else if(s.phase==='map') data=await api('/api/map/select',{nodeId:s.map.available[0]});
        else if(s.story?.options?.length) data=await api('/api/story/choose',{optionId:s.story.options[0].id});
        else data=await api('/api/story/advance',{skip:true});
      }
      await api('/api/battle/start',{});
      await api('/api/battle/tutorial',{skip:true});
      let current=await api('/api/battle/start',{});
      const shell=current.battle.hand.find(c=>c.cardId==='shell');
      await api('/api/battle/deploy',{uid:shell.uid,column:2});
      current=await api('/api/battle/end',{});
      const worker=current.battle.hand.find(c=>c.cardId==='worker');
      data=await api('/api/battle/deploy',{uid:worker.uid,column:4});
      username=auth.username; screen='game'; apply(data);
      return true;
    })()`);
    await sleep(350);
    await capture('after-closed');
    await click('#hand-toggle');
    await capture('after-hand');
    await resize(2048,1139);
    await evaluate(`document.getElementById('hand-dock').classList.remove('is-open'); document.getElementById('hand-toggle').setAttribute('aria-expanded','false'); true;`);
    await capture('after-2048-closed');
    await evaluate(`document.getElementById('hand-dock').classList.add('is-open'); document.getElementById('hand-toggle').setAttribute('aria-expanded','true'); true;`);
    await sleep(220);
    await capture('after-2048-open');

    // Exact geometry, rendered data and hit targets, not merely CSS declarations.
    for (const [width,height] of [[2048,1139],[1440,900],[1024,600],[667,375]]) {
      await resize(width,height);
      for (const open of [false,true]) {
        await evaluate(`document.getElementById('hand-dock').classList.toggle('is-open',${open}); document.getElementById('hand-toggle').setAttribute('aria-expanded','${open}'); true;`);
        await sleep(250);
        const result = await evaluate(`(() => {
          const rect=s=>document.querySelector(s).getBoundingClientRect();
          const table=rect('#battle-table'), enemy=rect('#enemy-row'), player=rect('#player-row');
          const eh=rect('.leader.enemy'),ph=rect('.leader.player'),status=rect('.turn-box'),top=rect('.topbar'),footer=rect('.battle-bottom');
          const hand=rect('#hand'), toggle=rect('#hand-toggle'),actions=rect('.battle-actions');
          const cols=[...document.querySelectorAll('#forecast-row [data-column]')].map(el=>el.getBoundingClientRect());
          const aligned=['enemy','player'].every(side=>[...document.querySelectorAll('#'+side+'-row .slot')].every(el=>{
            const r=el.getBoundingClientRect(),i=Number(el.dataset.column)-1,w=Number(el.dataset.width||1);
            return Math.abs(r.left-cols[i].left)<1 && Math.abs(r.right-cols[i+w-1].right)<1;
          }));
          const visible=s=>{ const el=document.querySelector(s),r=el.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest(s)===el; };
          const cards=[...document.querySelectorAll('#hand .card')];
          const metrics=cards.every(c=>{const f=c.querySelector('.card-face').getBoundingClientRect();return [...c.querySelectorAll('.card-cost,.card-name,.card-art,.card-stats,.card-metrics')].every(el=>{const r=el.getBoundingClientRect();return r.bottom<=f.bottom+1 && r.top>=f.top;});});
          return {table:[table.x,table.y,table.width,table.height],aligned,
            grids: {forecast:cols.map(r=>[r.left,r.right]), enemy:[...document.querySelectorAll('#enemy-row .slot')].map(e=>[e.dataset.column,e.getBoundingClientRect().left,e.getBoundingClientRect().right,e.style.gridColumn]), player:[...document.querySelectorAll('#player-row .slot')].map(e=>[e.dataset.column,e.getBoundingClientRect().left,e.getBoundingClientRect().right,e.style.gridColumn])},
            hpAligned:Math.abs((eh.y+eh.height/2)-(enemy.y+enemy.height/2))<1 && Math.abs((ph.y+ph.height/2)-(player.y+player.height/2))<1,
            hpOutside:eh.right<enemy.left && ph.right<player.left,
            statusCentered:Math.abs((status.x+status.width/2)-innerWidth/2)<1 && status.top>=top.bottom,
            footerClear:footer.top>=table.bottom && actions.left>=toggle.right+6 && actions.right<=innerWidth,
            handClear:!${open} || (hand.bottom<toggle.top && hand.top>=rect('#forecast-row').bottom-1 && hand.left>=ph.right && hand.right<=table.right+1),
            handCount:cards.length===battle.hand.length && Number(document.getElementById('hand-count').textContent)===cards.length,
            metrics,controlsClickable:visible('#hand-toggle') && visible('#end-turn') && visible('#recycle-btn'),
            hpData:Number(document.getElementById('enemy-hp').textContent)===battle.hp.enemy && Number(document.getElementById('player-hp').textContent)===battle.hp.player,
            hudData:document.getElementById('hud-user').textContent===username && !/undefined|NaN/.test(document.querySelector('.hud').textContent),
            overflow:document.documentElement.scrollWidth>innerWidth+1 || document.documentElement.scrollHeight>innerHeight+1,
            artLoaded:[...document.querySelectorAll('#battle-view img')].every(el=>el.complete && el.naturalWidth>0),
            unitData:['enemy','player'].every(side=>battle.board[side].every((u,i)=>!u||u.column!==i+1||document.querySelector('#'+side+'-row [data-column="'+u.column+'"]')?.dataset.uid===String(u.uid))),
            leaderCells:['enemy','player'].every(side=>{
              const el=document.querySelector('.leader.'+side),cells=[...el.querySelectorAll('.leader-cells i')];
              const max=state.node.leaderMaxHp[side];
              return cells.length===max && cells.filter(c=>c.classList.contains('filled')).length===battle.hp[side] &&
                cells.every((c,i)=>c.classList.contains('filled')===(i<battle.hp[side])) && el.querySelector('.leader-max').textContent==='/ '+max;
            }),
            leaderGauge:['enemy','player'].every(side=>{
              const el=document.querySelector('.leader.'+side),r=el.getBoundingClientRect(),g=el.querySelector('.leader-cells').getBoundingClientRect();
              const value=el.querySelector('b').textContent,max=el.querySelector('.leader-max').textContent;
              return [...el.querySelectorAll(':scope > span,:scope > b,.leader-max')].every(label=>getComputedStyle(label).visibility==='hidden') &&
                value===String(battle.hp[side]) && max.trim()==='/ '+state.node.leaderMaxHp[side] && g.width>=24 && g.height>=72 && g.height>g.width &&
                Math.abs(g.x+g.width/2-r.x-r.width/2)<2 && Math.abs(g.y+g.height/2-r.y-r.height/2)<2;
            }),
            terminalClear:[...document.querySelectorAll('.slot.unit')].every(el=>{
              const dossier=el.querySelector('.unit-dossier').getBoundingClientRect(),mechanic=el.querySelector('.unit-mechanic').getBoundingClientRect(),status=el.querySelector('.unit-status').getBoundingClientRect(),r=el.getBoundingClientRect();
              return dossier.top>=r.top && dossier.bottom<=r.bottom && mechanic.top>=dossier.top && mechanic.bottom<=status.top+1 && status.bottom<=dossier.bottom && el.querySelector('.unit-atk') && el.querySelector('.unit-durability') && el.querySelector('.unit-level') && el.textContent.includes('UNIT ID') && el.textContent.includes('ONLINE');
            }),
            forecastData:battle.forecast.every(item=>{
              const cell=document.querySelector('#forecast-row [data-slot="'+item.slot+'"]');
              return [...cell.querySelectorAll('.forecast-item')].some(el=>{
                return el.classList.contains('next') && el.textContent.includes('候补') && !el.textContent.includes('已部署') && !el.textContent.includes('部署受阻') && el.textContent.includes(item.name) && el.textContent.includes('攻 '+item.atk) && el.textContent.includes('耐 '+item.hp) && el.textContent.includes(traitText(item,true));
              });
            })
          };
        })()`);
        if (!open) globalThis.closedTable = result.table;
        assert.deepEqual(result.table,globalThis.closedTable,`Hand changes table geometry ${width}`);
        for (const [key,value] of Object.entries(result)) if (key!=='table' && key!=='grids') assert.equal(value,key==='overflow'?false:true,`${width}x${height} hand ${open}: ${key} ${JSON.stringify(result)}`);
      }
      await capture(`after-${width}`);
      console.log(`ok ${width}x${height}: columns, HP, hand overlay, footer, art, HUD and hit targets`);
    }
    await resize(1440,900);
    const selectable = await evaluate(`document.querySelector('#hand .card[data-type="unit"]')?.dataset.uid`);
    await click(`#hand .card[data-uid="${selectable}"]`);
    assert.equal(await evaluate(`document.querySelector('#hand .card[data-uid="${selectable}"]').classList.contains('selected')`),true,'Hand card click selection stopped working');
    await click(`#hand .card[data-uid="${selectable}"]`);
    await click('#hand-toggle');
    console.log('ok hand card selection');
    // Recycle and wide deployment use the original event bindings and server rules.
    await click('#recycle-btn');
    assert.equal(await evaluate('recycleMode && document.getElementById("recycle-btn").classList.contains("active")'),true);
    confirmNext=true;
    await click('#player-row [data-column="2"]');
    await wait('!busy && !battle.board.player[1]');
    await click('#end-turn');
    await wait('!busy && battle.energy >= 3');
    await drag('twin_rail','player',1);
    await wait(`!busy && battle.board.player[0]?.cardId === 'twin_rail'`);
    await sleep(300);
    const wideGeometry=await evaluate(`(() => { const el=document.querySelector('#player-row [data-column="1"]'); const r=el.getBoundingClientRect(); const c=[...document.querySelectorAll('#forecast-row [data-column]')].map(e=>e.getBoundingClientRect()); return {same:battle.board.player[0].uid===battle.board.player[1].uid,width:el.dataset.width,grid:el.style.gridColumn,unit:[r.left,r.right],cols:c.map(x=>[x.left,x.right])}; })()`);
    assert.equal(wideGeometry.same && Number(wideGeometry.width)===2 && Math.abs(wideGeometry.unit[0]-wideGeometry.cols[0][0])<3 && Math.abs(wideGeometry.unit[1]-wideGeometry.cols[1][1])<3,true,`Wide unit does not span the state columns: ${JSON.stringify(wideGeometry)}`);
    const turn=await evaluate('battle.turn');
    await click('#end-turn');
    await wait(`!busy && battle.turn === ${turn+1}`);
    assert.equal(await evaluate(`Number(document.getElementById('turn').textContent)===battle.turn && Number(document.getElementById('energy').textContent)===battle.energy && Number(document.getElementById('deck-count').textContent)===battle.deckCount && Number(document.getElementById('player-hp').textContent)===battle.hp.player && Number(document.getElementById('enemy-hp').textContent)===battle.hp.enemy`),true,'Live battle data did not update');
    await capture('after-wide');
    console.log('ok real mouse drag, two-column deployment, recycle confirmation and end-turn live data');

    const skinStates=await evaluate(`(() => {
      const unit=battle.board.player.find(Boolean),hp=unit.hp,atk=unit.atk;
      unit.hp=Math.max(0,hp-1);unit.atk=atk+1;renderBattle();
      const el=document.querySelector('#player-row [data-uid="'+unit.uid+'"]');
      const flashed=el.classList.contains('just-damaged') && el.classList.contains('just-boosted') && el.classList.contains('is-damaged');
      const enemyHp=battle.hp.enemy;
      const counts=[0,1,state.node.leaderMaxHp.enemy].every(value=>{battle.hp.enemy=value;renderBattle();return document.querySelectorAll('.leader.enemy .filled').length===value && document.querySelector('.leader.enemy').classList.contains('is-critical')===(value<=state.node.leaderMaxHp.enemy/3);});
      unit.hp=hp;unit.atk=atk;battle.hp.enemy=enemyHp;renderBattle();
      return flashed && counts && !document.querySelector('.slot.just-damaged,.slot.just-boosted');
    })()`);
    assert(skinStates,'Damage/boost or zero/full/critical leader states failed');
    await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.slot.unit'),'::before').animationName`),'none');
    const saved=await evaluate('JSON.stringify([battle.hp,battle.board,state.node.leaderMaxHp])');
    await command('Page.reload');
    await wait('document.readyState === "complete" && document.getElementById("menu-view") && !document.getElementById("menu-view").hidden');
    await click('#continue-btn');
    await wait('battle && !document.getElementById("battle-view").hidden');
    assert.equal(await evaluate('JSON.stringify([battle.hp,battle.board,state.node.leaderMaxHp])'),saved,'Refresh changed battle or leader capacity');
    console.log('ok terminal/forecast content, health cells, damage/boost, reduced motion and refresh restoration');

    const fallback=await evaluate(`(() => { const original=state; state={...state,node:{},progress:undefined,runLength:undefined,gold:undefined}; render(); const text=document.querySelector('.hud').textContent; state=original; render(); return !/undefined|NaN/.test(text) && text.includes('当前节点') && text.includes('—'); })()`);
    assert(fallback,'Missing HUD fields leak undefined');
    const counts=await evaluate(`(() => {
      const original=battle.hand;
      const card=original[0];
      const results=[0,1,10].map(count=>{ battle.hand=Array.from({length:count},(_,i)=>({...card,uid:10000+i}));renderBattle();return Number(document.getElementById('hand-count').textContent)===count && document.querySelectorAll('#hand .card').length===count; });
      battle.hand=original; renderBattle(); return results.every(Boolean);
    })()`);
    assert(counts,'Empty/single/full hand rendering failed');
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('ok missing HUD fields, 0/1/10 card counts, no browser console errors');
    console.log(`Screenshots: ${output}`);
  } finally {
    ws?.close();
    try { execFileSync('taskkill',['/PID',String(browser.pid),'/T','/F'],{stdio:'ignore'}); } catch {}
    try { fs.rmSync(profile,{recursive:true,force:true}); } catch {}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
