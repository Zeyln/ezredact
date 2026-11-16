'use strict';

/*
 * EzRedact
 * Everything lives in memory: the original image, the edit list and the
 * composited result are plain canvases held in variables. Nothing is written
 * to storage and nothing is sent over the network. wipe() releases it all and
 * runs automatically when the page is hidden for good (pagehide).
 */
(() => {
  // iOS Safari refuses canvases above ~16.7 megapixels.
  const MAX_PIXELS = 16_777_216;
  const MIN_DRAG_PX = 4; // screen px a drag must cover before it becomes a box

  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $('stage'),
    canvas: $('canvas'),
    empty: $('empty'),
    dropOverlay: $('dropOverlay'),
    toolbar: $('toolbar'),
    fileInput: $('fileInput'),
    openBtn: $('openBtn'),
    emptyOpenBtn: $('emptyOpenBtn'),
    wipeBtn: $('wipeBtn'),
    exportBtn: $('exportBtn'),
    undoBtn: $('undoBtn'),
    redoBtn: $('redoBtn'),
    fitBtn: $('fitBtn'),
    hint: $('hint'),
    colorRow: $('colorRow'),
    sizeRow: $('sizeRow'),
    sizeInput: $('sizeInput'),
    exportDialog: $('exportDialog'),
    shareBtn: $('shareBtn'),
    saveBtn: $('saveBtn'),
    copyBtn: $('copyBtn'),
    closeExportBtn: $('closeExportBtn'),
    toast: $('toast'),
  };
  const toolButtons = [...document.querySelectorAll('[data-tool]')];
  const colorButtons = [...document.querySelectorAll('[data-color]')];

  const HINTS = {
    box: 'Drag to cover. Safest for text.',
    pixelate: 'For faces. Use Box for text.',
    brush: 'Paint over areas.',
    move: 'Drag to pan. Pinch to zoom.',
  };

  // ---- State (memory only) ----
  let base = null; // original pixels
  let work = null; // original + all applied edits
  let workCtx = null;
  let scratch = null; // reusable small canvas for pixelation
  const ops = [];
  const redoStack = [];
  let unsaved = false;

  let tool = 'box';
  let color = '#000000';
  let brushSize = Number(el.sizeInput.value); // screen px

  const view = { s: 1, tx: 0, ty: 0 };
  let userMovedView = false;

  const pointers = new Map();
  let draft = null; // edit in progress
  let pan = null;
  let pinch = null;
  let gestureLocked = false; // after a pinch, ignore the remaining finger until all are lifted

  const blobUrls = new Set();

  // ---- Helpers ----
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function releaseCanvas(c) {
    if (c) {
      c.width = 0;
      c.height = 0;
    }
  }

  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3200);
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function localPoint(e) {
    const r = el.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function toImage(p) {
    return { x: (p.x - view.tx) / view.s, y: (p.y - view.ty) / view.s };
  }

  // ---- Loading ----
  async function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      toast('That file is not an image.');
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    try {
      img.src = url;
      await img.decode(); // <img> applies EXIF orientation when drawn
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      let scaled = false;
      if (w * h > MAX_PIXELS) {
        const k = Math.sqrt(MAX_PIXELS / (w * h));
        w = Math.floor(w * k);
        h = Math.floor(h * k);
        scaled = true;
      }
      wipe();
      base = makeCanvas(w, h);
      base.getContext('2d').drawImage(img, 0, 0, w, h);
      work = makeCanvas(w, h);
      workCtx = work.getContext('2d');
      workCtx.drawImage(base, 0, 0);
      showEditor();
      if (scaled) toast(`Large image reduced to ${w} × ${h} to fit in memory.`);
    } catch {
      toast('Could not open this image. Try a PNG or JPEG.');
    } finally {
      img.removeAttribute('src');
      URL.revokeObjectURL(url);
      el.fileInput.value = '';
    }
  }

  function showEditor() {
    el.empty.hidden = true;
    el.canvas.hidden = false;
    el.toolbar.hidden = false;
    userMovedView = false;
    unsaved = false;
    // Toolbar changes the stage size; fit after layout.
    requestAnimationFrame(() => {
      fit();
      updateUi();
    });
  }

  // ---- Wipe ----
  function wipe() {
    draft = null;
    pan = null;
    pinch = null;
    gestureLocked = false;
    pointers.clear();
    ops.length = 0;
    redoStack.length = 0;
    unsaved = false;
    releaseCanvas(base);
    releaseCanvas(work);
    releaseCanvas(scratch);
    base = work = workCtx = scratch = null;
    releaseCanvas(el.canvas);
    for (const u of blobUrls) URL.revokeObjectURL(u);
    blobUrls.clear();
    el.fileInput.value = '';
    if (el.exportDialog.open) el.exportDialog.close();
    el.canvas.hidden = true;
    el.toolbar.hidden = true;
    el.empty.hidden = false;
    updateUi();
  }

  // ---- Edits ----
  function pixelBlock() {
    return Math.max(8, Math.round(Math.max(work.width, work.height) / 60));
  }

  function normalizeRect(d) {
    const x0 = clamp(Math.floor(Math.min(d.x0, d.x1)), 0, work.width);
    const y0 = clamp(Math.floor(Math.min(d.y0, d.y1)), 0, work.height);
    const x1 = clamp(Math.ceil(Math.max(d.x0, d.x1)), 0, work.width);
    const y1 = clamp(Math.ceil(Math.max(d.y0, d.y1)), 0, work.height);
    return { type: 'rect', mode: d.mode, color: d.color, block: d.block, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Draws op onto ctx (in image coordinates), reading pixels from src.
  function applyOp(ctx, op, src) {
    ctx.save();
    if (op.type === 'rect') {
      if (op.w <= 0 || op.h <= 0) {
        ctx.restore();
        return;
      }
      if (op.mode === 'solid') {
        ctx.fillStyle = op.color;
        ctx.fillRect(op.x, op.y, op.w, op.h);
      } else {
        const b = op.block;
        const sw = Math.max(1, Math.ceil(op.w / b));
        const sh = Math.max(1, Math.ceil(op.h / b));
        if (!scratch) scratch = makeCanvas(sw, sh);
        if (scratch.width < sw) scratch.width = sw;
        if (scratch.height < sh) scratch.height = sh;
        const sctx = scratch.getContext('2d');
        sctx.imageSmoothingEnabled = true;
        sctx.imageSmoothingQuality = 'high';
        sctx.clearRect(0, 0, sw, sh);
        // Sample exactly the selected region (always inside the image) so every
        // block is fully opaque and no original pixels can show through at edges.
        sctx.drawImage(src, op.x, op.y, op.w, op.h, 0, 0, sw, sh);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(scratch, 0, 0, sw, sh, op.x, op.y, op.w, op.h);
      }
    } else if (op.type === 'stroke') {
      const p = op.points;
      ctx.fillStyle = ctx.strokeStyle = op.color;
      if (p.length === 2) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], op.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.lineWidth = op.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function commit(op) {
    applyOp(workCtx, op, work);
    ops.push(op);
    redoStack.length = 0;
    unsaved = true;
    updateUi();
  }

  function rebuild() {
    workCtx.clearRect(0, 0, work.width, work.height);
    workCtx.drawImage(base, 0, 0);
    for (const op of ops) applyOp(workCtx, op, work);
  }

  function undo() {
    if (!ops.length) return;
    redoStack.push(ops.pop());
    rebuild();
    unsaved = true;
    updateUi();
    requestRender();
  }

  function redo() {
    if (!redoStack.length) return;
    const op = redoStack.pop();
    applyOp(workCtx, op, work);
    ops.push(op);
    unsaved = true;
    updateUi();
    requestRender();
  }

  // ---- View ----
  function fit() {
    if (!work) return;
    const cw = el.canvas.clientWidth;
    const ch = el.canvas.clientHeight;
    const pad = 16;
    const s = Math.min((cw - pad * 2) / work.width, (ch - pad * 2) / work.height, 4);
    view.s = s > 0 ? s : 1;
    view.tx = (cw - work.width * view.s) / 2;
    view.ty = (ch - work.height * view.s) / 2;
    userMovedView = false;
    requestRender();
  }

  function zoomAt(p, newScale) {
    const fitScale = Math.min(el.canvas.clientWidth / work.width, el.canvas.clientHeight / work.height);
    const s = clamp(newScale, Math.min(fitScale * 0.5, 1), 32);
    const ix = (p.x - view.tx) / view.s;
    const iy = (p.y - view.ty) / view.s;
    view.s = s;
    view.tx = p.x - ix * s;
    view.ty = p.y - iy * s;
    userMovedView = true;
    requestRender();
  }

  let raf = 0;
  function requestRender() {
    if (!raf) raf = requestAnimationFrame(render);
  }

  function render() {
    raf = 0;
    const c = el.canvas;
    if (!work) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr);
    const H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.tx, dpr * view.ty);
    ctx.imageSmoothingEnabled = view.s < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(work, 0, 0);

    if (draft) {
      const op = draft.type === 'rect' ? normalizeRect(draft) : draft;
      applyOp(ctx, op, work);
      if (op.type === 'rect' && op.w > 0 && op.h > 0) {
        ctx.save();
        ctx.lineWidth = 1.5 / view.s;
        ctx.setLineDash([6 / view.s, 4 / view.s]);
        ctx.strokeStyle = '#ffcc33';
        ctx.strokeRect(op.x, op.y, op.w, op.h);
        ctx.restore();
      }
    }
  }

  // ---- Pointer input ----
  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      s0: view.s,
      tx0: view.tx,
      ty0: view.ty,
    };
  }

  function updatePinch() {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Restore the starting view, then zoom around the start midpoint and pan to the current one.
    view.s = pinch.s0;
    view.tx = pinch.tx0;
    view.ty = pinch.ty0;
    zoomAt(pinch.m0, pinch.s0 * (d / pinch.d0));
    view.tx += m.x - pinch.m0.x;
    view.ty += m.y - pinch.m0.y;
  }

  el.canvas.addEventListener('pointerdown', (e) => {
    if (!work) return;
    e.preventDefault();
    el.canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, localPoint(e));

    if (pointers.size === 2) {
      draft = null; // a second finger cancels the stroke in progress
      pan = null;
      startPinch();
      gestureLocked = true;
      requestRender();
      return;
    }
    if (pointers.size > 2 || gestureLocked) return;

    const p = localPoint(e);
    const wantsPan = tool === 'move' || (e.pointerType === 'mouse' && e.button !== 0);
    if (wantsPan) {
      pan = { x: p.x, y: p.y, tx: view.tx, ty: view.ty };
      return;
    }
    const ip = toImage(p);
    if (tool === 'brush') {
      draft = { type: 'stroke', color, size: brushSize / view.s, points: [ip.x, ip.y] };
    } else {
      draft = {
        type: 'rect',
        mode: tool === 'box' ? 'solid' : 'pixelate',
        color,
        block: pixelBlock(),
        x0: ip.x,
        y0: ip.y,
        x1: ip.x,
        y1: ip.y,
        start: p,
        moved: false,
      };
    }
    requestRender();
  });

  el.canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, localPoint(e));

    if (pinch && pointers.size >= 2) {
      updatePinch();
      return;
    }
    if (pan) {
      const p = localPoint(e);
      view.tx = pan.tx + (p.x - pan.x);
      view.ty = pan.ty + (p.y - pan.y);
      userMovedView = true;
      requestRender();
      return;
    }
    if (!draft) return;
    if (draft.type === 'stroke') {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events.length ? events : [e]) {
        const ip = toImage(localPoint(ev));
        draft.points.push(ip.x, ip.y);
      }
    } else {
      const p = localPoint(e);
      const ip = toImage(p);
      draft.x1 = ip.x;
      draft.y1 = ip.y;
      if (Math.hypot(p.x - draft.start.x, p.y - draft.start.y) >= MIN_DRAG_PX) draft.moved = true;
    }
    requestRender();
  });

  function endPointer(e, cancelled) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);

    if (pinch) {
      if (pointers.size < 2) pinch = null;
    } else if (pan) {
      pan = null;
    } else if (draft) {
      const d = draft;
      draft = null;
      if (!cancelled) {
        if (d.type === 'stroke') commit(d);
        else if (d.moved) {
          const op = normalizeRect(d);
          if (op.w > 0 && op.h > 0) commit(op);
        }
      }
      requestRender();
    }
    if (pointers.size === 0) gestureLocked = false;
  }

  el.canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  el.canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
  el.canvas.addEventListener('lostpointercapture', (e) => endPointer(e, false));
  el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  el.canvas.addEventListener(
    'wheel',
    (e) => {
      if (!work) return;
      e.preventDefault();
      if (e.ctrlKey || !e.shiftKey) {
        const unit = e.deltaMode === 1 ? 16 : 1;
        zoomAt(localPoint(e), view.s * Math.exp(-e.deltaY * unit * 0.0015));
      } else {
        view.tx -= e.deltaY;
        userMovedView = true;
        requestRender();
      }
    },
    { passive: false },
  );

  new ResizeObserver(() => {
    if (!work) return;
    if (userMovedView) requestRender();
    else fit();
  }).observe(el.stage);

  // Re-render sharply when the pixel density changes (browser zoom, moving to another screen).
  (function watchDpr() {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', () => {
      requestRender();
      watchDpr();
    }, { once: true });
  })();

  // ---- Toolbar ----
  function setTool(t) {
    tool = t;
    for (const b of toolButtons) b.setAttribute('aria-checked', String(b.dataset.tool === t));
    el.canvas.dataset.tool = t;
    el.hint.textContent = HINTS[t];
    el.hint.classList.toggle('warn', t === 'pixelate');
    el.colorRow.hidden = !(t === 'box' || t === 'brush');
    el.sizeRow.hidden = t !== 'brush';
  }

  function setColor(c) {
    color = c;
    for (const b of colorButtons) b.setAttribute('aria-checked', String(b.dataset.color === c));
  }

  function updateUi() {
    const has = !!work;
    el.wipeBtn.disabled = !has;
    el.exportBtn.disabled = !has;
    el.undoBtn.disabled = !ops.length;
    el.redoBtn.disabled = !redoStack.length;
  }

  for (const b of toolButtons) b.addEventListener('click', () => setTool(b.dataset.tool));
  for (const b of colorButtons) b.addEventListener('click', () => setColor(b.dataset.color));
  el.sizeInput.addEventListener('input', () => {
    brushSize = Number(el.sizeInput.value);
  });
  el.undoBtn.addEventListener('click', undo);
  el.redoBtn.addEventListener('click', redo);
  el.fitBtn.addEventListener('click', fit);

  const openPicker = () => el.fileInput.click();
  el.openBtn.addEventListener('click', () => {
    if (unsaved && !confirm('Open a new image? Unsaved edits to this one will be lost.')) return;
    openPicker();
  });
  el.emptyOpenBtn.addEventListener('click', openPicker);
  el.fileInput.addEventListener('change', () => loadFile(el.fileInput.files[0]));

  el.wipeBtn.addEventListener('click', () => {
    if (unsaved && !confirm('Wipe this image and all edits? This cannot be undone.')) return;
    wipe();
    toast('Wiped. Nothing remains in this page.');
  });

  // ---- Export ----
  function exportBlob() {
    return new Promise((resolve, reject) => {
      work.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png');
    });
  }

  function fileName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `redacted-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
  }

  const canShareFiles = (() => {
    try {
      return !!navigator.canShare && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] });
    } catch {
      return false;
    }
  })();
  const canCopy = !!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem);
  el.shareBtn.hidden = !canShareFiles;
  el.copyBtn.hidden = !canCopy;
  if (!canShareFiles) el.saveBtn.classList.add('primary');

  el.exportBtn.addEventListener('click', () => {
    if (work) el.exportDialog.showModal();
  });
  el.closeExportBtn.addEventListener('click', () => el.exportDialog.close());
  el.exportDialog.addEventListener('click', (e) => {
    // Close on a backdrop tap (outside the dialog box, not on its padding).
    const r = el.exportDialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (e.target === el.exportDialog && !inside) el.exportDialog.close();
  });

  el.shareBtn.addEventListener('click', async () => {
    try {
      const blob = await exportBlob();
      const file = new File([blob], fileName(), { type: 'image/png' });
      await navigator.share({ files: [file] });
      unsaved = false;
      el.exportDialog.close();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      toast('Sharing failed. Try Save instead.');
    }
  });

  el.saveBtn.addEventListener('click', async () => {
    try {
      const blob = await exportBlob();
      const url = URL.createObjectURL(blob);
      blobUrls.add(url);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName();
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        blobUrls.delete(url);
      }, 30_000);
      unsaved = false;
      el.exportDialog.close();
    } catch {
      toast('Could not save the image.');
    }
  });

  el.copyBtn.addEventListener('click', async () => {
    try {
      // Safari needs the ClipboardItem created synchronously within the tap, so pass a promise.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob() })]);
      unsaved = false;
      el.exportDialog.close();
      toast('Copied to clipboard.');
    } catch {
      toast('Copy is not allowed here. Try Save instead.');
    }
  });

  // ---- Paste, drop, keyboard ----
  document.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    if (unsaved && !confirm('Replace the current image? Unsaved edits will be lost.')) return;
    loadFile(file);
  });

  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    el.dropOverlay.hidden = false;
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.dropOverlay.hidden = true;
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.dropOverlay.hidden = true;
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    if (unsaved && !confirm('Replace the current image? Unsaved edits will be lost.')) return;
    loadFile(file);
  });

  document.addEventListener('keydown', (e) => {
    if (!work || el.exportDialog.open) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      redo();
    } else if (!mod && !e.altKey) {
      const map = { b: 'box', p: 'pixelate', d: 'brush', m: 'move' };
      if (map[k]) setTool(map[k]);
      else if (k === '0') fit();
    }
  });

  // ---- Privacy shield ----
  // Native apps (Snapchat, Teams with Intune) hide content before the OS takes
  // its app-switcher snapshot: on iOS by covering the window when the app
  // resigns active, on Android with FLAG_SECURE. A web page can't set either,
  // so this covers the screen on the earliest events browsers give us:
  // blur (focus lost: Safari tab switcher, dialogs, alt-tab) and
  // visibilitychange (Android fires it as soon as the recents screen opens).
  // On iOS the system snapshot may still be taken before this paints.
  const root = document.documentElement;
  function shield() {
    root.classList.add('shielded');
  }
  function unshield() {
    if (document.visibilityState === 'visible' && document.hasFocus()) root.classList.remove('shielded');
  }
  window.addEventListener('blur', shield);
  window.addEventListener('focus', unshield);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') shield();
    else unshield();
  });
  window.addEventListener('pageshow', unshield);
  // Losing focus right after a tap (file picker, share sheet, confirm) is expected; the shield lifts on return.
  el.stage.addEventListener('pointerdown', unshield);

  // ---- Leaving the page wipes everything ----
  window.addEventListener('pagehide', () => {
    shield();
    wipe();
  });
  // If the browser restores this page from its back/forward cache, start clean.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) wipe();
  });

  setTool('box');
  setColor('#000000');
  updateUi();
})();
