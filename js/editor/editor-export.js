/* ==========================================================================
   js/editor/editor-export.js
   ---------------------------------------------------------------------------
   Flattens editor-objects.js's object list back into the original PDF and
   triggers a download. editor-toolbar.js's Save button already calls
   window.EditorExport.exportCurrentDocument() — this implements that.

   Uses RenderEngine.getOriginalBytes() (Priority 5B, see render-engine.js's
   own file header — it already retains a clone of the loaded file's bytes
   specifically for this) rather than re-reading the input File, and pdf-lib
   (already loaded by index.html for every other tool) to reconstruct the
   output, reusing index.html's own loadPdfSafe()/downloadBlob() helpers
   when present (same fallback convention every other editor-*.js file
   already uses for its index.html-only dependencies).

   Coordinate conversion: editor-objects.js stores each object as xPct/yPct
   (top-left, 0-100, percent of the page box) / wPct/hPct (percent size).
   pdf-lib's page space has its origin at the bottom-left in points, so
   every draw call below converts top-down percentages into that space
   using the page's own getSize() — see toPdfBox().

   Text uses built-in PDF fonts where possible, wraps to the object width,
   and falls back to the existing same-origin Noto Sans Devanagari assets
   for text that StandardFonts cannot encode.
     - Rectangle corner radius (data.radius) IS applied on export (Phase
       12) via drawSvgPath() with a hand-built rounded-rect path, since
       pdf-lib's drawRectangle has no radius parameter of its own — see
       roundedRectSvgPath()/drawShapeObject() below. Sharp-cornered (r=0)
       rectangles are unaffected, still drawn via the original drawRectangle
       call.
   ---------------------------------------------------------------------------
   Public surface: window.EditorExport.init()
                   window.EditorExport.exportCurrentDocument() -> Promise
   ========================================================================== */
