// Optional text finding (beta): button, download question and results bar.
// Runs entirely in the browser; the image is never uploaded.
// Preview-only: the simple "Find text" flow as it could ship. Drives the test tools underneath.
(() => {
  const ui = window.__devQuadUI, panel = document.getElementById('devOcr');
  const stage = document.getElementById('stage'), history = document.querySelector('.toolbar .history');
  const MODEL = '/__ocr/model/craft.fp16.onnx', DOWNLOAD_MB = 56;
  const params = new URLSearchParams(location.search);
  let poll = 0, confirmed = false;

  // Test tools are hidden in this mode; a small link brings them back.
  const hideTools = (hide) => { if (hide) panel.style.setProperty('display', 'none', 'important'); else panel.style.removeProperty('display'); };
  hideTools(true);

  // ---- Toolbar button ----
  const findBtn = document.createElement('button');
  findBtn.className = 'icon-btn';
  findBtn.type = 'button';
  findBtn.title = findBtn.ariaLabel = 'Find text';
  findBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7V5h10v2M9 5v12M7 17h4"/><circle cx="17" cy="15" r="3"/><path d="M19.2 17.2L21 19"/></svg>';
  history.prepend(findBtn);

  // ---- Bar along the bottom of the image ----
  const bar = document.createElement('div');
  bar.hidden = true;
  bar.setAttribute('role', 'status');
  Object.assign(bar.style, { position: 'absolute', left: '50%', bottom: '12px', transform: 'translateX(-50%)', zIndex: '7', width: 'min(440px, calc(100% - 24px))', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '10px 12px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '10px', font: '14px system-ui, sans-serif' });
  const text = document.createElement('span');
  text.style.flex = '1 1 160px';
  const progress = document.createElement('div');
  Object.assign(progress.style, { flexBasis: '100%', height: '4px', borderRadius: '2px', background: 'var(--surface-2)', overflow: 'hidden' });
  const fill = document.createElement('div');
  Object.assign(fill.style, { width: '0%', height: '100%', background: 'var(--muted)', transition: 'width .3s' });
  progress.appendChild(fill);
  const note = document.createElement('span');
  Object.assign(note.style, { flexBasis: '100%', color: 'var(--muted)', fontSize: '12px' });
  note.textContent = 'Check the image. Small text can be missed.';
  const mk = (label, primary) => { const b = document.createElement('button'); b.type = 'button'; b.className = primary ? 'btn primary' : 'btn'; b.textContent = label; return b; };
  const coverBtn = mk('Cover', true), cancelBtn = mk('Cancel');
  const toolsLink = document.createElement('button');
  toolsLink.type = 'button'; toolsLink.textContent = 'Test tools';
  Object.assign(toolsLink.style, { flexBasis: '100%', textAlign: 'right', border: '0', background: 'none', color: 'var(--muted)', font: '11px system-ui, sans-serif', cursor: 'pointer', padding: '0' });
  bar.append(text, coverBtn, cancelBtn, progress, note);
  stage.appendChild(bar);

  // ---- Download question ----
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet';
  dialog.innerHTML = '<h2>Download needed</h2><p></p><div class="sheet-actions"><button class="btn primary large" type="button" value="yes">Download and find text</button><button class="btn ghost large" type="button" value="no">Not now</button></div>';
  document.body.appendChild(dialog);
  const ask = () => new Promise((resolve) => {
    const c = navigator.connection, cellular = c && (c.type === 'cellular' || c.saveData);
    dialog.querySelector('p').textContent = `Finding text needs a download of about ${DOWNLOAD_MB} MB. ` + (cellular ? 'You appear to be on mobile data or data saver.' : 'Use Wi-Fi if you are on a limited data plan.') + ' Your image is not uploaded.';
    const done = (v) => { dialog.close(); resolve(v); };
    dialog.querySelectorAll('button').forEach((b) => { b.onclick = () => done(b.value === 'yes'); });
    dialog.oncancel = () => resolve(false);
    dialog.showModal();
  });
  // Already downloaded in this browser? Then skip the question.
  async function modelCached() {
    return false; // The page itself makes no network requests; the question is asked once per visit.
  }

  // ---- Flow ----
  function show(kind) {
    bar.hidden = kind === 'none';
    const busy = kind === 'busy', done = kind === 'done';
    coverBtn.hidden = !done;
    progress.hidden = !busy;
    note.hidden = !busy && !done;
    note.textContent = busy ? 'Hatched areas are never shown to the AI.' : 'Check the image. Small text can be missed.';
    cancelBtn.textContent = 'Cancel';
    findBtn.disabled = busy || done;
  }
  function stopPolling() { clearInterval(poll); poll = 0; }

  function watch() {
    stopPolling();
    poll = setInterval(() => {
      const s = ui.status();
      if (s.busy) {
        const dl = /Downloading model (\d+)%/.exec(s.stage || '');
        if (dl) { text.textContent = `Downloading… ${dl[1]}%`; fill.style.width = `${dl[1]}%`; }
        else { const pct = s.total ? Math.round((s.next / s.total) * 100) : 0; text.textContent = s.total && s.stage !== 'Starting model' && !/Finding|quadtree|squares|Planning/.test(s.stage) ? `Finding text… ${pct}%` : 'Looking at the image…'; fill.style.width = `${pct}%`; }
        return;
      }
      if (s.done) {
        stopPolling();
        if (!s.found) { text.textContent = 'No text found.'; show('done'); coverBtn.hidden = true; cancelBtn.textContent = 'Close'; return; }
        show('done');
        update();
        return;
      }
      stopPolling(); show('none');
    }, 250);
  }
  function update() {
    const s = ui.status();
    text.textContent = `${s.found} found. Tap a box to skip it.`;
    coverBtn.textContent = `Cover ${s.on}`;
    coverBtn.disabled = !s.on;
  }

  async function start() {
    if (!confirmed && !(await modelCached())) {
      if (!(await ask())) return;
    }
    confirmed = true;
    ui.configure({ method: 'text', detail: '1', sens: '60', steps: true });
    show('busy');
    text.textContent = 'Starting…';
    fill.style.width = '0%';
    ui.find();
    watch();
  }

  findBtn.addEventListener('click', start);
  const warn = document.createElement('dialog');
  warn.className = 'sheet';
  warn.innerHTML = '<h2>Cover a large part of the image?</h2><p></p><div class="sheet-actions"><button class="btn primary large" type="button" value="yes">Cover anyway</button><button class="btn ghost large" type="button" value="no">Go back and check</button></div>';
  document.body.appendChild(warn);
  const confirmLarge = (share) => new Promise((resolve) => {
    warn.querySelector('p').textContent = `The selected boxes cover about ${Math.round(share * 100)}% of the image. Some may be covering more than text. Tap boxes to skip any you don't need.`;
    warn.querySelectorAll('button').forEach((b) => { b.onclick = () => { warn.close(); resolve(b.value === 'yes'); }; });
    warn.oncancel = () => resolve(false);
    warn.showModal();
  });
  coverBtn.addEventListener('click', async () => {
    const share = ui.coverShare();
    if (share > 0.4 && !(await confirmLarge(share))) return;
    ui.cover(); show('none');
  });
  cancelBtn.addEventListener('click', () => { stopPolling(); if (ui.status().busy) ui.stop(); else ui.clear(); show('none'); });
  toolsLink.addEventListener('click', () => { stopPolling(); ui.clear(); show('none'); hideTools(false); });
  document.getElementById('stage').addEventListener('click', () => { if (!bar.hidden && ui.status().done) setTimeout(update, 0); }, true);

  const previousWipe = window.__devOnWipe;
  window.__devOnWipe = () => { stopPolling(); dialog.open && dialog.close(); warn.open && warn.close(); show('none'); if (previousWipe) previousWipe(); };

})();
