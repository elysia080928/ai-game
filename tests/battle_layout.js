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
    const capture = async (name, clip) => {
      const r = await command('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, ...(clip && {clip}) });
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
        const aircraft = new Set(['flyer','phase_flyer','phase_hunter']);
        return images.length === 30 && images.every((img, i) => {
          const css = getComputedStyle(img);
          const expected = ${JSON.stringify(enemyIds)}.includes(ids[i]) ? 'enemy-' + ids[i] : CARD_ART[ids[i]];
          return expected && new URL(img.src).pathname === '/assets/cards/' + expected + '.png' &&
            img.naturalWidth > 0 && css.transform === 'none' &&
            css.rotate === (aircraft.has(ids[i]) ? '180deg' : 'none') &&
            !/sepia|hue-rotate|saturate/.test(css.filter);
        }) && !document.querySelector('.title-drone');
      } finally { root.remove(); }
    })()`);
    assert(artCheck, 'All 30 unit sprites must load without rotation, mirroring or recoloring');
    console.log('ok all 30 unit sprites load in shared battle/event card art');
    const dossierCheck = await evaluate(`(() => {
      const ids = ${JSON.stringify(unitIds.concat(enemyIds))};
      const complete = ids.length === 30 && ids.every(id => {
        const entry = UNIT_DOSSIERS[id];
        return entry && entry.tags.length && entry.description;
      });
      const flyer = UNIT_DOSSIERS.phase_flyer;
      const rendered = unitHtml({uid:1,cardId:'phase_flyer',name:'相位飞行器',level:1,atk:2,hp:2,maxHp:2,column:1,width:1,side:'player'},'player',1);
      return complete && UNIT_DOSSIERS.flyer.tags.includes('飞行') &&
        flyer.tags.includes('飞行') && flyer.description.includes('攻击') && flyer.description.includes('对空') &&
        rendered.includes('unit-tag') && rendered.includes('unit-intro');
    })()`);
    assert(dossierCheck, 'All unit dossiers need tags and descriptions, with explicit flying rules');
    console.log('ok all 30 unit dossiers include tags and descriptions');
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
              const counter=el.querySelector('b'),value=counter.textContent,max=el.querySelector('.leader-max').textContent;
              return getComputedStyle(counter).visibility==='visible' && counter.getBoundingClientRect().top>=g.bottom &&
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
    await resize(667,375);
    await evaluate(`(() => {
      globalThis.dossierPreviousBattle=battle;
      const fixture=JSON.parse(JSON.stringify(battle));
      const make=(cardId,name,uid,side,column)=>({uid,cardId,name,level:1,atk:2,hp:2,maxHp:3,column,width:1,side,attackPattern:cardId==='mirror_core'?'sweep':'forward',abilities:['phase_flyer','phase_hunter'].includes(cardId)?['flying']:[],shield:cardId==='mirror_core'?2:0,guard:0,shift:0,anchor:0});
      fixture.board.player=[make('phase_flyer','相位飞行器',9101,'player',1),make('mirror_core','镜像核心',9102,'player',2),make('double_claw','双爪维修兽',9103,'player',3),make('burst_beetle','爆裂甲虫',9104,'player',4)];
      fixture.board.enemy=[make('phase_hunter','相位猎手',9201,'enemy',1),make('null_anchor','空间锚',9202,'enemy',2),make('drift_hunter','漂移猎手',9203,'enemy',3),make('mirror_drone','镜像无人机',9204,'enemy',4)];
      battle=fixture; renderBattle(); return true;
    })()`);
    const dossierLayout = await evaluate(`(() => {
      const units=[...document.querySelectorAll('.slot.unit')];
      const details=units.map(el=>{
        const dossier=el.querySelector('.unit-dossier').getBoundingClientRect(),mechanic=el.querySelector('.unit-mechanic').getBoundingClientRect(),tags=el.querySelector('.unit-tags').getBoundingClientRect(),intro=el.querySelector('.unit-intro').getBoundingClientRect(),status=el.querySelector('.unit-status').getBoundingClientRect(),row=el.getBoundingClientRect();
        return {id:el.dataset.cardId,tag:el.querySelector('.unit-tags').textContent,intro:el.querySelector('.unit-intro').textContent,fit:dossier.top>=row.top && dossier.bottom<=row.bottom && tags.top>=mechanic.top && tags.bottom<=mechanic.bottom && intro.top>=mechanic.top && intro.bottom<=mechanic.bottom && mechanic.bottom<=status.top+1 && status.bottom<=dossier.bottom,rects:{dossier:[dossier.top,dossier.bottom],row:[row.top,row.bottom],mechanic:[mechanic.top,mechanic.bottom],tags:[tags.top,tags.bottom],intro:[intro.top,intro.bottom],status:[status.top,status.bottom]}};
      });
      return {fit:details.length===8 && details.every(item=>item.fit),details};
    })()`);
    assert(dossierLayout.fit, `Compact unit dossiers overflowed: ${JSON.stringify(dossierLayout.details)}`);
    const dossierHandOpen = await evaluate(`$('hand-dock').classList.contains('is-open')`);
    await evaluate(`$('hand-dock').classList.remove('is-open'); true`);
    await capture('dossiers-667');
    if (dossierHandOpen) await evaluate(`$('hand-dock').classList.add('is-open'); true`);
    await evaluate(`(() => { battle=globalThis.dossierPreviousBattle; delete globalThis.dossierPreviousBattle; renderBattle(); return true; })()`);
    console.log('ok tagged dossiers fit on narrow landscape with flight and multi-trait units');
    await resize(1440,900);
    const selectable = await evaluate(`document.querySelector('#hand .card[data-type="unit"]')?.dataset.uid`);
    await click(`#hand .card[data-uid="${selectable}"]`);
    assert.equal(await evaluate(`document.querySelector('#hand .card[data-uid="${selectable}"]').classList.contains('selected')`),true,'Hand card click selection stopped working');
    await click(`#hand .card[data-uid="${selectable}"]`);
    await click('#hand-toggle');
    console.log('ok hand card selection');
    await resize(1920,942);
    const discardGeometry=await evaluate(`(() => {
      const original={phase:battle.phase,required:battle.discardRequired,hand:battle.hand};
      const template=battle.hand[0];
      battle.phase='discard'; battle.discardRequired=1;
      battle.hand=Array.from({length:11},(_,i)=>({...template,uid:20000+i})); renderBattle();
      const panel=document.querySelector('#discard-panel .modal'),pr=panel.getBoundingClientRect();
      const cards=[...document.querySelectorAll('#discard-hand .card')].map(el=>({r:el.getBoundingClientRect(),h:el.offsetHeight}));
      const ok=!document.getElementById('discard-panel').hidden && cards.length===11 && pr.top>=0 && pr.bottom<=innerHeight && cards.every(c=>c.h<=180 && c.r.width>=130);
      globalThis.discardTestOriginal=original;
      return {ok,top:pr.top,bottom:pr.bottom,height:pr.height,cards:cards.length,cardHeight:cards[0]?.h};
    })()`);
    await capture('discard-dialog');
    assert(discardGeometry.ok,`Discard dialog overflow or oversized cards: ${JSON.stringify(discardGeometry)}`);
    console.log(`ok 11-card discard dialog fits viewport: ${JSON.stringify(discardGeometry)}`);
    for (const [width, height] of [[1024,600],[667,375]]) {
      await resize(width,height);
      const geometry = await evaluate(`(() => { const modal=document.querySelector('#discard-panel .modal').getBoundingClientRect(),confirm=document.getElementById('discard-confirm').getBoundingClientRect(); return {top:modal.top,bottom:modal.bottom,left:modal.left,right:modal.right,confirmTop:confirm.top,confirmBottom:confirm.bottom,handHeight:document.getElementById('discard-hand').clientHeight,cards:document.querySelectorAll('#discard-hand .card').length}; })()`);
      await capture(`discard-dialog-${width}`);
      assert(geometry.top>=0 && geometry.bottom<=height+1 && geometry.left>=0 && geometry.right<=width+1 && geometry.cards===11, `Discard dialog overflows ${width}x${height}: ${JSON.stringify(geometry)}`);
      assert(geometry.confirmTop>=geometry.top && geometry.confirmBottom<=geometry.bottom, `Discard confirmation is clipped at ${width}x${height}: ${JSON.stringify(geometry)}`);
      assert(geometry.handHeight>=176, `Discard card viewport is too short at ${width}x${height}: ${JSON.stringify(geometry)}`);
    }
    await resize(1440,900);
    await evaluate(`battle.phase=discardTestOriginal.phase; battle.discardRequired=discardTestOriginal.required; battle.hand=discardTestOriginal.hand; delete globalThis.discardTestOriginal; renderBattle(); true;`);
    // Recycle and deployment use the original event bindings and server rules.
    await click('#recycle-btn');
    assert.equal(await evaluate('recycleMode && document.getElementById("recycle-btn").classList.contains("active")'),true);
    confirmNext=true;
    await click('#player-row [data-column="2"]');
    await wait('!busy && !battle.board.player[1]');
    await click('#end-turn');
    await wait('!busy && battle.energy >= 3');
    const dragId = await evaluate(`battle.hand.find(card => card.type === 'unit' && card.width === 1 && card.cost <= battle.energy)?.cardId`);
    assert(dragId, 'Tutorial hand needs an affordable unit for real mouse drag');
    await drag(dragId,'player',1);
    await wait(`!busy && battle.board.player[0]?.cardId === ${JSON.stringify(dragId)}`);
    await evaluate(`globalThis.wideTestOriginal = battle.board.player; const unit = {...battle.board.player[0], cardId:'twin_rail', width:2}; battle.board.player=[unit,unit,...wideTestOriginal.slice(2)]; renderBattle(); true;`);
    await sleep(300);
    const wideGeometry=await evaluate(`(() => { const el=document.querySelector('#player-row [data-column="1"]'); const r=el.getBoundingClientRect(); const c=[...document.querySelectorAll('#forecast-row [data-column]')].map(e=>e.getBoundingClientRect()); return {same:battle.board.player[0].uid===battle.board.player[1].uid,width:el.dataset.width,grid:el.style.gridColumn,unit:[r.left,r.right],cols:c.map(x=>[x.left,x.right])}; })()`);
    assert.equal(wideGeometry.same && Number(wideGeometry.width)===2 && Math.abs(wideGeometry.unit[0]-wideGeometry.cols[0][0])<3 && Math.abs(wideGeometry.unit[1]-wideGeometry.cols[1][1])<3,true,`Wide unit does not span the state columns: ${JSON.stringify(wideGeometry)}`);
    await capture('after-wide');
    await evaluate(`battle.board.player = wideTestOriginal; delete globalThis.wideTestOriginal; renderBattle(); true;`);
    const turn=await evaluate('battle.turn');
    await click('#end-turn');
    await wait(`!busy && (battle.turn === ${turn+1} || battle.phase === 'over')`);
    assert.equal(await evaluate(`Number(document.getElementById('turn').textContent)===battle.turn && Number(document.getElementById('energy').textContent)===battle.energy && Number(document.getElementById('deck-count').textContent)===battle.deckCount && Number(document.getElementById('player-hp').textContent)===battle.hp.player && Number(document.getElementById('enemy-hp').textContent)===battle.hp.enemy`),true,'Live battle data did not update');
    console.log('ok real mouse drag, two-column rendering fixture, recycle confirmation and end-turn live data');

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
    if (process.env.COMBAT_FX_SCREENSHOTS === '1') {
      const ids = unitIds.concat(enemyIds);
      assert.equal(await evaluate(`Object.keys(COMBAT_FX).sort().join() === ${JSON.stringify([...ids].sort().join())}`), true);
      const sample = new Set(['bean','shell','striker','twin_rail','arc_drone','heavy','double_claw','phase_flyer','reach_turret','siege_carrier','mirror_core']);
      const crop = {x: 390, y: 120, width: 680, height: 750, scale: 1};
      const cards = ids.map(cardId => ({ ...content.cards[cardId], ...content.enemies[cardId], cardId }));
      await evaluate(`globalThis.fxOriginal = battle; globalThis.fxFrames = []; true;`);
      for (const [index, card] of cards.entries()) {
        const side = index < unitIds.length ? 'player' : 'enemy';
        const targetSide = side === 'player' ? 'enemy' : 'player';
        const stats = card.levels?.[0] || card;
        const source = {cardId:card.cardId,name:card.name,column:2,width:card.width || 1,uid:9001,side,atk:stats.atk,hp:stats.hp,maxHp:stats.hp};
        const target = {cardId:side === 'player' ? 'defender' : 'shell',name:side === 'player' ? '防守机偶' : '盾壳机器人',column:2,width:1,uid:9002,side:targetSide,atk:1,hp:1,maxHp:4};
        const events = [
          {kind:'attack',source:9001,target:9002,side:targetSide,column:2,pattern:card.attackPattern},
          {kind:'damage',target:9002,side:targetSide,hp:0,amount:1},
        ];
        await evaluate(`(async () => {
          const source=${JSON.stringify(source)},target=${JSON.stringify(target)};
          const row=unit=>[null,unit,unit.width===2?unit:null,null];
          battle={...fxOriginal,board:{[source.side]:row(source),[target.side]:row(target)}};
          renderBattle();
          await Promise.all([...document.querySelectorAll('.slot.unit img')].map(img=>img.decode()));
          const table=$('battle-table'), phases=[];
          const observe=new MutationObserver(records=>{
            for(const {target:el} of records){
              if(!el.isConnected) continue;
              const name=getComputedStyle(el).animationName;
              if(name==='combat-lunge') phases.push([name,el.style.getPropertyValue('--fx-end')]);
              if(name==='combat-cue'||name.startsWith('combat-flight')||name==='combat-impact'||name==='combat-dust') phases.push([name,el.dataset.shape]);
              if(name==='combat-impact'){ globalThis.fxImpactMarker=el; el.getAnimations().forEach(animation=>{animation.pause();animation.currentTime=128;}); }
              if(name==='combat-dust'){ globalThis.fxDeathMarker=el; el.getAnimations().forEach(animation=>{animation.pause();animation.currentTime=105;}); }
            }
          });
          observe.observe(table,{subtree:true,attributes:true,attributeFilter:['class']});
          globalThis.fxPlayback=replayCombat(${JSON.stringify(events)}).finally(()=>observe.disconnect());
          globalThis.fxPhases=phases;
          return true;
        })()`);
        if (sample.has(card.cardId)) {
          for (const [phase, selector, time] of [
            ['attack','#battle-table :is([class*="combat-flight"],.combat-lunge)',100],
            ['impact','#battle-table .combat-impact',128],
            ['death','#battle-table .combat-dust',92],
          ]) {
            try {
              await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
            } catch (error) {
              throw Error(`${error.message}: ${await evaluate(`JSON.stringify({phases:fxPhases,units:[...document.querySelectorAll('.slot.unit')].map(el=>[el.dataset.cardId,el.dataset.hp]),markers:[...document.querySelectorAll('.combat-marker')].map(el=>[el.className,el.dataset.shape]),aborted:combatPlayback?.signal.aborted})`)}`);
            }
            await evaluate(`(() => {
              const animations=$('battle-table').getAnimations({subtree:true});
              animations.forEach(animation=>{animation.pause();animation.currentTime=Math.min(${time},animation.effect.getTiming().duration-1);});
              return true;
            })()`);
            await capture(`fx-${card.cardId}-${phase}`, crop);
            if(phase==='impact') await evaluate('fxImpactMarker?.getAnimations().forEach(animation=>animation.play()); true;');
            if(phase==='death') await evaluate('fxDeathMarker?.getAnimations().forEach(animation=>animation.play()); true;');
            await evaluate(`$('battle-table').getAnimations({subtree:true}).forEach(animation=>animation.play()); true;`);
          }
        }
        const phases = await evaluate('fxPlayback.then(()=>fxPhases)');
        const profile = await evaluate(`COMBAT_FX[${JSON.stringify(card.cardId)}]`);
        assert(phases.some(([name, shape]) => name === 'combat-impact' && shape === profile.impact), JSON.stringify([card.cardId, phases]));
        assert(phases.some(([name, shape]) => name === (profile.path ? 'combat-flight-' + profile.path : 'combat-cue') && shape === profile.cue), JSON.stringify([card.cardId, phases]));
        assert(phases.some(([name, pose]) => name === 'combat-lunge' && pose.includes(`${(side === 'player' ? -1 : 1) * profile.end[1]}px)`)), JSON.stringify([card.cardId, phases]));
        assert(phases.some(([name]) => name === 'combat-dust'), card.cardId);
        assert(await evaluate('!combatPlayback && !document.querySelector(".combat-marker,.combat-extended")'), card.cardId);
      }
      for (const side of ['player','enemy']) {
        assert(await evaluate(`(() => {
          battle={...fxOriginal,hp:{...fxOriginal.hp,${side}:8}}; renderBattle();
          globalThis.fxPlayback=replayCombat([6,3].map((hp,index)=>({kind:'damage',target:null,leader:true,side:'${side}',hp,amount:index?3:2})));
          return $(${JSON.stringify(side+'-hp')}).textContent==='6';
        })()`));
        assert.equal(await evaluate(`$('damage-overlay').classList.contains('player-damage')`), side === 'player');
        assert.equal(await evaluate(`document.querySelector('.leader.enemy').classList.contains('enemy-damage')`), side === 'enemy');
        assert(await evaluate(`(() => {
          const overlay=$('damage-overlay'), rect=overlay.getBoundingClientRect();
          return rect.left===0 && rect.top===0 && rect.width===innerWidth && rect.height===innerHeight &&
            getComputedStyle(overlay).pointerEvents==='none';
        })()`));
        await capture('fx-leader-' + side);
        await evaluate('fxPlayback.then(()=>true)');
        assert(await evaluate(`$(${JSON.stringify(side+'-hp')}).textContent==='3' && !$('damage-overlay').classList.contains('player-damage')`));
      }
      await evaluate('battle=fxOriginal; delete globalThis.fxOriginal; renderBattle(); true;');
      console.log('ok all 30 combat profiles, both leaders, consecutive damage and animation cleanup');
    }
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
