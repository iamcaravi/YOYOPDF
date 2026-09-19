/* ==========================================================================
   js/editor/editor-objects.js
   ---------------------------------------------------------------------------
   Owns the editable-object model for Edit PDF: text/image/rectangle/
   ellipse/line boxes placed on top of the rendered PDF pages, plus their
   selection, drag-to-move, corner-handle resize, and delete.

   This file did not exist before — editor-toolbar.js and editor-
   inspector.js already called into `window.EditorObjects` extensively
   (beginPlacement/getAllObjects/updateObject) with a fully-specified
   contract inferred from those call sites; this implements exactly that
   contract rather than inventing a new one, so no other editor-*.js file
   needed to change.

   Object schema: { id, type, page, xPct, yPct, wPct, hPct, selected, data }
   xPct/yPct/wPct/hPct are percentages (0-100) of the page's own box, top-
   left anchored — matches editor-toolbar.js's own image-placement comment
   ("wPct/hPct are percentages of the page's width/height respectively").
   `data` holds per-type fields exactly as editor-inspector.js's Properties
   panel and editor-toolbar.js's beginPlacement() calls already define them
   (text: text/fontFamily/fontSize/bold/italic/underline/color/align;
   image: src/naturalWidth/naturalHeight/keepAspectRatio; rectangle/
   ellipse/line: fill/stroke/strokeWidth/radius).

   Single-selection model: at most one object has `selected:true` at a
   time, matching editor-inspector.js's own `.find(o => o.selected)` usage.
   ---------------------------------------------------------------------------
   Public surface:
     EditorObjects.init(rootEl)
     EditorObjects.beginPlacement(type, { data, wPct, hPct })
     EditorObjects.getAllObjects() -> array (live objects, not a clone)
     EditorObjects.updateObject(id, patch)
     EditorObjects.deleteObject(id)
     EditorObjects.getState() -> JSON-safe deep clone (for EditorHistory)
     EditorObjects.restoreState(snapshot) -> replaces all objects + re-renders
   Events emitted:
     editor:objectAdded      { object }
     editor:objectsChanged   fires on ANY change, including selection-only
                              (existing contract editor-inspector.js relies on)
     editor:objectsCommitted { before } fires only for real mutations (add/
                              delete/move/resize/property edit/restore) —
                              NOT for selection-only changes. EditorHistory
                              listens to this one, not objectsChanged, so
                              selecting an object never creates an undo step.
   ========================================================================== */
