(() => {
  'use strict';

  const cfg = window.SEAGATE_CONFIG || {};
  const mode = cfg.mode === 'clip' ? 'clip' : 'journey';
  const clipIndex = Math.min(3, Math.max(0, cfg.clip | 0));
  const params = new URLSearchParams(location.search);
  const loop = mode === 'clip' && (cfg.loop === true || params.get('loop') === '1');
  const startAt = params.has('t') ? Number(params.get('t')) : NaN;
  const gameTransition = params.get('gameTransition');
  const showHint = cfg.hint !== false;
  const replayOnClick = cfg.replayOnClick !== false;

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { alpha: false });
  const hint = document.getElementById('hint');

  const SRC = ['frames/01.webp', 'frames/02.webp', 'frames/03.webp', 'frames/04.webp'];
  const FOCUS = [
    [0.500, 0.390],
    [0.500, 0.365],
    [0.500, 0.408],
    [0.500, 0.395]
  ];
  const SEGMENTS = [
    { dur: 3.7, zoom: 2.75 },
    { dur: 3.7, zoom: 2.75 },
    { dur: 3.7, zoom: 2.35 },
    { dur: 4.6, final: true, zoom: 1.7 }
  ];
  const CLIP_DUR = 4.5;
  const CLIP_ZOOM = [2.75, 2.75, 2.35, 1.9];

  const starts = [];
  let JOURNEY_TOTAL = 0;
  for (const s of SEGMENTS) { starts.push(JOURNEY_TOTAL); JOURNEY_TOTAL += s.dur; }
  const TOTAL = mode === 'clip' ? CLIP_DUR : JOURNEY_TOTAL;

  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const smoothstep = (a, b, v) => {
    const x = clamp01((v - a) / (b - a));
    return x * x * (3 - 2 * x);
  };

  let CW = 0, CH = 0;
  let quality = 1;
  let perfAccum = 0, perfFrames = 0;
  let vignette = null;
  let grain = null;
  let mote = null;

  const MOTES = [];
  for (let i = 0; i < 44; i++) {
    MOTES.push({
      a: Math.random() * Math.PI * 2,
      d: Math.random(),
      sp: 0.10 + Math.random() * 0.22,
      sz: 0.7 + Math.random() * 1.5,
      al: 0.18 + Math.random() * 0.38
    });
  }

  function buildOverlays() {
    vignette = ctx.createRadialGradient(CW * 0.5, CH * 0.46, Math.min(CW, CH) * 0.22,
                                        CW * 0.5, CH * 0.46, Math.max(CW, CH) * 0.78);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(0.62, 'rgba(2,8,18,0.10)');
    vignette.addColorStop(1, 'rgba(1,4,10,0.42)');

    const n = document.createElement('canvas');
    n.width = n.height = 160;
    const nc = n.getContext('2d');
    const id = nc.createImageData(160, 160);
    for (let i = 0; i < id.data.length; i += 4) {
      const v = 96 + Math.random() * 64;
      id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
      id.data[i + 3] = 255;
    }
    nc.putImageData(id, 0, 0);
    grain = ctx.createPattern(n, 'repeat');

    const m = document.createElement('canvas');
    m.width = m.height = 32;
    const mc = m.getContext('2d');
    const mg = mc.createRadialGradient(16, 16, 0, 16, 16, 16);
    mg.addColorStop(0, 'rgba(255,255,255,1)');
    mg.addColorStop(0.35, 'rgba(215,238,255,0.55)');
    mg.addColorStop(1, 'rgba(180,220,255,0)');
    mc.fillStyle = mg;
    mc.fillRect(0, 0, 32, 32);
    mote = m;
  }

  function resize() {
    const cw = window.innerWidth;
    const ch = window.innerHeight;
    let dpr = Math.min(window.devicePixelRatio || 1, 1.5) * quality;
    const maxPixels = 1920 * 1080;
    if (cw * ch * dpr * dpr > maxPixels) dpr = Math.sqrt(maxPixels / (cw * ch));

    CW = cw;
    CH = ch;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildOverlays();
    render(time);
  }

  const images = [];
  let ready = false;
  let endNotified = false;

  function notifyGame(type, detail) {
    if (gameTransition && window.parent !== window) {
      window.parent.postMessage({ type: 'seagate-transition-' + type, token: gameTransition, detail }, location.origin);
    }
  }

  function drawImageLayer(img, focus, scale, blur, swayX, swayY, roll, layers) {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const cover = Math.max(CW / iw, CH / ih);
    const fx = focus[0] * CW + swayX;
    const fy = focus[1] * CH + swayY;

    ctx.save();
    ctx.translate(CW / 2, CH / 2);
    ctx.rotate(roll);
    ctx.translate(-CW / 2, -CH / 2);

    for (let i = 0; i < layers; i++) {
      const f = layers === 1 ? 1 : (1 - blur) + blur * (i / (layers - 1));
      const s = cover * scale * f;
      const dw = iw * s;
      const dh = ih * s;
      ctx.globalAlpha = 1 / (i + 1);
      ctx.drawImage(img, fx - focus[0] * dw, fy - focus[1] * dh, dw, dh);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function getShot(t) {
    if (mode === 'clip') {
      const p = clamp01(t / CLIP_DUR);
      const reveal = 1 - smoothstep(0.02, 0.15, p);
      const q = clamp01((p - 0.11) / 0.84);
      const scale = Math.exp(CLIP_ZOOM[clipIndex] * Math.pow(q, 2.6));
      const bloom = Math.pow(smoothstep(0.62, 0.96, p), 1.5);
      const flat = smoothstep(0.87, 0.96, p);
      return {
        i: clipIndex, reveal, q, scale, bloom, flat,
        white: Math.max(reveal, flat), end: 0, isFinal: false
      };
    }

    let segIndex = SEGMENTS.length - 1;
    for (let i = 0; i < SEGMENTS.length; i++) {
      if (t < starts[i] + SEGMENTS[i].dur || i === SEGMENTS.length - 1) { segIndex = i; break; }
    }
    const seg = SEGMENTS[segIndex];
    const p = clamp01((t - starts[segIndex]) / seg.dur);
    const isFinal = !!seg.final;

    const reveal = segIndex > 0 ? 1 - smoothstep(0.03, 0.15, p) : 0;
    const q = clamp01((p - 0.06) / 0.94);
    const scale = Math.exp(seg.zoom * Math.pow(q, isFinal ? 2.3 : 2.6));
    const bloom = isFinal
      ? Math.pow(smoothstep(0.60, 1.0, p), 1.6) * 0.32
      : Math.pow(smoothstep(0.64, 1.0, p), 1.6);
    const flat = isFinal ? 0 : smoothstep(0.87, 0.97, p);
    const end = isFinal ? smoothstep(0.82, 1.0, p) : 0;

    return {
      i: segIndex, p, reveal, q, scale, bloom, flat,
      white: Math.max(reveal, flat), end, isFinal
    };
  }

  function render(t) {
    if (!ready) {
      ctx.fillStyle = mode === 'clip' ? '#fdfeff' : '#000';
      ctx.fillRect(0, 0, CW, CH);
      return;
    }

    const shot = getShot(t);
    const img = images[shot.i];
    const focus = FOCUS[shot.i];

    const swayX = Math.sin(t * 0.55) * 2.2 + Math.sin(t * 1.37) * 1.0;
    const swayY = Math.cos(t * 0.47) * 1.6;
    const roll = Math.sin(t * 0.39) * 0.0011;

    if (shot.white < 0.996) {
      const blur = Math.min(0.36, 0.42 * Math.pow(shot.q, 2.8));
      const layers = blur < 0.015 ? 1 : blur < 0.07 ? 3 : blur < 0.16 ? 4 : 5;
      drawImageLayer(img, focus, shot.scale, blur, swayX, swayY, roll, layers);
    }

    const fx = focus[0] * CW + swayX;
    const fy = focus[1] * CH + swayY;

    const flow = Math.pow(shot.q, 1.6) * (1 - shot.white);
    if (flow > 0.01 && mote) {
      const rx = Math.max(CW, CH) * 0.95;
      const ry = Math.max(CW, CH) * 0.58;
      ctx.globalCompositeOperation = 'lighter';
      for (const m of MOTES) {
        const d = (m.d + shot.i * 0.37 + shot.q * m.sp * 2.4) % 1;
        const size = (m.sz + d * 2.2) * 3.2;
        const alpha = Math.pow(1 - d, 2.2) * m.al * flow;
        if (alpha < 0.008) continue;
        ctx.globalAlpha = alpha;
        ctx.drawImage(mote, fx + Math.cos(m.a) * d * rx - size / 2,
                            fy + Math.sin(m.a) * d * ry - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    const glow = (0.05 + 0.40 * Math.pow(shot.q, 3.0)) * (shot.isFinal ? 0.85 : 1);
    if (glow > 0.01 && shot.white < 0.999) {
      const R = (0.08 + 0.60 * Math.pow(shot.q, 2.0)) * Math.max(CW, CH);
      const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, R);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.42 * glow).toFixed(3) + ')');
      g.addColorStop(0.35, 'rgba(226,242,255,' + (0.18 * glow).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(200,230,255,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, CW, CH);
      ctx.globalCompositeOperation = 'source-over';
    }

    if (shot.reveal > 0.001) {
      const R = (0.35 + 0.55 * shot.reveal) * Math.max(CW, CH);
      const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, R);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.80 * shot.reveal).toFixed(3) + ')');
      g.addColorStop(0.45, 'rgba(248,252,255,' + (0.40 * shot.reveal).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(245,250,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, CW, CH);
    }

    if (shot.bloom > 0.001) {
      const R = (0.08 + 0.85 * Math.pow(shot.q, 2.1)) * Math.max(CW, CH);
      const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, R);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.95 * shot.bloom).toFixed(3) + ')');
      g.addColorStop(0.5, 'rgba(247,251,255,' + (0.72 * shot.bloom).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(240,248,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, CW, CH);
    }

    if (shot.white > 0.001) {
      ctx.fillStyle = 'rgba(253,254,255,' + shot.white.toFixed(3) + ')';
      ctx.fillRect(0, 0, CW, CH);
    }

    if (vignette) {
      ctx.globalAlpha = 1 - shot.white;
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, CW, CH);
      ctx.globalAlpha = 1;
    }

    if (grain) {
      const ox = (t * 61) % 160;
      const oy = (t * 97) % 160;
      ctx.globalAlpha = 0.05;
      ctx.globalCompositeOperation = 'overlay';
      ctx.save();
      ctx.translate(-ox, -oy);
      ctx.fillStyle = grain;
      ctx.fillRect(0, 0, CW + 160, CH + 160);
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    if (shot.end > 0.001) {
      ctx.fillStyle = 'rgba(2,5,10,' + shot.end.toFixed(3) + ')';
      ctx.fillRect(0, 0, CW, CH);
    }

    if (hint && showHint && !loop) {
      hint.classList.toggle('show', t >= TOTAL - 0.05);
    }
  }

  let time = 0;
  let playing = false;
  let raf = 0;
  let last = 0;

  function tick(now) {
    if (playing) {
      const dt = now - last;
      time += Math.min(0.05, dt / 1000);
      last = now;

      if (dt < 120) {
        perfAccum += dt;
        perfFrames++;
        if (perfFrames >= 90) {
          const avg = perfAccum / perfFrames;
          if (avg > 22 && quality > 0.6) {
            quality = Math.max(0.6, quality * 0.85);
            resize();
          }
          perfAccum = 0;
          perfFrames = 0;
        }
      }

      if (loop) {
        if (time >= TOTAL) time -= TOTAL * Math.floor(time / TOTAL);
      } else if (time >= TOTAL) {
        time = TOTAL;
        playing = false;
        if (hint && showHint) hint.classList.add('show');
      }
      render(time);
      if (!loop && time >= TOTAL && !endNotified) {
        endNotified = true;
        notifyGame('ended');
      }
    }
    raf = playing ? requestAnimationFrame(tick) : 0;
  }

  function play() {
    if (!loop && time >= TOTAL) return;
    if (!playing) {
      playing = true;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }

  function replay() {
    time = 0;
    if (hint) hint.classList.remove('show');
    if (raf) cancelAnimationFrame(raf);
    playing = false;
    play();
  }

  window.seaGate = {
    seek(t) {
      playing = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      time = Math.max(0, Math.min(TOTAL, t));
      render(time);
    },
    play,
    replay,
    pause() { playing = false; if (raf) cancelAnimationFrame(raf); raf = 0; },
    get mode() { return mode; },
    get clip() { return clipIndex; },
    get loop() { return loop; },
    get duration() { return TOTAL; },
    get time() { return time; }
  };

  window.addEventListener('resize', resize);
  if (replayOnClick) {
    window.addEventListener('pointerdown', () => {
      if (!loop && time >= TOTAL - 0.05) replay();
    });
  }

  resize();

  Promise.all(SRC.map(src => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  }))).then(list => {
    images.push(...list);
    ready = true;
    if (Number.isFinite(startAt)) {
      time = Math.max(0, Math.min(TOTAL, startAt));
      playing = false;
      render(time);
    } else {
      play();
    }
    notifyGame('ready');
  }).catch(err => {
    console.error('帧图加载失败：', err);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CW, CH);
    notifyGame('error', '动画帧资源加载失败');
  });
})();
