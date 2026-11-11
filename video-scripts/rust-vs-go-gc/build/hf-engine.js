/* 引擎：沿用原来的"关键帧轨道"写法，但最终全部编译成 GSAP 时间线（可 seek、可渲染） */
const GE = { lin: 'none', out: 'power3.out', in: 'power3.in', io: 'power3.inOut', back: 'back.out(1.7)', bounce: 'bounce.out' };
const ALL = [];
const tl = gsap.timeline({ paused: true });
const stage = document.getElementById(SC.id + '-stage');
class El {
  constructor(parent, html, css = {}, init = {}) {
    this.o = document.createElement('div'); this.o.style.cssText = 'position:absolute;left:0;top:0';   // GSAP 驱动 x/y/scale/rotation/opacity
    this.n = document.createElement('div'); this.n.style.whiteSpace = 'nowrap'; this.n.innerHTML = html || '';   // 内容层（fx 偏移、cust 在这里）
    Object.assign(this.n.style, css); this.o.appendChild(this.n);
    this.t = { x: [], y: [], s: [], r: [], o: [] };
    this.base = Object.assign({ x: 0, y: 0, s: 1, r: 0, o: 1 }, init);
    this.fx = []; this.cb = []; this.center = true;
    (parent.n || parent).appendChild(this.o); ALL.push(this);
  }
  val(p, t) {
    const a = this.t[p]; if (!a.length) return this.base[p];
    if (t <= a[0].t) return a[0].v; const L = a[a.length - 1]; if (t >= L.t) return L.v;
    for (let i = 1; i < a.length; i++) if (t <= a[i].t) {
      const A_ = a[i - 1], B = a[i]; const u = (t - A_.t) / ((B.t - A_.t) || 1e-6);
      const ez = { lin: x => x, out: x => 1 - Math.pow(1 - x, 3), in: x => x * x * x, io: x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2, back: x => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2), bounce: x => x };
      return A_.v + (B.v - A_.v) * ez[B.e || 'io'](u);
    }
  }
  k(p, t, v, e) { const a = this.t[p]; a.push({ t, v, e }); a.sort((x, y) => x.t - y.t); return this; }
  to(t0, t1, props, e = 'io') { for (const p in props) { this.k(p, t0, this.val(p, t0), 'lin'); this.k(p, t1, props[p], e); } return this; }
  at(t, props) { for (const p in props) { this.k(p, t - .001, this.val(p, t - .001), 'lin'); this.k(p, t, props[p], 'lin'); } return this; }
  pop(t, d = .45) { const b = this.base.s;
    return this.k('o', t, 0, 'lin').k('o', t + .08, 1, 'lin').k('s', t, 0, 'lin').k('s', t + d * .6, 1.18 * b, 'out').k('s', t + d, b, 'io'); }
  fade(t0, t1, o0, o1) { return this.k('o', t0, o0, 'lin').k('o', t1, o1, 'lin'); }
  hide(t, d = .25) { return this.k('o', t, this.val('o', t), 'lin').k('o', t + d, 0, 'lin'); }
  wob(fn) { this.fx.push(fn); return this; }
  cust(fn) { this.cb.push(fn); return this; }
  finalize() {
    const G = { x: 'x', y: 'y', s: 'scale', r: 'rotation', o: 'opacity' };
    const init = this.center ? { xPercent: -50, yPercent: -50 } : { xPercent: 0, yPercent: 0 };
    for (const p in G) { const a = this.t[p]; init[G[p]] = a.length ? a[0].v : this.base[p]; }
    gsap.set(this.o, init);
    for (const p in G) { const a = this.t[p];
      for (let i = 1; i < a.length; i++) { const A_ = a[i - 1], B = a[i], dur = B.t - A_.t;
        if (dur < .003) tl.set(this.o, { [G[p]]: B.v }, B.t);
        else tl.fromTo(this.o, { [G[p]]: A_.v }, { [G[p]]: B.v, duration: dur, ease: GE[B.e || 'io'], immediateRender: false }, A_.t); } }
  }
}
const kf = pairs => t => { if (t <= pairs[0][0]) return pairs[0][1]; const L = pairs[pairs.length - 1]; if (t >= L[0]) return L[1];
  for (let i = 1; i < pairs.length; i++) if (t <= pairs[i][0]) { const [a, va] = pairs[i - 1], [b, vb] = pairs[i]; const u = (t - a) / (b - a || 1e-6); return va + (vb - va) * (u * u * (3 - 2 * u)); } };