(function () {
  const MIN_PCT = 2;
  const HANDLES = ['nw', 'ne', 'sw', 'se'];

  let root = null;
  let pagesEl = null;
  let objects = [];
  let nextId = 1;
  let pendingPlacement = null; // { type, data, wPct, hPct }
  const elById = new Map(); // id -> DOM element
  const pageInfoCache = new Map(); // pageNumber -> {width,height} in PDF points, for image aspect-lock math
  let drawState = null; // in-progress freehand stroke: { rect, page, points, data }
  let suppressNextClick = false; // swallows the synthetic click that follows a finished drag-to-draw stroke

  function init(rootEl) {
    root = rootEl;
    pagesEl = root.querySelector('.editor-canvas-pages') || root.querySelector('.editor-canvas');
    objects = [];
    nextId = 1;
    pendingPlacement = null;
    drawState = null;
    suppressNextClick = false;
    elById.clear();
    pageInfoCache.clear();

    const canvasEl = root.querySelector('.editor-canvas');

    canvasEl.addEventListener('click', onCanvasClick);
    canvasEl.addEventListener('mousedown', onCanvasMouseDown);

    window.addEventListener('keydown', onKeyDown);

    // A fresh document invalidates every existing object (pages/positions
    // no longer correspond to anything) and any pending placement.
    window.addEventListener('editor:documentLoaded', () => {
      objects = [];
      nextId = 1;
      pendingPlacement = null;
      elById.clear();
      pageInfoCache.clear();
      setCrosshair(false);
    });
    window.addEventListener('editor:zoomChange', () => {
      setTimeout(() => objects.filter((object) => object.type === 'text').forEach(renderObjectContent), 0);
    });
  }

  function onCanvasClick(e) {
    if (suppressNextClick) { suppressNextClick = false; return; }
    // Clicks on an existing object are handled (and stopPropagation'd) by
    // that object's own pointerdown handler below — this only ever sees
    // clicks on empty page area or, mid-placement, the page itself.
    const wrap = e.target.closest('.editor-canvas-page');
    if (pendingPlacement) {
      if (!wrap) return;
      if (pendingPlacement.type === 'draw') return; // draw placement is drag-driven, see onCanvasMouseDown
      placeAt(wrap, e.clientX, e.clientY);
      return;
    }
    if (!e.target.closest('.editor-object')) deselectAll();
  }

  /** Freehand draw ('draw' type) doesn't fit the click-to-place model every
   *  other type uses — it's a drag gesture that records a path. Only armed
   *  while pendingPlacement.type === 'draw'; every other placement/select/
   *  drag interaction still goes through onCanvasClick / startDrag. */
  function onCanvasMouseDown(e) {
    if (!pendingPlacement || pendingPlacement.type !== 'draw') return;
    const wrap = e.target.closest('.editor-canvas-page');
    if (!wrap) return;
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const page = Number(wrap.dataset.page);
    const data = pendingPlacement.data;
    drawState = { rect, page, data, points: [{ x: e.clientX - rect.left, y: e.clientY - rect.top }] };
    pendingPlacement = null;

    function onMove(ev) {
      drawState.points.push({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      finishDraw();
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function finishDraw() {
    const { rect, page, points, data } = drawState;
    drawState = null;
    setCrosshair(false);
    if (points.length < 2) return; // a plain click with no drag — nothing to create
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 4; // px, so the stroke isn't clipped flush against the box edge
    const boxX = Math.max(0, minX - pad), boxY = Math.max(0, minY - pad);
    const boxW = Math.max(1, maxX - minX + pad * 2), boxH = Math.max(1, maxY - minY + pad * 2);
    const normPoints = points.map((p) => ({ x: ((p.x - boxX) / boxW) * 100, y: ((p.y - boxY) / boxH) * 100 }));
    const xPct = clamp((boxX / rect.width) * 100, 0, 100);
    const yPct = clamp((boxY / rect.height) * 100, 0, 100);
    const wPct = (boxW / rect.width) * 100;
    const hPct = (boxH / rect.height) * 100;
    addObject({ type: 'draw', page, xPct, yPct, wPct, hPct, data: Object.assign({ points: normPoints }, data) });
    suppressNextClick = true;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && pendingPlacement) {
      pendingPlacement = null;
      setCrosshair(false);
      // Stop navigation-manager.js's own Escape handler (also on
      // `window`, registered after this one - see initEditorShell() in
      // index.html) from also treating this same keystroke as "close the
      // whole workspace" - it would otherwise close the editor out from
      // under an in-progress placement instead of just canceling it.
      // stopImmediatePropagation(), not stopPropagation(): both listeners
      // are on the *same* target (window), and plain stopPropagation()
      // only blocks propagation to *other* targets, not sibling listeners
      // already registered on this one - confirmed the hard way, this
      // exact bug reproduced with stopPropagation() alone before switching.
      e.stopImmediatePropagation();
      return;
    }
    if(/^Arrow(Left|Right|Up|Down)$/.test(e.key)){
      const active=document.activeElement;
      if(active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
      const selected=objects.find(o=>o.selected);
      if(!selected) return;
      e.preventDefault();
      const step=e.shiftKey?1:0.15;
      const patch={};
      if(e.key==='ArrowLeft') patch.xPct=clamp(selected.xPct-step,0,100-selected.wPct);
      if(e.key==='ArrowRight') patch.xPct=clamp(selected.xPct+step,0,100-selected.wPct);
      if(e.key==='ArrowUp') patch.yPct=clamp(selected.yPct-step,0,100-selected.hPct);
      if(e.key==='ArrowDown') patch.yPct=clamp(selected.yPct+step,0,100-selected.hPct);
      patch.data={manualGeometry:true};
      updateObject(selected.id,patch);
    }
  }

  function setCrosshair(on) {
    const canvasEl = root && root.querySelector('.editor-canvas');
    if (canvasEl) canvasEl.style.cursor = on ? 'crosshair' : '';
  }

  // --- Placement ------------------------------------------------------------

  function beginPlacement(type, opts) {
    opts = opts || {};
    const defaults = defaultBoxFor(type);
    pendingPlacement = {
      type,
      data: opts.data || {},
      wPct: opts.wPct != null ? opts.wPct : defaults.wPct,
      hPct: opts.hPct != null ? opts.hPct : defaults.hPct
    };
    deselectAll();
    setCrosshair(true);
  }

  function cancelPlacement(){ pendingPlacement=null; drawState=null; setCrosshair(false); }

  function defaultBoxFor(type) {
    if (type === 'text') return { wPct: 22, hPct: 6 };
    if (type === 'highlight') return { wPct: 30, hPct: 6 };
    if (type === 'whiteout') return { wPct: 30, hPct: 10 };
    if (type === 'link') return { wPct: 28, hPct: 5 };
    if (type === 'strikethrough') return { wPct: 30, hPct: 4 };
    if (type && type.indexOf('form-') === 0) return { wPct: type==='form-checkbox'||type==='form-radio'?4:28, hPct: type==='form-multiline'?12:5 };
    return { wPct: 25, hPct: 15 }; // image (usually overridden by caller), rectangle/ellipse/line
  }

  function placeAt(wrapEl, clientX, clientY) {
    const { type, data, wPct, hPct } = pendingPlacement;
    const rect = wrapEl.getBoundingClientRect();
    const cxPct = ((clientX - rect.left) / rect.width) * 100;
    const cyPct = ((clientY - rect.top) / rect.height) * 100;
    const xPct = clamp(cxPct - wPct / 2, 0, Math.max(0, 100 - wPct));
    const yPct = clamp(cyPct - hPct / 2, 0, Math.max(0, 100 - hPct));
    const page = Number(wrapEl.dataset.page);

    pendingPlacement = null;
    setCrosshair(false);

    addObject({ type, page, xPct, yPct, wPct, hPct, data });
  }

  // --- CRUD -------------------------------------------------------------

  function addObject({ type, page, xPct, yPct, wPct, hPct, data }, options) {
    const opts = options || {};
    const before = getState();
    const obj = { id: 'obj' + (nextId++), type, page, xPct, yPct, wPct, hPct, selected: opts.select !== false, data: Object.assign({}, data) };
    if (opts.select !== false) objects.forEach((o) => { o.selected = false; });
    objects.push(obj);
    mountObjectEl(obj);
    syncSelectionDom();
    if (!opts.silent) {
      window.dispatchEvent(new CustomEvent('editor:objectAdded', { detail: { object: obj } }));
      commit(before);
    } else if (opts.notify !== false) window.dispatchEvent(new CustomEvent('editor:objectsChanged'));
    return obj;
  }

  function addObjects(specs) {
    const list = Array.isArray(specs) ? specs.filter(Boolean) : [];
    if (!list.length) return [];
    const before = getState();
    objects.forEach((object) => { object.selected = false; });
    const added = list.map((spec) => addObject(Object.assign({}, spec, {data:cloneValue(spec.data || {})}), {silent:true,select:false}));
    added.forEach((object) => { object.selected = true; });
    syncSelectionDom();
    added.forEach((object) => window.dispatchEvent(new CustomEvent('editor:objectAdded', {detail:{object}})));
    commit(before);
    return added;
  }

  function updateObject(id, patch, options) {
    const obj = objects.find((o) => o.id === id);
    if (!obj) return;
    const before = getState();
    const previousData = obj.data;
    const dataPatch = patch.data;
    Object.assign(obj, patch);
    if (dataPatch) obj.data = Object.assign({}, previousData, dataPatch);
    renderObjectContent(obj);
    renderObjectBox(obj);
    if (!options?.silent) commit(before);
    return obj;
  }

  function deleteObject(id) {
    const idx = objects.findIndex((o) => o.id === id);
    if (idx === -1) return;
    const before = getState();
    const el = elById.get(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    elById.delete(id);
    objects.splice(idx, 1);
    commit(before);
  }

  function deleteObjects(ids) {
    const targets = new Set((ids || []).map(String));
    if (!targets.size || !objects.some((object) => targets.has(String(object.id)))) return [];
    const before = getState(), removed = [];
    objects = objects.filter((object) => {
      if (!targets.has(String(object.id))) return true;
      elById.get(object.id)?.remove();
      elById.delete(object.id);
      removed.push(object);
      return false;
    });
    commit(before);
    return removed;
  }

  function selectObject(id) {
    let changed = false;
    objects.forEach((o) => {
      const shouldBeSelected = o.id === id;
      if (o.selected !== shouldBeSelected) changed = true;
      o.selected = shouldBeSelected;
    });
    if (changed) { syncSelectionDom(); window.dispatchEvent(new CustomEvent('editor:objectsChanged')); }
  }

  function deselectAll() {
    let changed = false;
    objects.forEach((o) => { if (o.selected) changed = true; o.selected = false; });
    if (changed) { syncSelectionDom(); window.dispatchEvent(new CustomEvent('editor:objectsChanged')); }
  }

  function syncSelectionDom() {
    objects.forEach((o) => {
      const el = elById.get(o.id);
      if (el) el.classList.toggle('is-selected', !!o.selected);
    });
  }

  /** Fires the two events every real mutation needs: the general-purpose
   *  one editor-inspector.js already listens to, and the commit-only one
   *  EditorHistory listens to (see file header). */
  function commit(before) {
    window.dispatchEvent(new CustomEvent('editor:objectsChanged'));
    window.dispatchEvent(new CustomEvent('editor:objectsCommitted', { detail: { before } }));
  }

  // --- Rendering ----------------------------------------------------------

  function getPageWrapper(pageNumber) {
    return pagesEl && pagesEl.querySelector(`.editor-canvas-page[data-page="${pageNumber}"]`);
  }

  function mountObjectEl(obj) {
    const wrap = getPageWrapper(obj.page);
    if (!wrap) return; // page not mounted (shouldn't happen — all wrappers exist up front)
    const el = document.createElement('div');
    el.className = 'editor-object';
    if (obj.type === 'text' && obj.data?.replaceOriginal) el.classList.add('is-source-text');
    el.dataset.id = obj.id;
    el.dataset.type = obj.type;
    HANDLES.forEach((h) => {
      const handle = document.createElement('span');
      handle.className = 'editor-object-handle editor-object-handle-' + h;
      handle.addEventListener('pointerdown', (e) => startDrag(e, obj, 'resize', h));
      el.appendChild(handle);
    });
    const content = document.createElement('div');
    content.className = 'editor-object-content';
    el.appendChild(content);

    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.editor-object-handle')) return; // handles wire their own
      if (e.target.isContentEditable) return; // mid text-edit — let the click place the caret
      // A newly activated source run enters editing immediately. Once that
      // edit is committed it becomes a normal movable editor object.
      if (obj.type === 'text' && obj.data?.replaceOriginal && !obj.data.sourceCommitted) {
        selectObject(obj.id);
        return;
      }
      startDrag(e, obj, 'move');
    });
    if (obj.type === 'text') {
      // Bound to `el`, not `content`: content is pointer-events:none (see
      // css/editor-objects.css) so drag/move on the wrapper works without
      // the rendered content intercepting it — which also means content
      // itself never receives any DOM events, dblclick included.
      el.addEventListener('dblclick', (e) => startTextEdit(e, obj));
      if (obj.data?.replaceOriginal) el.addEventListener('click', (e) => {
        if (!e.target.isContentEditable && !obj.data.sourceCommitted) startTextEdit(e, obj);
      });
    }

    elById.set(obj.id, el);
    wrap.appendChild(el);
    renderObjectContent(obj);
    renderObjectBox(obj);
  }

  function renderObjectBox(obj) {
    const el = elById.get(obj.id);
    if (!el) return;
    el.style.left = obj.xPct + '%';
    el.style.top = obj.yPct + '%';
    el.style.width = obj.wPct + '%';
    el.style.height = obj.hPct + '%';
    el.style.transform = obj.data && obj.data.rotation ? `rotate(${obj.data.rotation}deg)` : '';
  }

  function renderObjectContent(obj) {
    const el = elById.get(obj.id);
    if (!el) return;
    const content = el.querySelector('.editor-object-content');
    const d = obj.data || {};
    el.classList.toggle('is-source-committed',!!(d.replaceOriginal && d.sourceCommitted));
    el.classList.toggle('is-reflowed',!!d.reflowApplied);
    if(d.layoutMode) el.dataset.layoutMode=d.layoutMode;
    else delete el.dataset.layoutMode;
    if (obj.type === 'text') {
      const editingInner = content.querySelector('.eo-text-inner[contenteditable="true"]');
      if (editingInner) { styleTextInner(editingInner, d, el); return; }
      content.innerHTML = '';
      const inner = document.createElement('div');
      inner.className = 'eo-text-inner';
      inner.textContent = d.text != null ? d.text : 'Text';
      styleTextInner(inner, d, el);
      content.appendChild(inner);
    } else if (obj.type === 'image') {
      content.innerHTML = '';
      const img = document.createElement('img');
      img.src = d.src || '';
      img.draggable = false;
      img.addEventListener('load', () => {
        if (!d.naturalWidth || !d.naturalHeight) updateObject(obj.id, { data: { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight } });
      });
      content.appendChild(img);
    } else if (obj.type === 'rectangle' || obj.type === 'ellipse') {
      content.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'eo-shape-box';
      box.style.background = d.fill || '#ffffff';
      box.style.border = `${d.strokeWidth != null ? d.strokeWidth : 2}px solid ${d.stroke || '#000000'}`;
      box.style.borderRadius = obj.type === 'ellipse' ? '50%' : ((d.radius || 0) + 'px');
      content.appendChild(box);
    } else if (obj.type === 'line') {
      content.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%">
        <line x1="0" y1="0" x2="100" y2="100" stroke="${d.stroke || '#000000'}" stroke-width="${d.strokeWidth != null ? d.strokeWidth : 2}" vector-effect="non-scaling-stroke" />
      </svg>`;
    } else if (obj.type === 'draw') {
      const pts = (d.points || []).map((p) => `${p.x},${p.y}`).join(' ');
      content.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%">
        <polyline points="${pts}" fill="none" stroke="${d.stroke || '#000000'}" stroke-width="${d.strokeWidth != null ? d.strokeWidth : 2}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      </svg>`;
    } else if (obj.type === 'highlight') {
      content.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'eo-highlight-box';
      box.style.background = d.fill || '#ffeb3b';
      box.style.opacity = d.opacity != null ? d.opacity : 0.4;
      content.appendChild(box);
    } else if (obj.type === 'whiteout') {
      content.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'eo-whiteout-box';
      box.style.background = d.color || '#ffffff';
      content.appendChild(box);
    } else if (obj.type === 'strikethrough') {
      content.innerHTML='<div class="eo-strikethrough-box"></div>';
    } else if (obj.type === 'link') {
      content.innerHTML='';
      const box=document.createElement('div'); box.className='eo-link-box';
      box.textContent=d.url || 'https://'; content.appendChild(box);
    } else if (obj.type && obj.type.indexOf('form-')===0) {
      content.innerHTML='';
      const field=document.createElement('div'); field.className='eo-form-field';
      if(obj.type==='form-checkbox') field.textContent='✓';
      else if(obj.type==='form-radio') field.textContent='●';
      else if(obj.type==='form-dropdown') field.textContent=(d.options&&d.options[0])||'Select ▾';
      else field.textContent=d.defaultValue || d.name || (obj.type==='form-multiline'?'Multiline field':'Text field');
      content.appendChild(field);
    }
  }

  function styleTextInner(inner, d, el) {
    inner.style.fontFamily = d.fontFamily || 'Arial';
    const wrap = el.closest('.editor-canvas-page');
    const nativeWidth = Number(wrap?.dataset.nativeWidth) || wrap?.getBoundingClientRect().width || 1;
    const displayScale = (wrap?.getBoundingClientRect().width || nativeWidth) / nativeWidth;
    inner.style.fontSize = ((d.layoutFontSize || d.fontSize || 16) * displayScale) + 'px';
    inner.style.fontWeight = d.bold ? '700' : '400';
    inner.style.fontStyle = d.italic ? 'italic' : 'normal';
    inner.style.textDecoration = d.underline ? 'underline' : 'none';
    inner.style.color = d.color || '#000000';
    inner.style.opacity = d.opacity == null ? '1' : String(d.opacity);
    inner.style.textAlign = d.align || 'left';
    inner.style.lineHeight = d.lineHeight || 1.2;
    inner.style.letterSpacing = ((d.characterSpacing || 0) * displayScale) + 'px';
    inner.style.wordSpacing = ((d.wordSpacing || 0) * displayScale) + 'px';
    inner.style.direction = d.direction || 'ltr';
    inner.style.transformOrigin = 'left top';
    const horizontalScale = d.layoutHorizontalScale || d.horizontalScale;
    inner.style.transform = horizontalScale && Math.abs(horizontalScale - 1) > .001
      ? `scaleX(${horizontalScale})`
      : '';
    inner.style.backgroundColor = '';
    inner.style.whiteSpace = d.layoutMode === 'wrap' ? 'pre-wrap' : 'pre';
    inner.style.overflowWrap = d.layoutMode === 'wrap' ? 'anywhere' : 'normal';
  }

  // --- Drag / resize --------------------------------------------------------

  async function getPageAspect(pageNumber) {
    if (pageInfoCache.has(pageNumber)) return pageInfoCache.get(pageNumber);
    if (!window.RenderEngine) return 1;
    try {
      const info = await window.RenderEngine.getPageInfo(pageNumber);
      const aspect = info.width / info.height;
      pageInfoCache.set(pageNumber, aspect);
      return aspect;
    } catch (_) { return 1; }
  }

  /** Pointer Events (not mouse+touch pairs) — one implementation covers
   *  mouse, touch, and pen alike, matching the pattern already established
   *  by js/core/pdf-canvas-widgets.js's wireCropCanvas(). setPointerCapture
   *  on the element the gesture started on (the handle span for a resize,
   *  the object wrapper for a move) keeps every subsequent pointermove/up
   *  targeted at that same element even once the finger/cursor leaves its
   *  bounds — same reason wireCropCanvas captures on its canvas — so
   *  listening on that element directly (rather than `window`, the old
   *  mouse-only implementation's approach) is sufficient and needs no
   *  separate cross-boundary tracking. touch-action:none on
   *  .editor-object/.editor-object-handle (css/editor-objects.css) is what
   *  stops a touch drag here from being hijacked as a page-scroll gesture
   *  instead of reaching these listeners at all. */
  function startDrag(e, obj, mode, handle) {
    e.preventDefault();
    e.stopPropagation();
    selectObject(obj.id);
    const wrap = getPageWrapper(obj.page);
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const start = { xPct: obj.xPct, yPct: obj.yPct, wPct: obj.wPct, hPct: obj.hPct };
    const before = getState();
    const lockAspect = obj.type === 'image' && obj.data && obj.data.keepAspectRatio !== false;
    let pageAspect = 1, imageAspect = 1;
    if (lockAspect) {
      imageAspect = (obj.data.naturalWidth && obj.data.naturalHeight) ? obj.data.naturalWidth / obj.data.naturalHeight : 1;
      getPageAspect(obj.page).then((a) => { pageAspect = a; });
    }

    const captureEl = e.currentTarget;
    const pointerId = e.pointerId;
    try { captureEl.setPointerCapture(pointerId); } catch (err) {}

    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      const dxPct = ((ev.clientX - startX) / rect.width) * 100;
      const dyPct = ((ev.clientY - startY) / rect.height) * 100;
      if (mode === 'move') {
        obj.xPct = clamp(start.xPct + dxPct, 0, Math.max(0, 100 - obj.wPct));
        obj.yPct = clamp(start.yPct + dyPct, 0, Math.max(0, 100 - obj.hPct));
      } else {
        applyResize(obj, start, handle, dxPct, dyPct, lockAspect ? (imageAspect / pageAspect) : null);
      }
      renderObjectBox(obj);
    }
    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      captureEl.removeEventListener('pointermove', onMove);
      captureEl.removeEventListener('pointerup', onUp);
      captureEl.removeEventListener('pointercancel', onUp);
      try { captureEl.releasePointerCapture(pointerId); } catch (err) {}
      // A plain click (no actual movement — including the pointerdown
      // that's part of every dblclick-to-edit sequence) must not push a no-op
      // undo step: compare against `start` rather than committing
      // unconditionally.
      const moved = obj.xPct !== start.xPct || obj.yPct !== start.yPct || obj.wPct !== start.wPct || obj.hPct !== start.hPct;
      if (moved) {
        obj.data = Object.assign({}, obj.data, {manualGeometry:true});
        if (mode === 'resize' && obj.type === 'text') {
          const layoutData = window.EditorTextLayout?.planWithinBox(obj);
          if (layoutData) obj.data = Object.assign({}, obj.data, layoutData);
          renderObjectContent(obj);
          renderObjectBox(obj);
        }
        commit(before);
      }
    }
    captureEl.addEventListener('pointermove', onMove);
    captureEl.addEventListener('pointerup', onUp);
    captureEl.addEventListener('pointercancel', onUp);
  }

  /** hAspectFactor, when set, is hPct/wPct's required ratio (accounting for
   *  the page's own aspect so the image's true visual aspect is preserved
   *  even though wPct/hPct are percentages of two different absolute
   *  lengths — same correction editor-toolbar.js's handlePickedImage()
   *  already applies once at initial placement). */
  function applyResize(obj, start, handle, dxPct, dyPct, hAspectFactor) {
    let w = start.wPct, h = start.hPct, x = start.xPct, y = start.yPct;
    const east = handle === 'ne' || handle === 'se';
    const south = handle === 'sw' || handle === 'se';
    if (east) w = start.wPct + dxPct; else { w = start.wPct - dxPct; x = start.xPct + dxPct; }
    if (south) h = start.hPct + dyPct; else { h = start.hPct - dyPct; y = start.yPct + dyPct; }
    w = Math.max(MIN_PCT, w);
    h = Math.max(MIN_PCT, h);
    if (hAspectFactor) {
      h = w * hAspectFactor;
      if (!south) y = start.yPct + start.hPct - h;
    }
    if (!east) x = start.xPct + start.wPct - w;
    obj.xPct = clamp(x, 0, 100);
    obj.yPct = clamp(y, 0, 100);
    obj.wPct = w;
    obj.hPct = h;
  }

  // --- Text editing ---------------------------------------------------------

  function startTextEdit(e, obj) {
    e.stopPropagation();
    const el = elById.get(obj.id);
    const inner = el && el.querySelector('.eo-text-inner');
    if (!inner) return;
    const textBeforeEdit = obj.data?.text || '';
    let before = getState();
    if (obj.data?.replaceOriginal && !obj.data.sourceCommitted) before = before.filter((item) => item.id !== obj.id);
    let cancelled = false;
    selectObject(obj.id);
    el.classList.add('is-editing');
    inner.contentEditable = 'true';
    inner.focus();
    const selection = window.getSelection?.();
    const pointerX = Number(e.clientX), pointerY = Number(e.clientY);
    let caretPlaced = false;
    if (selection && Number.isFinite(pointerX) && Number.isFinite(pointerY)) {
      const caret = document.caretPositionFromPoint?.(pointerX, pointerY);
      const range = caret ? document.createRange() : document.caretRangeFromPoint?.(pointerX, pointerY);
      if (caret && range) {
        range.setStart(caret.offsetNode, caret.offset);
        range.collapse(true);
      }
      const container = range?.startContainer;
      if (range && container && (container === inner || inner.contains(container))) {
        selection.removeAllRanges(); selection.addRange(range); caretPlaced = true;
      }
    }
    if (selection && !caretPlaced) {
      const range = document.createRange();
      range.selectNodeContents(inner); range.collapse(false);
      selection.removeAllRanges(); selection.addRange(range);
    }

    function finish() {
      inner.contentEditable = 'false';
      el.classList.remove('is-editing');
      inner.removeEventListener('blur', finish);
      inner.removeEventListener('keydown', onKey);
      const text = inner.textContent || '';
      const previousText = textBeforeEdit;
      const changed = text !== previousText;
      if (changed) {
        obj.data = Object.assign({}, obj.data, { text, sourceCommitted:true });
      }
      window.dispatchEvent(new CustomEvent('editor:textEditFinished', { detail: { object:obj, changed, cancelled } }));
      if (changed) {
        renderObjectContent(obj);
        renderObjectBox(obj);
        commit(before);
      }
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancelled = true; inner.textContent = obj.data.text || ''; inner.blur(); }
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); inner.blur(); }
    }
    inner.addEventListener('blur', finish);
    inner.addEventListener('keydown', onKey);
  }

  function discardObject(id, options){
    const idx=objects.findIndex(o=>o.id===id);
    if(idx===-1) return;
    elById.get(id)?.remove(); elById.delete(id); objects.splice(idx,1);
    if (!options?.silent) window.dispatchEvent(new CustomEvent('editor:objectsChanged'));
  }

  function editText(id,pointer){
    const obj=objects.find(o=>o.id===id);
    if(!obj || obj.type!=='text') return;
    selectObject(id);
    startTextEdit(Object.assign({stopPropagation:()=>{}},pointer||{}),obj);
  }

  // --- History support --------------------------------------------------

  function getState() {
    return objects.map((o) => ({ id: o.id, type: o.type, page: o.page, xPct: o.xPct, yPct: o.yPct, wPct: o.wPct, hPct: o.hPct, selected: o.selected, data: cloneValue(o.data || {}) }));
  }

  function restoreState(snapshot) {
    elById.forEach((el) => { if (el.parentNode) el.parentNode.removeChild(el); });
    elById.clear();
    objects = (snapshot || []).map((o) => Object.assign({}, o, { data: cloneValue(o.data || {}) }));
    let maxN = 0;
    objects.forEach((o) => { const n = parseInt(String(o.id).replace('obj', ''), 10); if (n > maxN) maxN = n; });
    nextId = maxN + 1;
    objects.forEach((o) => mountObjectEl(o));
    syncSelectionDom();
    window.dispatchEvent(new CustomEvent('editor:objectsChanged'));
  }

  function getAllObjects() { return objects; }

  function getSelectedObjects() { return objects.filter((object) => object.selected); }

  function cloneValue(value) {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (value && typeof value === 'object') {
      const copy = {};
      Object.keys(value).forEach((key) => { copy[key] = cloneValue(value[key]); });
      return copy;
    }
    return value;
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  window.EditorObjects = {
    init, beginPlacement, cancelPlacement, addObject, addObjects, getAllObjects, getSelectedObjects, updateObject, deleteObject, deleteObjects,
    selectObject, deselectAll, editText, discardObject, getState, restoreState
  };
})();
