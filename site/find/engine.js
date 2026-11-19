// Optional text finding (beta): detection engine.
// Runs entirely in the browser; the image is never uploaded.
// Preview-only "Find text": quadtree region selection + CRAFT + isolated-mark finder.
// Served by dev-server.js; never part of site/.
(() => {
  const dev = window.__dev, viz = window.__devViz;
  const stage = document.getElementById('stage');
  const canvas = document.getElementById('canvas');
  const params = new URLSearchParams(location.search);

  // Cells are 8 px. The quadtree goes down to 8 px only where detail is dense (adaptive);
  // sparse 16 px squares are kept whole, and single isolated specks in large empty squares are ignored.
  // ?tree=fixed restores the previous behaviour (16 px leaves, no speck rule).
  const BLOCK = 4, LEAF_BLOCKS = 2, CELL = BLOCK * LEAF_BLOCKS, SPARSE_BLOCKS = 4, DENSE = 0.4;
  const ADAPT = new URLSearchParams(location.search).get('tree') !== 'fixed';
  const EDGE_STEP = 8, EDGES_PER_BLOCK = 2;
  // 'text' (default): stroke-like pixels that stand out from their local background.
  // 'edges': the previous test, any step of 8 brightness levels.
  const DETAIL = new URLSearchParams(location.search).get('detail') || 'text';
  const INK_MIN = 12, INK_SIGMA = 1.5, BLOCK_MIN = 3, BLOCK_MAX = 13;
  const MAX_INPUT = 1280, MAX_REGIONS = 40;

  const state = { worker: null, runId: 0, busy: false, result: null, boxes: [], marks: [], markChoice: new Map(), timer: 0, metrics: null, score: null };
  const css = (node, styles) => Object.assign(node.style, styles);
  const make = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---- Panel ----
  const panel = make('div');
  panel.id = 'devOcr';
  panel.hidden = true;
  css(panel, { position: 'absolute', left: '8px', top: '8px', zIndex: '5', maxWidth: 'calc(100% - 16px)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', padding: '6px', font: '13px system-ui, sans-serif', color: 'var(--text)', background: 'var(--surface)', border: '1px dashed currentColor', borderRadius: '8px' });
  const button = (label) => {
    const b = make('button', label);
    b.type = 'button';
    css(b, { minHeight: '36px', padding: '0 10px', font: 'inherit', color: 'inherit', background: 'var(--surface-2)', border: '0', borderRadius: '6px', cursor: 'pointer' });
    return b;
  };
  const findBtn = button('Find text');
  const detail = make('select');
  detail.setAttribute('aria-label', 'Detection detail');
  css(detail, { minHeight: '36px', font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px' });
  detail.add(new Option('Fast', '0.5'));
  detail.add(new Option('Normal', '1', true, true));
  detail.add(new Option('High', '2'));
  const method = make('select');
  method.setAttribute('aria-label', 'Region method');
  css(method, { minHeight: '36px', font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px' });
  method.add(new Option('Auto method', 'auto', true, true));
  method.add(new Option('Tight, no outlines', 'text'));
  method.add(new Option('Coarse, then zoom', 'coarse'));
  method.add(new Option('Previous regions', 'current'));
  const METHOD_NAMES = { text: 'tight regions', coarse: 'coarse, then zoom', current: 'previous regions' };
  const stopBtn = button('Stop');
  const status = make('span');
  const sensLabel = make('label', 'Sensitivity ');
  css(sensLabel, { display: 'inline-flex', alignItems: 'center', gap: '4px' });
  const sens = make('input');
  sens.type = 'range'; sens.min = '0'; sens.max = '100'; sens.value = '25';
  css(sens, { width: '96px' });
  sensLabel.appendChild(sens);
  const marksBtn = button('Add marks');
  const coverBtn = button('Cover');
  const clearBtn = button('Clear');
  panel.append(findBtn, detail, method, stopBtn, status, sensLabel, marksBtn, coverBtn, clearBtn);
  stage.appendChild(panel);
  viz.mount(panel, () => drawOverlay());

  const overlay = make('canvas');
  overlay.hidden = true;
  css(overlay, { position: 'absolute', zIndex: '4', touchAction: 'none', cursor: 'pointer' });
  stage.appendChild(overlay);

  const allBoxes = () => state.boxes.concat(state.marks);

  function syncPanel() {
    const done = !!state.result;
    findBtn.hidden = state.busy || done;
    detail.hidden = method.hidden = state.busy || done;
    stopBtn.hidden = !state.busy;
    sensLabel.hidden = !done;
    marksBtn.hidden = !done || !state.marks.some((b) => !b.auto);
    coverBtn.hidden = !done;
    clearBtn.hidden = !done;
    overlay.hidden = !done && !(state.busy && viz.active());
    viz.sync(state.busy, done);
    if (!done) return;
    const n = allBoxes().filter((b) => b.on).length;
    const suggested = state.marks.filter((b) => !b.auto), marked = state.marks.length - suggested.length;
    coverBtn.textContent = `Cover ${n}`;
    coverBtn.disabled = !n;
    marksBtn.textContent = suggested.length && suggested.every((b) => b.on) ? 'Skip suggested' : `Add ${suggested.length} suggested`;
    status.textContent = `${state.boxes.length} text (${state.boxes.filter((b) => b.gapFill).length} added for missed text), ${marked} marked, ${suggested.length} suggested. Tap a box to change it.`;
    if (state.metrics) status.textContent += ` Used ${METHOD_NAMES[state.metrics.method]} (${Math.round(state.metrics.detailShare * 100)}% detail, ${(state.metrics.totalMs / 1000).toFixed(0)} s).`;
    if (state.score) status.textContent += ` Text covered ${(state.score.overall * 100).toFixed(1)}%, ${state.score.full} of ${state.score.usable} complete. Red = incomplete.`;
  }

  function drawOverlay() {
    if (overlay.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    css(overlay, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`, width: `${w}px`, height: `${h}px` });
    overlay.width = Math.round(w * dpr);
    overlay.height = Math.round(h * dpr);
    const g = overlay.getContext('2d');
    const v = dev.view();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (viz.draw(g, v)) return;
    g.lineWidth = 1.5;
    for (const b of allBoxes()) {
      const mark = b.kind === 'mark';
      const x = b.x * v.s + v.tx, y = b.y * v.s + v.ty, bw = b.w * v.s, bh = b.h * v.s;
      g.setLineDash(b.on ? [] : [4, 3]);
      g.strokeStyle = !b.on && !mark ? '#868e96' : mark ? (b.auto ? '#7048e8' : '#e64980') : '#e8590c';
      g.fillStyle = !b.on ? 'rgba(134, 142, 150, 0.06)' : mark ? 'rgba(112, 72, 232, 0.25)' : 'rgba(232, 89, 12, 0.22)';
      if (b.poly) {
        g.beginPath();
        for (let i = 0; i < b.poly.length; i += 2) g.lineTo(b.poly[i] * v.s + v.tx, b.poly[i + 1] * v.s + v.ty);
        g.closePath(); g.fill(); g.stroke();
      } else { g.fillRect(x, y, bw, bh); g.strokeRect(x, y, bw, bh); }
    }
    if (state.score) {
      g.setLineDash([]); g.strokeStyle = '#e03131'; g.lineWidth = 2;
      for (const r of state.score.rows) if (!r.fontMissing && r.covered !== null && r.covered < 0.999) g.strokeRect(r.x * v.s + v.tx, r.y * v.s + v.ty, r.w * v.s, r.h * v.s);
    }
  }

  overlay.addEventListener('click', (e) => {
    if (!state.result || viz.view() !== 'result') return;
    const r = overlay.getBoundingClientRect(), v = dev.view();
    const x = (e.clientX - r.left - v.tx) / v.s, y = (e.clientY - r.top - v.ty) / v.s;
    const hits = allBoxes().filter((b) => inShape(b, x, y));
    if (!hits.length) return;
    hits.sort((a, b) => shapeArea(a) - shapeArea(b));
    hits[0].on = !hits[0].on;
    if (hits[0].kind === 'mark') state.markChoice.set(`${hits[0].x},${hits[0].y}`, hits[0].on);
    updateScore();
  });
  new ResizeObserver(() => requestAnimationFrame(drawOverlay)).observe(stage);

  // ---- Step 1: where is there any detail? ----
  // Counts, per 4x4 block, pixels that look like parts of strokes:
  //  - brightness differs from the surrounding 20x20 px by at least 12 levels and 1.5x the local spread,
  //    so faint text on a flat background passes, while grain, noise and soft texture mostly do not;
  //  - and the pixel has a similar neighbour, so isolated specks are ignored.
  // A block counts as detail with 3 to 13 such pixels: solid areas (14-16) are not text-like.
  // Works on block sums only, so memory stays small even for large images.
  function textLike(rgba, W, H, bw, bh, counts) {
    const lum = (i) => 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    const sum = new Float64Array(bw * bh), sq = new Float64Array(bw * bh), n = new Uint16Array(bw * bh);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = lum((y * W + x) * 4), b = (y >> 2) * bw + (x >> 2); sum[b] += v; sq[b] += v * v; n[b]++; }
    // Mean and spread over 5x5 blocks around each block.
    const mean = new Float32Array(bw * bh), spread = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let s = 0, s2 = 0, c = 0;
      for (let y = Math.max(0, by - 2); y <= Math.min(bh - 1, by + 2); y++) for (let x = Math.max(0, bx - 2); x <= Math.min(bw - 1, bx + 2); x++) { const b = y * bw + x; s += sum[b]; s2 += sq[b]; c += n[b]; }
      const m = s / c, b = by * bw + bx;
      mean[b] = m; spread[b] = Math.sqrt(Math.max(0, s2 / c - m * m));
    }
    // Mark standout pixels in a 3-state map: 0 none, 1 darker, 2 lighter than surroundings.
    const ink = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const b = (y >> 2) * bw + (x >> 2), d = lum((y * W + x) * 4) - mean[b];
      if (Math.abs(d) >= Math.max(INK_MIN, INK_SIGMA * spread[b])) ink[y * W + x] = d < 0 ? 1 : 2;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, v = ink[i];
      if (!v) continue;
      const friend = (x > 0 && ink[i - 1] === v) || (x + 1 < W && ink[i + 1] === v) || (y > 0 && ink[i - W] === v) || (y + 1 < H && ink[i + W] === v);
      if (friend) counts[(y >> 2) * bw + (x >> 2)]++;
    }
  }

  function analyse(work) {
    const W = work.width, H = work.height;
    const rgba = work.getContext('2d').getImageData(0, 0, W, H).data;
    const bw = Math.ceil(W / BLOCK), bh = Math.ceil(H / BLOCK);
    const counts = new Uint16Array(bw * bh);
    if (DETAIL === 'text') textLike(rgba, W, H, bw, bh, counts);
    else for (let y = 0; y < H; y++) {
      const by = y >> 2;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        let edge = false;
        if (x + 1 < W) edge = Math.abs(rgba[i] - rgba[i + 4]) >= EDGE_STEP || Math.abs(rgba[i + 1] - rgba[i + 5]) >= EDGE_STEP || Math.abs(rgba[i + 2] - rgba[i + 6]) >= EDGE_STEP;
        if (!edge && y + 1 < H) { const d = i + W * 4; edge = Math.abs(rgba[i] - rgba[d]) >= EDGE_STEP || Math.abs(rgba[i + 1] - rgba[d + 1]) >= EDGE_STEP || Math.abs(rgba[i + 2] - rgba[d + 2]) >= EDGE_STEP; }
        if (edge) counts[by * bw + (x >> 2)]++;
      }
    }
    const blocks = new Uint8Array(bw * bh);
    const sum = new Int32Array((bw + 1) * (bh + 1));
    for (let y = 0; y < bh; y++) {
      let row = 0;
      for (let x = 0; x < bw; x++) {
        const c = counts[y * bw + x], on = (DETAIL === 'text' ? c >= BLOCK_MIN && c <= BLOCK_MAX : c >= EDGES_PER_BLOCK) ? 1 : 0;
        blocks[y * bw + x] = on; row += on;
        sum[(y + 1) * (bw + 1) + x + 1] = sum[y * (bw + 1) + x + 1] + row;
      }
    }
    const count = (x, y, s) => {
      const x1 = Math.min(bw, x + s), y1 = Math.min(bh, y + s), a = bw + 1;
      return sum[y1 * a + x1] - sum[y * a + x1] - sum[y1 * a + x] + sum[y * a + x];
    };
    // Quadtree: flat squares are dropped whole; detailed ones split, down to 8 px where dense.
    const cw = Math.ceil(bw / LEAF_BLOCKS), ch = Math.ceil(bh / LEAF_BLOCKS);
    const cells = new Uint8Array(cw * ch);
    let side = LEAF_BLOCKS;
    while (side < Math.max(bw, bh)) side *= 2;
    const markSquare = (x, y, s) => { for (let cy = y / LEAF_BLOCKS; cy < Math.min(ch, (y + s) / LEAF_BLOCKS); cy++) for (let cx = x / LEAF_BLOCKS; cx < Math.min(cw, (x + s) / LEAF_BLOCKS); cx++) cells[cy * cw + cx] = 1; };
    const speck = (x, y, s) => {
      for (let by = y; by < Math.min(bh, y + s); by++) for (let bx = x; bx < Math.min(bw, x + s); bx++) {
        if (!blocks[by * bw + bx]) continue;
        for (let ny = by - 1; ny <= by + 1; ny++) for (let nx = bx - 1; nx <= bx + 1; nx++) if ((nx !== bx || ny !== by) && nx >= 0 && ny >= 0 && nx < bw && ny < bh && blocks[ny * bw + nx]) return false;
        return true;
      }
      return false;
    };
    const todo = [[0, 0, side, 0]], tree = [];
    let nodes = 0;
    while (todo.length) {
      const [x, y, s, depth] = todo.pop();
      if (x >= bw || y >= bh) continue;
      nodes++;
      const c = count(x, y, s);
      if (!c) { tree.push({ x, y, s, depth, kind: 0 }); continue; }
      // Near-zero detail: one isolated 4 px speck in a square of 64 px or more is noise, not text.
      if (ADAPT && s >= 16 && c === 1 && speck(x, y, s)) { tree.push({ x, y, s, depth, kind: 0 }); continue; }
      const leaf = s <= LEAF_BLOCKS || (s === SPARSE_BLOCKS && (!ADAPT || c / (s * s) < DENSE));
      tree.push({ x, y, s, depth, kind: leaf ? 2 : 1 });
      if (leaf) { markSquare(x, y, s); continue; }
      const h = s / 2;
      todo.push([x, y, h, depth + 1], [x + h, y, h, depth + 1], [x, y + h, h, depth + 1], [x + h, y + h, h, depth + 1]);
    }
    // Fill single-cell holes inside detailed areas: an empty cell becomes detail when all 4 direct
    // neighbours are detail, or at least 6 of its 8 neighbours are. Two passes, so small gaps close too.
    for (let pass = 0; pass < 2; pass++) {
      const fill = [];
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        if (cells[y * cw + x]) continue;
        let n = 0, direct = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch || !cells[ny * cw + nx]) continue;
          n++; if (!dx || !dy) direct++;
        }
        if (direct === 4 || n >= 6) fill.push(y * cw + x);
      }
      if (!fill.length) break;
      for (const i of fill) { cells[i] = 1; const x = i % cw, y = (i - x) / cw; tree.push({ x: x * LEAF_BLOCKS, y: y * LEAF_BLOCKS, s: LEAF_BLOCKS, depth: 99, kind: 4 }); }
    }
    // Enclosed holes: the insides of bold or large letters are flat, so only their outlines count as
    // detail. Empty areas completely surrounded by detail are filled in, up to about 400 x 400 px.
    {
      const outside = new Uint8Array(cw * ch), stack = [];
      const push = (i) => { if (!cells[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
      for (let x = 0; x < cw; x++) { push(x); push((ch - 1) * cw + x); }
      for (let y = 0; y < ch; y++) { push(y * cw); push(y * cw + cw - 1); }
      while (stack.length) {
        const i = stack.pop(), x = i % cw, y = (i - x) / cw;
        if (x > 0) push(i - 1); if (x + 1 < cw) push(i + 1); if (y > 0) push(i - cw); if (y + 1 < ch) push(i + cw);
      }
      const seen = new Uint8Array(cw * ch), LIMIT = 2500;
      for (let start = 0; start < cells.length; start++) {
        if (cells[start] || outside[start] || seen[start]) continue;
        const part = [start]; seen[start] = 1;
        for (let k = 0; k < part.length && part.length <= LIMIT; k++) {
          const i = part[k], x = i % cw, y = (i - x) / cw;
          for (const n of [x > 0 ? i - 1 : -1, x + 1 < cw ? i + 1 : -1, y > 0 ? i - cw : -1, y + 1 < ch ? i + cw : -1]) if (n >= 0 && !cells[n] && !seen[n]) { seen[n] = 1; part.push(n); }
        }
        if (part.length > LIMIT) continue;
        for (const i of part) { cells[i] = 1; const x = i % cw, y = (i - x) / cw; tree.push({ x: x * LEAF_BLOCKS, y: y * LEAF_BLOCKS, s: LEAF_BLOCKS, depth: 99, kind: 4 }); }
      }
    }
    return { W, H, bw, bh, blocks, counts, cw, ch, cells, nodes, tree, cell: CELL };
  }

  // Connected groups in a grid, returned as bounding boxes in grid units.
  function groups(grid, gw, gh, reach) {
    const seen = new Uint8Array(gw * gh), stack = [], out = [];
    for (let start = 0; start < grid.length; start++) {
      if (!grid[start] || seen[start]) continue;
      let x0 = gw, y0 = gh, x1 = 0, y1 = 0, size = 0;
      seen[start] = 1; stack.push(start);
      while (stack.length) {
        const i = stack.pop(), x = i % gw, y = (i - x) / gw;
        size++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        for (let ny = Math.max(0, y - reach); ny <= Math.min(gh - 1, y + reach); ny++) {
          for (let nx = Math.max(0, x - reach); nx <= Math.min(gw - 1, x + reach); nx++) {
            const n = ny * gw + nx;
            if (grid[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
          }
        }
      }
      out.push({ x0, y0, x1, y1, size });
    }
    return out;
  }

  const area = (r) => r.w * r.h;
  const SHAPE = new URLSearchParams(location.search).get('shape') || 'any', TILT = SHAPE !== 'upright';
  const polyArea = (p) => { let s = 0; for (let i = 0; i < p.length; i += 2) { const j = (i + 2) % p.length; s += p[i] * p[j + 1] - p[j] * p[i + 1]; } return Math.abs(s) / 2; };
  const shapeArea = (b) => (b.poly ? polyArea(b.poly) : b.w * b.h);
  const inPoly = (p, x, y) => { let hit = false; for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) { if ((p[i + 1] > y) !== (p[j + 1] > y) && x < ((p[j] - p[i]) * (y - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) hit = !hit; } return hit; };
  const inShape = (b, x, y) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h && (!b.poly || inPoly(b.poly, x, y));
  // Calls fn(index) for every pixel inside a box or tilted shape.
  const eachPixel = (b, W, fn) => { for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (!b.poly || inPoly(b.poly, x + 0.5, y + 0.5)) fn(y * W + x); };

  // Smallest rectangle at any angle around a word's map cells; used only when clearly better than upright.
  function tiltedBox(cells, mapW, t, sx, sy, grow, upright) {
    if (!TILT || cells.length > 40000) return null;
    const pts = [];
    for (const i of cells) { const x = i % mapW, y = (i - x) / mapW; pts.push([t.x + x * sx, t.y + y * sy], [t.x + (x + 1) * sx, t.y + y * sy], [t.x + x * sx, t.y + (y + 1) * sy], [t.x + (x + 1) * sx, t.y + (y + 1) * sy]); }
    pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const lower = [], upper = [];
    for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    if (hull.length < 3) return null;
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const p = hull[i], q = hull[(i + 1) % hull.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (!len) continue;
      const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const h of hull) { const a = h[0] * ux + h[1] * uy, b = -h[0] * uy + h[1] * ux; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
      if (!best || (a1 - a0) * (b1 - b0) < best.area) best = { area: (a1 - a0) * (b1 - b0), ux, uy, a0, a1, b0, b1 };
    }
    // Make u the long (reading) direction.
    let { ux, uy, a0, a1, b0, b1 } = best;
    if (b1 - b0 > a1 - a0) { [ux, uy] = [-uy, ux]; [a0, a1, b0, b1] = [-b1, -b0, a0, a1]; }
    const height = b1 - b0, angle = Math.abs((Math.atan2(uy, ux) * 180) / Math.PI) % 90, tilt = Math.min(angle, 90 - angle);
    const g = grow * Math.max(sx, sy) + 2, along = g + height * 0.45;
    a0 -= along; a1 += along; b0 -= g; b1 += g;
    const corner = (a, b) => [a * ux - b * uy, a * uy + b * ux];
    let poly = [corner(a0, b0), corner(a1, b0), corner(a1, b1), corner(a0, b1)].flat();
    // Four-sided shapes with any corner angles (parallelograms, e.g. 2 x 50 and 2 x 130 degrees),
    // for slanted or skewed text. Each pair of sides follows an edge of the word's outline.
    if (SHAPE === 'any') {
      const dirs = [[1, 0], [0, 1]];
      for (let k = 0; k < hull.length; k++) { const p = hull[k], q = hull[(k + 1) % hull.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]); if (l > 0) dirs.push([(q[0] - p[0]) / l, (q[1] - p[1]) / l]); }
      const range = (nx, ny) => { let lo = Infinity, hi = -Infinity; for (const h of hull) { const v = h[0] * nx + h[1] * ny; lo = Math.min(lo, v); hi = Math.max(hi, v); } return [lo, hi]; };
      let bestPara = null;
      for (let p = 0; p < dirs.length; p++) for (let q = p + 1; q < dirs.length; q++) {
        const [d1, d2] = [dirs[p], dirs[q]], sin = Math.abs(d1[0] * d2[1] - d1[1] * d2[0]);
        if (sin < 0.2) continue; // corners sharper than about 12 degrees are not useful
        // n1 is normal to d1 (bounds the sides along d1), n2 normal to d2.
        const n1 = [-d1[1], d1[0]], n2 = [-d2[1], d2[0]];
        let [l1, h1] = range(...n1), [l2, h2] = range(...n2);
        // Margins: g outward on every side, plus extra length along the reading direction (the longer sides).
        const len1 = (h2 - l2) / sin, len2 = (h1 - l1) / sin, read = len1 >= len2 ? d1 : d2;
        l1 -= g + along * Math.abs(n1[0] * read[0] + n1[1] * read[1]); h1 += g + along * Math.abs(n1[0] * read[0] + n1[1] * read[1]);
        l2 -= g + along * Math.abs(n2[0] * read[0] + n2[1] * read[1]); h2 += g + along * Math.abs(n2[0] * read[0] + n2[1] * read[1]);
        const a = ((h1 - l1) * (h2 - l2)) / sin;
        if (!bestPara || a < bestPara.a) bestPara = { a, n1, n2, l1, h1, l2, h2 };
      }
      if (bestPara) {
        const { n1, n2 } = bestPara, det = n1[0] * n2[1] - n1[1] * n2[0];
        const meet = (c1, c2) => [(c1 * n2[1] - n1[1] * c2) / det, (n1[0] * c2 - c1 * n2[0]) / det];
        const para = [meet(bestPara.l1, bestPara.l2), meet(bestPara.h1, bestPara.l2), meet(bestPara.h1, bestPara.h2), meet(bestPara.l1, bestPara.h2)].flat();
        if (polyArea(para) < polyArea(poly)) poly = para;
      }
    }
    if (polyArea(poly) >= area(upright)) return null;
    const xs = poly.filter((_, i) => i % 2 === 0), ys = poly.filter((_, i) => i % 2 === 1);
    return { poly, x: Math.max(0, Math.floor(Math.min(...xs))), y: Math.max(0, Math.floor(Math.min(...ys))), x1: Math.ceil(Math.max(...xs)), y1: Math.ceil(Math.max(...ys)) };
  }
  function union(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }
  function overlapArea(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  }
  function mergeRects(rects, waste) {
    const list = rects.slice();
    for (let changed = true; changed;) {
      changed = false;
      outer: for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const o = overlapArea(list[i], list[j]), u = union(list[i], list[j]);
          if ((o > 0 || waste > 1.3) && area(u) <= (area(list[i]) + area(list[j]) - o) * waste) { list[i] = u; list.splice(j, 1); changed = true; break outer; }
        }
      }
    }
    return list;
  }

  // Typical height of text lines inside a rectangle, from runs of active block rows.
  function lineRuns(a, r) {
    const x0 = r.x >> 2, x1 = Math.min(a.bw, Math.ceil((r.x + r.w) / BLOCK)), runs = [];
    let run = 0;
    for (let y = r.y >> 2; y <= Math.min(a.bh, Math.ceil((r.y + r.h) / BLOCK)); y++) {
      let on = false;
      if (y < a.bh) for (let x = x0; x < x1 && !on; x++) on = !!a.blocks[y * a.bw + x];
      if (on) run++; else if (run) { runs.push(run * BLOCK); run = 0; }
    }
    return runs.sort((p, q) => p - q);
  }

  function lineHeight(a, r) {
    const x0 = r.x >> 2, x1 = Math.min(a.bw, Math.ceil((r.x + r.w) / BLOCK)), runs = [];
    let run = 0;
    for (let y = r.y >> 2; y <= Math.min(a.bh, Math.ceil((r.y + r.h) / BLOCK)); y++) {
      let on = false;
      if (y < a.bh) for (let x = x0; x < x1 && !on; x++) on = !!a.blocks[y * a.bw + x];
      if (on) run++; else if (run) { runs.push(run); run = 0; }
    }
    if (!runs.length) return 40;
    runs.sort((p, q) => p - q);
    return runs[runs.length >> 1] * BLOCK;
  }

  function hasDetail(a, r) {
    for (let y = Math.floor(r.y / CELL); y <= Math.min(a.ch - 1, Math.floor((r.y + r.h - 1) / CELL)); y++) for (let x = Math.floor(r.x / CELL); x <= Math.min(a.cw - 1, Math.floor((r.x + r.w - 1) / CELL)); x++) if (a.cells[y * a.cw + x]) return true;
    return false;
  }

  // ---- Step 2: turn detailed squares into a small set of regions ----
  function planRegions(a, budgetMP) {
    const pad = 40;
    let rects = groups(a.cells, a.cw, a.ch, 2).map((g) => {
      const x = Math.max(0, g.x0 * CELL - pad), y = Math.max(0, g.y0 * CELL - pad);
      return { x, y, w: Math.min(a.W, (g.x1 + 1) * CELL + pad) - x, h: Math.min(a.H, (g.y1 + 1) * CELL + pad) - y };
    });
    for (const waste of [1.15, 1.6, 2.5, 5, 1e9]) {
      rects = mergeRects(rects, waste);
      if (rects.length <= MAX_REGIONS) break;
    }
    let plan = rects.map((r) => ({ ...r, scale: clamp(36 / lineHeight(a, r), 1, 2.5) }));
    const total = plan.reduce((n, r) => n + area(r) * r.scale * r.scale, 0);
    const budget = budgetMP * 1e6;
    if (total > budget) { const k = Math.sqrt(budget / total); plan = plan.map((r) => ({ ...r, scale: Math.max(0.5, r.scale * k) })); }
    // Large regions become overlapping tiles; tiles without detail are skipped.
    const tiles = [];
    for (const r of plan) {
      const side = Math.floor(MAX_INPUT / r.scale), step = side - 96;
      for (let y = r.y; ; y += step) {
        for (let x = r.x; ; x += step) {
          const t = { x, y, w: Math.min(side, r.x + r.w - x), h: Math.min(side, r.y + r.h - y), scale: r.scale };
          if (hasDetail(a, t)) tiles.push(t);
          if (x + side >= r.x + r.w) break;
        }
        if (y + side >= r.y + r.h) break;
      }
    }
    return tiles;
  }

  // ---- Step 3: isolated marks the model may not recognise as text ----
  function findMarks(a, boxes) {
    const busy = a.cells.reduce((n, c) => n + c, 0) / (a.cw * a.ch) > 0.35;
    const out = [], inText = new Uint8Array(a.bw * a.bh);
    for (const b of boxes) for (let y = b.y >> 2; y <= Math.min(a.bh - 1, (b.y + b.h - 1) >> 2); y++) inText.fill(1, y * a.bw + (b.x >> 2), y * a.bw + Math.min(a.bw, ((b.x + b.w - 1) >> 2) + 1));
    // A mark is trusted when nothing else surrounds it, i.e. it sits on a clean background.
    const clean = (g) => {
      const ring = 4;
      for (let y = Math.max(0, g.y0 - ring); y <= Math.min(a.bh - 1, g.y1 + ring); y++) for (let x = Math.max(0, g.x0 - ring); x <= Math.min(a.bw - 1, g.x1 + ring); x++) {
        if (x >= g.x0 && x <= g.x1 && y >= g.y0 && y <= g.y1) continue;
        const i = y * a.bw + x;
        if (a.blocks[i] && !inText[i]) return false;
      }
      return true;
    };
    for (const g of groups(a.blocks, a.bw, a.bh, 2)) {
      const x = Math.max(0, g.x0 * BLOCK - 3), y = Math.max(0, g.y0 * BLOCK - 3);
      const w = Math.min(a.W, (g.x1 + 1) * BLOCK + 3) - x, h = Math.min(a.H, (g.y1 + 1) * BLOCK + 3) - y;
      const long = Math.max(w, h), short = Math.min(w, h);
      if (long > 150 || (long > 60 && long / short > 10)) continue;
      const box = { x, y, w, h, on: false, kind: 'mark', auto: false };
      const covered = boxes.reduce((n, b) => n + overlapArea(box, b), 0);
      if (covered < area(box) * 0.5) { box.auto = busy ? false : clean(g); out.push(box); }
    }
    return out;
  }

  // ---- Model output to boxes ----
  function boxesFromRegion(t, { mapW, mapH, region, link }, a, level, thr) {
    const s = level === undefined ? Number(sens.value) / 100 : level;
    const textThreshold = thr ? thr.text : 0.85 - 0.6 * s, lowText = thr ? thr.low : 0.5 - 0.4 * s, linkThreshold = thr ? thr.link : 0.5 - 0.4 * s;
    const seen = new Uint8Array(mapW * mapH), stack = new Int32Array(mapW * mapH);
    const on = (i) => region[i] >= lowText || link[i] >= linkThreshold;
    const out = [], sx = t.w / mapW, sy = t.h / mapH;
    for (let start = 0; start < seen.length; start++) {
      if (seen[start] || !on(start)) continue;
      let top = 0, size = 0, peak = 0, x0 = mapW, y0 = mapH, x1 = 0, y1 = 0;
      const cells = [];
      stack[top++] = start; seen[start] = 1;
      while (top) {
        const i = stack[--top], x = i % mapW, y = (i - x) / mapW;
        size++; peak = Math.max(peak, region[i]); cells.push(i);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        for (const n of [x > 0 ? i - 1 : -1, x < mapW - 1 ? i + 1 : -1, y > 0 ? i - mapW : -1, y < mapH - 1 ? i + mapW : -1]) if (n >= 0 && !seen[n] && on(n)) { seen[n] = 1; stack[top++] = n; }
      }
      if (size < 3 || peak < textThreshold) continue;
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const grow = Math.floor(Math.sqrt((size * Math.min(bw, bh)) / (bw * bh)) * 2) + 1, padX = grow + bh * 0.45;
      const left = Math.max(0, Math.floor(t.x + (x0 - padX) * sx)), up = Math.max(0, Math.floor(t.y + (y0 - grow) * sy));
      const right = Math.min(a.W, Math.ceil(t.x + (x1 + 1 + padX) * sx)), down = Math.min(a.H, Math.ceil(t.y + (y1 + 1 + grow) * sy));
      const upright = { x: left, y: up, w: right - left, h: down - up, on: true, kind: 'text' };
      const tilted = tiltedBox(cells, mapW, t, sx, sy, grow, upright);
      if (tilted) { const x = tilted.x, y = tilted.y; out.push({ x, y, w: Math.min(a.W, tilted.x1) - x, h: Math.min(a.H, tilted.y1) - y, poly: tilted.poly, on: true, kind: 'text' }); }
      else out.push(upright);
    }
    return out;
  }

  // Pixels inside a box that stand out from their local surroundings.
  function contrastMask(work, b) {
    const d = work.getContext('2d').getImageData(b.x, b.y, b.w, b.h).data, w = b.w, h = b.h;
    const lum = new Float32Array(w * h), sum = new Float64Array((w + 1) * (h + 1));
    for (let i = 0; i < w * h; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += lum[y * w + x]; sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row; } }
    const k = Math.max(3, Math.round(Math.min(w, h) / 2)), on = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - k), x1 = Math.min(w, x + k + 1), y0 = Math.max(0, y - k), y1 = Math.min(h, y + k + 1);
      const mean = (sum[y1 * (w + 1) + x1] - sum[y0 * (w + 1) + x1] - sum[y1 * (w + 1) + x0] + sum[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      if (Math.abs(lum[y * w + x] - mean) >= 18) on[y * w + x] = 1;
    }
    return on;
  }

  // 3. Shrink to contents, 1. limit size. Nothing is deleted: doubtful boxes become unselected suggestions.
  const STEPS = (new URLSearchParams(location.search).get('refine') || 'shrink,limit,fill').split(',');
  function refine(list, a, maps = [], level) {
    if (!STEPS.includes('shrink') && !STEPS.includes('limit')) return list;
    const work = dev.work(), imageArea = a.W * a.H, MAX_SHARE = 0.4;
    const s0 = level === undefined ? Number(sens.value) / 100 : level, low0 = 0.5 - 0.4 * s0;
    const clip = (r, b) => { const x = Math.max(r.x, b.x), y = Math.max(r.y, b.y); return { ...r, x, y, w: Math.min(r.x + r.w, b.x + b.w) - x, h: Math.min(r.y + r.h, b.y + b.h) - y }; };
    // Splits an oversized box using the model's own character map at stricter thresholds, without links.
    // Accepted only if the pieces are small enough and still hold 90% of the model's text signal in the box.
    const heatSplit = (b) => {
      const near = maps.filter((m) => overlapArea(m.tile, b) > 0);
      if (!near.length) return null;
      const signal = (boxes) => {
        let total = 0, kept = 0;
        for (const m of near) {
          const sx = m.tile.w / m.mapW, sy = m.tile.h / m.mapH;
          for (let y = 0; y < m.mapH; y++) for (let x = 0; x < m.mapW; x++) {
            if (m.region[y * m.mapW + x] < low0) continue;
            const px = m.tile.x + (x + 0.5) * sx, py = m.tile.y + (y + 0.5) * sy;
            if (px < b.x || py < b.y || px >= b.x + b.w || py >= b.y + b.h) continue;
            total++;
            if (boxes.some((q) => inShape(q, px, py))) kept++;
          }
        }
        return total ? kept / total : 1;
      };
      for (const step of [0.1, 0.2, 0.3, 0.4]) {
        const low = Math.min(0.9, low0 + step);
        const thr = { low, link: 2, text: Math.max(low + 0.05, 0.85 - 0.6 * s0) };
        const sub = mergeOnLines(near.flatMap((m) => boxesFromRegion(m.tile, m, a, s0, thr))).map((r) => clip(r, b)).filter((r) => r.w > 2 && r.h > 2);
        if (!sub.length) continue;
        if (Math.max(...sub.map(shapeArea)) <= MAX_SHARE * imageArea && signal(sub) >= 0.9) return sub;
      }
      return null;
    };
    const heights = list.map((b) => b.h).sort((p, q) => p - q), typical = heights.length >= 3 ? heights[heights.length >> 1] : Infinity;
    const shrink = (b) => {
      if (b.w < 2 || b.h < 2) return null;
      const on = contrastMask(work, b);
      let x0 = b.w, y0 = b.h, x1 = -1, y1 = -1, n = 0;
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (on[y * b.w + x]) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (n < 6) return null;
      const m = Math.max(3, Math.round((y1 - y0 + 1) * 0.15));
      const nx = Math.max(b.x, b.x + x0 - m), ny = Math.max(b.y, b.y + y0 - m);
      return { ...b, x: nx, y: ny, w: Math.min(b.x + b.w, b.x + x1 + 1 + m) - nx, h: Math.min(b.y + b.h, b.y + y1 + 1 + m) - ny, on, ox: x0, oy: y0 };
    };
    // Splits a too-tall box into bands at empty rows.
    const bands = (b) => {
      const on = contrastMask(work, b), counts = [];
      for (let y = 0; y < b.h; y++) { let n = 0; for (let x = 0; x < b.w; x++) n += on[y * b.w + x]; counts.push(n); }
      const peak = Math.max(...counts), rows = counts.map((n) => n > peak * 0.08);
      const out = [];
      for (let y = 0, start = -1; y <= b.h; y++) {
        if (y < b.h && rows[y]) { if (start < 0) start = y; continue; }
        if (start >= 0) { out.push({ ...b, y: b.y + Math.max(0, start - 2), h: Math.min(b.h, y + 2) - Math.max(0, start - 2) }); start = -1; }
      }
      return out.length > 1 ? out : [b];
    };
    const out = [];
    for (const raw of list) {
      const tooBig = (b) => STEPS.includes('limit') && shapeArea(b) > MAX_SHARE * imageArea;
      for (const piece of tooBig(raw) ? (heatSplit(raw) || (raw.poly ? [raw] : bands(raw))) : [raw]) {
        const s = piece.poly || !STEPS.includes('shrink') ? { ...piece } : shrink(piece);
        if (!s) { out.push({ ...piece, on: false, kind: 'text', why: 'empty' }); continue; }
        const box = { x: s.x, y: s.y, w: s.w, h: s.h, kind: 'text', on: true };
        if (piece.poly) box.poly = piece.poly;
        if (tooBig(box)) box.large = true;
        out.push(box);
      }
    }
    return STEPS.includes('fill') ? fillGaps(out, a, maps, low0) : out;
  }

  // Gap filling: any part of the model's character map (score >= the current threshold) that no box
  // covers gets an upright box of its own, with the usual margins. Shapes, clean-up and tile edges
  // can leave such gaps; this guarantees the boxes contain everything the model saw.
  function fillGaps(boxes, a, maps, low) {
    if (!maps.length) return boxes;
    const gw = Math.ceil(a.W / 2), gh = Math.ceil(a.H / 2), covered = new Uint8Array(gw * gh);
    for (const b of boxes) if (b.on) for (let y = b.y >> 1; y < Math.min(gh, Math.ceil((b.y + b.h) / 2)); y++) for (let x = b.x >> 1; x < Math.min(gw, Math.ceil((b.x + b.w) / 2)); x++) {
      if (!b.poly || inPoly(b.poly, x * 2 + 1, y * 2 + 1)) covered[y * gw + x] = 1;
    }
    const added = [];
    for (const m of maps) {
      const sx = m.tile.w / m.mapW, sy = m.tile.h / m.mapH, miss = new Uint8Array(m.mapW * m.mapH);
      let any = false;
      for (let y = 0; y < m.mapH; y++) for (let x = 0; x < m.mapW; x++) {
        const i = y * m.mapW + x;
        if (m.region[i] < low) continue;
        // A cell is missed if any of its corners lies outside every box.
        for (const [cx, cy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) {
          const px = Math.min(gw - 1, Math.floor((m.tile.x + cx * sx) / 2)), py = Math.min(gh - 1, Math.floor((m.tile.y + cy * sy) / 2));
          if (!covered[py * gw + px]) { miss[i] = 1; any = true; break; }
        }
      }
      if (!any) continue;
      for (const g of groups(miss, m.mapW, m.mapH, 1)) {
        const h = (g.y1 - g.y0 + 1) * sy, pad = 2 * Math.max(sx, sy) + h * 0.3;
        const x = Math.max(0, Math.floor(m.tile.x + g.x0 * sx - pad)), y = Math.max(0, Math.floor(m.tile.y + g.y0 * sy - pad));
        const w = Math.min(a.W, Math.ceil(m.tile.x + (g.x1 + 1) * sx + pad)) - x, hh = Math.min(a.H, Math.ceil(m.tile.y + (g.y1 + 1) * sy + pad)) - y;
        added.push({ x, y, w, h: hh, on: true, kind: 'text', gapFill: true });
      }
    }
    return boxes.concat(added);
  }

  function mergeOnLines(list) {
    const boxes = list.slice();
    for (let changed = true; changed;) {
      changed = false;
      outer: for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          const lo = Math.min(a.h, b.h), u = union(a, b);
          const duplicate = ox > 0 && oy > 0 && ox * oy >= 0.7 * Math.min(area(a), area(b));
          const sameLine = Math.max(a.h, b.h) <= 1.6 * lo && oy >= 0.6 * lo && ox >= -0.6 * lo && u.h <= 2 * lo;
          if (a.poly || b.poly) {
            if (!duplicate) continue;
            boxes[i] = shapeArea(a) >= shapeArea(b) ? a : b;
            boxes.splice(j, 1);
            changed = true;
            break outer;
          }
          if (!STEPS.includes('merge') ? (ox < 0 || oy < 0.5 * lo) : (!duplicate && !sameLine)) continue;
          boxes[i] = { ...u, on: true, kind: 'text' };
          boxes.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
    return boxes;
  }

  // ---- Scoring, only for templates with known text positions ----
  function scoreList(list) {
    const t = window.__devTruth, work = dev.work();
    if (!t || !work || t.w !== work.width || t.h !== work.height) return null;
    const hit = new Uint8Array(t.w * t.h);
    let empty = 0;
    for (const b of list) {
      let hasInk = false;
      eachPixel(b, t.w, (i) => { hit[i] = 1; if (t.all[i]) hasInk = true; });
      if (!hasInk) empty++;
    }
    let inkTotal = 0, inkHit = 0;
    const rows = t.samples.map((s) => {
      let n = 0;
      for (let i = 0; i < s.ink.length; i++) n += hit[s.ink[i]];
      if (!s.fontMissing) { inkTotal += s.ink.length; inkHit += n; }
      return { section: s.section, label: s.label, x: s.x, y: s.y, w: s.w, h: s.h, covered: s.ink.length ? n / s.ink.length : null, fontMissing: s.fontMissing };
    });
    const usable = rows.filter((r) => !r.fontMissing && r.covered !== null);
    // Over-coverage: share of the image that is boxed but lies outside every annotated text area (with a 4 px margin).
    const text = new Uint8Array(t.w * t.h);
    for (const s of t.samples) { const x0 = Math.max(0, s.x - 4), x1 = Math.min(t.w, s.x + s.w + 4); for (let y = Math.max(0, s.y - 4); y < Math.min(t.h, s.y + s.h + 4); y++) text.fill(1, y * t.w + x0, y * t.w + x1); }
    let boxed = 0, outside = 0;
    for (let i = 0; i < hit.length; i++) if (hit[i]) { boxed++; if (!text[i]) outside++; }
    return { rows, overall: inkTotal ? inkHit / inkTotal : 0, full: usable.filter((r) => r.covered >= 0.999).length, usable: usable.length, emptyBoxes: empty, boxedShare: boxed / hit.length, outsideShare: outside / hit.length };
  }

  function updateScore() {
    state.score = scoreList(allBoxes().filter((b) => b.on));
    syncPanel();
    drawOverlay();
  }

  function refreshBoxes() {
    const r = state.result;
    if (!r) return;
    const level = Number(sens.value) / 100;
    viz.setLimits(0.5 - 0.4 * level, 0.5 - 0.4 * level);
    state.boxes = refine(mergeOnLines(r.maps.flatMap((m) => boxesFromRegion(m.tile, m, r.analysis))), r.analysis, r.maps);
    state.marks = findMarks(r.analysis, state.boxes);
    for (const m of state.marks) { const key = `${m.x},${m.y}`; m.on = state.markChoice.has(key) ? state.markChoice.get(key) : m.auto; }
    viz.setGaps(r.analysis, state.boxes, state.marks);
    updateScore();
  }
  sens.addEventListener('input', refreshBoxes);
  marksBtn.addEventListener('click', () => {
    const list = state.marks.filter((m) => !m.auto), all = list.every((m) => m.on);
    for (const m of list) { m.on = !all; state.markChoice.set(`${m.x},${m.y}`, m.on); }
    updateScore();
  });

  // ---- Running ----
  function stopTimer() { clearInterval(state.timer); state.timer = 0; }
  function stopWorker() { if (state.worker) { state.worker.terminate(); state.worker = null; } }

  function reset(message = '') {
    state.runId++;
    Object.assign(state, { busy: false, result: null, boxes: [], marks: [], markChoice: new Map(), score: null, job: null });
    stopTimer();
    viz.reset();
    status.textContent = message;
    syncPanel();
  }

  function fail(message) {
    stopTimer();
    state.busy = false; state.job = null;
    status.textContent = `Failed: ${message}`;
    report({ error: message });
    syncPanel();
  }

  function sendNext() {
    const job = state.job, work = dev.work(), t = job.tiles[job.next];
    const round32 = (v) => Math.max(64, Math.round((v * t.scale) / 32) * 32);
    const w = round32(t.w), h = round32(t.h);
    const small = make('canvas');
    small.width = w; small.height = h;
    const g = small.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(work, t.x, t.y, t.w, t.h, 0, 0, w, h);
    // Blank out everything the quadtree marked empty (outside the kept cells), using the average
    // colour of those areas, so the AI only sees quadtree-approved pixels.
    if (t.keep && new URLSearchParams(location.search).get('blank') !== '0') {
      const img = g.getImageData(0, 0, w, h), d = img.data, sx = t.w / w, sy = t.h / h, hide = new Uint8Array(w * h);
      let r = 0, gg = 0, bb = 0, n = 0;
      for (let v = 0; v < h; v++) {
        const cy = Math.min(t.ch - 1, Math.floor((t.y + (v + 0.5) * sy) / t.cell));
        for (let u = 0; u < w; u++) {
          const cx = Math.min(t.cw - 1, Math.floor((t.x + (u + 0.5) * sx) / t.cell));
          if (t.keep[cy * t.cw + cx]) continue;
          const i = v * w + u; hide[i] = 1; r += d[i * 4]; gg += d[i * 4 + 1]; bb += d[i * 4 + 2]; n++;
        }
      }
      if (n) { r /= n; gg /= n; bb /= n; for (let i = 0; i < hide.length; i++) if (hide[i]) { d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = bb; } g.putImageData(img, 0, 0); }
    }
    const rgba = g.getImageData(0, 0, w, h).data.buffer;
    small.width = small.height = 0;
    job.pixels += w * h;
    viz.setTile(job.next);
    state.worker.postMessage({ id: state.runId, width: w, height: h, rgba }, [rgba]);
  }

  function finish() {
    const job = state.job;
    stopTimer();
    state.busy = false; state.job = null;
    state.result = { analysis: job.analysis, maps: job.maps };
    viz.finished();
    const a = job.analysis, kept = a.cells.reduce((n, c) => n + c, 0);
    state.metrics = { method: job.method, detailShare: job.share, loadMs: Math.round(job.loadMs), modelMs: Math.round(job.runMs), analyseMs: Math.round(job.analyseMs), totalMs: Date.now() - job.started, regions: job.tiles.length, modelMegapixels: +(job.pixels / 1e6).toFixed(2), quadtreeNodes: a.nodes, detailShare: +((kept / (a.cw * a.ch)) || 0).toFixed(3) };
    refreshBoxes();
    selfTestDone();
  }

  function ensureWorker() {
    if (state.worker) return;
    const w = new Worker('find/worker.js');
    w.onmessage = ({ data: m }) => {
      if (m.type === 'stage') { state.stage = m.text; return; }
      if (m.id !== state.runId || !state.job) return;
      if (m.type === 'error') { fail(m.message); return; }
      const job = state.job;
      const done = { tile: job.tiles[job.next], mapW: m.mapW, mapH: m.mapH, region: m.region, link: m.link };
      job.maps.push(done);
      viz.addMap(done);
      job.loadMs += m.loadMs; job.runMs += m.runMs; job.next++;
      if (job.next >= job.tiles.length && job.second) {
        job.second = false;
        job.tiles.push(...window.__devPlans.secondPass(job.analysis, job.maps, job.budget));
      }
      if (job.next < job.tiles.length) sendNext(); else finish();
    };
    w.onerror = (e) => fail(e.message || 'worker error');
    state.worker = w;
  }

  async function find() {
    const work = dev.work();
    if (!work || state.busy) return;
    reset();
    const started = Date.now();
    const analysis = analyse(work);
    const share = analysis.cells.reduce((n, c) => n + c, 0) / (analysis.cw * analysis.ch), budget = Number(detail.value), plans = window.__devPlans;
    let chosen = method.value === 'auto' ? (share > 0.55 ? 'coarse' : 'text') : method.value;
    if (!plans) chosen = 'current';
    const tiles = chosen === 'current' ? planRegions(analysis, budget) : plans[chosen](analysis, budget);
    state.job = { method: chosen, share, budget, second: chosen === 'coarse', analysis, tiles, next: 0, maps: [], pixels: 0, loadMs: 0, runMs: 0, analyseMs: Date.now() - started, started };
    const run = state.runId;
    state.busy = true; state.stage = 'Starting';
    viz.prepare(analysis, tiles);
    viz.setLimits(0.5 - 0.004 * Number(sens.value), 0.5 - 0.004 * Number(sens.value));
    if (!tiles.length) { finish(); return; }
    const tick = () => { if (state.job) status.textContent = `${METHOD_NAMES[state.job.method]}, region ${state.job.next + 1} of ${state.job.tiles.length}: ${state.stage} (${Math.round((Date.now() - started) / 1000)} s)`; };
    tick();
    state.timer = setInterval(tick, 500);
    syncPanel();
    if (viz.enabled()) { await viz.intro(analysis, tiles, (t) => { state.stage = t; }); if (run !== state.runId) return; viz.showRun(); }
    state.stage = 'Starting model';
    ensureWorker();
    sendNext();
  }

  function cover() {
    const chosen = allBoxes().filter((b) => b.on);
    for (const b of chosen) dev.commit(b.poly ? { type: 'poly', color: dev.color(), points: b.poly.slice() } : { type: 'rect', mode: 'solid', color: dev.color(), block: 1, x: b.x, y: b.y, w: b.w, h: b.h });
    reset(`Covered ${chosen.length}.`);
    dev.render();
    return chosen.length;
  }

  findBtn.addEventListener('click', find);
  stopBtn.addEventListener('click', () => { stopWorker(); reset('Stopped.'); });
  clearBtn.addEventListener('click', () => reset());
  coverBtn.addEventListener('click', cover);

  window.__devQuad = { lineRuns, refine, CELL, analyse, groups, mergeRects, lineHeight, planRegions, boxesFromRegion, mergeOnLines, findMarks, scoreList, truth: (work) => { const t = window.__devTruth; return t && t.w === work.width && t.h === work.height ? t : null; } };
  window.__devQuadUI = {
    configure({ method: m, detail: d, sens: s, steps }) { method.value = m; detail.value = d; sens.value = s; const box = panel.querySelector('input[type=checkbox]'); if (box && box.checked !== steps) box.click(); },
    find: () => find(),
    cover: () => cover(),
    stop: () => { stopWorker(); reset(); },
    clear: () => reset(),
    coverShare: () => {
      const work = dev.work();
      if (!work) return 0;
      const gw = Math.ceil(work.width / 4), gh = Math.ceil(work.height / 4), grid = new Uint8Array(gw * gh);
      for (const b of allBoxes().filter((q) => q.on && q.poly)) for (let y = b.y >> 2; y < Math.min(gh, Math.ceil((b.y + b.h) / 4)); y++) for (let x = b.x >> 2; x < Math.min(gw, Math.ceil((b.x + b.w) / 4)); x++) if (inPoly(b.poly, x * 4 + 2, y * 4 + 2)) grid[y * gw + x] = 1;
      for (const b of allBoxes().filter((q) => q.on && !q.poly)) for (let y = b.y >> 2; y < Math.min(gh, Math.ceil((b.y + b.h) / 4)); y++) grid.fill(1, y * gw + (b.x >> 2), y * gw + Math.min(gw, Math.ceil((b.x + b.w) / 4)));
      return grid.reduce((n, v) => n + v, 0) / grid.length;
    },
    status: () => ({ busy: state.busy, stage: state.stage, next: state.job ? state.job.next : 0, total: state.job ? state.job.tiles.length : 0, done: !!state.result, found: allBoxes().length, on: allBoxes().filter((b) => b.on).length }),
  };
  window.__devOnWipe = () => { stopWorker(); reset(); panel.hidden = true; if (window.__devBenchStop) window.__devBenchStop(); };
  const note = document.getElementById('leaveNote');
  new MutationObserver(() => { panel.hidden = note.hidden; if (!note.hidden) syncPanel(); }).observe(note, { attributes: true, attributeFilter: ['hidden'] });
  syncPanel();

})();