/* ---- 常用元件 ---- */
const mk = (p, html, x, y, css = {}, init = {}) => new El(p, html, css, Object.assign({ x, y }, init));
const emo = (p, ch, x, y, size, init = {}, css = {}) => { const e = mk(p, ch, x, y, Object.assign({ fontSize: size + 'px', lineHeight: '1', fontFamily: '"Apple Color Emoji","Noto Sans JP",sans-serif' }, css), init); e.n.setAttribute('data-layout-ignore', ''); e.o.setAttribute('data-layout-ignore', ''); return e; };
const txt = (p, s, x, y, size, color = '#3b2a20', css = {}, init = {}) => mk(p, s, x, y, Object.assign({ fontSize: size + 'px', fontWeight: 800, color }, css), init);
const pill = (p, s, x, y, bg, size = 40, init = {}) => { const e = mk(p, s, x, y, { fontSize: size + 'px', background: bg, padding: '10px 30px', borderRadius: '999px', fontWeight: 800, color: bg === '#ffb300' ? '#263238' : '#fff', boxShadow: '0 6px 0 rgba(0,0,0,.2)' }, init); return e; };
const grp = (p, init = {}) => mk(p, '', 960, 540, { width: '1920px', height: '1080px', pointerEvents: 'none' }, init);
const box = (p, x, y, w, h, bg, rad = 24, css = {}) => mk(p, '', x, y, Object.assign({ width: w + 'px', height: h + 'px', background: bg, borderRadius: rad + 'px' }, css));
const bg = (g, css) => { g.n.style.background = css; };
const chip = (g, s, color) => { const e = pill(g, s, 40, 36, color, 38); e.center = false; return e; };
const bar = (p, x, y, w, h, color, frac, rad = 14, bgc = 'rgba(0,0,0,.12)') => {
  const e = mk(p, `<div style="width:0;height:100%;background:${color};border-radius:${rad}px"></div>`, x, y,
    { width: w + 'px', height: h + 'px', background: bgc, borderRadius: rad + 'px', overflow: 'hidden' });
  e.cust((t, el) => { el.n.firstChild.style.width = (Math.max(0, Math.min(1, frac(t))) * 100) + '%'; });
  return e;
};
const table = (p, dark, light, labelColor = '#fff') => {
  const g = grp(p);
  box(g, 960, 790, 1640, 36, light, 18);
  box(g, 960, 915, 1560, 214, dark, 30);
  txt(g, '工作台 = 内存', 960, 925, 54, labelColor, { opacity: .9 });
  return g;
};
const hud = (g, memFn, cpuFn, t0, dark = false) => {
  const h = grp(g); h.fade(t0, t0 + .4, 0, 1);
  box(h, 310, 200, 540, 150, dark ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.85)', 26, { boxShadow: '0 8px 24px rgba(0,0,0,.15)' });
  const col = dark ? '#ffe0b2' : '#3b2a20';
  txt(h, '内存', 130, 170, 34, col); txt(h, 'CPU', 130, 230, 34, col);
  const mem = bar(h, 330, 170, 280, 36, '#43a047', memFn); bar(h, 330, 230, 280, 36, '#1e88e5', cpuFn);
  mem.cust((t, e) => { const v = memFn(t); e.n.firstChild.style.background = v > .85 ? '#e53935' : v > .6 ? '#fb8c00' : '#43a047'; });
  txt(h, '', 515, 170, 30, col).cust((t, e) => { e.n.textContent = Math.round(memFn(t) * 100) + '%'; });
  txt(h, '', 515, 230, 30, col).cust((t, e) => { e.n.textContent = Math.round(cpuFn(t) * 100) + '%'; });
  return h;
};
const card = (g, t0, t1, title, color = '#1e88e5') => {
  const c = grp(g, { x: 1230 }); gsap.set(c.o, { transformOrigin: '50% 29%' }); c.pop(t0, .4); if (t1) c.hide(t1, .25);
  box(c, 960, 315, 1120, 410, '#fff', 36, { boxShadow: '0 14px 40px rgba(0,0,0,.25)' });
  box(c, 960, 160, 1120, 90, color, 36);
  box(c, 960, 190, 1120, 30, color, 0);
  txt(c, title, 960, 162, 50, '#fff');
  return c;
};
