// Optional text finding (beta): region planning.
// Runs entirely in the browser; the image is never uploaded.
// Preview-only comparison of region strategies. Only numbers are saved; images stay in the browser.
(() => {
  const Q = window.__devQuad, dev = window.__dev;
  const params = new URLSearchParams(location.search);
  const BUDGETS = [0.5, 1, 2], SENS = [25, 60];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const area = (r) => r.w * r.h;
  let token = 0, worker = null, waiting = null;

  function splitRect(r, scale, maxInput = 1280, overlap = 96, keep = () => true) {
    const side = Math.max(256, Math.floor(maxInput / scale)), step = side - overlap, out = [];
    for (let y = r.y; ; y += step) {
      for (let x = r.x; ; x += step) {
        const t = { x, y, w: Math.min(side, r.x + r.w - x), h: Math.min(side, r.y + r.h - y), scale };
        if (keep(t)) out.push(t);
        if (x + side >= r.x + r.w) break;
      }
      if (y + side >= r.y + r.h) break;
    }
    return out;
  }
  function fit(rects, budget) {
    const total = rects.reduce((n, r) => n + area(r) * r.scale * r.scale, 0), mp = budget * 1e6;
    const k = total > mp ? Math.sqrt(mp / total) : 1;
    return rects.map((r) => ({ ...r, scale: Math.max(0.2, r.scale * k) }));
  }
  const tilesFor = (a, rects, budget, keep) => fit(rects, budget).flatMap((r) => splitRect(r, r.scale, 1280, 96, keep));
  function padded(a, r, pad, min = 96) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, w = Math.max(min, r.w + pad * 2), h = Math.max(min, r.h + pad * 2);
    const x = Math.max(0, Math.floor(cx - w / 2)), y = Math.max(0, Math.floor(cy - h / 2));
    return { x, y, w: Math.min(a.W - x, Math.ceil(w)), h: Math.min(a.H - y, Math.ceil(h)) };
  }
  const withScale = (a, rects) => rects.map((r) => {
    const runs = Q.lineRuns(a, r);
    if (runs.length && runs[0] > 72) return { ...r, scale: clamp(48 / runs[0], 0.4, 1) };
    return { ...r, scale: clamp(36 / Q.lineHeight(a, r), 1, 2) };
  });

  function rectsFromCells(a, cells, pad) {
    const rects = Q.groups(cells, a.cw, a.ch, 1).map((g) => padded(a, { x: g.x0 * Q.CELL, y: g.y0 * Q.CELL, w: (g.x1 - g.x0 + 1) * Q.CELL, h: (g.y1 - g.y0 + 1) * Q.CELL }, pad));
    return Q.mergeRects(rects, 1);
  }

  // Removes long, even, thin runs: outlines and rules rather than text.
  function withoutOutlines(a) {
    const b = a.blocks.slice(), at = (x, y) => (x >= 0 && y >= 0 && x < a.bw && y < a.bh ? a.blocks[y * a.bw + x] : 0);
    const scan = (outer, inner, get, side) => {
      for (let o = 0; o < outer; o++) {
        let start = -1;
        for (let i = 0; i <= inner; i++) {
          const on = i < inner && get(o, i);
          if (on && start < 0) start = i;
          if (on || start < 0) continue;
          const len = i - start;
          if (len >= 20) {
            let near = 0, sum = 0, sq = 0;
            for (let j = start; j < i; j++) { near += side(o, j, -2) + side(o, j, 2); const c = a.counts[get.index(o, j)]; sum += c; sq += c * c; }
            const mean = sum / len, cv = Math.sqrt(Math.max(0, sq / len - mean * mean)) / (mean || 1);
            if (near < len * 0.6 && cv < 0.3) for (let j = start; j < i; j++) b[get.index(o, j)] = 0;
          }
          start = -1;
        }
      }
    };
    const horizontal = (y, x) => at(x, y); horizontal.index = (y, x) => y * a.bw + x;
    const vertical = (x, y) => at(x, y); vertical.index = (x, y) => y * a.bw + x;
    scan(a.bh, a.bw, horizontal, (y, x, d) => at(x, y + d));
    scan(a.bw, a.bh, vertical, (x, y, d) => at(x + d, y));
    const cells = new Uint8Array(a.cw * a.ch);
    const per = Q.CELL / 4;
    for (let y = 0; y < a.bh; y++) for (let x = 0; x < a.bw; x++) if (b[y * a.bw + x]) cells[Math.floor(y / per) * a.cw + Math.floor(x / per)] = 1;
    return cells;
  }

  // Snug regions: the kept cells (detail plus a 2-cell margin) split into rectangles that follow
  // their shape, instead of one bounding rectangle per group. Each tile carries the kept-cell map,
  // so the runner can blank out everything else before the AI sees it.
  function snugTiles(a, cells, budget) {
    const M = 2, keep = new Uint8Array(a.cw * a.ch);
    for (let y = 0; y < a.ch; y++) for (let x = 0; x < a.cw; x++) if (cells[y * a.cw + x])
      for (let yy = Math.max(0, y - M); yy <= Math.min(a.ch - 1, y + M); yy++) keep.fill(1, yy * a.cw + Math.max(0, x - M), yy * a.cw + Math.min(a.cw, x + M + 1));
    // Row runs of kept cells; identical runs in consecutive rows grow into one rectangle.
    const done = [], open = new Map();
    for (let y = 0; y <= a.ch; y++) {
      const seen = new Set();
      if (y < a.ch) for (let x = 0; x < a.cw;) {
        if (!keep[y * a.cw + x]) { x++; continue; }
        let e = x; while (e < a.cw && keep[y * a.cw + e]) e++;
        const key = `${x},${e}`; seen.add(key);
        if (open.has(key)) open.get(key).y1 = y; else open.set(key, { x0: x, x1: e, y0: y, y1: y });
        x = e;
      }
      for (const [key, r] of open) if (!seen.has(key)) { done.push(r); open.delete(key); }
    }
    const C = Q.CELL;
    let rects = done.map((r) => padded(a, { x: r.x0 * C, y: r.y0 * C, w: (r.x1 - r.x0) * C, h: (r.y1 - r.y0 + 1) * C }, 0, 64));
    for (const waste of [1.35, 1.6, 2]) { rects = Q.mergeRects(rects, waste); if (rects.length <= 300) break; }
    return tilesFor(a, withScale(a, rects), budget).map((t) => ({ ...t, keep, cw: a.cw, ch: a.ch, cell: C }));
  }

  function wholeTiles(a, budget) {
    const s = Math.min(1.5, Math.sqrt((budget * 1e6) / (a.W * a.H)));
    return splitRect({ x: 0, y: 0, w: a.W, h: a.H }, s, 2048, 96);
  }

  const STRATEGIES = {
    whole: { label: 'Whole image', plan: (a, b) => wholeTiles(a, b) },
    grid: { label: 'Plain tiles', plan: (a, b) => { const r = splitRect({ x: 0, y: 0, w: a.W, h: a.H }, 1, 640, 64), total = r.reduce((n, t) => n + area(t), 0), s = Math.min(1.5, Math.sqrt((b * 1e6) / total)); return r.map((t) => ({ ...t, scale: s })); } },
    current: { label: 'Current regions', plan: (a, b) => Q.planRegions(a, b) },
    tight: { label: 'Tight regions', plan: (a, b) => tilesFor(a, withScale(a, rectsFromCells(a, a.cells, 24)), b) },
    text: { label: 'Tight, no outlines', plan: (a, b) => (new URLSearchParams(location.search).get('regions') === 'bbox' ? tilesFor(a, withScale(a, rectsFromCells(a, withoutOutlines(a), 24)), b) : snugTiles(a, withoutOutlines(a), b)) },
    coarse: { label: 'Coarse, then zoom', twoPass: true, plan: (a, b) => wholeTiles(a, b * 0.3) },
    best: { label: 'Best case (known text)', truthOnly: true, plan: (a, b, truth) => tilesFor(a, withScale(a, Q.mergeRects(truth.samples.filter((s) => s.ink.length).map((s) => { let x0 = a.W, y0 = a.H, x1 = 0, y1 = 0; for (const i of s.ink) { const x = i % a.W, y = (i - x) / a.W; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return padded(a, { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, 24); }), 1)), b) },
  };

  window.__devPlans = { text: (a, b) => STRATEGIES.text.plan(a, b), coarse: (a, b) => STRATEGIES.coarse.plan(a, b), secondPass: (a, m, b) => secondPass(a, m, b) };

  function secondPass(a, maps, budget) {
    const hot = new Uint8Array(a.cw * a.ch);
    for (const m of maps) {
      const sx = m.tile.w / m.mapW, sy = m.tile.h / m.mapH;
      for (let y = 0; y < m.mapH; y++) for (let x = 0; x < m.mapW; x++) {
        const i = y * m.mapW + x;
        if (m.region[i] < 0.15 && m.link[i] < 0.15) continue;
        const cx = Math.floor((m.tile.x + x * sx) / Q.CELL), cy = Math.floor((m.tile.y + y * sy) / Q.CELL);
        if (cx < a.cw && cy < a.ch) hot[cy * a.cw + cx] = 1;
      }
    }
    // Enlarge by the height of each hot area: small text gets up to 3x, large text stays at 1x.
    const pad = 32, found = Q.groups(hot, a.cw, a.ch, 1).map((g) => {
      const r = { x: g.x0 * Q.CELL, y: g.y0 * Q.CELL, w: (g.x1 - g.x0 + 1) * Q.CELL, h: (g.y1 - g.y0 + 1) * Q.CELL };
      return { ...padded(a, r, pad), scale: clamp(40 / r.h, 1, 3) };
    });
    const merged = Q.mergeRects(found, 1).map((r) => ({ ...r, scale: Math.max(1, ...found.filter((f) => f.x >= r.x && f.y >= r.y && f.x + f.w <= r.x + r.w && f.y + f.h <= r.y + r.h).map((f) => f.scale)) }));
    return tilesFor(a, merged, budget * 0.7);
  }

})();
