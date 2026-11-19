// Optional text finding (beta): on-screen stages.
// Runs entirely in the browser; the image is never uploaded.
// Preview-only visual walkthrough of the text-detection pipeline.
(() => {
  const VIEWS = {
    result: ['Result', 'Orange: text found by the model. Purple: marks on clean backgrounds, included. Pink dashes: suggestions, not included.'],
    edges: ['1. Text-like pixels', 'Cyan: pixels that stand out from their surroundings like parts of strokes. Brighter means more of them.'],
    tree: ['2. Quadtree', 'Green: squares with nothing text-like, skipped. Red: smallest squares that still contain text-like detail. Yellow: holes filled in, including the insides of bold or large letters.'],
    cells: ['3. Detail', 'Orange: the area with detail. Everything else needs no model time.'],
    regions: ['4. Regions', 'Green: what the model is actually given, with its enlargement. Yellow: running now.'],
    heat: ['5. Character heat', 'Yellow and red: how strongly the model sees a character.'],
    links: ['6. Link heat', 'Blue: where the model thinks neighbouring characters connect.'],
    mask: ['7. Threshold', 'White: model output that passes the current sensitivity and can become a box.'],
    gaps: ['8. Model gaps', 'Red: quadtree detail the model did not box. Purple: marked automatically. Pink: suggested.'],
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const make = (tag, w, h) => { const c = document.createElement(tag); if (w) { c.width = w; c.height = h; } return c; };
  // Views in which areas outside the model's regions are hatched.
  const UNSEEN = new Set(['regions', 'heat', 'links', 'mask', 'gaps']);
  let hatchTile = null;
  function hatch(g) {
    if (!hatchTile) {
      hatchTile = make('canvas', 10, 10);
      const h = hatchTile.getContext('2d');
      h.fillStyle = 'rgba(20, 22, 28, 0.72)'; h.fillRect(0, 0, 10, 10);
      h.strokeStyle = 'rgba(255, 255, 255, 0.35)'; h.lineWidth = 2;
      h.beginPath(); h.moveTo(-2, 12); h.lineTo(12, -2); h.moveTo(-2, 2); h.lineTo(2, -2); h.moveTo(8, 12); h.lineTo(12, 8); h.stroke();
    }
    return g.createPattern(hatchTile, 'repeat');
  }
  // Hatches everything outside the regions the model is given; overlapping regions stay clear.
  function drawUnseen(g, v, a) {
    if (!s.tiles.length) return;
    const w = Math.ceil(a.W * v.s), h = Math.ceil(a.H * v.s);
    if (w < 1 || h < 1) return;
    const off = make('canvas', w, h), o = off.getContext('2d');
    o.fillStyle = hatch(o); o.fillRect(0, 0, w, h);
    o.globalCompositeOperation = 'destination-out';
    for (const t of s.tiles) o.fillRect(t.x * v.s, t.y * v.s, t.w * v.s, t.h * v.s);
    const k = s.tiles.find((t) => t.keep);
    if (k && new URLSearchParams(location.search).get('blank') !== '0') {
      // Re-hatch blanked cells inside regions, drawn as row runs.
      o.globalCompositeOperation = 'source-over';
      o.fillStyle = hatch(o);
      const C = k.cell * v.s;
      for (let y = 0; y < k.ch; y++) for (let x = 0; x < k.cw;) {
        if (k.keep[y * k.cw + x]) { x++; continue; }
        let e = x; while (e < k.cw && !k.keep[y * k.cw + e]) e++;
        o.fillRect(x * C, y * C, (e - x) * C, C);
        x = e;
      }
    }
    g.drawImage(off, v.tx, v.ty);
  }
  const s = { on: !new URLSearchParams(location.search).has('selftest') || new URLSearchParams(location.search).has('vizlive'), view: 'result', auto: true, token: 0, analysis: null, tiles: [], active: -1, maps: [], depth: Infinity, layers: {}, redraw: () => {} };
  let select, legend, enable, replay;

  function setView(v, fromUser) {
    s.view = v;
    if (fromUser) s.auto = false;
    if (select) { select.value = v; legend.textContent = VIEWS[v][1] + (UNSEEN.has(v) ? ' Hatched: never shown to the AI.' : ''); }
    s.redraw();
  }

  function layerEdges(a) {
    const c = make('canvas', a.bw, a.bh), g = c.getContext('2d'), im = g.createImageData(a.bw, a.bh);
    for (let i = 0; i < a.counts.length; i++) { const v = Math.min(255, a.counts[i] * 14); im.data.set([60, 230, 255, v ? 70 + v * 0.72 : 0], i * 4); }
    g.putImageData(im, 0, 0);
    return c;
  }
  function layerCells(a) {
    const c = make('canvas', a.cw, a.ch), g = c.getContext('2d'), im = g.createImageData(a.cw, a.ch);
    for (let i = 0; i < a.cells.length; i++) if (a.cells[i]) im.data.set([255, 146, 43, 210], i * 4);
    g.putImageData(im, 0, 0);
    return c;
  }
  function paintTree(a, from, to) {
    const g = s.layers.tree.getContext('2d');
    for (let i = from; i < to; i++) {
      const n = a.tree[i], x = n.x * 2, y = n.y * 2, z = n.s * 2;
      if (n.kind === 0) { g.fillStyle = 'rgba(64,192,87,.3)'; g.fillRect(x, y, z, z); g.strokeStyle = 'rgba(64,192,87,.95)'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, z - 1, z - 1); }
      else if (n.kind === 4) { g.fillStyle = 'rgba(255,212,59,.9)'; g.fillRect(x, y, z, z); }
      else if (n.kind === 2) { g.fillStyle = 'rgba(250,82,82,.85)'; g.fillRect(x, y, z, z); }
      else { g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, z - 1, z - 1); }
    }
  }

  function prepare(a, tiles) {
    Object.assign(s, { analysis: a, tiles, maps: [], active: -1, depth: Infinity });
    const f = Math.min(1, 1200 / Math.max(a.W, a.H)), w = Math.ceil(a.W * f), h = Math.ceil(a.H * f);
    s.scale = f;
    s.layers = { edges: layerEdges(a), cells: layerCells(a), tree: make('canvas', a.bw * 2, a.bh * 2), heat: make('canvas', w, h), links: make('canvas', w, h), mask: make('canvas', w, h) };
    a.tree.sort((p, q) => p.depth - q.depth);
    paintTree(a, 0, a.tree.length);
  }

  function colour(kind, v, d, i) {
    if (kind === 'heat') { d[i] = 255; d[i + 1] = Math.min(255, 500 * Math.max(0, v - 0.2)); d[i + 2] = 40; d[i + 3] = v < 0.08 ? 0 : 60 + 195 * v; }
    else { d[i] = 60; d[i + 1] = 150 + 90 * v; d[i + 2] = 255; d[i + 3] = v < 0.08 ? 0 : 60 + 195 * v; }
  }
  function paintMap(layer, m, pixel) {
    const k = make('canvas', m.mapW, m.mapH), g = k.getContext('2d'), im = g.createImageData(m.mapW, m.mapH);
    for (let i = 0; i < m.mapW * m.mapH; i++) pixel(i, im.data, i * 4);
    g.putImageData(im, 0, 0);
    const t = m.tile, f = s.scale, out = s.layers[layer].getContext('2d');
    out.imageSmoothingEnabled = true;
    out.drawImage(k, t.x * f, t.y * f, t.w * f, t.h * f);
  }
  function paintMask(m) {
    const { low, link } = s.limits;
    paintMap('mask', m, (i, d, p) => { if (m.region[i] >= low || m.link[i] >= link) { d[p] = d[p + 1] = d[p + 2] = 255; d[p + 3] = 225; } });
  }

  async function intro(a, tiles, label) {
    const token = ++s.token, live = () => token === s.token && s.on;
    const step = async (view, text, ms) => { if (!live()) return false; label(text); if (s.auto) setView(view); await wait(ms); return live(); };
    if (!(await step('edges', 'Finding text-like detail', 900))) return;
    label('Building quadtree');
    const fresh = s.layers.tree.getContext('2d');
    fresh.clearRect(0, 0, s.layers.tree.width, s.layers.tree.height);
    if (s.auto) setView('tree');
    let at = 0;
    for (let d = 0, top = a.tree.reduce((n, t) => Math.max(n, t.depth), 0); d <= top; d++) {
      const start = at;
      while (at < a.tree.length && a.tree[at].depth <= d) at++;
      paintTree(a, start, at);
      s.redraw();
      await wait(260);
      if (!live()) { paintTree(a, at, a.tree.length); return; }
    }
    if (!(await step('cells', 'Keeping squares with detail', 900))) return;
    await step('regions', `Planning ${tiles.length} model regions`, 1300);
  }

  window.__devViz = {
    mount(panel, redraw) {
      s.redraw = redraw;
      const css = { minHeight: '36px', font: 'inherit', color: 'inherit', borderRadius: '6px' };
      const label = document.createElement('label');
      Object.assign(label.style, { display: 'inline-flex', alignItems: 'center', gap: '4px' });
      enable = document.createElement('input'); enable.type = 'checkbox'; enable.checked = s.on;
      enable.addEventListener('change', () => { s.on = enable.checked; });
      label.append(enable, 'Show steps');
      select = document.createElement('select');
      select.setAttribute('aria-label', 'Analysis view');
      Object.assign(select.style, css, { background: 'transparent', border: '1px solid var(--border)' });
      for (const [id, v] of Object.entries(VIEWS)) select.add(new Option(v[0], id));
      select.addEventListener('change', () => setView(select.value, true));
      replay = document.createElement('button'); replay.type = 'button'; replay.textContent = 'Replay';
      Object.assign(replay.style, css, { padding: '0 10px', background: 'var(--surface-2)', border: '0', cursor: 'pointer' });
      replay.addEventListener('click', async () => {
        if (!s.analysis) return;
        s.auto = true; const was = s.on; s.on = true;
        await intro(s.analysis, s.tiles, () => {});
        if (s.auto) { setView('heat'); await wait(1400); }
        if (s.auto) setView('mask'); await wait(s.auto ? 1000 : 0);
        s.on = was; if (s.auto) setView('result');
      });
      legend = document.createElement('span');
      Object.assign(legend.style, { flexBasis: '100%', fontSize: '12px' });
      panel.append(label, select, replay, legend);
      this.sync(false, false);
    },
    sync(busy, done) { if (!select) return; select.hidden = replay.hidden = legend.hidden = !(busy || done) || (!s.analysis); replay.hidden = !done; enable.parentNode.hidden = busy || done; },
    prepare,
    intro,
    showRun() { if (s.on && s.auto) setView('regions'); },
    enabled: () => s.on,
    active: () => !!s.analysis,
    view: () => s.view,
    views: Object.keys(VIEWS),
    setView: (v) => setView(v),
    setTile(i) { s.active = i; s.redraw(); },
    addMap(m) {
      s.maps.push(m);
      paintMap('heat', m, (i, d, p) => colour('heat', m.region[i], d, p));
      paintMap('links', m, (i, d, p) => colour('links', m.link[i], d, p));
      if (s.limits) paintMask(m);
      if (s.on && s.auto) setView('heat'); else s.redraw();
    },
    setLimits(low, link) {
      s.limits = { low, link };
      if (!s.layers.mask) return;
      s.layers.mask.getContext('2d').clearRect(0, 0, s.layers.mask.width, s.layers.mask.height);
      s.maps.forEach(paintMask);
    },
    setGaps(a, boxes, marks) {
      const c = make('canvas', a.cw, a.ch), g = c.getContext('2d'), im = g.createImageData(a.cw, a.ch), seen = new Uint8Array(a.cw * a.ch);
      const C = a.cell || 16;
      for (const b of boxes) for (let y = Math.floor(b.y / C); y <= Math.min(a.ch - 1, Math.floor((b.y + b.h - 1) / C)); y++) seen.fill(1, y * a.cw + Math.floor(b.x / C), y * a.cw + Math.min(a.cw, Math.floor((b.x + b.w - 1) / C) + 1));
      for (let i = 0; i < a.cells.length; i++) if (a.cells[i] && !seen[i]) im.data.set([250, 82, 82, 215], i * 4);
      g.putImageData(im, 0, 0);
      s.layers.gaps = c; s.marks = marks;
    },
    finished() { s.active = -1; s.auto = true; setView('result'); },
    reset() { s.token++; Object.assign(s, { analysis: null, tiles: [], maps: [], layers: {}, active: -1, auto: true, view: 'result' }); if (select) select.value = 'result'; },
    draw(g, v) {
      if (s.view === 'result' || !s.analysis) return false;
      const a = s.analysis, x = v.tx, y = v.ty, w = a.W * v.s, h = a.H * v.s;
      g.save();
      g.fillStyle = 'rgba(8,10,14,.62)'; g.fillRect(x, y, w, h);
      const layer = s.layers[s.view];
      if (layer) { g.imageSmoothingEnabled = s.view === 'heat' || s.view === 'links' || s.view === 'mask'; g.drawImage(layer, x, y, w, h); }
      if (UNSEEN.has(s.view)) drawUnseen(g, v, a);
      if (s.view === 'regions' || s.active >= 0) {
        s.tiles.forEach((t, i) => {
          const rx = x + t.x * v.s, ry = y + t.y * v.s, rw = t.w * v.s, rh = t.h * v.s, now = i === s.active;
          g.strokeStyle = now ? '#ffe066' : '#51cf66'; g.lineWidth = now ? 3 : 1.5; g.strokeRect(rx, ry, rw, rh);
          if (s.view === 'regions') { g.fillStyle = now ? 'rgba(255,224,102,.2)' : 'rgba(81,207,102,.12)'; g.fillRect(rx, ry, rw, rh); g.fillStyle = '#fff'; g.font = '12px system-ui, sans-serif'; g.fillText(`${i + 1}  x${t.scale.toFixed(1)}`, rx + 4, ry + 14); }
        });
      }
      if (s.view === 'gaps') for (const m of s.marks || []) { g.setLineDash(m.auto ? [] : [5, 3]); g.strokeStyle = m.auto ? '#b197fc' : '#f783ac'; g.lineWidth = 2; g.strokeRect(x + m.x * v.s, y + m.y * v.s, m.w * v.s, m.h * v.s); }
      g.restore();
      return true;
    },
  };
})();
