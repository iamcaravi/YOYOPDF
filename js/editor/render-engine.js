/* ==========================================================================
   js/editor/render-engine.js
   ---------------------------------------------------------------------------
   Owns the pdf.js PDFDocumentProxy and knows how to render one page to one
   canvas at one scale. Nothing else in this engine talks to pdfjsLib
   directly — every other module (viewport-manager, thumbnail-engine,
   render-queue) goes through this file. That's the whole reason it exists
   as its own module: swap pdf.js for another renderer later, and only this
   file changes.

   Reads whatever window.pdfjsLib the host page has already loaded — it
   does not load or vendor pdf.js itself. Originally paired with a vendored
   copy at js/vendor/pdfjs/ for standalone testing (see PDF_RENDERING.md);
   as of the live-SPA integration, that vendored copy is discarded and this
   file instead reuses the pdf.js instance index.html already loads from
   cdnjs — see INTEGRATION_ROADMAP.md Priority 2. Nothing here assumes a
   specific loading strategy for pdf.js itself, vendored or CDN, standalone
   test harness or live app — it only ever reads window.pdfjsLib.
   ---------------------------------------------------------------------------
   Public surface:
     RenderEngine.loadDocument(fileOrArrayBuffer) -> Promise<{ numPages, ... }>
     RenderEngine.getPageInfo(pageNumber) -> Promise<{ width, height, ratio }>
     RenderEngine.renderPage(pageNumber, canvas, scale, { signal }) -> Promise
     RenderEngine.destroy()
   Events emitted:
     editor:documentLoaded  { numPages, fileName, fileSize, pdfVersion }
       (fileSize/pdfVersion added Priority 3E for the Inspector's Document
       section — same event, no new one; existing listeners that only read
       numPages/fileName are unaffected)
     editor:documentError   { message }

   Priority 5B — Export: this module is a pdf.js *viewer*, not a writer —
   there is no way to reconstruct the original PDF's bytes from a parsed
   PDFDocumentProxy, so Export needs the same bytes this file already reads
   at load time, retained rather than discarded. `loadDocument()` now
   clones the input buffer with `.slice(0)` *before* handing a copy to
   `pdfjsLib.getDocument({data})` — pdf.js can take ownership of (transfer/
   detach) the buffer it's given, a documented class of bug this exact
   project has hit before with a different tool ("the ArrayBuffer transfer/
   detach bug with pdf.js"), so the retained copy is taken first, never the
   same reference handed to pdf.js. New getter, `getOriginalBytes()`,
   returns a further clone each call (never the retained reference itself)
   so a caller can't accidentally mutate or detach this module's own copy.
   Cleared in `destroy()`, same as `pageInfoCache.clear()` already is —
   freed the moment a new document loads or the engine is torn down, not
   held indefinitely.

   Priority 6A — Existing PDF Text Detection: one more small, additive
   method, `getPageTextContent(pageNumber)`, calling pdf.js's core
   `page.getTextContent()` — a method already available on the same
   `PDFPageProxy` `getPageInfo()`/`renderPage()` already use, requiring no
   different pdf.js bundle or new dependency. Cached per page number,
   mirroring `pageInfoCache`'s own pattern in this same file; cleared in
   `destroy()` the same way. This module remains the only one that talks
   to `pdfjsLib` directly — `editor-text-detect.js` calls this method
   rather than reaching into pdf.js itself.
   ========================================================================== */
