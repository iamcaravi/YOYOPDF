/* ==========================================================================
   js/editor/zoom-manager.js
   ---------------------------------------------------------------------------
   Owns the current zoom level and the two fit modes. Every zoom change
   calls RenderQueue.cancelAll() and PageCache.clear() before asking
   viewport-manager to re-render at the new scale — stale in-flight renders
   at the old scale are exactly the kind of wasted work render-queue.js
   exists to cancel (see that file's header comment).
   ---------------------------------------------------------------------------
   Public surface:
     ZoomManager.init(getContainerSize, getPageNativeSize)
     ZoomManager.setZoom(percent)         // snaps to nearest allowed STEP
     ZoomManager.zoomIn() / zoomOut()     // moves one STEP
     ZoomManager.fitWidth() / fitPage() / initialReadable()
     ZoomManager.getScale() -> number     // e.g. 1.25 for 125%
     ZoomManager.getPercent() -> number   // e.g. 125
   Events emitted:
     editor:zoomChange { zoom }  (zoom is the 0–4-ish scale factor, matching
                                   the existing shell's convention from Phase
                                   6.0/Editor Architecture — statusbar and
                                   toolbar already listen for this, unchanged)
   ========================================================================== */
(function () {
  const STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 4]; // 25% .. 400%, per the brief
  // Default opening zoom is 200% (was 175%) - Edit PDF's text-grouping fix
  // makes editable runs meaningfully easier to work with at a larger
  // initial size, and 2 is already one of the STEPS above so it snaps
  // cleanly with no separate "is this an allowed zoom" rule needed.
  const INITIAL_READABLE_SCALE = 2;
  let scale = 1;
  let fitMode = null;
  let getContainerSize = () => ({ width: 800, height: 600 });
  let getPageNativeSize = () => ({ width: 612, height: 792 }); // US Letter default until a doc loads

  function init(containerSizeFn, pageNativeSizeFn) {
    if (containerSizeFn) getContainerSize = containerSizeFn;
    if (pageNativeSizeFn) getPageNativeSize = pageNativeSizeFn;
  }

  function nearestStep(target) {
    return STEPS.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  }

  function setScale(next, { snap = false, preserveFit = false } = {}) {
    if (!preserveFit) fitMode = null;
    const clamped = Math.min(STEPS[STEPS.length - 1], Math.max(STEPS[0], next));
    scale = snap ? nearestStep(clamped) : clamped;
    window.RenderQueue && window.RenderQueue.cancelAll();
    window.PageCache && window.PageCache.clear();
    window.dispatchEvent(new CustomEvent('editor:zoomChange', { detail: { zoom: scale } }));
    return scale;
  }

  function setZoom(percent) { return setScale(percent / 100, { snap: true }); }
  function zoomIn() {
    const i = STEPS.findIndex((s) => s > scale + 1e-6);
    return setScale(i === -1 ? STEPS[STEPS.length - 1] : STEPS[i]);
  }
  function zoomOut() {
    const i = [...STEPS].reverse().findIndex((s) => s < scale - 1e-6);
    return setScale(i === -1 ? STEPS[0] : [...STEPS].reverse()[i]);
  }

  function fitWidth() {
    fitMode = 'width';
    const { width: containerW } = getContainerSize();
    const { width: pageW } = getPageNativeSize();
    return setScale(containerW / pageW, { preserveFit: true });
  }

  function fitPage() {
    fitMode = 'page';
    const { width: containerW, height: containerH } = getContainerSize();
    const { width: pageW, height: pageH } = getPageNativeSize();
    const scaleW = containerW / pageW;
    const scaleH = containerH / pageH;
    return setScale(Math.min(scaleW, scaleH), { preserveFit: true });
  }

  /** Opening policy for an editing-first workspace. It aims for 175% on
   *  normal desktop canvases, but never makes the first page wider than the
   *  measured usable canvas. Height is intentionally allowed to scroll: a
   *  full-page fit is what made ordinary documents open around 71% and too
   *  small to edit. CSS sizes remain logical pixels; RenderEngine applies
   *  devicePixelRatio only to the backing canvas for sharp output. */
  function initialReadable() {
    fitMode = 'initial';
    const { width: containerW } = getContainerSize();
    const { width: pageW } = getPageNativeSize();
    const widthSafeScale = containerW > 0 && pageW > 0 ? containerW / pageW : 1;
    return setScale(Math.min(INITIAL_READABLE_SCALE, widthSafeScale), { preserveFit: true });
  }

  function refit() {
    if (fitMode === 'width') return fitWidth();
    if (fitMode === 'page') return fitPage();
    if (fitMode === 'initial') return initialReadable();
    return scale;
  }

  /** Ctrl+wheel zoom — call from a `wheel` listener already filtered to
   *  e.ctrlKey (viewport-manager.js owns attaching the actual listener,
   *  this just turns a wheel delta into a zoom step so the two concerns —
   *  "is this a zoom gesture" and "what does zooming mean" — stay separate). */
  function handleWheelDelta(deltaY) {
    const factor = deltaY > 0 ? 0.9 : 1.1;
    return setScale(scale * factor);
  }

  function getScale() { return scale; }
  function getPercent() { return Math.round(scale * 100); }
  // Exposes the internal fitMode read-only, so a caller can check whether
  // initialReadable() has already run (fitMode === 'initial') without
  // duplicating any zoom-selection logic here - added specifically so
  // editor-layout.js's pendingInitialFit guard (see its own comment) can
  // verify that invariant instead of assuming it. Doesn't change setScale's
  // behavior or any existing fitMode semantics.
  function getFitMode() { return fitMode; }

  window.ZoomManager = { init, setZoom, zoomIn, zoomOut, fitWidth, fitPage, initialReadable, refit, handleWheelDelta, getScale, getPercent, getFitMode, STEPS };
})();