(function () {
  // Only ever used by the window.downloadBlob-missing fallback below (a
  // defensive path for a dependency index.html always actually loads) -
  // tracked and revoked on the next export the same way pdf-processing-
  // utils.js's own downloadBlob() tracks __activeResultUrl, so repeated
  // exports through this fallback don't leak one object URL each.
  let __fallbackExportUrl = null;
  let __printUrl = null;
  let __printFrame = null;
  let __printStyleEl = null;
  let __printCleanupTimer = null;
  let __printListenerActive = false;
  let currentFileName = '';
  let documentGeneration = 0;
  let exportController = null;
  let printController = null;
  let fallbackExportPromise = null;
  let fallbackPrintPromise = null;
  function t(key, vars) { return window.I18N ? window.I18N.t(key, vars) : key; }

  function init() {
    if(typeof window.createOperationController === 'function') {
      // These toolbar buttons contain an icon plus a visible label. A null
      // default button keeps the shared controller from replacing that rich
      // markup with plain text while statusbar progress still reports work.
      exportController = window.createOperationController(null, {timeoutMs:120000});
      printController = window.createOperationController(null, {timeoutMs:120000});
    }
    window.addEventListener('editor:documentLoaded', (e) => {
      documentGeneration += 1;
      exportController?.cancel();
      printController?.cancel();
      cleanupPrintSurface();
      currentFileName = (e.detail && e.detail.fileName) || '';
    });
  }

  function outputFileName() {
    // Defers to pdf-processing-utils.js's suffixedName() when it's loaded
    // (same index.html-only-dependency fallback convention as
    // downloadBlob() above) so this export path strips any prior
    // _compressed/_rotated/etc suffix and caps length exactly like every
    // other tool's download, instead of maintaining a second, weaker
    // copy of that logic.
    if (typeof window.suffixedName === 'function') {
      return window.suffixedName(currentFileName ? { name: currentFileName } : null, 'edited', 'pdf');
    }
    const base = currentFileName ? currentFileName.replace(/\.pdf$/i, '') : 'document';
    return `${base}_edited.pdf`;
  }

  function mapFontKey(fontFamily, bold, italic) {
    const family = (fontFamily || 'Arial').toLowerCase();
    let base = 'Helvetica';
    if (family.includes('times') || family.includes('georgia')) base = 'TimesRoman';
    else if (family.includes('courier')) base = 'Courier';
    if (base === 'TimesRoman') {
      if (bold && italic) return 'TimesRomanBoldItalic';
      if (bold) return 'TimesRomanBold';
      if (italic) return 'TimesRomanItalic';
      return 'TimesRoman';
    }
    if (base === 'Courier') {
      if (bold && italic) return 'CourierBoldOblique';
      if (bold) return 'CourierBold';
      if (italic) return 'CourierOblique';
      return 'Courier';
    }
    if (bold && italic) return 'HelveticaBoldOblique';
    if (bold) return 'HelveticaBold';
    if (italic) return 'HelveticaOblique';
    return 'Helvetica';
  }

  /** Converts an object's top-down xPct/yPct/wPct/hPct box into pdf-lib's
   *  bottom-left-origin point space for a page of size (pw, ph). */
  function toPdfBox(obj, page) {
    const {width:pw,height:ph}=page.getSize();
    const rotation=((page.getRotation()?.angle||0)%360+360)%360;
    const displayW=rotation===90||rotation===270?ph:pw;
    const displayH=rotation===90||rotation===270?pw:ph;
    const dx=(obj.xPct/100)*displayW, w=(obj.wPct/100)*displayW;
    const h=(obj.hPct/100)*displayH, dy=displayH-(obj.yPct/100)*displayH-h;
    if(rotation===90) return {x:dy,y:ph-dx-w,w:h,h:w,yTopPdf:ph-dx,rotation};
    if(rotation===180) return {x:pw-dx-w,y:ph-dy-h,w,h,yTopPdf:ph-dy,rotation};
    if(rotation===270) return {x:pw-dy-h,y:dx,w:h,h:w,yTopPdf:dx+w,rotation};
    return {x:dx,y:dy,w,h,yTopPdf:dy+h,rotation};
  }

  function hexToRgb01(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '000000');
    if (!m) return { r: 0, g: 0, b: 0 };
    return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
  }

  function sniffImageType(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
    return null;
  }

  async function drawTextObject(page, obj, pdfDoc, fontCache, rgb) {
    const d = obj.data || {};
    const { x, y, w, h, yTopPdf, rotation } = toPdfBox(obj, page);
    if(d.replaceOriginal && d.sourceBox){
      const cover=toPdfBox(d.sourceBox,page);
      const background=hexToRgb01(d.backgroundColor||'#ffffff');
      page.drawRectangle({x:cover.x,y:cover.y,width:cover.w,height:cover.h,color:rgb(background.r,background.g,background.b)});
    }
    const sourceText=String(d.text != null ? d.text : 'Text');
    const needsUnicode=/[^\u0000-\u00ff]/.test(sourceText);
    let font,key;
    if(needsUnicode){
      key=d.bold?'unicodeBold':'unicodeRegular';
      if(!fontCache[key]){
        if(typeof window.ensureFontkit!=='function') throw new Error('Unicode font support is unavailable.');
        await window.ensureFontkit();
        pdfDoc.registerFontkit(window.fontkit);
        const url=d.bold?'assets/vendor/noto-sans-devanagari/3a06b1c521155492df224d33464b3c7b2852d861/NotoSansDevanagari-Bold.ttf':'assets/vendor/noto-sans-devanagari/3a06b1c521155492df224d33464b3c7b2852d861/NotoSansDevanagari-Regular.ttf';
        const response=await fetch(url); if(!response.ok) throw new Error('Could not load the Unicode editing font.');
        fontCache[key]=await pdfDoc.embedFont(await response.arrayBuffer(),{subset:true});
      }
      font=fontCache[key];
    }else{
      key=mapFontKey(d.fontFamily,d.bold,d.italic);
      if(!fontCache[key]) fontCache[key]=await pdfDoc.embedFont(window.PDFLib.StandardFonts[key]);
      font=fontCache[key];
    }
    let size = d.layoutFontSize || d.fontSize || 16;
    if(d.replaceOriginal && !d.reflowApplied && !sourceText.includes('\n')){
      const naturalWidth=font.widthOfTextAtSize(sourceText,size);
      if(naturalWidth>w && naturalWidth>0) size=Math.max(size*.72,size*(w/naturalWidth));
    }
    const color = hexToRgb01(d.color);
    const sanitize = needsUnicode ? (s)=>s : (typeof window.winAnsiSafe === 'function' ? window.winAnsiSafe : (s) => s);
    const plannedLines=Array.isArray(d.layoutLines)?d.layoutLines.map(line=>sanitize(line)):null;
    const lines=plannedLines?plannedLines.slice():[];
    if(!plannedLines) sanitize(sourceText).split('\n').forEach(paragraph=>{
      const words=paragraph.split(/(\s+)/); let line='';
      words.forEach(word=>{
        const candidate=line+word;
        if(line && font.widthOfTextAtSize(candidate,size)>w){ lines.push(line.trimEnd()); line=word.trimStart(); }
        else line=candidate;
      });
      lines.push(line);
    });
    const widestLine=lines.reduce((max,line)=>Math.max(max,font.widthOfTextAtSize(line,size)),0);
    if(widestLine>w && widestLine>0) size=Math.max(size*.72,size*(w/widestLine));
    const lineHeight = size * (d.lineHeight || 1.2);
    const maxLines=Math.max(1,Math.floor(h/lineHeight));
    if(lines.length>maxLines) lines.length=maxLines;
    const baselineOffset=(Number(d.baselineOffset)||size)*(size/(Number(d.originalFontSize)||size));
    let cursorY = yTopPdf - baselineOffset;
    const operators=window.PDFLib;
    const canClip=d.replaceOriginal && operators.pushGraphicsState && operators.rectangle && operators.clip && operators.endPath && operators.popGraphicsState;
    if(canClip) page.pushOperators(operators.pushGraphicsState(),operators.rectangle(x,y,w,h),operators.clip(),operators.endPath());
    for (const line of lines) {
      let lineX = x;
      if (d.align === 'center' || d.align === 'right') {
        const textWidth = font.widthOfTextAtSize(line, size);
        if (d.align === 'center') lineX = x + (w - textWidth) / 2;
        else lineX = x + (w - textWidth);
      }
      page.drawText(line, { x: lineX, y: cursorY, size, font, color: rgb(color.r, color.g, color.b), opacity:d.opacity==null?1:d.opacity, rotate:window.PDFLib.degrees((d.rotation||0)-rotation) });
      if (d.underline) {
        const textWidth = font.widthOfTextAtSize(line, size);
        page.drawLine({ start: { x: lineX, y: cursorY - size * 0.12 }, end: { x: lineX + textWidth, y: cursorY - size * 0.12 }, thickness: Math.max(0.5, size * 0.05), color: rgb(color.r, color.g, color.b) });
      }
      cursorY -= lineHeight;
    }
    if(canClip) page.pushOperators(operators.popGraphicsState());
  }

  async function drawImageObject(page, obj, pdfDoc) {
    const d = obj.data || {};
    if (!d.src) throw new Error(t('editor.errNoImageSource'));
    const res = await fetch(d.src);
    const buf = new Uint8Array(await res.arrayBuffer());
    const kind = sniffImageType(buf);
    let embedded;
    if (kind === 'png') embedded = await pdfDoc.embedPng(buf);
    else if (kind === 'jpg') embedded = await pdfDoc.embedJpg(buf);
    else throw new Error(t('editor.errUnsupportedImageFormat'));
    const { x, y, w, h, rotation } = toPdfBox(obj, page);
    page.drawImage(embedded, { x, y, width: w, height: h, rotate:window.PDFLib.degrees((d.rotation||0)-rotation) });
  }

  /** SVG path for a rounded rectangle, top-left-anchored, y increasing
   *  downward (the convention page.drawSvgPath() expects - it flips the
   *  path into PDF's y-up space itself via its own anchor+scale, the same
   *  way toPdfBox()'s yTopPdf already anchors drawTextObject() above). r is
   *  pre-clamped by the caller so it can never exceed half of w or h. */
  function roundedRectSvgPath(w, h, r) {
    return `M ${r},0 L ${w - r},0 A ${r},${r} 0 0 1 ${w},${r} L ${w},${h - r} A ${r},${r} 0 0 1 ${w - r},${h} L ${r},${h} A ${r},${r} 0 0 1 0,${h - r} L 0,${r} A ${r},${r} 0 0 1 ${r},0 Z`;
  }

  function drawShapeObject(page, obj, rgb) {
    const d = obj.data || {};
    const { x, y, w, h, yTopPdf } = toPdfBox(obj, page);
    const stroke = hexToRgb01(d.stroke);
    const strokeWidth = d.strokeWidth != null ? d.strokeWidth : 2;
    if (obj.type === 'rectangle') {
      const fill = hexToRgb01(d.fill);
      const radius = Math.max(0, Math.min(d.radius || 0, w / 2, h / 2));
      if (radius > 0) {
        // Sharp corners still go through drawRectangle (unchanged, zero
        // regression risk for the common no-radius case) - only a real
        // radius takes the SVG-path route pdf-lib needs for rounding,
        // since drawRectangle has no radius parameter of its own.
        page.drawSvgPath(roundedRectSvgPath(w, h, radius), {
          x, y: yTopPdf,
          color: rgb(fill.r, fill.g, fill.b),
          borderColor: rgb(stroke.r, stroke.g, stroke.b),
          borderWidth: strokeWidth,
        });
      } else {
        page.drawRectangle({ x, y, width: w, height: h, color: rgb(fill.r, fill.g, fill.b), borderColor: rgb(stroke.r, stroke.g, stroke.b), borderWidth: strokeWidth });
      }
    } else if (obj.type === 'ellipse') {
      const fill = hexToRgb01(d.fill);
      page.drawEllipse({ x: x + w / 2, y: y + h / 2, xScale: w / 2, yScale: h / 2, color: rgb(fill.r, fill.g, fill.b), borderColor: rgb(stroke.r, stroke.g, stroke.b), borderWidth: strokeWidth });
    } else if (obj.type === 'line') {
      page.drawLine({ start: { x, y: y + h }, end: { x: x + w, y }, thickness: strokeWidth, color: rgb(stroke.r, stroke.g, stroke.b) });
    }
  }

  /** Freehand strokes have no native pdf-lib primitive — drawn as a chain
   *  of straight segments between consecutive recorded points, same
   *  approach the on-screen SVG polyline preview uses. Points are stored
   *  (editor-objects.js) as 0-100 percentages of the object's own box, not
   *  the page, so each point is converted through that box first. */
  function drawDrawObject(page, obj, rgb) {
    const d = obj.data || {};
    const pts = d.points || [];
    if (pts.length < 2) return;
    const stroke = hexToRgb01(d.stroke);
    const strokeWidth = d.strokeWidth != null ? d.strokeWidth : 2;
    function toAbs(p) {
      const point=toPdfBox({xPct:obj.xPct+(p.x/100)*obj.wPct,yPct:obj.yPct+(p.y/100)*obj.hPct,wPct:0,hPct:0},page);
      return {x:point.x,y:point.y};
    }
    for (let i = 1; i < pts.length; i++) {
      const a = toAbs(pts[i - 1]), b = toAbs(pts[i]);
      page.drawLine({ start: a, end: b, thickness: strokeWidth, color: rgb(stroke.r, stroke.g, stroke.b) });
    }
  }

  function drawHighlightObject(page, obj, rgb) {
    const d = obj.data || {};
    const { x, y, w, h } = toPdfBox(obj, page);
    const fill = hexToRgb01(d.fill || '#ffeb3b');
    page.drawRectangle({ x, y, width: w, height: h, color: rgb(fill.r, fill.g, fill.b), opacity: d.opacity != null ? d.opacity : 0.4 });
  }

  function drawWhiteoutObject(page, obj, rgb) {
    const d = obj.data || {};
    const { x, y, w, h } = toPdfBox(obj, page);
    const fill = hexToRgb01(d.color || '#ffffff');
    page.drawRectangle({ x, y, width: w, height: h, color: rgb(fill.r, fill.g, fill.b) });
  }

  function addMarkupAnnotation(page,obj,pdfDoc){
    const d=obj.data||{}, {x,y,w,h}=toPdfBox(obj,page);
    const color=hexToRgb01(d.fill||d.color||(obj.type==='highlight'?'#ffeb3b':'#dc2626'));
    const {PDFName}=window.PDFLib;
    const annotation=pdfDoc.context.obj({
      Type:PDFName.of('Annot'),Subtype:PDFName.of(obj.type==='highlight'?'Highlight':'StrikeOut'),
      Rect:[x,y,x+w,y+h],QuadPoints:[x,y+h,x+w,y+h,x,y,x+w,y],C:[color.r,color.g,color.b],CA:d.opacity!=null?d.opacity:0.4,F:4
    });
    page.node.addAnnot(pdfDoc.context.register(annotation));
  }

  function addLinkAnnotation(page,obj,pdfDoc){
    const {x,y,w,h}=toPdfBox(obj,page);
    const {PDFName,PDFString}=window.PDFLib;
    const url=String(obj.data?.url||'').trim();
    if(!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) throw new Error(`Invalid link URL: ${url||'(empty)'}`);
    const action=pdfDoc.context.obj({S:PDFName.of('URI'),URI:PDFString.of(url)});
    const annotation=pdfDoc.context.obj({Type:PDFName.of('Annot'),Subtype:PDFName.of('Link'),Rect:[x,y,x+w,y+h],Border:[0,0,0],A:action,F:4});
    page.node.addAnnot(pdfDoc.context.register(annotation));
  }

  function addFormField(page,obj,pdfDoc){
    const d=obj.data||{}, {x,y,w,h}=toPdfBox(obj,page);
    const form=pdfDoc.getForm(), name=String(d.name||obj.id).replace(/[^\w.-]/g,'_');
    const options={x,y,width:w,height:h,borderWidth:1};
    if(obj.type==='form-text'||obj.type==='form-multiline'){
      const field=form.createTextField(name);
      if(obj.type==='form-multiline') field.enableMultiline();
      if(d.defaultValue) field.setText(String(d.defaultValue));
      field.addToPage(page,options);
    }else if(obj.type==='form-dropdown'){
      const field=form.createDropdown(name), values=(d.options||[]).map(String).filter(Boolean);
      if(values.length){ field.addOptions(values); field.select(values.includes(d.defaultValue)?d.defaultValue:values[0]); }
      field.addToPage(page,options);
    }else if(obj.type==='form-checkbox'){
      const field=form.createCheckBox(name); field.addToPage(page,options); if(d.checked) field.check();
    }else if(obj.type==='form-radio'){
      const field=form.createRadioGroup(d.groupName||name); field.addOptionToPage(d.exportValue||'Yes',page,options); if(d.checked) field.select(d.exportValue||'Yes');
    }
  }

  function pageSize(page) {
    const { width, height } = page.getSize();
    return [width, height];
  }

  function exportStatus(text) {
    window.dispatchEvent(new CustomEvent('editor:progressText', { detail: { text } }));
  }

  function triggerDownload(url, fileName) {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function buildEditedPdf(operation, statusText) {
    if (!window.RenderEngine) throw new Error(t('editor.errNotReady'));
    const original = window.RenderEngine.getOriginalBytes();
    if (!original) throw new Error(t('editor.errOpenBeforeExport'));
    const PDFLibNS = window.PDFLib;
    if (!PDFLibNS) throw new Error(t('editor.errExportLibUnavailable'));
    const { rgb } = PDFLibNS;
    const exportGeneration = documentGeneration;
    exportStatus(statusText || t('editor.statusSaving'));

    const pdfDoc = typeof window.loadPdfSafe === 'function'
      ? await window.loadPdfSafe(original)
      : await PDFLibNS.PDFDocument.load(original);
    const objectList = window.EditorObjects ? window.EditorObjects.getState() : [];
    const pages = pdfDoc.getPages();
    const fontCache = {};

    for (const obj of objectList) {
      operation.throwIfStale();
      const page = pages[obj.page - 1];
      if (!page) throw new Error(t('editor.errObjectPageGone', { id: obj.id }));

      if (obj.type === 'text') await drawTextObject(page, obj, pdfDoc, fontCache, rgb);
      else if (obj.type === 'image') await drawImageObject(page, obj, pdfDoc);
      else if (obj.type === 'rectangle' || obj.type === 'ellipse' || obj.type === 'line') drawShapeObject(page, obj, rgb);
      else if (obj.type === 'draw') drawDrawObject(page, obj, rgb);
      else if (obj.type === 'highlight' || obj.type === 'strikethrough') addMarkupAnnotation(page,obj,pdfDoc);
      else if (obj.type === 'whiteout') drawWhiteoutObject(page, obj, rgb);
      else if (obj.type === 'link') addLinkAnnotation(page,obj,pdfDoc);
      else if (obj.type && obj.type.indexOf('form-')===0) addFormField(page,obj,pdfDoc);
      else throw new Error(t('editor.errObjectUnsupportedType', { id: obj.id, type: obj.type }));
    }

    operation.throwIfStale();
    if(exportGeneration !== documentGeneration) {
      const error = new Error(t('editor.errDocChangedDuringExport'));
      error.name = 'AbortError';
      throw error;
    }
    const outBytes = await pdfDoc.save();
    operation.throwIfStale();
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    const fileName = outputFileName();

    return { blob, fileName, byteLength:outBytes.length };
  }

  async function performExport(operation) {
    const result = await buildEditedPdf(operation, t('editor.statusSaving'));
    const {blob,fileName}=result;

    if (typeof window.downloadBlob === 'function') {
      const { url } = window.downloadBlob(blob, fileName);
      triggerDownload(url, fileName);
    } else {
      if (__fallbackExportUrl) URL.revokeObjectURL(__fallbackExportUrl);
      __fallbackExportUrl = URL.createObjectURL(blob);
      triggerDownload(__fallbackExportUrl, fileName);
    }
    exportStatus(t('editor.statusSaved', { name: fileName }));
    window.dispatchEvent(new CustomEvent('editor:documentSaved', {detail:{fileName}}));
    return result;
  }

  /* Root cause of the intermittent "Failed to read a named property
     'print' from 'Window': Blocked a frame with origin ... from
     accessing a cross-origin frame" error this replaces: the previous
     implementation called `frame.contentWindow.focus()` /
     `frame.contentWindow.print()` directly on the print iframe. Even
     though `frame.src` is a same-origin `blob:` URL created by this exact
     document, Chromium's built-in PDF viewer can render that blob's
     `application/pdf` content in its own internal security context - at
     that point `contentWindow` is no longer a Window this document is
     allowed to read named properties from, and the browser throws exactly
     the reported SecurityError. This is intermittent because it depends
     on Chromium's own internal handling of that PDF-viewer frame for a
     given navigation, not on anything this code controls - so no amount
     of try/catch around the same unsafe call fixes it.
     The fix removes cross-frame Window access entirely: this document's
     OWN `window.print()` (always same-origin, since it is this document)
     is called instead, and a print-only stylesheet - injected only for
     the duration of the print, removed in cleanup - hides the rest of the
     editor shell so only the iframe (showing the edited PDF, still
     rendered by the browser's own PDF viewer) actually prints. This is
     the standard, cross-browser-safe pattern for printing embedded PDF
     content without ever reading a property off another frame's Window. */
  function cleanupPrintSurface() {
    if (__printCleanupTimer) clearTimeout(__printCleanupTimer);
    __printCleanupTimer = null;
    if (__printListenerActive) window.removeEventListener('afterprint', cleanupPrintSurface);
    __printListenerActive = false;
    __printFrame?.remove();
    __printFrame = null;
    __printStyleEl?.remove();
    __printStyleEl = null;
    if (__printUrl) URL.revokeObjectURL(__printUrl);
    __printUrl = null;
  }

  async function performPrint(operation) {
    const result = await buildEditedPdf(operation, t('editor.statusPreparingPrint'));
    operation.throwIfStale();
    cleanupPrintSurface();
    __printUrl = URL.createObjectURL(result.blob);
    const frame = document.createElement('iframe');
    frame.className = 'editor-print-frame';
    frame.setAttribute('aria-hidden','true');
    frame.style.cssText='position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    frame.src = __printUrl;
    __printFrame = frame;
    document.body.appendChild(frame);

    // Scoped to `@media print` only - has zero effect on the normal
    // editor UI, and only exists in the DOM for the duration of this one
    // print (removed by cleanupPrintSurface()). Hiding every OTHER direct
    // child of <body> (nav/toolbar/panels/dock/etc. all already live
    // there) and expanding the iframe to fill the printed page is what
    // keeps the printed output to just the PDF, per the brief's "do not
    // print the editor shell" requirement - without needing to touch any
    // cross-origin frame to achieve it.
    const style = document.createElement('style');
    style.textContent = '@media print { body > *:not(.editor-print-frame){display:none !important;} .editor-print-frame{position:static !important; left:auto !important; top:auto !important; width:100% !important; height:100vh !important; opacity:1 !important;} }';
    document.head.appendChild(style);
    __printStyleEl = style;

    await new Promise((resolve,reject)=>{
      const timer=setTimeout(resolve,1800);
      frame.onload=()=>{clearTimeout(timer);setTimeout(resolve,250);};
      frame.onerror=()=>{clearTimeout(timer);reject(new Error(t('editor.errPrintSurfaceFailed')));};
    });
    operation.throwIfStale();

    // afterprint fires once the browser's print dialog closes, whether
    // the user actually printed or cancelled it (Chrome/Edge/Firefox) -
    // the primary cleanup trigger. The timeout below is only the
    // fallback safety net for a browser/scenario where that event
    // somehow never fires, same role the old fixed 60s timer already had.
    window.addEventListener('afterprint', cleanupPrintSurface, { once:true });
    __printListenerActive = true;
    __printCleanupTimer=setTimeout(cleanupPrintSurface,60000);
    window.print();
    exportStatus(t('editor.statusPrintReady'));
    return result;
  }

  function reportExportFailure(error) {
    const message = error?.message || t('editor.errExportFailed');
    console.error('EditorExport:', error);
    exportStatus(t('editor.statusExportFailed', { message }));
    if(typeof window.toast === 'function') window.toast(message);
  }

  /* Deliberately separate from reportExportFailure(): a failure while
     printing must never be shown as "Export failed" (Save uses that
     wording; Print did not fail to export anything if buildEditedPdf()
     itself succeeded - the failure, if any, is in preparing/opening the
     print surface). Keeping two reporters is what makes that distinction
     possible without the two flows' status text getting tangled. */
  function reportPrintFailure(error) {
    const message = error?.message || t('editor.errPrintFailed');
    console.error('EditorExport (print):', error);
    exportStatus(t('editor.statusPrintFailed', { message }));
    if(typeof window.toast === 'function') window.toast(message);
  }

  function exportCurrentDocument() {
    if(exportController){
      return exportController.run(performExport, {busyLabel:t('editor.busySaving'), timeoutMs:120000})
        .catch(reportExportFailure);
    }
    if(fallbackExportPromise) return fallbackExportPromise;
    const context = {
      isCurrent: () => true,
      throwIfStale: () => {},
    };
    fallbackExportPromise = performExport(context)
      .catch(reportExportFailure)
      .finally(() => { fallbackExportPromise = null; });
    return fallbackExportPromise;
  }

  function printCurrentDocument() {
    // printController.run() already returns `undefined` without starting
    // a new operation while a previous one is still `busy` (see
    // createOperationController in pdf-processing-utils.js) - rapid
    // repeated Print clicks are covered by that existing guard, not a new
    // debounce mechanism here.
    if(printController){
      return printController.run(performPrint, {timeoutMs:120000}).catch(reportPrintFailure);
    }
    if(fallbackPrintPromise) return fallbackPrintPromise;
    const context={isCurrent:()=>true,throwIfStale:()=>{}};
    fallbackPrintPromise=performPrint(context)
      .catch(reportPrintFailure)
      .finally(()=>{fallbackPrintPromise=null;});
    return fallbackPrintPromise;
  }

  window.EditorExport = { init, exportCurrentDocument, printCurrentDocument };
})();
