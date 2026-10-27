/* ---- PDF to Word (geometry/style-aware: headings, tables, images, headers/footers; scanned pages fall back to a full-page image) ---- */
TOOLS.pdf2word = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.pdf2word")}</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2wordBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.pdf2word")}</h2>
        <p class="tool-hero-desc">${t("toolPdf2word.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, t("workspace.selectPdfFiles"))}
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-toolbar" id="pdf2wordToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("toolPdf2word.convertToWord")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("pdf2wordToolbar").style.display="none"; document.getElementById("pdf2wordBody").classList.remove("is-loaded"); });
    document.getElementById("pdf2wordToolbar").style.display="flex";
    document.getElementById("pdf2wordBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out=document.getElementById("out"); out.innerHTML=statusEl(T("workspace.statusReadingPdf"));
    // Guards against the same race every Go-button handler in this app
    // needs (see pdf-page-tools-1.js's Compress PDF for the established
    // pattern): without this, clicking Go again - or dropping a
    // replacement file and clicking Go while this run is still in
    // flight - starts a second concurrent conversion writing to the same
    // #out/#statusLine, and whichever finishes last wins regardless of
    // which file it was actually converting.
    goBtn.disabled = true;
    try {
    await ensureJSZip();
    const bytes=await file.arrayBuffer();
    const pdoc = operation.track(await loadPdfJsSafe({data:bytes}));
    const pageBlocksList = [];
    const pageSizesArr = [];
    for(let i=1;i<=pdoc.numPages;i++){
      setStatus(t("toolPdf2word.statusExtracting"), false, Math.round((i/pdoc.numPages)*100));
      const page_i = await pdoc.getPage(i);
      pageSizesArr.push({widthPt: page_i.view[2]-page_i.view[0], heightPt: page_i.view[3]-page_i.view[1]});
      let visuals = {images:[], shapes:[], colorSpans:[]};
      try{ visuals = await extractPageVisuals(pdoc, i); }catch(e){ /* no vector/image/color data - text still extracts fine */ }
      let pageBlocks = [];
      try{ pageBlocks = await extractPageBlocks(pdoc, i, visuals); }catch(e){ /* fall through to page-image fallback below */ }
      // A page whose entire content is a table (no separate title/body
      // paragraph anywhere on it) has real, extractable text too - only
      // checking "paragraph"-type blocks here was a real bug: a
      // table-only page would incorrectly read as textless and get
      // replaced with a flat page screenshot, discarding the actual
      // editable table structure entirely. Found via a dedicated
      // "image inside table, no surrounding heading" test case that
      // exposed it - every real-bill page happens to have a title
      // paragraph alongside its tables, so this never surfaced before.
      let pageHasText = pageBlocks.some(blockHasRealText);
      // If the richer geometry/style pass fails, preserve any text that pdf.js can still
      // extract instead of replacing an otherwise-editable page with a screenshot.
      if(!pageHasText){
        try{
          const editableFallback = await extractPlainPageParagraphs(pdoc, i);
          if(editableFallback.some(blockHasRealText)){
            pageBlocks = editableFallback;
            pageHasText = true;
          }
        }catch(e){ /* a genuinely textless/scanned page still uses the image fallback below */ }
      }
      let thisPageBlocks = [];
      if(!pageHasText){
        try{
          const canvas = await renderPdfPageCanvas(pdoc, i, 1.6);
          const sourceSize=pageSizesArr[pageSizesArr.length-1];
          thisPageBlocks = [{type:"image", pngBase64:canvasToPngBase64(canvas), width:canvas.width, height:canvas.height,
            widthPt:sourceSize.widthPt, heightPt:sourceSize.heightPt, placement:"anchored", xPt:0, yFromTopPt:0, _y:sourceSize.heightPt}];
        }catch(e){ /* nothing extractable and nothing renderable - leave this page out */ }
      } else {
        // Merge real embedded images (logo, QR) into the text flow by
        // approximate vertical position instead of only ever falling back
        // to a whole-page screenshot. Wide images (banners/logos spanning
        // most of the page width) render centered inline with the text
        // flow, matching how they actually behave visually. Narrow images
        // (QR codes, stamps, small logos) are independently positioned in
        // the source - not part of any text line - so they're anchored at
        // their real page-relative x/y instead of just being dropped into
        // the flow whenever their Y-sort position happens to fall, which
        // is the only way to keep e.g. a QR code sitting next to its
        // "Scan & Pay" label rather than drifting to wherever text
        // ordering puts it.
        const pageWidthPt = pageSizesArr[pageSizesArr.length-1].widthPt;
        const pageHeightPt = pageSizesArr[pageSizesArr.length-1].heightPt;
        const pageImages = visuals.images.map(im=>{
          return {
            type:"image", pngBase64: pdfImageToPngBase64(im.raw),
            width: im.width, height: im.height,
            widthPt: im.width, heightPt: im.height, _y: im.y,
            placement: "anchored",
            xPt: im.x, yFromTopPt: pageHeightPt - (im.y + im.height),
            pageWidthPt, pageHeightPt
          };
        });
        // Geometrically test every image against gridtable cell bounds
        // first - an image genuinely inside a table cell (e.g. a product
        // photo in an "Image" column) should render as part of that
        // cell, not float as a separately-anchored page block. Only
        // images that don't land inside any cell fall through to the
        // existing centered/anchored placement below.
        const unmatchedImages = embedImagesIntoTableCells(pageBlocks, pageImages);
        thisPageBlocks = pageBlocks.concat(unmatchedImages).sort((a,b)=> (b._y||0) - (a._y||0));
      }
      const currentPageSize = inferPdfPageLayoutSize(pageSizesArr[pageSizesArr.length-1], thisPageBlocks);
      pageSizesArr[pageSizesArr.length-1] = currentPageSize;
      thisPageBlocks.forEach(block=>{ block._pageSize = currentPageSize; });
      pageBlocksList.push(thisPageBlocks);
      // Release page-local operator/font/image caches once the compact document model is built.
      // This keeps long conversions bounded without reparsing or rasterizing completed pages.
      if(typeof page_i.cleanup === "function") page_i.cleanup();
    }

    // Word applies margins per section, not per ordinary page break. Pages with the same paper
    // geometry therefore share the least restrictive source-derived margins, keeping every
    // page's coordinate model consistent without creating unnecessary section breaks.
    const geometryMargins = new Map();
    pageSizesArr.forEach(size=>{
      const key=`${Math.round(size.widthPt)}x${Math.round(size.heightPt)}`;
      const current=geometryMargins.get(key);
      const values=[size.marginTopPt,size.marginRightPt,size.marginBottomPt,size.marginLeftPt];
      geometryMargins.set(key,current ? current.map((value,index)=>Math.min(value,values[index])) : values);
    });
    pageSizesArr.forEach((size,index)=>{
      const margins=geometryMargins.get(`${Math.round(size.widthPt)}x${Math.round(size.heightPt)}`);
      [size.marginTopPt,size.marginRightPt,size.marginBottomPt,size.marginLeftPt]=margins;
      pageBlocksList[index].forEach(block=>{ block._pageSize=size; });
    });

    // Detect real repeating headers/footers (e.g. a company name at the
    // top of every page, a legal footer at the bottom) - only promoted
    // to actual DOCX header/footer parts when the SAME normalized text
    // (digits masked, so "Page 1 of 4" / "Page 2 of 4" still match)
    // appears at the top/bottom of a strong majority of pages. Ordinary
    // one-off content near a page edge never matches this bar, since it
    // requires repetition, not just position.
    const {headerRuns, footerRuns} = detectHeaderFooter(pageBlocksList);

    setStatus(t("toolPdf2word.statusBuilding"));
    let prevPageSize = pageSizesArr[0];
    const blocks = [];
    pageBlocksList.forEach((pb, idx)=>{
      blocks.push({type:"pagelayout", blocks:pb, pageSize:pageSizesArr[idx]});
      if(idx < pageBlocksList.length-1){
        const nextSize = pageSizesArr[idx+1];
        // A plain page break can't change paper size/orientation mid
        // document - only a real DOCX section break can. Only pay that
        // cost when the next page's size actually differs (rounded to
        // avoid a section break firing on sub-point PDF measurement
        // noise between otherwise-identical pages).
        const changed = Math.round(nextSize.widthPt) !== Math.round(prevPageSize.widthPt) || Math.round(nextSize.heightPt) !== Math.round(prevPageSize.heightPt);
        blocks.push(changed ? {type:"pagebreak", sectionSize: prevPageSize} : {type:"pagebreak"});
        prevPageSize = nextSize;
      }
    });
    const finalPageSize = pageSizesArr[pageSizesArr.length-1];
    const blob = await buildMixedDocx(blocks, finalPageSize, {headerRuns, footerRuns});
    const outName = suffixedName(file, "converted", "docx");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* Word to PDF's Devanagari-safe Unicode font. pdf-lib's StandardFonts
   (Helvetica etc) only support WinAnsi encoding - no Devanagari, no complex-
   script shaping - which is why Hindi text in a DOCX previously came out
   as garbled Latin-1 mojibake (or "?" marks, depending on the sanitizer):
   the actual Unicode text mammoth extracts from the DOCX XML was always
   correct, the corruption was entirely in how it got drawn onto the page.
   Fixed by embedding a real OpenType Devanagari font (Noto Sans Devanagari,
   OFL-licensed, Google Fonts) via pdf-lib's fontkit integration, which does
   its own complex-script shaping (conjunct formation, matra reordering) -
   not by pattern-matching/replacing specific characters, which would only
   work for the exact sample text seen once and break on any other document.
   One font is used for BOTH scripts (not switched per character run):
   Noto Sans Devanagari covers Basic Latin as well as Devanagari, so mixed
   Hindi+English text renders from a single embedded font, and its Latin
   glyphs read as an ordinary sans-serif - plain-English documents still
   look effectively the same as the previous Helvetica output.
   A STATIC instance (Regular weight), not the variable NotoSansDevanagari
   [wdth,wght].ttf Google Fonts ships today: embedding the variable font
   through pdf-lib/fontkit produced a PDF whose text extracted correctly
   but which pdf.js's own page.render() hung on indefinitely (confirmed the
   hang wasn't Devanagari-specific - even plain Latin text through that
   same embedded variable font hung the same way) - a real, if narrow,
   rendering-compatibility risk not worth taking. Sourced from the Noto
   Fonts project's own static-instance mirror, pinned to a specific upstream
   commit, and vendored as a same-origin production asset. The SHA-256 check
   only warns on a mismatch rather than blocking the conversion, since a
   swapped font file is a rendering-quality risk, not a code-execution one
   (unlike the @pdf-lib/fontkit script pdf-lib actually executes, which uses
   a real SRI `integrity` attribute in ensureFontkit() above). */
const DEVANAGARI_FONTS = {
  regular: {
    url: "assets/vendor/noto-sans-devanagari/3a06b1c521155492df224d33464b3c7b2852d861/NotoSansDevanagari-Regular.ttf",
    sha256: "c82fb837eed9988ee6a240ce0635fe18f9c5859389206a24dfc348c926f42500",
    bytesPromise: null,
  },
  bold: {
    url: "assets/vendor/noto-sans-devanagari/3a06b1c521155492df224d33464b3c7b2852d861/NotoSansDevanagari-Bold.ttf",
    sha256: "1ebda0d88076fef54dd70b4dc48deb4dadf634cc9c7c325b812facb802ae3c51",
    bytesPromise: null,
  },
};
function loadDevanagariFontBytes(weight){
  const entry = DEVANAGARI_FONTS[weight];
  if(entry.bytesPromise) return entry.bytesPromise;
  entry.bytesPromise = (async () => {
    const resp = await fetch(entry.url);
    if(!resp.ok) throw new Error("Devanagari font fetch failed: " + resp.status);
    const bytes = await resp.arrayBuffer();
    try {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hex = [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
      if(hex !== entry.sha256) console.warn("Devanagari font hash mismatch - the CDN file may have changed since this was pinned.");
    } catch(e) { /* crypto.subtle needs a secure context - skip the check rather than fail the conversion over it */ }
    return bytes;
  })().catch(e => { entry.bytesPromise = null; throw e; }); // don't cache a rejected fetch - a transient network failure shouldn't permanently break every future conversion this page session
  return entry.bytesPromise;
}
async function embedUnicodeFont(pdfDoc, weight){
  await ensureFontkit();
  pdfDoc.registerFontkit(fontkit);
  const fontBytes = await loadDevanagariFontBytes(weight === "bold" ? "bold" : "regular");
  return pdfDoc.embedFont(fontBytes, {subset:true});
}

/* ==================================================================
   Word to PDF's layout engine. Converts a run's text (Kruti Dev-aware, see below) into styled
   "atoms" (words/spaces/tabs/breaks/images), word-wraps those atoms per paragraph using each atom's
   OWN font/size (not one font per paragraph), and draws the result with real per-run bold/italic/
   underline/strikethrough/color/superscript/subscript, real page geometry (size/orientation/margins
   from the DOCX's own sectPr), real table column widths and colspan, inline images, headers/footers,
   and page breaks (explicit and natural). This is what makes the converter actually preserve the
   source document's layout instead of just its text - see docx-reader.js's own file header for
   exactly which OOXML structures are read, and its "deliberately NOT attempted" list for the
   disclosed gaps (floating shapes/text boxes, multi-column text flow, row-spanning cells, per-
   section odd/even/first-page header or footer variants). */

/* Same per-run Kruti Dev handling as before, adapted to the richer {text, style} atom shape:
   Kruti Dev-fonted text goes through krutidevToUnicode(), everything else (already-Unicode Hindi,
   English, any other font) passes through completely unchanged - see krutidev-to-unicode.js for why
   this can never be "just swap the font": Kruti Dev's bytes are not Devanagari to begin with. */
function wordTokenEffectiveText(token){
  const raw = token.text;
  const font = token.style && token.style.rFonts;
  if(font && typeof isKrutiDevFontName === "function" && isKrutiDevFontName(font) && !/[ऀ-ॿ]/.test(raw)){
    // Convert only the non-whitespace core and reattach the run's own original edge whitespace -
    // krutidevToUnicode() ends with a .trim() (ported as-is from the library it's based on), and
    // calling it on a token that starts/ends with meaningful whitespace would otherwise silently
    // eat the space between this run and its neighbor (e.g. a Kruti Dev run ending in "...esa "
    // right before a plain-font "Executive Engineer " run).
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.slice(lead.length).match(/\s*$/)[0];
    const core = raw.slice(lead.length, raw.length - trail.length);
    return lead + krutidevToUnicode(core) + trail;
  }
  return raw;
}

function wordLegacyStyleKey(style){
  if(!style || typeof isKrutiDevFontName !== "function" || !isKrutiDevFontName(style.rFonts)) return null;
  const color = style.color ? [style.color.r,style.color.g,style.color.b].join(",") : "";
  return [String(style.rFonts).toLowerCase().replace(/\s+/g,""),style.sizePt||"",!!style.bold,!!style.italic,!!style.underline,!!style.strike,style.vertAlign||"",color].join("|");
}

/* Word frequently splits one visually-uniform legacy word into several w:r elements (spellcheck,
   editing history and proofing can all do this). Kruti Dev is a contextual byte encoding: converting
   each XML run independently corrupts sequences such as `vf` + `/` + `k’kklh`. Join only adjacent
   text runs that are explicitly Kruti Dev and have the same effective visual style, then convert the
   complete sequence. Style boundaries, tabs, breaks, images, Unicode Hindi and English remain hard
   boundaries, so this is general font-aware decoding rather than document-specific replacement. */
function wordCoalesceLegacyTokens(tokens){
  const out = [];
  for(const token of tokens){
    const key = token.kind === "text" ? wordLegacyStyleKey(token.style) : null;
    const previous = out[out.length-1];
    if(key && previous && previous.kind === "text" && previous._legacyKey === key){
      previous.text += token.text;
      continue;
    }
    const copy = Object.assign({},token);
    if(key) copy._legacyKey = key;
    out.push(copy);
  }
  return out;
}

// Noto Sans Devanagari has no italic style (Devanagari has no established italic convention, and
// Noto doesn't ship one) - Devanagari runs render upright regardless of the source's italic flag.
// Latin/other-script italic text uses pdf-lib's built-in Helvetica Oblique instead (no extra fetch/
// embed cost - it's one of the 14 always-available StandardFonts), so real italic is still preserved
// wherever the document can actually have it.
function wordPickFont(text, bold, italic, fonts, style){
  // Keep dates, numbers and punctuation that originated in a legacy Hindi run
  // in the same embedded family as its converted Devanagari neighbours.
  const hasDevanagari = /[ऀ-ॿ]/.test(text || "") || !!wordLegacyStyleKey(style);
  if(hasDevanagari) return bold ? fonts.bold : fonts.regular;
  if(bold && italic) return fonts.boldItalic;
  if(italic) return fonts.italic;
  if(bold) return fonts.bold;
  return fonts.regular;
}

function wordStyleFontSize(style){ return (style && style.sizePt) || 11; }

// A paragraph's tokens (readDocxStructured()'s per-run text/tabs/breaks/images) become a flat list
// of layout atoms: words and inter-word whitespace are split out separately (each still carrying
// its own run's style) so word-wrap can measure and place them individually, rather than measuring
// one paragraph-wide string in one font like the previous version of this function did.
function wordBuildAtoms(paragraph){
  const atoms = [];
  for(const token of wordCoalesceLegacyTokens(paragraph.tokens)){
    if(token.kind === "text"){
      const text = wordTokenEffectiveText(token);
      if(!text) continue;
      for(const part of text.split(/(\s+)/)){
        if(part === "") continue;
        atoms.push({ kind: /^\s+$/.test(part) ? "space" : "word", text: part, style: token.style });
      }
    } else if(token.kind === "tab") atoms.push({ kind: "tab" });
    else if(token.kind === "lineBreak") atoms.push({ kind: "break" });
    else if(token.kind === "pageBreak") atoms.push({ kind: "pageBreak" });
    else if(token.kind === "image") atoms.push({ kind: "image", relId: token.relId, widthPt: token.widthPt, heightPt: token.heightPt });
  }
  return atoms;
}

// Word-wraps one paragraph's atoms into lines, each line an array of placed pieces ({x, width,
// text/font/size/style, or a tab/image}). Purely a measuring/placement pass - nothing is drawn here,
// so the exact same lines can be used to both measure a block's total height (for footer placement
// and page-break look-ahead) and to actually draw it.
function wordWrapParagraph(paragraph, maxWidth, fonts){
  const atoms = wordBuildAtoms(paragraph);
  const firstLineIndent = paragraph.indentFirstLinePt || 0;
  const tabStops = paragraph.tabStopsPt;
  const lines = [];
  let line = [], x = 0, isFirstLine = true;
  const lineMax = () => Math.max(20, maxWidth);
  function trimTrailingSpaces(){
    while(line.length && line[line.length-1].kind === "text" && /^\s+$/.test(line[line.length-1].text || "")){
      const removed = line.pop();
      x -= removed.width || 0;
    }
  }
  function pushLine(forcedBreak){
    trimTrailingSpaces();
    const sizes = line.map(p => p.kind === "image" ? (p.heightPt||11) : (p.size||0)).filter(Boolean);
    lines.push({ pieces: line, maxSize: sizes.length ? Math.max(...sizes) : 11, forcedBreak:!!forcedBreak });
    line = []; isFirstLine = false; x = 0;
  }
  x = isFirstLine ? Math.max(0, firstLineIndent) : 0;
  for(const atom of atoms){
    if(atom.kind === "break"){ pushLine(true); x = isFirstLine ? Math.max(0, firstLineIndent) : 0; continue; }
    if(atom.kind === "pageBreak"){ if(line.length) pushLine(); lines.push({ pageBreak: true }); x = 0; continue; }
    if(atom.kind === "tab"){
      let next;
      if(tabStops && tabStops.length){ next = tabStops.find(s => s > x); if(next == null) next = x + 36; }
      else next = (Math.floor(x / 36) + 1) * 36;
      line.push({ kind: "tab", x, width: Math.max(0, next - x) });
      x = next;
      continue;
    }
    if(atom.kind === "image"){
      const width = atom.widthPt || 0;
      if(x + width > lineMax() && line.length){
        // Font substitution can make the text before a manually tabbed signature a little wider
        // than Word's source font, advancing the final tab one stop too far. Keep an image after
        // tabs on that same line by clamping it to the last fitting tab stop, provided it cannot
        // overlap the actual preceding text; otherwise use an ordinary wrap.
        const hasTab = line.some(p=>p.kind === "tab");
        const textEnd = line.filter(p=>p.kind !== "tab").reduce((m,p)=>Math.max(m,(p.x||0)+(p.width||0)),0);
        let fittingStop = null;
        if(hasTab){
          if(tabStops && tabStops.length) fittingStop = tabStops.filter(s=>s+width<=lineMax()).pop();
          else fittingStop = Math.floor((lineMax()-width)/36)*36;
        }
        if(fittingStop != null && fittingStop >= textEnd) x = fittingStop;
        else pushLine();
      }
      line.push({ kind:"image", relId:atom.relId, widthPt:atom.widthPt, heightPt:atom.heightPt, x, width });
      x += width;
      continue;
    }
    if(atom.kind === "space" && !line.length) continue;
    const bold = !!(atom.style && atom.style.bold), italic = !!(atom.style && atom.style.italic);
    const font = wordPickFont(atom.text, bold, italic, fonts, atom.style);
    const size = wordStyleFontSize(atom.style);
    const width = atom.text ? font.widthOfTextAtSize(atom.text, size) : 0;
    if(atom.kind === "word" && x + width > lineMax() && line.length) pushLine();
    line.push({ kind: "text", text: atom.text, style: atom.style, font, size, x, width });
    x += width;
  }
  if(line.length) pushLine();
  if(!lines.length) lines.push({ pieces: [], maxSize: 11 }); // an empty paragraph is still one blank line
  return lines;
}

// auto: `value` is in 240ths of a line (360 = 1.5x); exact: `value` is a hard height in twips,
// always used as-is; atLeast: same twips value, but only as a floor under the font's own natural
// height (a bigger font on that line still gets more room).
function wordLineHeightPt(paragraph, naturalPt){
  const ls = paragraph.lineSpacing;
  if(!ls) return naturalPt;
  if(ls.rule === "exact") return ls.value / 20;
  if(ls.rule === "atLeast") return Math.max(naturalPt, ls.value / 20);
  // naturalPt already includes the font renderer's normal leading. Word's auto value scales
  // the nominal font size, so multiplying the expanded height again overstates e.g. 1.15 lines.
  return Math.max(naturalPt, (naturalPt / 1.2) * (ls.value / 240));
}

function wordParagraphSpacingPt(paragraph, side){
  const automatic = side === "before" ? paragraph.spaceBeforeAuto : paragraph.spaceAfterAuto;
  if(!automatic) return side === "before" ? (paragraph.spaceBeforePt || 0) : (paragraph.spaceAfterPt || 0);
  // Word's HTML-style automatic paragraph spacing is approximately one em; its explicit
  // before/after value is ignored while the automatic flag is active.
  return Math.max(1, ...((paragraph.tokens || []).map(token => wordStyleFontSize(token.style))));
}

function wordMeasureLinesHeight(lines, paragraph){
  return lines.reduce((sum, line) => sum + (line.pageBreak ? 0 : wordLineHeightPt(paragraph, (line.maxSize || 11) * 1.2)), 0);
}

/* Builds the actual PDF from readDocxStructured()'s sections. Each section gets its own page
   geometry (page size/orientation/margins) and header/footer; body content flows down the page,
   drawing every line, table row, and inline image in place, and starting a fresh page (of the
   current section's geometry) whenever content would run past the bottom margin, an explicit Word
   page break is hit, or a new section begins. */
async function buildWordPdfBytes(sections, loadMediaBytes){
  const doc = await PDFDocument.create();
  const fonts = {
    regular: await embedUnicodeFont(doc, "regular"),
    bold: await embedUnicodeFont(doc, "bold"),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };

  // Every inline image is embedded up front, once, into a flat relId -> pdf-lib image cache. This
  // keeps the actual page-layout pass below fully synchronous (no async calls interleaved with the
  // page-break bookkeeping it already has to do), and naturally de-duplicates an image reused
  // multiple times (e.g. a letterhead logo repeated via the header on every page).
  const imageCache = {};
  async function collectImageRelIds(blocksOrRows, relIds){
    for(const block of blocksOrRows){
      if(!block) continue;
      if(block.type === "paragraph"){
        for(const token of block.tokens) if(token.kind === "image") relIds.add(token.relId);
      } else if(block.type === "table"){
        for(const row of block.rows) for(const cell of row) await collectImageRelIds(cell.paragraphs, relIds);
      }
    }
  }
  const allRelIds = new Set();
  for(const { section, blocks } of sections){
    await collectImageRelIds(blocks, allRelIds);
    if(section.header) await collectImageRelIds(section.header, allRelIds);
    if(section.footer) await collectImageRelIds(section.footer, allRelIds);
  }
  for(const relId of allRelIds){
    try {
      const media = await loadMediaBytes(relId);
      if(!media) continue;
      imageCache[relId] = media.format === "png" ? await doc.embedPng(media.bytes) : await doc.embedJpg(media.bytes);
    } catch(e) { /* an unreadable/corrupt embedded image shouldn't fail the whole conversion */ }
  }

  let page, geo, y;

  function drawPieceRun(pieces, startY, opts){
    // Draws one already-wrapped line's pieces at a given baseline y. `opts.dryRun` skips the actual
    // page.drawText/Image calls (used for measuring header/footer height before positioning them).
    const dryRun = opts && opts.dryRun;
    for(const piece of pieces){
      if(piece.kind === "tab") continue;
      if(piece.kind === "image"){
        const img = imageCache[piece.relId];
        if(img && !dryRun){
          const w = piece.widthPt || img.width, h = piece.heightPt || img.height;
          const ix = piece.lineX + (piece.x||0);
          // Inline DrawingML images sit on the current text baseline. Keeping
          // them in that line also preserves tabs used to position signatures.
          page.drawImage(img, { x: ix, y: startY - h*0.12, width: w, height: h });
        }
        continue;
      }
      if(!piece.text || dryRun) continue;
      const style = piece.style || {};
      const isSuper = style.vertAlign === "superscript", isSub = style.vertAlign === "subscript";
      const size = isSuper || isSub ? piece.size * 0.68 : piece.size;
      const yOff = isSuper ? piece.size * 0.32 : (isSub ? -piece.size * 0.14 : 0);
      const color = style.color ? rgb(style.color.r, style.color.g, style.color.b) : undefined;
      const drawX = piece.lineX + piece.x;
      page.drawText(piece.text, Object.assign({ x: drawX, y: startY + yOff, size, font: piece.font }, color ? { color } : {}));
      if(style.underline || style.strike){
        const lineY = startY + yOff + (style.strike ? size * 0.3 : -size * 0.08);
        page.drawLine({ start: { x: drawX, y: lineY }, end: { x: drawX + piece.width, y: lineY }, thickness: Math.max(0.5, size * 0.05), color: color || rgb(0,0,0) });
      }
    }
  }

  function lineStartX(line, paragraph){
    const contentWidth = line.pieces.reduce((m,p)=>Math.max(m,(p.x||0)+(p.width||0)),0);
    const avail = geo.maxWidth - (paragraph.indentLeftPt||0) - (paragraph.indentRightPt||0);
    let x = geo.marginLeft + (paragraph.indentLeftPt||0);
    if(paragraph.align === "center") x += Math.max(0, (avail - contentWidth) / 2);
    else if(paragraph.align === "right" || paragraph.align === "end") x += Math.max(0, avail - contentWidth);
    return x;
  }

  function positionedLinePieces(line, paragraph, lineX, justify){
    const pieces = line.pieces.map(p=>Object.assign({},p,{lineX}));
    if(!justify || !(paragraph.align === "both" || paragraph.align === "distribute")) return pieces;
    const stretchable = pieces.filter((p,i)=>p.kind === "text" && /^\s+$/.test(p.text||"") && pieces.slice(i+1).some(n=>n.kind === "text" && !/^\s+$/.test(n.text||"")));
    if(!stretchable.length) return pieces;
    const used = pieces.reduce((m,p)=>Math.max(m,(p.x||0)+(p.width||0)),0);
    const available = geo.maxWidth - (paragraph.indentLeftPt||0) - (paragraph.indentRightPt||0);
    const extra = available-used;
    if(extra <= 0.25) return pieces;
    const perSpace = extra/stretchable.length;
    let shift = 0;
    for(const piece of pieces){
      piece.x = (piece.x||0)+shift;
      if(stretchable.includes(piece)){ piece.width += perSpace; shift += perSpace; }
    }
    return pieces;
  }

  async function newPage(){
    page = doc.addPage([geo.widthPt, geo.heightPt]);
    y = geo.heightPt - geo.marginTop;
    if(geo.header && geo.header.length) drawFixedBlocks(geo.header, geo.heightPt - geo.headerPt);
    if(geo.footer && geo.footer.length){
      const h = measureBlocksHeight(geo.footer);
      drawFixedBlocks(geo.footer, geo.footerPt + h);
    }
  }

  function measureBlocksHeight(blocks){
    let h = 0;
    for(const block of blocks){
      if(block.type !== "paragraph") continue;
      const lines = wordWrapParagraph(block, geo.maxWidth - (block.indentLeftPt||0) - (block.indentRightPt||0), fonts);
      h += wordParagraphSpacingPt(block, "before") + wordMeasureLinesHeight(lines, block) + wordParagraphSpacingPt(block, "after");
    }
    return h;
  }

  // Draws a small self-contained block list (header/footer) top-down from a fixed y, with no page-
  // break handling of its own - headers/footers are expected to be a few short lines, not multi-page
  // content.
  function drawFixedBlocks(blocks, startY){
    let fy = startY;
    for(const block of blocks){
      if(block.type !== "paragraph") continue;
      const w = geo.maxWidth - (block.indentLeftPt||0) - (block.indentRightPt||0);
      const lines = wordWrapParagraph(block, w, fonts);
      fy -= wordParagraphSpacingPt(block, "before");
      lines.forEach(line => {
        if(line.pageBreak) return;
        const lh = wordLineHeightPt(block, (line.maxSize||11) * 1.2);
        const lineX = lineStartX(line, block);
        drawPieceRun(line.pieces.map(p => Object.assign({}, p, { lineX })), fy - lh*0.8);
        fy -= lh;
      });
      fy -= wordParagraphSpacingPt(block, "after");
    }
  }

  function newPageIfNeeded(need){ if(y - need < geo.marginBottom) return true; return false; }

  async function drawParagraph(paragraph){
    if(paragraph.pageBreakBefore){ await newPage(); }
    const w = geo.maxWidth - (paragraph.indentLeftPt||0) - (paragraph.indentRightPt||0);
    const lines = wordWrapParagraph(paragraph, w, fonts);
    y -= wordParagraphSpacingPt(paragraph, "before");
    let first = true;
    for(let lineIndex=0;lineIndex<lines.length;lineIndex++){
      const line = lines[lineIndex];
      if(line.pageBreak){ await newPage(); first = true; continue; }
      const lh = wordLineHeightPt(paragraph, (line.maxSize||11) * 1.2);
      if(newPageIfNeeded(lh)) await newPage();
      let lineX = lineStartX(line, paragraph);
      if(first && paragraph.listMarker){
        const markerFont = fonts.regular;
        const markerStr = paragraph.listMarker + " ";
        page.drawText(markerStr, { x: geo.marginLeft, y: y - lh*0.8, size: (line.maxSize||11), font: markerFont });
      }
      const nextIsPageBreak = lines[lineIndex+1] && lines[lineIndex+1].pageBreak;
      const justify = !line.forcedBreak && !nextIsPageBreak && lineIndex < lines.length-1;
      drawPieceRun(positionedLinePieces(line,paragraph,lineX,justify), y - lh*0.8);
      y -= lh;
      first = false;
    }
    y -= wordParagraphSpacingPt(paragraph, "after");
  }

  async function drawTable(table){
    const rows = table.rows;
    if(!rows.length) return;
    const colCount = Math.max(1, ...rows.map(r => r.reduce((s,c)=>s+(c.gridSpan||1),0)));
    const totalGridWidth = (table.gridColsPt||[]).reduce((s,w)=>s+(w||0),0);
    const colWidths = (table.gridColsPt && table.gridColsPt.length === colCount && totalGridWidth > 0)
      ? table.gridColsPt.map(w => w * (geo.maxWidth / totalGridWidth)) // scale to fit the page's real content width
      : new Array(colCount).fill(geo.maxWidth / colCount);
    y -= 4;
    for(const row of rows){
      const cellWidths = [];
      { let ci = 0; for(const cell of row){ const span=cell.gridSpan||1; cellWidths.push(colWidths.slice(ci,ci+span).reduce((s,w)=>s+w,0)); ci+=span; } }
      const cellLines = row.map((cell,i) => cell.paragraphs.map(p => wordWrapParagraph(p, Math.max(10, cellWidths[i]-10), fonts)));
      const rowHeight = Math.max(16, ...row.map((cell,i) =>
        cell.paragraphs.reduce((s,p,pi) => s + wordMeasureLinesHeight(cellLines[i][pi], p) + 4, 4)
      ));
      if(newPageIfNeeded(rowHeight)) await newPage();
      const rowTop = y;
      let cx = geo.marginLeft;
      row.forEach((cell, ci) => {
        const cw = cellWidths[ci];
        if(cell.shadeRgb) page.drawRectangle({ x: cx, y: rowTop - rowHeight, width: cw, height: rowHeight, color: rgb(cell.shadeRgb.r, cell.shadeRgb.g, cell.shadeRgb.b) });
        page.drawRectangle({ x: cx, y: rowTop - rowHeight, width: cw, height: rowHeight, borderColor: rgb(0.55,0.55,0.55), borderWidth: 0.6 });
        let cy = rowTop - 5;
        cell.paragraphs.forEach((p, pi) => {
          const lines = cellLines[ci][pi];
          lines.forEach(line => {
            if(line.pageBreak) return;
            const lh = wordLineHeightPt(p, (line.maxSize||9.5) * 1.2);
            const contentWidth = line.pieces.reduce((s,pc)=> s + (pc.width||0), 0);
            let lineX = cx + 5;
            if(p.align === "center") lineX += Math.max(0, (cw - 10 - contentWidth) / 2);
            else if(p.align === "right" || p.align === "end") lineX += Math.max(0, cw - 10 - contentWidth);
            drawPieceRun(line.pieces.map(pc => Object.assign({}, pc, { lineX })), cy - lh*0.8);
            cy -= lh;
          });
        });
        cx += cw;
      });
      y = rowTop - rowHeight;
    }
    y -= 8;
  }

  for(const { section, blocks } of sections){
    geo = {
      widthPt: section.landscape ? Math.max(section.widthPt, section.heightPt) : section.widthPt,
      heightPt: section.landscape ? Math.min(section.widthPt, section.heightPt) : section.heightPt,
      marginTop: section.marginTopPt, marginBottom: section.marginBottomPt,
      marginLeft: section.marginLeftPt, marginRight: section.marginRightPt,
      headerPt: section.headerPt, footerPt: section.footerPt,
      header: section.header, footer: section.footer,
    };
    geo.maxWidth = geo.widthPt - geo.marginLeft - geo.marginRight;
    await newPage();
    for(const block of blocks){
      if(block.type === "paragraph") await drawParagraph(block);
      else if(block.type === "table") await drawTable(block);
    }
  }

  return doc.save();
}

/* ---- Word to PDF (basic layout fidelity; Kruti Dev-aware) ----
   Reads word/document.xml directly (docx-reader.js) rather than going through mammoth, since Kruti
   Dev detection needs each run's actual font name, which mammoth's plain-text extraction discards.
   See krutidev-to-unicode.js / docx-reader.js for the two pieces this is built on:
     - a Unicode Hindi document (Mangal, Nirmala UI, ...) is drawn completely unchanged.
     - a Kruti Dev document (any "Kruti Dev NNN" font run) has ONLY those runs converted from the
       legacy Kruti Dev byte encoding to real Unicode Devanagari before drawing - never a font swap
       alone, since Kruti Dev's bytes are not Devanagari to begin with (see krutidev-to-unicode.js).
     - a mixed document (Hindi in Kruti Dev + English in a normal font, or Kruti Dev + Unicode Hindi
       in the same file) converts only the runs that are actually Kruti Dev-fonted, per run. */
TOOLS.word2pdf = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.word2pdf")}</h3></div>
    <div class="panel-body compact tool-workspace" id="word2pdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.word2pdf")}</h2>
        <p class="tool-hero-desc">${t("toolWord2pdf.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML(".docx", false, t("toolWord2pdf.selectDocx"))}
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-toolbar" id="word2pdfToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("toolWord2pdf.convertToPdf")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("word2pdfToolbar").style.display="none"; document.getElementById("word2pdfBody").classList.remove("is-loaded"); });
    document.getElementById("word2pdfToolbar").style.display="flex";
    document.getElementById("word2pdfBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("toolWord2pdf.statusReading"));
    // Same rapid-file-replacement/double-click guard as PDF to Word above.
    goBtn.disabled = true;
    try {
    const arrayBuffer = await file.arrayBuffer();
    let structured;
    try {
      /* readDocxStructured() unzips with JSZip and parses XML with DOMParser - both synchronous-
         ish and well-behaved, unlike mammoth.extractRawText() (see the timeout this replaced in an
         earlier version of this function) - but kept under the same kind of timeout regardless,
         since a pathological/huge document is still a real possibility. */
      structured = await Promise.race([
        readDocxStructured(arrayBuffer),
        new Promise((_, reject) => setTimeout(() => reject(new Error(t("toolWord2pdf.errTookTooLong"))), 15000))
      ]);
    } catch(e) {
      out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolWord2pdf.errCouldNotRead", {msg: escapeAttr(e.message)})}</div>`;
      return;
    }
    setStatus(t("toolWord2pdf.statusConverting"));
    if(!operation.isCurrent()) return;
    setStatus(t("toolWord2pdf.statusRenderingPages"));
    let outBytes;
    try {
      outBytes = await buildWordPdfBytes(structured.sections, structured.loadMediaBytes);
    } catch(e) {
      out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolWord2pdf.errCouldNotBuild", {msg: escapeAttr(e.message)})}</div>`;
      return;
    }
    // Output validation (requirement: never hand back a silently-broken file): a real PDF must
    // parse back with at least one page and a non-trivial byte size.
    if(!outBytes || !outBytes.length){
      out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolWord2pdf.errCouldNotBuild", {msg: "empty output"})}</div>`;
      return;
    }
    setStatus(t("toolWord2pdf.statusFinalizing"));
    if(!operation.isCurrent()) return;
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "converted", "pdf");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- PDF to Excel (page-layout aware: one worksheet per page, real column widths, merged cells, borders and number formatting) ---- */
TOOLS.pdf2excel = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.pdf2excel")}</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2excelBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.pdf2excel")}</h2>
        <p class="tool-hero-desc">${t("toolPdf2excel.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, t("workspace.selectPdfFiles"))}
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-toolbar" id="pdf2excelToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("toolPdf2excel.convertToExcel")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("pdf2excelToolbar").style.display="none"; document.getElementById("pdf2excelBody").classList.remove("is-loaded"); });
    document.getElementById("pdf2excelToolbar").style.display="flex";
    document.getElementById("pdf2excelBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out=document.getElementById("out"); out.innerHTML=statusEl(T("workspace.statusReadingPdf"));
    // Same rapid-file-replacement/double-click guard as PDF to Word above.
    goBtn.disabled = true;
    try {
    await Promise.all([ensureXLSX(), ensureJSZip()]);
    const bytes=await file.arrayBuffer();
    const pdoc = operation.track(await loadPdfJsSafe({data:bytes}));
    const wb = XLSX.utils.book_new();
    const imagePlacements=[];
    // One entry per worksheet appended below, in the SAME order - passed
    // to applyCellFormattingToXlsx so each PDF page's own real geometry/
    // styling only ever applies to ITS OWN sheet. Each PDF page becomes
    // its own worksheet (see the architectural decision below) instead of
    // every page being forced onto one shared row/column grid.
    const pagesFormatting = [];
    // A single Excel workbook has one continuous row/column grid, but a
    // PDF has arbitrary per-page X/Y coordinates - forcing every page
    // onto ONE shared grid means an unrelated table on page 5 can only
    // ever be reconciled against (never truly independent of) whatever
    // page 1 already established, and two structurally different pages
    // permanently compete for the same physical column axis. Since a PDF
    // page break is already a REAL visual break in the source document
    // (the reader's eye resets to a new page), giving each page its own
    // worksheet - its own real MediaBox dimensions, its own real column/
    // row grid, its own real page setup - is the more faithful mapping,
    // not a lesser one: nothing about "closer to the source PDF" is lost
    // by not visually gluing two different physical pages together. A
    // table that genuinely continues across a page break simply repeats
    // its header on the next page's own sheet, exactly as the source PDF
    // itself does when printed/paginated.
    for(let i=1;i<=pdoc.numPages;i++){
      setStatus(t("toolPdf2excel.statusDetectingTables"), false, Math.round((i/pdoc.numPages)*100));
      const pdfPage = await pdoc.getPage(i);
      const pageGeometry = detectPageGeometry(pdfPage.view[2]-pdfPage.view[0], pdfPage.view[3]-pdfPage.view[1]);
      const sheetName = `Page ${i}`.slice(0,31);
      const content = await pdfPage.getTextContent();
      const pageText = content.items.map(it=>it.str).join(" ").trim();
      if(pageText.length < 6){
        const rows = [[`Page ${i} (image content — see embedded image below)`]];
        try{
          const canvas = await renderPdfPageCanvas(pdoc, i, 1.3);
          const rowFrom = rows.length;
          imagePlacements.push({sheetIndex: wb.SheetNames.length, row: rowFrom, col: 0, pngBase64: canvasToPngBase64(canvas), widthPx: canvas.width, heightPx: canvas.height});
          const heightRows = Math.max(4, Math.round(canvas.height/20));
          for(let r=0;r<heightRows;r++) rows.push([]);
        }catch(e){ /* keep the text-only row if rendering fails */ }
        const ws = XLSX.utils.aoa_to_sheet(rows);
        if(pageGeometry) ws["!margins"] = {left:0.7, right:0.7, top:0.75, bottom:0.75, header:0.3, footer:0.3};
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        pagesFormatting.push({gridRanges:[], cellStyles:[], rowHeights:{}, cellEdges:[], pageGeometry});
        continue;
      }
      // Real ruling-line grids and the confident borderless column-band
      // model - the same table detection PDF to Word already relies on -
      // take priority over the old pure text-gap guessing below, which is
      // kept only as the last-resort fallback for a page where this finds
      // no usable structure at all (e.g. no operator-list/visuals data).
      let visuals = {images:[], shapes:[], colorSpans:[]};
      try{ visuals = await extractPageVisuals(pdoc, i); }catch(e){ /* no vector/table-ruling data - fallback below still works */ }
      let blocks = [];
      try{ blocks = await extractPageBlocks(pdoc, i, visuals); }catch(e){ /* fall through to the plain gap-based extractor */ }
      if(!blocks.length){
        const rows = extractTableRows(content);
        const ws = XLSX.utils.aoa_to_sheet(rows);
        if(pageGeometry) ws["!margins"] = {left:0.7, right:0.7, top:0.75, bottom:0.75, header:0.3, footer:0.3};
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        pagesFormatting.push({gridRanges:[], cellStyles:[], rowHeights:{}, cellEdges:[], pageGeometry});
        continue;
      }
      // buildPageLayout constructs THIS page's own real, self-contained
      // coordinate grid from its own blocks alone (no cross-page carry-
      // forward - see the architectural note above), then
      // layoutToSheetRows converts it starting at row 0, since this page
      // is now its own sheet.
      const pageLayout = buildPageLayout(blocks, pdfPage.view[2]-pdfPage.view[0], pdfPage.view[3]-pdfPage.view[1], null);
      const converted = layoutToSheetRows(pageLayout, 0);
      const ws = XLSX.utils.aoa_to_sheet(converted.rows);
      if(converted.merges.length) ws["!merges"] = converted.merges;
      if(pageLayout.colBoundsPt.length > 1){
        // PDF points -> Excel's character-count column-width unit (~7px
        // per character at the default Calibri 11 font, 96 CSS px per
        // 72pt) - the one part of column/cell styling SheetJS's free
        // build actually honors on write (unlike cell.s borders/fonts -
        // see applyCellFormattingToXlsx). Deliberately absolute, not
        // rescaled: pageSetup below sets a paperSize matching THIS page's
        // own real dimensions and prints at natural 100% scale (no
        // fitToWidth stretch), so each column's physical printed width
        // must equal its real PDF width for the printed page to actually
        // match the source page. wch<->pixel formula is Excel's own
        // documented conversion for the default Calibri 11 font (7px
        // Maximum Digit Width): pixels = wch*7 + 5. Real geometry-derived
        // column identity (buildPageLayout's colBoundsPt), not a
        // per-index blended array - this page's own grid, nothing else's.
        const PX_PER_PT = 96/72, MDW = 7;
        ws["!cols"] = pageLayout.colBoundsPt.slice(0,-1).map((x,i)=>{
          const w = pageLayout.colBoundsPt[i+1]-x;
          return {wch: Math.max(1, Math.round(((w||60) * PX_PER_PT - 5) / MDW * 100) / 100)};
        });
      }
      if(pageGeometry){
        // Real physical margins: how far THIS page's own first detected
        // table sits from ITS OWN page edges - not a fixed default, and
        // not borrowed from a different page.
        const firstGrid = blocks.find(b=>b.type==="gridtable" && b.colBounds && b.rowBounds);
        const toIn = pt => Math.max(0.2, pt/72);
        ws["!margins"] = firstGrid ? {
          left: toIn(Math.min(...firstGrid.colBounds)), right: toIn(pageGeometry.widthPt - Math.max(...firstGrid.colBounds)),
          top: toIn(pageGeometry.heightPt - Math.max(...firstGrid.rowBounds)), bottom: toIn(Math.min(...firstGrid.rowBounds)),
          header: 0.3, footer: 0.3
        } : {left:0.7, right:0.7, top:0.75, bottom:0.75, header:0.3, footer:0.3};
      }
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
      pagesFormatting.push({gridRanges: converted.gridRanges, cellStyles: converted.cellStyles, rowHeights: converted.rowHeights, cellEdges: converted.cellEdges, pageGeometry});
    }
    setStatus(t("toolPdf2excel.statusBuilding"));
    let wbout = XLSX.write(wb, {bookType:"xlsx", type:"array"});
    wbout = await applyCellFormattingToXlsx(wbout, pagesFormatting);
    const blob = imagePlacements.length ? await embedImagesInXlsx(wbout, imagePlacements) : new Blob([wbout], {type:"application/octet-stream"});
    const outName = suffixedName(file, "converted", "xlsx");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- PDF to PowerPoint (one full-page image per slide) ---- */
TOOLS.pdf2pptx = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.pdf2pptx")}</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2pptxBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.pdf2pptx")}</h2>
        <p class="tool-hero-desc">${t("toolPdf2pptx.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, t("workspace.selectPdfFiles"))}
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-toolbar" id="pdf2pptxToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("toolPdf2pptx.convertToPowerPoint")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("pdf2pptxToolbar").style.display="none"; document.getElementById("pdf2pptxBody").classList.remove("is-loaded"); });
    document.getElementById("pdf2pptxToolbar").style.display="flex";
    document.getElementById("pdf2pptxBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("toolPdf2pptx.statusExtracting"));
    // Same rapid-file-replacement/double-click guard as PDF to Word above.
    goBtn.disabled = true;
    try {
    await ensureJSZip();
    const bytes=await file.arrayBuffer();
    let blob;
    let imageFallbackPages = 0, totalPages = 0, previewCanvas = null;
    try{
      const pdoc = operation.track(await loadPdfJsSafe({data:bytes}));
      totalPages = pdoc.numPages;
      const pages = [];
      for(let i=1;i<=pdoc.numPages;i++){
        setStatus(t("toolPdf2pptx.statusExtracting"), false, Math.round((i/pdoc.numPages)*90));
        // Same per-page extraction as PDF to Word (see TOOLS.pdf2word):
        // geometry/style blocks first, plain-text fallback second, and
        // only a genuinely textless (scanned) page becomes a full-page
        // picture - so text PDFs get editable slides instead of the old
        // one-picture-per-slide deck, while scanned PDFs keep working.
        const page_i = await pdoc.getPage(i);
        const pageWidthPt = page_i.view[2]-page_i.view[0], pageHeightPt = page_i.view[3]-page_i.view[1];
        let visuals = {images:[], shapes:[], colorSpans:[]};
        try{ visuals = await extractPageVisuals(pdoc, i); }catch(e){ /* no vector/image/color data - text still extracts fine */ }
        let pageBlocks = [];
        try{ pageBlocks = await extractPageBlocks(pdoc, i, visuals); }catch(e){ /* fall through to fallbacks below */ }
        let pageHasText = pageBlocks.some(blockHasRealText);
        if(!pageHasText){
          try{
            const editableFallback = await extractPlainPageParagraphs(pdoc, i);
            if(editableFallback.some(blockHasRealText)){ pageBlocks = editableFallback; pageHasText = true; }
          }catch(e){ /* a genuinely textless/scanned page still uses the image fallback below */ }
        }
        let thisPageBlocks;
        if(!pageHasText){
          imageFallbackPages++;
          const canvas = await renderPdfPageCanvas(pdoc, i, 1.6);
          if(!previewCanvas) previewCanvas = canvas;
          thisPageBlocks = [{type:"image", pngBase64:canvasToPngBase64(canvas), width:canvas.width, height:canvas.height,
            widthPt:pageWidthPt, heightPt:pageHeightPt, placement:"anchored", xPt:0, yFromTopPt:0, _y:pageHeightPt}];
        } else {
          const pageImages = visuals.images.map(im=>({
            type:"image", pngBase64: pdfImageToPngBase64(im.raw),
            width: im.width, height: im.height,
            widthPt: im.width, heightPt: im.height, _y: im.y,
            placement: "anchored", xPt: im.x, yFromTopPt: pageHeightPt - (im.y + im.height),
            pageWidthPt, pageHeightPt
          }));
          const unmatchedImages = embedImagesIntoTableCells(pageBlocks, pageImages);
          thisPageBlocks = pageBlocks.concat(unmatchedImages).sort((a,b)=> (b._y||0) - (a._y||0));
          if(!previewCanvas){
            try{ previewCanvas = await renderPdfPageCanvas(pdoc, i, 1); }catch(e){ /* preview is best-effort; the deck still builds */ }
          }
        }
        pages.push({pageWidthPt, pageHeightPt, blocks: thisPageBlocks});
        if(typeof page_i.cleanup === "function") page_i.cleanup();
      }
      setStatus(t("toolPdf2pptx.statusBuilding"), false, 95);
      blob = await buildEditablePptx(pages, file.name.replace(/\.[^./\\]+$/, ""));
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolPdf2pptx.errCouldNotConvert", {msg: escapeAttr(e.message)})}</div>`;
      return;
    }
    const outName = suffixedName(file, "converted", "pptx");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    setStatus(imageFallbackPages === totalPages ? t("toolPdf2pptx.doneNotEditable")
      : imageFallbackPages > 0 ? t("toolPdf2pptx.doneEditableMixed", {n: imageFallbackPages})
      : t("toolPdf2pptx.doneEditable"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:previewCanvas, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- Excel to PDF measured table layout ---- */
const EXCEL_PDF_LAYOUT = Object.freeze({
  pageWidth: 842,
  pageHeight: 595,
  margin: 32,
  titleHeight: 22,
  fontSize: 8.5,
  headerFontSize: 9,
  lineHeight: 11.5,
  paddingX: 5,
  paddingY: 4,
  minRowHeight: 20,
  minColWidth: 46,
  maxColWidth: 180,
});

function excelPdfCellText(sheet, row, col){
  const cell = sheet[XLSX.utils.encode_cell({r:row, c:col})];
  if(!cell || cell.v == null) return "";
  let value = cell.w;
  if(value == null){
    try { value = XLSX.utils.format_cell(cell); }
    catch(e) { value = cell.v instanceof Date ? cell.v.toLocaleDateString() : cell.v; }
  }
  return winAnsiSafe(String(value == null ? "" : value).replace(/\r\n?/g, "\n").replace(/\t/g, "    "));
}

function excelPdfMeasure(font, text, size){
  if(!text) return 0;
  try { return font.widthOfTextAtSize(text, size); }
  catch(e) { return text.length * size * 0.52; }
}

/* Wrap at words when possible, then split an overlong word character-by-character.
   Every returned line is guaranteed to fit maxWidth, which is the invariant that
   prevents one cell's text from ever entering its neighbour. */
function excelPdfWrapText(text, font, size, maxWidth){
  const result = [];
  const width = Math.max(4, maxWidth);
  const pushLongWord = word => {
    let chunk = "";
    for(const ch of word){
      const candidate = chunk + ch;
      if(chunk && excelPdfMeasure(font, candidate, size) > width){ result.push(chunk); chunk = ch; }
      else chunk = candidate;
    }
    if(chunk) result.push(chunk);
  };
  String(text).split("\n").forEach(paragraph => {
    if(!paragraph){ result.push(""); return; }
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    let line = "";
    words.forEach(word => {
      const candidate = line ? line + " " + word : word;
      if(excelPdfMeasure(font, candidate, size) <= width){ line = candidate; return; }
      if(line){ result.push(line); line = ""; }
      if(excelPdfMeasure(font, word, size) <= width) line = word;
      else pushLongWord(word);
    });
    if(line) result.push(line);
  });
  return result.length ? result : [""];
}

function excelPdfFindMerge(merges, row, col){
  return merges.find(m => row >= m.s.r && row <= m.e.r && col >= m.s.c && col <= m.e.c) || null;
}

function excelPdfScaleWidths(widths, usableWidth){
  const cfg = EXCEL_PDF_LAYOUT;
  let out = widths.slice();
  let total = out.reduce((sum,w)=>sum+w,0);
  if(total <= usableWidth || out.length * cfg.minColWidth > usableWidth) return out;
  out = out.map(w => Math.max(cfg.minColWidth, w * usableWidth / total));
  total = out.reduce((sum,w)=>sum+w,0);
  for(let pass=0; pass<4 && total>usableWidth+0.1; pass++){
    const flexible = out.map((w,i)=>({i, room:w-cfg.minColWidth})).filter(x=>x.room>0.01);
    const room = flexible.reduce((sum,x)=>sum+x.room,0);
    if(!room) break;
    const excess = total-usableWidth;
    flexible.forEach(x => { out[x.i] -= Math.min(x.room, excess * x.room / room); });
    total = out.reduce((sum,w)=>sum+w,0);
  }
  return out;
}

function excelPdfColumnWidths(sheet, range, visibleRows, visibleCols, regularFont, boldFont){
  const cfg = EXCEL_PDF_LAYOUT;
  const sheetCols = sheet["!cols"] || [];
  const headerRow = visibleRows[0];
  return visibleCols.map(col => {
    const meta = sheetCols[col] || {};
    let requested = 0;
    if(Number.isFinite(meta.wpx)) requested = meta.wpx * 72/96;
    else if(Number.isFinite(meta.wch)) requested = (meta.wch * 7 + 5) * 72/96;
    else if(Number.isFinite(meta.width)) requested = (meta.width * 7 + 5) * 72/96;
    let content = cfg.minColWidth;
    visibleRows.forEach(row => {
      const text = excelPdfCellText(sheet,row,col);
      if(!text) return;
      const font = row === headerRow ? boldFont : regularFont;
      const size = row === headerRow ? cfg.headerFontSize : cfg.fontSize;
      const widest = text.split("\n").reduce((max,line)=>Math.max(max,excelPdfMeasure(font,line,size)),0);
      content = Math.max(content, Math.min(cfg.maxColWidth, widest + cfg.paddingX*2));
    });
    return Math.max(cfg.minColWidth, Math.min(cfg.maxColWidth, Math.max(requested,content)));
  });
}

function excelPdfColumnBands(visibleCols, widths, usableWidth){
  const cfg = EXCEL_PDF_LAYOUT;
  const scaled = excelPdfScaleWidths(widths, usableWidth);
  if(scaled.reduce((sum,w)=>sum+w,0) <= usableWidth+0.1){
    return [{cols:visibleCols.slice(), widths:scaled}];
  }
  const bands = [];
  let cols = [], bandWidths = [], used = 0;
  visibleCols.forEach((col,i) => {
    const width = Math.min(usableWidth, Math.max(cfg.minColWidth,scaled[i]));
    if(cols.length && used+width > usableWidth){ bands.push({cols,widths:bandWidths}); cols=[]; bandWidths=[]; used=0; }
    cols.push(col); bandWidths.push(width); used += width;
  });
  if(cols.length) bands.push({cols,widths:bandWidths});
  return bands;
}

function excelPdfRowLayout(sheet, row, band, merges, regularFont, boldFont, isHeader){
  const cfg = EXCEL_PDF_LAYOUT;
  const entries = [];
  let pos = 0;
  while(pos < band.cols.length){
    const col = band.cols[pos];
    const merge = excelPdfFindMerge(merges,row,col);
    let endPos = pos;
    let sourceRow = row, sourceCol = col;
    if(merge){
      while(endPos+1 < band.cols.length && band.cols[endPos+1] <= merge.e.c) endPos++;
      sourceRow = merge.s.r; sourceCol = merge.s.c;
    }
    const width = band.widths.slice(pos,endPos+1).reduce((sum,w)=>sum+w,0);
    const text = (!merge || row === merge.s.r) ? excelPdfCellText(sheet,sourceRow,sourceCol) : "";
    const cell = sheet[XLSX.utils.encode_cell({r:sourceRow,c:sourceCol})];
    const font = isHeader ? boldFont : regularFont;
    const size = isHeader ? cfg.headerFontSize : cfg.fontSize;
    const lines = excelPdfWrapText(text,font,size,width-cfg.paddingX*2);
    entries.push({pos,endPos,width,text,cell,font,size,lines,align:!isHeader && cell && (cell.t === "n" || cell.t === "d") ? "right" : "left"});
    pos = endPos+1;
  }
  const maxLines = Math.max(1,...entries.map(entry=>entry.lines.length));
  const rowMeta = (sheet["!rows"] || [])[row] || {};
  const requestedHeight = Number.isFinite(rowMeta.hpt) ? rowMeta.hpt : (Number.isFinite(rowMeta.hpx) ? rowMeta.hpx*72/96 : 0);
  const height = Math.max(cfg.minRowHeight, requestedHeight, maxLines*cfg.lineHeight+cfg.paddingY*2);
  return {row,entries,maxLines,height,isHeader};
}

function excelPdfDrawRow(page, topY, band, layout, lineOffset, lineCount, height, striped){
  const cfg = EXCEL_PDF_LAYOUT;
  let x = cfg.margin;
  layout.entries.forEach(entry => {
    const fill = layout.isHeader ? rgb(0.90,0.95,0.90) : (striped ? rgb(0.975,0.98,0.975) : rgb(1,1,1));
    page.drawRectangle({x,y:topY-height,width:entry.width,height,color:fill,borderColor:rgb(0.68,0.72,0.68),borderWidth:0.55});
    entry.lines.slice(lineOffset,lineOffset+lineCount).forEach((line,lineIndex) => {
      if(!line) return;
      const textWidth = excelPdfMeasure(entry.font,line,entry.size);
      const textX = entry.align === "right"
        ? x + entry.width - cfg.paddingX - textWidth
        : x + cfg.paddingX;
      page.drawText(line,{x:Math.max(x+cfg.paddingX,textX),y:topY-cfg.paddingY-entry.size-lineIndex*cfg.lineHeight,size:entry.size,font:entry.font,color:rgb(0.10,0.12,0.10)});
    });
    x += entry.width;
  });
}

async function buildExcelPdfBytes(sheet, sheetName){
  const cfg = EXCEL_PDF_LAYOUT;
  const doc = await PDFDocument.create();
  const regularFont = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  let range;
  try { range = sheet && sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null; }
  catch(e) { range = null; }
  if(!range){
    const page = doc.addPage([cfg.pageWidth,cfg.pageHeight]);
    page.drawText(winAnsiSafe(String(sheetName||"Sheet")).slice(0,90),{x:cfg.margin,y:cfg.pageHeight-cfg.margin-11,size:11,font:boldFont,color:rgb(0.12,0.20,0.13)});
    page.drawText("This worksheet is empty.",{x:cfg.margin,y:cfg.pageHeight-cfg.margin-cfg.titleHeight-14,size:11,font:regularFont,color:rgb(0.2,0.2,0.2)});
    return doc.save();
  }

  const rowMeta = sheet["!rows"] || [], colMeta = sheet["!cols"] || [];
  const visibleRows = [];
  const visibleCols = [];
  for(let r=range.s.r;r<=range.e.r;r++) if(!(rowMeta[r] && rowMeta[r].hidden)) visibleRows.push(r);
  for(let c=range.s.c;c<=range.e.c;c++) if(!(colMeta[c] && colMeta[c].hidden)) visibleCols.push(c);
  if(!visibleRows.length || !visibleCols.length){
    const page = doc.addPage([cfg.pageWidth,cfg.pageHeight]);
    page.drawText(winAnsiSafe(String(sheetName||"Sheet")).slice(0,90),{x:cfg.margin,y:cfg.pageHeight-cfg.margin-11,size:11,font:boldFont,color:rgb(0.12,0.20,0.13)});
    page.drawText("This worksheet has no visible cells.",{x:cfg.margin,y:cfg.pageHeight-cfg.margin-cfg.titleHeight-14,size:11,font:regularFont,color:rgb(0.2,0.2,0.2)});
    return doc.save();
  }

  const usableWidth = cfg.pageWidth-cfg.margin*2;
  const widths = excelPdfColumnWidths(sheet,range,visibleRows,visibleCols,regularFont,boldFont);
  const bands = excelPdfColumnBands(visibleCols,widths,usableWidth);
  const merges = (sheet["!merges"] || []).filter(m => m.e.r>=range.s.r && m.s.r<=range.e.r && m.e.c>=range.s.c && m.s.c<=range.e.c);
  const headerRow = visibleRows[0];

  for(let bandIndex=0;bandIndex<bands.length;bandIndex++){
    const band = bands[bandIndex];
    const headerLayout = excelPdfRowLayout(sheet,headerRow,band,merges,regularFont,boldFont,true);
    let page, y, renderedBodyRows;
    const title = winAnsiSafe(String(sheetName || "Sheet")).slice(0,90) + (bands.length>1 ? `  -  columns ${XLSX.utils.encode_col(band.cols[0])}-${XLSX.utils.encode_col(band.cols[band.cols.length-1])}` : "");

    function startPage(repeatHeader){
      page = doc.addPage([cfg.pageWidth,cfg.pageHeight]);
      y = cfg.pageHeight-cfg.margin;
      page.drawText(title,{x:cfg.margin,y:y-11,size:11,font:boldFont,color:rgb(0.12,0.20,0.13)});
      y -= cfg.titleHeight;
      renderedBodyRows = 0;
      if(repeatHeader){
        const h = Math.min(headerLayout.height,y-cfg.margin);
        excelPdfDrawRow(page,y,band,headerLayout,0,headerLayout.maxLines,h,false);
        y -= h;
      }
    }

    startPage(false);
    for(const row of visibleRows){
      const isHeader = row === headerRow;
      const layout = isHeader ? headerLayout : excelPdfRowLayout(sheet,row,band,merges,regularFont,boldFont,false);
      const maxPageRowHeight = cfg.pageHeight-cfg.margin*2-cfg.titleHeight-(isHeader ? 0 : Math.min(headerLayout.height,80));
      if(layout.height <= maxPageRowHeight){
        if(y-layout.height < cfg.margin) startPage(!isHeader);
        excelPdfDrawRow(page,y,band,layout,0,layout.maxLines,layout.height,!isHeader && renderedBodyRows%2===1);
        y -= layout.height;
        if(!isHeader) renderedBodyRows++;
        continue;
      }

      // A pathological single row can be taller than a complete page. It is
      // the only case where keeping the row whole is physically impossible;
      // continue its wrapped lines on following pages instead of clipping or
      // allowing them to overlap another row.
      let lineOffset = 0;
      while(lineOffset < layout.maxLines){
        let available = y-cfg.margin;
        let linesHere = Math.floor((available-cfg.paddingY*2)/cfg.lineHeight);
        if(linesHere < 1){ startPage(!isHeader); available=y-cfg.margin; linesHere=Math.max(1,Math.floor((available-cfg.paddingY*2)/cfg.lineHeight)); }
        linesHere = Math.min(linesHere,layout.maxLines-lineOffset);
        const chunkHeight = Math.max(cfg.minRowHeight,linesHere*cfg.lineHeight+cfg.paddingY*2);
        excelPdfDrawRow(page,y,band,layout,lineOffset,linesHere,chunkHeight,!isHeader && renderedBodyRows%2===1);
        y -= chunkHeight;
        lineOffset += linesHere;
        if(lineOffset < layout.maxLines) startPage(!isHeader);
      }
      if(!isHeader) renderedBodyRows++;
    }
  }
  return doc.save();
}

async function buildExcelWorkbookPdfBytes(workbook){
  const combined = await PDFDocument.create();
  for(const sheetName of workbook.SheetNames){
    const sheetBytes = await buildExcelPdfBytes(workbook.Sheets[sheetName], sheetName);
    const sheetPdf = await PDFDocument.load(sheetBytes);
    const pages = await combined.copyPages(sheetPdf, sheetPdf.getPageIndices());
    pages.forEach(page=>combined.addPage(page));
  }
  // A malformed workbook with no sheet entries should still produce a valid, explanatory PDF.
  if(!combined.getPageCount()){
    const font = await combined.embedFont(StandardFonts.Helvetica);
    const page = combined.addPage([EXCEL_PDF_LAYOUT.pageWidth,EXCEL_PDF_LAYOUT.pageHeight]);
    page.drawText("This workbook contains no worksheets.",{x:EXCEL_PDF_LAYOUT.margin,y:EXCEL_PDF_LAYOUT.pageHeight-EXCEL_PDF_LAYOUT.margin-14,size:11,font,color:rgb(0.2,0.2,0.2)});
  }
  return combined.save();
}

TOOLS.excel2pdf = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.excel2pdf")}</h3></div>
    <div class="panel-body compact tool-workspace" id="excel2pdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.excel2pdf")}</h2>
        <p class="tool-hero-desc">${t("toolExcel2pdf.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML(".xlsx,.xls,.csv", false, t("toolExcel2pdf.selectSpreadsheet"))}
      </div>
      <div class="status" role="note">${t("toolExcel2pdf.allSheetsNote")}</div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-toolbar" id="excel2pdfToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("toolWord2pdf.convertToPdf")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("excel2pdfToolbar").style.display="none"; document.getElementById("excel2pdfBody").classList.remove("is-loaded"); });
    document.getElementById("excel2pdfToolbar").style.display="flex";
    document.getElementById("excel2pdfBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("toolExcel2pdf.statusReading"));
    // Same rapid-file-replacement/double-click guard as PDF to Word above.
    goBtn.disabled = true;
    try {
    await ensureXLSX();
    let outBytes;
    try {
      const bytes = await file.arrayBuffer();
      const wb = XLSX.read(bytes, {type:"array", cellDates:true, cellStyles:true});
      setStatus(t("toolExcel2pdf.statusGenerating"));
      outBytes = await buildExcelWorkbookPdfBytes(wb);
    } catch(e) {
      out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolExcel2pdf.errCouldNotConvert", {msg: escapeAttr(e.message)})}</div>`;
      return;
    }
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "converted", "pdf");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- Merge Excel (low-level OOXML/JSZip package merge, see js/core/xlsx-merge.js) ---- */
TOOLS.mergeexcel = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let files=[];
  const sheetNameCache = new WeakMap();

  openPanel(`
    <div class="panel-head"><h3>${t("tools.mergeexcel")}</h3></div>
    <div class="panel-body compact tool-workspace merge-workspace" id="mergeexcelBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("toolMergeExcel.heroTitle")}</h2>
        <p class="tool-hero-desc">${t("toolMergeExcel.heroDesc")}</p>
      </div>
      <p class="page-grid-hint" id="mergeexcelHint" style="display:none">${t("toolMergeExcel.addFilesHint")}</p>
      <div class="tool-upload-wrap workspace-host" id="mergeexcelUploadWrap">
        ${fileInputHTML(".xlsx", true, t("toolMergeExcel.selectExcelFiles"))}
        <div class="workspace-action-stack" id="mergeexcelFileToolbar" style="display:none">
          <button type="button" class="workspace-action-btn workspace-action-primary" id="mergeexcelAddFab" aria-label="${t("toolMergeExcel.addMoreFiles")}" data-tip="${t("toolMergeExcel.addMoreFiles")}">
            +<span class="workspace-action-badge" id="mergeexcelFileCount" hidden></span>
          </button>
        </div>
      </div>
      <div class="tool-content-area merge-info-tip">
        <span class="tip-icon" aria-hidden="true">ℹ️</span><span>${t("toolMergeExcel.infoTip")}</span>
      </div>
      <p class="tool-privacy-hint">🔒 ${t("toolMergeExcel.privacyHint")}</p>
      <div class="split-error" id="mergeexcelError" hidden></div>
      <div class="tool-toolbar" id="mergeexcelToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go" disabled>${t("toolMergeExcel.mergeWorkbooks")} <span aria-hidden="true">&rarr;</span></button>
      </div>
      <div id="out"></div>
    </div>`);

  const errorBox = document.getElementById("mergeexcelError");
  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${escapeAttr(msg)}</span>`; errorBox.hidden=false; }
    else { errorBox.hidden=true; errorBox.innerHTML=""; }
  }

  async function loadSheetNames(file){
    if(sheetNameCache.has(file)) return sheetNameCache.get(file);
    const promise = (async ()=>{
      try{
        await ensureJSZip();
        const zip = await JSZip.loadAsync(await file.arrayBuffer());
        const wbFile = zip.file("xl/workbook.xml");
        if(!wbFile) return null;
        const wbXml = await wbFile.async("string");
        return [...wbXml.matchAll(/<sheet\b[^>]*\sname="([^"]*)"/g)].map(m=>m[1]);
      }catch(e){ return null; }
    })();
    sheetNameCache.set(file, promise);
    return promise;
  }

  const flistDrag = wireFileCardDrag(()=>files, reordered=>{ files = reordered; refresh(); });
  const refresh = ()=>{
    renderFileList(files, i=>{files.splice(i,1); refresh();});
    document.querySelectorAll("#flist .file-card").forEach((card,i)=>{
      let badge = card.querySelector(".file-card-order");
      if(!badge){ badge = document.createElement("span"); badge.className="file-card-order"; card.prepend(badge); }
      badge.textContent = i+1;
      // Best-effort, per-file sheet-name preview - not required for the
      // merge itself, just lets the user confirm what's inside each file
      // before merging. Silently omitted (never blocks the tool) if the
      // file can't be read as a workbook.
      let sheetsEl = card.querySelector(".file-card-sheets");
      if(!sheetsEl){
        sheetsEl = document.createElement("div");
        sheetsEl.className = "file-card-sheets";
        sheetsEl.textContent = t("toolMergeExcel.readingSheets");
        card.appendChild(sheetsEl);
        loadSheetNames(files[i]).then(names=>{
          if(!sheetsEl.isConnected) return;
          if(names && names.length) sheetsEl.textContent = names.join(", ");
          else sheetsEl.remove();
        });
      }
    });
    flistDrag.rewire();
    document.getElementById("go").disabled = files.length<2;
    document.getElementById("mergeexcelToolbar").style.display = files.length ? "flex" : "none";
    document.getElementById("mergeexcelFileToolbar").style.display = files.length ? "flex" : "none";
    document.getElementById("mergeexcelHint").style.display = files.length ? "block" : "none";
    const countBadge = document.getElementById("mergeexcelFileCount");
    if(files.length){ countBadge.hidden=false; countBadge.textContent = files.length; } else countBadge.hidden = true;
    document.getElementById("mergeexcelBody").classList.toggle("is-loaded", files.length>0);
    showError(files.length===1 ? t("toolMergeExcel.errAddOneMore") : null);
  };
  document.getElementById("mergeexcelAddFab").addEventListener("click", ()=>document.getElementById("fi").click());
  wireDropzone(fs=>{ files = files.concat(fs.filter(f=>f.name.toLowerCase().endsWith(".xlsx"))); refresh(); });

  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolMergeExcel.statusReadingWorkbooks"));
    showError(null);
    try{
      await ensureJSZip();
      const inputs = [];
      for(const f of files) inputs.push({ name: f.name, bytes: await f.arrayBuffer() });
      if(!operation.isCurrent()) return;
      const result = await XlsxMerge.mergeWorkbooks(inputs, (pct, msg)=>{ if(operation.isCurrent()) setStatus(msg, false, pct); });
      if(!operation.isCurrent()) return;
      const blob = new Blob([result.bytes], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
      const outName = suffixedName(files[0], "merged", "xlsx");
      setStatus(T("workspace.statusPreparingDownload"));
      if(!operation.isCurrent()) return;
      const {url} = downloadBlob(blob, outName);
      setStatus(t("workspace.done"), true);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
      // Truthful, specific caveats only - never a blanket "some formatting
      // may be lost" disclaimer, and never shown at all when the merge
      // engine found nothing worth flagging.
      if(result.warnings.length){
        const note = document.createElement("div");
        note.className = "status mergeexcel-warning";
        note.setAttribute("role", "note");
        note.innerHTML = `<span aria-hidden="true">⚠️</span><span>${result.warnings.map(w=>escapeAttr(w)).join(" ")}</span>`;
        out.appendChild(note);
      }
    }catch(e){
      out.innerHTML = "";
      showError(e && e.message ? e.message : t("toolMergeExcel.errGenericFailed"));
    }
  }));
};
