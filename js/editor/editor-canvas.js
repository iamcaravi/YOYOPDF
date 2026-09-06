/* ==========================================================================
   js/editor/editor-canvas.js
   ---------------------------------------------------------------------------
   Center Canvas: owns the empty / loading / page state machine via the
   `data-state` attribute on .editor-canvas (unchanged since the Editor
   Architecture phase — see editor-workspace.css for the CSS that shows/
   hides each state).

   Phase 6.0A: "page" state now means a real PDF is mounted. loadFile() is
   the one entry point that takes a File, hands it to RenderEngine, and on
   success asks ViewportManager to build the real page wrappers and
   ThumbnailEngine to start lazily filling in the sidebar — this file is
   the orchestrator for that sequence, but doesn't render anything itself.

   Priority 3F: on a failed load, this used to fall back to the plain
   empty state with no visible explanation — the only feedback was a
   console.error and a status-bar message that editor-statusbar.js's own
   bug (fixed this same phase) then immediately erased, and which is
   `data-optional` and hidden below 640px regardless. The 3-state machine
   itself (empty/loading/page) is unchanged — this only writes the
   failure's message into `[data-canvas-empty-error]`, an element that
   lives inside the existing `.editor-canvas-empty` block and is empty/
   hidden by default, so a host page whose markup predates this phase
   (none currently do — both index.html and editor-preview.html were
   updated) simply finds nothing and no-ops.
   ---------------------------------------------------------------------------
   Public surface: window.EditorCanvas.init(rootEl)
                   window.EditorCanvas.setState('empty' | 'loading' | 'page')
                   window.EditorCanvas.loadFile(file) -> Promise
   ========================================================================== */
(function () {
  let canvasEl = null;
  let rootEl = null;
  let loadGeneration = 0;

  function init(root) {
    rootEl = root;
    canvasEl = root.querySelector('.editor-canvas');
    if (!canvasEl) return;
    setState(canvasEl.dataset.state || 'empty');

    window.addEventListener('editor:zoomChange', () => {
      // Real pages re-render themselves at the new scale (see
      // viewport-manager.js / render-queue.js) — this just asks the
      // viewport to do that, once a document is actually mounted.
      if (window.ViewportManager) window.ViewportManager.rerenderAtCurrentScale();
    });
  }

  async function loadFile(file) {
    const generation = ++loadGeneration;
    clearEmptyError();
    setState('loading');
    try {
      const { numPages } = await window.RenderEngine.loadDocument(file);
      if (generation !== loadGeneration) return;
      // Root cause of the "wrong initial render, fixed only by clicking
      // Zoom" production bug: mountDocument() below immediately starts an
      // IntersectionObserver that renders in-view pages at whatever scale
      // ZoomManager currently holds (the previous document's scale, or the
      // 1x default). editor-layout.js's own auto-fit only runs afterward,
      // async (on the pageChange event mountDocument() dispatches, deferred
      // one more tick via setTimeout(0)) — on a slow network that gap is
      // wide enough for the wrong-scale render to win the race and stick
      // until the user manually reopens Zoom, which forces one more,
      // uncontested rerenderAtCurrentScale(). Computing the correct scale
      // here, before mountDocument() ever mounts a wrapper or fires the
      // observer, makes the very first render already correct — same
      // getPageInfo()+initialReadable() calls editor-layout.js's own
      // pageChange listener already uses, just sequenced earlier.
      try { window.__currentPageNativeSize = await window.RenderEngine.getPageInfo(1); } catch (_) { /* fall back to ZoomManager's existing default */ }
      if (generation !== loadGeneration) return;
      window.ZoomManager?.initialReadable();
      await window.ViewportManager.mountDocument(numPages);
      if (generation !== loadGeneration) return;
      window.EditorSidebar.init(rootEl, { pageCount: numPages });
      window.ThumbnailEngine.init(rootEl, numPages);
      setState('page');
    } catch (err) {
      if (generation !== loadGeneration || err?.name === 'AbortError') return;
      console.error('Failed to load PDF:', err);
      showEmptyError(err && err.message ? err.message : String(err));
      setState('empty');
    }
  }

  function showEmptyError(message) {
    if (!canvasEl) return;
    const el = canvasEl.querySelector('[data-canvas-empty-error]');
    if (!el) return;
    const t = window.I18N ? window.I18N.t : (k) => k;
    el.textContent = t('editor.errCouldNotOpen', { message });
    el.hidden = false;
  }

  function clearEmptyError() {
    if (!canvasEl) return;
    const el = canvasEl.querySelector('[data-canvas-empty-error]');
    if (!el) return;
    el.textContent = '';
    el.hidden = true;
  }

  function setState(state) {
    if (!canvasEl) return;
    canvasEl.dataset.state = state;
    window.dispatchEvent(new CustomEvent('editor:canvasStateChange', { detail: { state } }));
  }

  window.EditorCanvas = { init, setState, loadFile };
})();
