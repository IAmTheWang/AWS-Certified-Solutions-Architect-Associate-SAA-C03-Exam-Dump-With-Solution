// 从 anim.html 的场景代码 + hf-engine.js 生成 HyperFrames 项目（hf/index.html、hf/compositions/s1..s5.html）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const hf = path.join(root, 'hf');
const src = fs.readFileSync(path.join(root, 'anim.html'), 'utf8');
const engine = fs.readFileSync(path.join(here, 'hf-engine.js'), 'utf8');
const timing = JSON.parse(fs.readFileSync(path.join(here, 'timing.json'), 'utf8'));

// 切出每个场景函数体
const parts = src.split(/\/\* ---------- 场景 \d+[^\n]*\*\/\n/).slice(1).map(p => { const c = p.indexOf('/* ============'); return c > 0 ? p.slice(0, c) : p; });
const bodies = parts.map(p => {
  const a = p.indexOf('scenes.push(') + 'scenes.push('.length;
  const end = p.lastIndexOf('});');
  return p.slice(a, end + 1).trim();   // "(g, A, D) => { ... }"
});
if (bodies.length !== timing.length) throw new Error('scene count mismatch');

const FONT = `"Noto Sans JP",sans-serif`;
fs.mkdirSync(path.join(hf, 'compositions'), { recursive: true });
let startAt = 0; const hosts = [];
timing.forEach((s, i) => {
  const id = `s${i + 1}`;
  let acc = 0; const starts = [], spans = [];
  s.beats.forEach(b => { starts.push(+(acc + b.lead).toFixed(3)); spans.push(+(b.dur - b.lead).toFixed(3)); acc += b.dur; });
  const D = +s.dur.toFixed(3);
  let body = bodies[i];
  // 第一帧就要有内容；小字号/低对比度修正；图表里每帧重绘的"耗时"小标签去掉
  body = body.replace("title.pop(A(0, .3), .5).hide(A(1, .05), .3)", "title.hide(A(1, .05), .3)")
    .split("26, 'rgba(59,42,32,.5)'").join("30, '#7a5c45'")
    .replace("pill(all, '葱皮、空碗 = 垃圾 Garbage', 960, 215, '#8d6e63', 50).pop(A(2, .05), .4).hide(A(2, .8), .3);", "pill(all, '葱皮、空碗 = 垃圾 Garbage', 960, 215, '#8d6e63', 50).pop(A(2, .05), .4).hide(A(2, .7), .2);")
    .replace("pill(g, 'GC · 保洁阿姨', 1560, 455, '#2e7d32', 40).pop(A(0, .95), .4);", "pill(g, 'GC · 保洁阿姨', 1560, 455, '#2e7d32', 40).pop(A(0, .95), .4).hide(A(3, .08), .1);")
    .replace("'第12行：菜刀借给了二厨', 1000, 330", "'第12行：菜刀借给了二厨', 1130, 330").replace("'第15行：怎么又拿它切肉？', 1000, 410", "'第15行：怎么又拿它切肉？', 1130, 410").replace("'✋ 借用检查：不行', 1000, 490", "'✋ 借用检查：不行', 1130, 490")
    .replace("oom.pop(ts, .45);", "oom.pop(ts, .45); oom.n.setAttribute('data-layout-allow-overlap', '');")
    .replace('<text x="20" y="40" font-size="30" font-weight="800" fill="#78909c">耗时</text>', '');
  // 天平（场景5）：旋转改成真正的关键帧
  body = body.replace("grp(s3, { y: 540 + 70 })", "grp(s3, { x: 960, y: 420 })")
    .replace(/beam\.cust\([^\n]*\n/, "beam.k('r', A(3, 0), -12, 'lin').k('r', A(3, .25), 8, 'io').k('r', A(3, .45), -3, 'io').k('r', A(3, .6), 0, 'io');\n");
  const html = `<template>
  <style>
    #root { position: absolute; inset: 0; overflow: hidden; font-family: ${FONT}; color: #3b2a20; }
    #${id}-stage { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; overflow: hidden; }
  </style>
  <div id="root" data-composition-id="${id}" data-width="1920" data-height="1080">
    <div id="${id}-stage"></div>
  </div>
  <script>
  (function () {
    const SC = { id: ${JSON.stringify(id)}, D: ${D}, starts: ${JSON.stringify(starts)}, spans: ${JSON.stringify(spans)} };
    const A = (i, f = 0) => SC.starts[i] + f * SC.spans[i], D = SC.D;
${engine}
    // ---- 场景：${s.name} ----
    const rootG = grp(stage);
    const scene = ${body};
    scene(rootG, A, D);
    ALL.forEach(e => e.finalize());
    // 整个场景淡入 / 淡出
    ${i === 0 ? '' : 'gsap.set(stage, { opacity: 0 });'}
    ${i === 0 ? '' : "tl.fromTo(stage, { opacity: 0 }, { opacity: 1, duration: .35, ease: 'none', immediateRender: false }, 0);"}
    tl.fromTo(stage, { opacity: 1 }, { opacity: 0, duration: .35, ease: 'none', immediateRender: false }, D - .35);
    // 数值条、计数器、抖动等"随时间变化的函数"：通过 modifiers 在每次 seek 时求值
    const step = t => { for (const e of ALL) {
      if (e.fx.length) { let dx = 0, dy = 0, dr = 0, ds = 1; for (const f of e.fx) { const d = f(t) || {}; dx += d.dx || 0; dy += d.dy || 0; dr += d.dr || 0; ds *= (d.ds == null ? 1 : d.ds); }
        e.n.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(' + dr + 'deg) scale(' + ds + ')'; }
      for (const f of e.cb) f(t, e); } };
    const px = { t: 0 };
    tl.fromTo(px, { t: 0 }, { t: D, duration: D, ease: 'none', immediateRender: false, modifiers: { t: v => { step(v); return v; } } }, 0);
    step(0);
    window.__timelines[${JSON.stringify(id)}] = tl;
  })();
  </script>
</template>
`;
  fs.writeFileSync(path.join(hf, 'compositions', `${id}.html`), html);
  hosts.push(`      <div id="${id}" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${+startAt.toFixed(3)}" data-duration="${D}" data-track-index="1" data-track-kind="graphics" data-width="1920" data-height="1080"></div>`);
  startAt += D;
});
const total = +startAt.toFixed(3);
const index = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #000; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="1920" data-height="1080">
${hosts.join('\n')}
      <audio id="voice" src="assets/draft-voice.mp3" data-start="0" data-duration="${total}" data-track-index="2" data-volume="1"></audio>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;
      tl.seek(0);
    </script>
  </body>
</html>
`;
fs.writeFileSync(path.join(hf, 'index.html'), index);
console.log('built', timing.length, 'scenes, total', total);