(function () {
  let pdfDoc = null;
  let fileName = '';
  let fileSize = 0;
  const pageInfoCache = new Map(); // pageNumber -> {width, height, ratio}
  const textContentCache = new Map(); // pageNumber -> Promise<TextContent>, Priority 6A
  const textLayoutCache = new Map();
  const annotationCache = new Map();
  let originalBytes = null; // Priority 5B — retained clone for Export, see file header
  let loadingTask = null;
  let loadGeneration = 0;

  function ensureWorker() {
    if (!window.pdfjsLib) throw new Error('pdf.js is not loaded — the host page must load it before RenderEngine is used.');
    // The live app configures workerSrc before the editor loads.
    // This fallback only matters for a standalone test harness that loaded
    // pdf.js without configuring a worker. It uses the same exact-version
    // local worker as the live app, avoiding worker CDN/CORS dependencies.

    if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('assets/vendor/pdfjs/3.11.174/pdf.worker.min.js', document.baseURI).href;
    }
  }

  function staleLoadError() {
    const error = new Error('A newer document replaced this load.');
    error.name = 'AbortError';
    return error;
  }

  function releaseCurrentDocument() {
    if (loadingTask) {
      try { loadingTask.destroy(); } catch (_) { /* best effort */ }
      loadingTask = null;
    }
    if (pdfDoc) {
      try { pdfDoc.destroy(); } catch (_) { /* best effort */ }
      pdfDoc = null;
    }
    pageInfoCache.clear();
    textContentCache.clear();
    textLayoutCache.clear();
    annotationCache.clear();
    originalBytes = null;
  }

  async function loadDocument(input) {
    ensureWorker();
    const generation = ++loadGeneration;
    releaseCurrentDocument();

    let data;
    let nextFileName = '';
    let nextFileSize = 0;
    let candidateDoc = null;
    try {
      if (input instanceof File) {
        if (typeof window.validateFileSelection === 'function') {
          await window.validateFileSelection([input], { accept: 'application/pdf', multiple: false });
        }
        if (generation !== loadGeneration) throw staleLoadError();
        nextFileName = input.name;
        nextFileSize = input.size;
        data = await input.arrayBuffer();
      } else {
        data = input;
        nextFileSize = data?.byteLength || 0;
      }

      if (generation !== loadGeneration) throw staleLoadError();
      const maxBytes = window.YOYO_RUNTIME?.limits?.maxBytes?.pdf || (200 * 1024 * 1024);
      const t = window.I18N ? window.I18N.t : (k) => k;
      if (!nextFileSize) throw new Error(t('editor.errPdfEmpty'));
      if (nextFileSize > maxBytes) throw new Error(t('editor.errPdfTooLarge'));

      // Retain a separate copy before pdf.js can transfer/detach its input.
      const retainedBytes = (data && typeof data.slice === 'function') ? data.slice(0) : null;
      const task = window.pdfjsLib.getDocument({ data });
      loadingTask = task;
      candidateDoc = await task.promise;
      if (loadingTask === task) loadingTask = null;
      if (generation !== loadGeneration) throw staleLoadError();

      const maxPages = window.YOYO_RUNTIME?.limits?.maxPdfPages || 1500;
      if (!candidateDoc.numPages) throw new Error(t('editor.errPdfNoPages'));
      if (candidateDoc.numPages > maxPages) {
        throw new Error(t('editor.errPdfTooManyPages', { n: candidateDoc.numPages, max: maxPages }));
      }

      pdfDoc = candidateDoc;
      candidateDoc = null;
      fileName = nextFileName;
      fileSize = nextFileSize;
      originalBytes = retainedBytes;

      // Best-effort metadata: a missing or malformed metadata dictionary
      // must not prevent otherwise valid pages from opening.
      let pdfVersion = '';
      try {
        const meta = await pdfDoc.getMetadata();
        pdfVersion = (meta && meta.info && meta.info.PDFFormatVersion) || '';
      } catch (_) { /* non-fatal — leave pdfVersion empty */ }
      if (generation !== loadGeneration) throw staleLoadError();

      const result = { numPages: pdfDoc.numPages, fileName, fileSize, pdfVersion };
      window.dispatchEvent(new CustomEvent('editor:documentLoaded', { detail: result }));
      return result;
    } catch (err) {
      if (candidateDoc) { try { await candidateDoc.destroy(); } catch (_) { /* best effort */ } }
      if (generation === loadGeneration && err?.name !== 'AbortError') {
        releaseCurrentDocument();
        window.dispatchEvent(new CustomEvent('editor:documentError', { detail: { message: err.message || String(err) } }));
      }
      throw err;
    }
  }
  async function getPageInfo(pageNumber) {
    if (pageInfoCache.has(pageNumber)) return pageInfoCache.get(pageNumber);
    if (!pdfDoc) throw new Error('No document loaded');
    const page = await pdfDoc.getPage(pageNumber);
    const vp = page.getViewport({ scale: 1 });
    const info = { width: vp.width, height: vp.height, ratio: vp.width / vp.height, rotation: vp.rotation };
    pageInfoCache.set(pageNumber, info);
    return info;
  }

  /** Priority 6A: pdf.js's core text-extraction API — see file header.
   *  Cached per page, same shape as getPageInfo()'s own cache above. */
  async function getPageTextContent(pageNumber) {
    if (textContentCache.has(pageNumber)) return textContentCache.get(pageNumber);
    if (!pdfDoc) throw new Error('No document loaded');
    const promise = pdfDoc.getPage(pageNumber).then((page) => page.getTextContent());
    textContentCache.set(pageNumber, promise);
    return promise;
  }

  async function getPageTextLayout(pageNumber) {
    if (textLayoutCache.has(pageNumber)) return textLayoutCache.get(pageNumber);
    if (!pdfDoc) throw new Error('No document loaded');
    const promise = (async () => {
      const page = await pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
      const util = window.pdfjsLib.Util;
      const paintRuns = await getPageTextPaintRuns(page);
      const paintByItem = alignPaintRuns(content.items, paintRuns);
      const items = content.items.filter((item) => item.str != null && item.str.length).map((item, index) => {
        const tx = util.transform(viewport.transform, item.transform);
        const fontHeight = Math.max(1, Math.hypot(tx[2], tx[3]));
        const angle = Math.atan2(tx[1], tx[0]) * 180 / Math.PI;
        const style = content.styles[item.fontName] || {};
        const ascent = Number.isFinite(style.ascent) ? style.ascent : 0.8;
        const descent = Number.isFinite(style.descent) ? style.descent : -0.2;
        const baseline = tx[5];
        const height = Math.max(1, (ascent - descent) * fontHeight);
        const width = Math.max(1, Math.abs(item.width || 0));
        const paint = paintByItem[index] || {};
        let fontObject = null;
        try { fontObject = page.commonObjs && page.commonObjs.get(item.fontName); } catch (_) { /* best-effort internal font metadata */ }
        const fontFamily = fontObject?.loadedName || fontObject?.fallbackName || style.fontFamily || item.fontName || unicodeFallback(item.str);
        return {
          index, text:item.str, x:tx[4], y:baseline-ascent*fontHeight,
          width, height, angle, baseline,
          transform:Array.from(item.transform || []),
          fontSize:fontHeight, fontFamily, fontName:item.fontName || '',
          bold:!!fontObject?.black || !!fontObject?.bold || /bold|black|heavy|semibold/i.test(`${fontFamily} ${item.fontName || ''}`),
          italic:!!fontObject?.italic || /italic|oblique/i.test(`${fontFamily} ${item.fontName || ''}`),
          color:paint.color || '#000000', opacity:paint.opacity == null ? 1 : paint.opacity,
          characterSpacing:paint.characterSpacing || 0, wordSpacing:paint.wordSpacing || 0,
          horizontalScale:paint.horizontalScale || 1, textRise:paint.textRise || 0,
          ascent, descent, direction:item.dir || 'ltr', vertical:!!style.vertical
        };
      });
      return {width:viewport.width,height:viewport.height,rotation:viewport.rotation,items:groupTextItems(items)};
    })();
    textLayoutCache.set(pageNumber,promise);
    return promise;
  }

  /** Root cause of the "one editable box per word" problem this function
   *  fixes: pdf.js's own getTextContent() returns one TextItem per
   *  content-stream text-showing operator, which many real-world PDFs
   *  (especially form-generated ones, e.g. tax acknowledgements) emit
   *  once per word or short run - never once per visual line. Everything
   *  downstream of this file (editor-content.js's hit-boxes, the
   *  EditorTextLayout reflow/collision planner, and PDF export in
   *  editor-export.js, which only ever draws a cover-rectangle over
   *  data.sourceBox + the new text - it never touches the PDF's original
   *  content-stream operators) already works purely off of each item's
   *  bounding box and never assumed a 1:1 correspondence with a raw
   *  pdf.js item, so merging happens exactly once, here, at the source -
   *  every consumer benefits automatically with no changes of its own.
   *
   *  Greedy left-to-right run building per visual row: repeatedly extend
   *  the current run with whichever remaining item is the nearest
   *  same-row neighbor to its right, stopping the run (not skipping past
   *  the gap) the moment that neighbor fails to look like normal
   *  in-line text flow. Adaptive to font size (not one fixed pixel gap),
   *  so it works the same at any PDF size/zoom - callers only ever see
   *  this in PDF point-space (scale 1), never CSS/zoomed pixels.
   *
   *  Deliberately conservative about what it merges: a large horizontal
   *  gap (table cell/column boundary), a real font-size mismatch, or any
   *  rotation/vertical text keeps items separate - see canMergeAdjacent()
   *  and the rotated-text carve-out below. Under-merging only costs a
   *  user one extra click to select an adjacent run; over-merging would
   *  silently corrupt a table (exactly what the "PAN / HEGPS2973D" and
   *  "Name / JITENDRA PRATAP SINGH" cases in the brief this was built
   *  against warn against), so every threshold here errs toward keeping
   *  genuinely separate content separate.
   */
  function isSameTextRow(a, b) {
    const overlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    if (overlap >= Math.min(a.height, b.height) * 0.42) return true;
    const refSize = Math.max(1, Math.max(a.fontSize, b.fontSize));
    return Math.abs((a.baseline ?? a.y + a.height) - (b.baseline ?? b.y + b.height)) <= Math.max(2, refSize * 0.3);
  }

  function canMergeAdjacent(last, cand) {
    const gap = cand.x - (last.x + last.width);
    if (gap < -Math.max(2, last.height * 0.3)) return false; // overlapping / out of natural reading order
    if (!isSameTextRow(last, cand)) return false;
    const big = Math.max(last.fontSize, cand.fontSize), small = Math.min(last.fontSize, cand.fontSize);
    if (small <= 0 || big / small > 1.35) return false; // meaningfully different type sizes -> not the same run
    const refSize = (last.fontSize + cand.fontSize) / 2;
    // Normal inter-word spacing scales with font size, not a fixed px value
    // - this is what makes grouping work the same at any PDF size/zoom.
    // A real table/column gap is comfortably larger than this in every
    // sample layout this was checked against (including the PAN/Name
    // table cells in the brief), while ordinary word spacing (including a
    // stray double-space) stays well under it.
    const maxWordGap = Math.max(refSize * 0.9, 3);
    return gap <= maxWordGap;
  }

  function groupTextItems(rawItems) {
    // Whitespace-only items (pdf.js sometimes emits a literal " " TextItem
    // between words, INSTEAD OF encoding the gap purely as position math)
    // are dropped before grouping ever runs - editor-content.js's own
    // hit-box loop already treats them as unclickable (`!item.text.trim()`),
    // and keeping them in the candidate pool actively breaks table
    // detection: a wide space item can span an entire cell-boundary gap
    // with a ~0 gap on EITHER side of itself, which made the gap check
    // below think "PAN" and a same-row value in the next cell were
    // touching, when the real distance between them was never checked at
    // all. Confirmed live against a synthetic PAN/HEGPS2973D-style table
    // row - without this exclusion those two merge into one box; with it,
    // the real ~200pt gap between them is what the gap check actually
    // sees, and they correctly stay separate.
    const meaningful = rawItems.filter((item) => item.text && item.text.trim().length);
    // Rotated/vertical text is kept exactly as pdf.js reported it, one
    // item per box - x/y/width here are an axis-aligned bounding box, not
    // a coordinate frame this row/gap math is valid in once real rotation
    // is involved (see editor-text-layout.js's own >2° carve-out, which
    // this mirrors rather than risk mis-grouping geometry it can't
    // reliably reason about).
    const flat = meaningful.filter((item) => Math.abs(item.angle || 0) <= 2 && !item.vertical);
    const rotated = meaningful.filter((item) => !(Math.abs(item.angle || 0) <= 2 && !item.vertical));
    const sorted = flat.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const n = sorted.length;
    const used = new Array(n).fill(false);
    const runs = [];
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const run = [sorted[i]];
      used[i] = true;
      let last = sorted[i];
      for (;;) {
        let bestIdx = -1, bestX = Infinity;
        for (let j = 0; j < n; j++) {
          if (used[j]) continue;
          const cand = sorted[j];
          if (cand.x < last.x + last.width - Math.max(1, last.height * 0.15)) continue; // must extend past the run's current right edge
          if (!isSameTextRow(last, cand)) continue;
          if (cand.x < bestX) { bestX = cand.x; bestIdx = j; }
        }
        if (bestIdx === -1) break;
        const cand = sorted[bestIdx];
        if (!canMergeAdjacent(last, cand)) break; // real gap/size mismatch: stop the run here, don't skip past it
        run.push(cand);
        used[bestIdx] = true;
        last = cand;
      }
      runs.push(run);
    }
    const grouped = runs.map((run) => buildGroupedTextItem(run)).concat(rotated.map((item) => Object.assign({}, item)));
    // Reading order for downstream consumers (find/replace result order,
    // spatial index construction) - by row then column, same ordering
    // principle the input was sorted with above.
    grouped.sort((a, b) => a.y - b.y || a.x - b.x);
    grouped.forEach((item, index) => { item.index = index; });
    return grouped;
  }

  function buildGroupedTextItem(run) {
    if (run.length === 1) return Object.assign({}, run[0]);
    const first = run[0];
    const minX = Math.min(...run.map((r) => r.x));
    const minY = Math.min(...run.map((r) => r.y));
    const maxRight = Math.max(...run.map((r) => r.x + r.width));
    const maxBottom = Math.max(...run.map((r) => r.y + r.height));
    let text = '';
    for (let i = 0; i < run.length; i++) {
      const item = run[i];
      if (i > 0) {
        const prev = run[i - 1];
        const gap = item.x - (prev.x + prev.width);
        const alreadyHasSpace = /\s$/.test(text) || /^\s/.test(item.text);
        if (!alreadyHasSpace && gap > Math.max(1, item.fontSize * 0.12)) text += ' ';
      }
      text += item.text;
    }
    return Object.assign({}, first, {
      text, x: minX, y: minY, width: maxRight - minX, height: maxBottom - minY
    });
  }

  function unicodeFallback(text) {
    return /[\u0900-\u097f]/.test(text || '') ? 'Noto Sans Devanagari' : 'sans-serif';
  }

  function normalizedText(value) { return String(value || '').replace(/\s+/g, ''); }

  /** Align PDF.js text-content items with operator-list paint runs by their
   *  ordered character ranges. A showText operator may produce several text
   *  items (or several operators may be combined into one item), so advancing
   *  one paint run per item assigns neighboring colors to the wrong text.
   *  The greatest-overlap run is the best single-style representation when a
   *  PDF.js item genuinely spans more than one painted run. */
  function alignPaintRuns(rawItems, paintRuns) {
    const items = rawItems.filter((item) => item.str != null && item.str.length);
    const segments = [];
    let stream = '';
    paintRuns.forEach((run) => {
      const text = normalizedText(run.text);
      if (!text) return;
      const start = stream.length;
      stream += text;
      segments.push({start,end:stream.length,run});
    });
    let cursor = 0, segmentIndex = 0;
    return items.map((item) => {
      const text = normalizedText(item.str);
      if (!text || !segments.length) return {};
      let start = stream.indexOf(text, cursor);
      if (start === -1) start = cursor;
      const end = Math.min(stream.length, start + text.length);
      while (segmentIndex < segments.length - 1 && segments[segmentIndex].end <= start) segmentIndex++;
      let best = segments[segmentIndex], bestOverlap = -1;
      for (let i = segmentIndex; i < segments.length && segments[i].start < end; i++) {
        const overlap = Math.max(0, Math.min(end, segments[i].end) - Math.max(start, segments[i].start));
        if (overlap > bestOverlap) { best = segments[i]; bestOverlap = overlap; }
      }
      cursor = Math.max(cursor, end);
      return best?.run || {};
    });
  }

  function operatorText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(operatorText).join('');
    if (value && typeof value === 'object') return value.unicode || value.fontChar || '';
    return '';
  }

  function colorHex(args) {
    let values = args;
    if (args?.length === 1 && (Array.isArray(args[0]) || ArrayBuffer.isView(args[0]))) values = Array.from(args[0]);
    values = Array.from(values || []).slice(0, 3).map(Number);
    if (values.length < 3 || values.some((n) => !Number.isFinite(n))) return '#000000';
    if (Math.max(...values) <= 1) values = values.map((n) => n * 255);
    return '#' + values.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
  }

  function grayHex(args) {
    const raw = args?.length === 1 && (Array.isArray(args[0]) || ArrayBuffer.isView(args[0])) ? args[0][0] : args?.[0];
    const gray = Number(raw);
    const scale = Number.isFinite(gray) && gray > 1 ? 255 : 1;
    const byte = Math.round(Math.max(0, Math.min(1, Number.isFinite(gray) ? gray / scale : 0)) * 255);
    return colorHex([byte, byte, byte]);
  }

  function cmykHex(args) {
    let values = args;
    if (args?.length === 1 && (Array.isArray(args[0]) || ArrayBuffer.isView(args[0]))) values = Array.from(args[0]);
    const [c,m,y,k] = Array.from(values || []).slice(0,4).map(Number);
    if (![c,m,y,k].every(Number.isFinite)) return '#000000';
    const scale = Math.max(c,m,y,k) > 1 ? 255 : 1;
    const channel = (component) => 255 * (1 - Math.min(1, component / scale + k / scale));
    return colorHex([channel(c),channel(m),channel(y)]);
  }

  async function getPageTextPaintRuns(page) {
    const OPS = window.pdfjsLib.OPS || {};
    const list = await page.getOperatorList();
    const state = { fillColor:'#000000', strokeColor:'#000000', fillOpacity:1, strokeOpacity:1, renderingMode:0, characterSpacing:0, wordSpacing:0, horizontalScale:1, textRise:0 };
    const stack = [], runs = [];
    for (let i = 0; i < list.fnArray.length; i++) {
      const fn = list.fnArray[i], args = list.argsArray[i] || [];
      if (fn === OPS.save) stack.push(Object.assign({}, state));
      else if (fn === OPS.restore && stack.length) Object.assign(state, stack.pop());
      else if (fn === OPS.setFillRGBColor) state.fillColor = colorHex(args);
      else if (fn === OPS.setStrokeRGBColor) state.strokeColor = colorHex(args);
      else if (fn === OPS.setFillGray) state.fillColor = grayHex(args);
      else if (fn === OPS.setStrokeGray) state.strokeColor = grayHex(args);
      else if (fn === OPS.setFillCMYKColor) state.fillColor = cmykHex(args);
      else if (fn === OPS.setStrokeCMYKColor) state.strokeColor = cmykHex(args);
      else if (fn === OPS.setTextRenderingMode) state.renderingMode = Number(args[0]) || 0;
      else if (fn === OPS.setCharSpacing) state.characterSpacing = Number(args[0]) || 0;
      else if (fn === OPS.setWordSpacing) state.wordSpacing = Number(args[0]) || 0;
      else if (fn === OPS.setHScale) state.horizontalScale = (Number(args[0]) || 100) / 100;
      else if (fn === OPS.setTextRise) state.textRise = Number(args[0]) || 0;
      else if (fn === OPS.setGState) {
        const entries = Array.isArray(args[0]) ? args[0] : args;
        for (const entry of entries) if (Array.isArray(entry)) {
          const value = Number(entry[1]);
          if (entry[0] === 'ca' && Number.isFinite(value)) state.fillOpacity = Math.max(0,Math.min(1,value));
          if (entry[0] === 'CA' && Number.isFinite(value)) state.strokeOpacity = Math.max(0,Math.min(1,value));
        }
      } else if (fn === OPS.showText || fn === OPS.showSpacedText || fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
        const strokeOnly = state.renderingMode === 1 || state.renderingMode === 5;
        runs.push(Object.assign({
          text:operatorText(args),
          color:strokeOnly ? state.strokeColor : state.fillColor,
          opacity:strokeOnly ? state.strokeOpacity : state.fillOpacity
        }, state));
      }
    }
    return runs;
  }

  async function getPageAnnotations(pageNumber) {
    if (annotationCache.has(pageNumber)) return annotationCache.get(pageNumber);
    if (!pdfDoc) throw new Error('No document loaded');
    const promise = (async () => {
      const page = await pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({scale:1});
      const annotations = await page.getAnnotations({intent:'display'});
      return annotations.map((annotation,index) => {
        const rect = annotation.rect ? viewport.convertToViewportRectangle(annotation.rect) : [0,0,0,0];
        return Object.assign({},annotation,{index,viewportRect:[Math.min(rect[0],rect[2]),Math.min(rect[1],rect[3]),Math.max(rect[0],rect[2]),Math.max(rect[1],rect[3])]});
      });
    })();
    annotationCache.set(pageNumber,promise);
    return promise;
  }

  /**
   * Renders one page into one canvas at the given scale. Returns the live
   * pdf.js RenderTask so callers (render-queue.js) can .cancel() it — this
   * is the single most important hook for avoiding wasted/leaked work when
   * the user scrolls past a page or changes zoom mid-render.
   *
   * Priority 3G: renders at `scale * devicePixelRatio` internally so pages
   * are crisp on HiDPI/Retina screens, while the canvas's *displayed* size
   * (`canvas.style.width/height`) stays pinned to the original CSS-pixel
   * viewport — every caller (viewport-manager.js, thumbnail-engine.js)
   * keeps passing the same plain `scale` it always has, unaware of DPR;
   * this is entirely internal to this one module, matching this file's own
   * "only this file changes" boundary (see file header). The pdf.js
   * `transform` option scales what's drawn to match the enlarged canvas
   * buffer without touching `viewport` itself, so callers that read
   * `viewport.width/height` for layout math (e.g. aspect-ratio) are
   * unaffected — only the raster resolution changes.
   */
  async function renderPage(pageNumber, canvas, scale) {
    if (!pdfDoc) throw new Error('No document loaded');
    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.ceil(viewport.width * dpr);
    canvas.height = Math.ceil(viewport.height * dpr);
    canvas.style.width = Math.ceil(viewport.width) + 'px';
    canvas.style.height = Math.ceil(viewport.height) + 'px';

    const ctx = canvas.getContext('2d');
    const renderTask = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
    });
    return renderTask; // has .promise and .cancel()
  }

  function getNumPages() {
    return pdfDoc ? pdfDoc.numPages : 0;
  }

  /** Priority 5B: a fresh clone of the originally-loaded document's bytes,
   *  for Export to build a new PDFDocument.load() from — see file header.
   *  Returns null if no document is loaded. Always returns a new clone,
   *  never the module's own retained reference, so a caller can't
   *  accidentally mutate or detach it. */
  function getOriginalBytes() {
    return originalBytes ? originalBytes.slice(0) : null;
  }

  function destroy() {
    loadGeneration += 1;
    releaseCurrentDocument();
    fileName = '';
    fileSize = 0;
  }

  window.RenderEngine = { loadDocument, getPageInfo, getPageTextContent, getPageTextLayout, getPageAnnotations, renderPage, getNumPages, getOriginalBytes, destroy };

  // Every module that awaits a RenderTask's .promise already treats
  // RenderingCancelledException as expected/non-fatal (see render-queue.js
  // and thumbnail-engine.js's catch blocks). Under rapid cancellation
  // bursts — e.g. Home/End jumping across a hundred pages at once — a
  // handful of these can still surface as unhandled promise rejections
  // before a module's own try/catch finishes binding, which is pdf.js's
  // internal cancellation plumbing, not a bug in this engine's own control
  // flow (verified: functionality is unaffected either way — the target
  // page still renders correctly). This handler exists so "no console
  // errors" holds under that specific, verified-harmless condition without
  // silently swallowing any *other* kind of unhandled rejection.
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason && event.reason.name === 'RenderingCancelledException') {
      event.preventDefault();
    }
  });
})();
