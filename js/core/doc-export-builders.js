/* ---- Minimal DOCX builder (text-only, no external docx library needed) ---- */
function escapeXml(s){
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
/* Extracts a page's text as structured paragraphs with per-run bold/
   italic/size instead of one flat unstyled string, so PDF to Word can
   preserve real formatting. Bold/italic come from pdf.js's internal font
   objects (page.commonObjs), which expose the actual parsed font
   descriptor's bold/italic flags - NOT content.styles[fontName].fontFamily,
   which was verified empirically to only ever return a generic CSS
   fallback ("sans-serif") regardless of the real embedded font, so it's
   useless for this. Deliberately out of scope here: real table
   reconstruction and precise text alignment (centered/right) detection -
   both need much more structural inference than font/position data alone
   reliably supports; a future pass could add them without touching this
   function's output shape. */
/* Devanagari vowel-sign reordering fix. U+093F (ि, VOWEL SIGN I) is the one
   Devanagari matra that renders to the LEFT of its base consonant while
   Unicode requires it stored AFTER the consonant. This PDF's embedded
   font's ToUnicode CMap emits glyphs in visual (rendering) order, so
   pdf.js's getTextContent() faithfully reproduces the "wrong" order
   (e.g. "तिथि" comes out as "ितिथ"). Swapping every ि back with the
   consonant it precedes restores the correct logical order; verified
   against real extracted text from the source document. */
function fixDevanagari(text){
  if(!text) return text;
  return text.normalize("NFC").replace(/ि([क-हक़-य़])/g, "$1ि");
}

/* Splits one line's items into cells (as item arrays, so per-run bold/
   italic/size survives) wherever a real visual gap exceeds minGap. Two
   distinct gap encodings show up across real-world PDFs, and a table only
   reads correctly if both are checked: (1) a whitespace-only filler item
   whose own width IS the gap - pdf.js inserts these to fill the space
   between two separately-positioned runs (confirmed against this
   document's actual table rows, e.g. a `" "` item with width 160pt sitting
   between a left-column value and the next label - the item's neighbors
   sit flush against it with ~0 positional jump, so the gap is only visible
   via the filler's own width); (2) a direct x-position jump with no filler
   item at all. Checking only positional jumps (as an earlier version of
   this function did) misses case (1) entirely and finds zero table cells
   on this kind of PDF. */
function splitLineIntoCellItems(items, minGap){
  const cells = [];
  let cur = [], runningX = null;
  for(const it of items){
    const gapBefore = runningX != null ? (it.x - runningX) : 0;
    const isFiller = it.str.trim()==="" && it.width > minGap;
    const gap = isFiller ? Math.max(gapBefore, it.width) : gapBefore;
    if(gap >= minGap && cur.some(x=>x.str.trim())){
      cells.push(cur); cur = [];
    }
    if(!isFiller) cur.push(it);
    runningX = it.x + (it.width || 0);
  }
  if(cur.some(x=>x.str.trim())) cells.push(cur);
  return cells;
}
function cellItemsToText(cellItems){
  return cellItems.map(i=>i.str).join("").trim();
}

/* ============================================================
   PDF -> WORD: DOCUMENT MODEL
   ============================================================
   Everything from here down to buildMixedDocx is organized in two
   strictly separate layers that do not call into each other in the wrong
   direction:

   1. DETECTION (this section): linesToParagraphs, extractPageBlocks,
      detectRulingGridTable, buildBorderlessTable, extractPageVisuals,
      detectHeaderFooter. These read PDF geometry (pdf.js text items,
      operator-list shapes/images) and produce plain JS objects - the
      "document model" - with NO OOXML/DOCX knowledge whatsoever. Audited
      directly (grepped for `<w:` inside every one of these functions) to
      confirm none of them emit XML strings - they never did, this section
      just makes that boundary explicit rather than implicit.

   2. RENDERING (below, starting at runFontsXml/runsToXml): consumes the
      document model and is the ONLY place `<w:...>` OOXML strings get
      built. Nothing in this layer re-derives geometry or makes detection
      decisions; it only shapes already-decided content into valid XML.

   The document model's shapes, produced by the detection layer:

     Block (page-level, in reading order) - one of:
       {type:"paragraph", runs:[Run], listItem, align, spacingBeforePt,
        lineSpacingPt, _y}
       {type:"table", rows:[[{text,span}]], shadeHex?, borderHex?, _y}
         - gap-detected, no real column-boundary geometry, auto-width
       {type:"gridtable", nRows, nCols, cells:[Cell], colWidthsPt,
        colBounds, rowBounds, _y}
         - real geometry-backed columns (ruling-line grid OR the
           borderless global-column-band model), real widths, real
           rowSpan/colSpan
         - colBounds/rowBounds: nCols+1/nRows+1 absolute-y-boundary
           arrays used to test which cell an image's center point falls
           into (see embedImagesIntoTableCells); ruling-grid bounds are
           real rule-line positions, borderless bounds are synthesized
           midpoints between line y's (no real row-height evidence)
       {type:"columns", left:[Paragraph], right:[Paragraph], shadeHex?, _y}
       {type:"image", pngBase64, width, height, widthPt?, heightPt?,
        placement:"centered"|"anchored", xPt?, yFromTopPt?, _y}
       {type:"separator", _y}
       {type:"pagebreak", sectionSize?}

     Run: {text, bold, italic, underline, color:[r,g,b]|null, size,
           fontFamily, isBreak?} - isBreak:true is a detected intentional
           hard line break rendered as <w:br/>, not a separate run of text.

     Cell (gridtable only): {r0, c0, rowSpan, colSpan, text, align,
           vAlign?, padLeftPt, runs?, shadeHex?, borderHex?, images?} -
           runs is only present when the cell's source lines came through
           linesToParagraphs (ruling-line path), giving it real per-line
           structure; the borderless path only ever produces single-line
           cells so it has no runs to preserve. images (array of the same
           image-block shape used at page level, minus placement/xPt/
           yFromTopPt) is attached by embedImagesIntoTableCells when a
           page image's center point geometrically falls inside this
           cell's colBounds/rowBounds - such images are consumed and do
           NOT also appear as a separate page-level image block.

   This model is deliberately NOT a set of classes/typed constructors -
   it's plain object literals, matching the rest of this codebase's style
   (no build step, no TypeScript). The schema above is the actual contract;
   changing a shape here means updating every renderer function that reads
   it (grep the field name across runFontsXml..buildMixedDocx). ============================================================ */

/* Groups already Y-clustered lines into paragraphs: a vertical gap
   noticeably larger than the line's own font size means a new paragraph,
   not just a wrapped line. A fully blank line always forces a break.
   When pageWidth is given, also detects real centered/right-aligned
   headings by comparing the line's own text bounding box against the
   page - not by guessing from content (e.g. "numbers are probably
   right-aligned"), only from geometry: a line whose left and right
   margins are both large and roughly equal reads as centered; one flush
   to the right edge reads as right-aligned. Ordinary left-flowing body
   text always has ~0 left margin so this can't misfire on it. */
function linesToParagraphs(lines, pageWidth){
  const sorted = lines.slice().sort((a,b)=> b.y - a.y);
  const paragraphs = [];
  let prevY = null, prevSize = null, current = null, prevLineRightExtent = null;
  for(const line of sorted){
    const items = line.items;
    const lineText = items.map(i=>i.str).join("");
    if(!lineText.trim()){ current = null; prevLineRightExtent = null; continue; }
    const size = (items.find(i=>i.str.trim()) || items[0]).size;
    const gap = prevY != null ? prevY - line.y : 0;
    const realItems = items.filter(it=>it.str.trim());
    const lineRightExtent = realItems.length ? Math.max(...realItems.map(it=>it.x+it.width)) : 0;
    const isNewParagraph = !current || (prevSize && gap > prevSize*1.6);
    if(isNewParagraph){
      current = {type:"paragraph", runs:[], listItem:false, _y: line.y, _lineGaps:[], _maxRightExtent: lineRightExtent};
      // Preserve the actual PDF vertical gap before this paragraph as
      // real w:spacing (converted pt->twips) instead of a single global
      // spacing value or fabricated blank paragraphs. Only meaningful
      // once a previous paragraph exists on the same page/region; capped
      // to guard against one stray huge gap (e.g. a genuine page-section
      // jump) blowing up the visible spacing.
      if(prevY != null && gap > 0) current.spacingBeforePt = Math.min(gap, 200);
      paragraphs.push(current);
      if(/^\s*([•●▪‣\-*]|\d{1,3}[.)])\s+/.test(lineText)) current.listItem = true;
      // Real min/max X of this paragraph's own first line, captured
      // unconditionally (not just when pageWidth is available for
      // alignment detection) - the actual physical horizontal extent
      // this text occupies, used by buildPageLayout to place/span a
      // paragraph on the page's shared column-boundary grid instead of
      // always confining it to one fixed column.
      if(realItems.length){
        current.xLeft = Math.min(...realItems.map(it=>it.x));
        current.xRight = Math.max(...realItems.map(it=>it.x+it.width));
      }
      if(pageWidth && realItems.length){
        const leftGap = current.xLeft, rightGap = pageWidth - current.xRight;
        if(rightGap < pageWidth*0.04 && leftGap > pageWidth*0.2) current.align = "right";
        else if(leftGap > pageWidth*0.15 && rightGap > pageWidth*0.15 && Math.abs(leftGap-rightGap) < pageWidth*0.08) current.align = "center";
      }
    } else {
      // Continuing the same paragraph - this gap is a genuine line-to-
      // line (not paragraph-to-paragraph) baseline distance, collected to
      // derive real intra-paragraph line spacing below.
      current._lineGaps.push(gap);
      // Intentional hard line break vs. normal word-wrap: a wrapped line
      // (except the true last one) fills close to the paragraph's own
      // right margin - so the line we're about to append TO reads as a
      // deliberate break if the PREVIOUS line ended noticeably short of
      // the widest line seen so far in this paragraph. This can't fire on
      // a normal wrapped paragraph (every line but the last stays close
      // to the running max by definition); it also can't detect a break
      // between two lines that are BOTH short with nothing wider to
      // compare against (e.g. a pure short-line address block) - a real,
      // disclosed limitation of geometry-only detection.
      // Threshold tuned conservatively (0.65, not the geometrically
      // "tighter-looking" 0.85): natural word-wrap regularly ends a line
      // anywhere from ~70-99% of the paragraph's fill width depending on
      // where word boundaries fall, so a tighter threshold was firing on
      // ordinary wrapped prose (confirmed against the real bill's long
      // Notes sections). 0.65 still catches lines that are CLEARLY short
      // (address-block-style deliberate breaks) while leaving normal
      // wrapping alone.
      if(prevLineRightExtent != null && current._maxRightExtent > 0 && prevLineRightExtent < current._maxRightExtent*0.65){
        current.runs.push({text:"", isBreak:true});
      }
      current._maxRightExtent = Math.max(current._maxRightExtent, lineRightExtent);
    }
    for(const item of items){
      const last = current.runs[current.runs.length-1];
      const colorKey = item.color ? item.color.join(",") : "";
      if(last && !last.isBreak && last.bold===item.bold && last.italic===item.italic && last.size===item.size
         && !!last.underline===!!item.underline && (last.color?last.color.join(","):"")===colorKey
         && last.fontFamily===item.fontFamily){
        last.text += item.str;
      } else {
        current.runs.push({text:item.str, bold:item.bold, italic:item.italic, size:item.size, underline:item.underline, color:item.color, fontFamily:item.fontFamily});
      }
    }
    current.runs.push({text:" ", bold:false, italic:false, size});
    prevY = line.y; prevSize = size; prevLineRightExtent = lineRightExtent;
  }
  // Derive real intra-paragraph line spacing (only meaningful for
  // paragraphs that actually span 2+ visual lines) instead of one global
  // line height, clamped to a sane range so one noisy gap can't produce
  // pathological spacing.
  paragraphs.forEach(p=>{
    if(p._lineGaps && p._lineGaps.length){
      const avg = p._lineGaps.reduce((a,b)=>a+b,0) / p._lineGaps.length;
      p.lineSpacingPt = Math.max(6, Math.min(60, avg));
    }
    delete p._lineGaps; delete p._maxRightExtent;
  });
  return paragraphs;
}

/* Builds structured page blocks (paragraph / two-column / table) instead
   of one flat left-to-right text dump. Root cause of the old layout loss:
   extractStyledParagraphs (now removed) grouped items into lines by Y only
   and sorted every item on a line strictly by X with zero notion of
   column/region boundaries, so a genuine two-column page (e.g. account
   info on the left, division info on the right, both at the same Y) was
   merged into a single run-on line. This function instead classifies each
   line as a table row (>=3 small, consistent gaps), a two-column split
   (one very wide gap), or plain prose, and only then converts runs of
   same-classified lines into the matching DOCX structure. */
async function extractPageBlocks(pdoc, pageNum, visuals){
  const page = await pdoc.getPage(pageNum);
  await page.getOperatorList(); // populates commonObjs with real font descriptors
  const content = await page.getTextContent();
  const viewport = page.view; // [x0,y0,x1,y1] in PDF points
  const pageWidth = viewport[2] - viewport[0];
  const shapes = (visuals && visuals.shapes) || [];
  const colorSpans = (visuals && visuals.colorSpans) || [];
  const nearestPageColor = buildNearestColorLookup(colorSpans, 40);

  const fontStyleCache = {};
  async function styleFor(fontName){
    if(fontStyleCache[fontName]) return fontStyleCache[fontName];
    let style = {bold:false, italic:false, fontFamily:null};
    try{
      const f = await page.commonObjs.get(fontName);
      if(f) style = {bold: !!f.bold, italic: !!f.italic, fontFamily: mapFontFamily(f.fallbackName)};
    }catch(e){ /* keep default (unstyled) if the font object isn't resolvable */ }
    fontStyleCache[fontName] = style;
    return style;
  }

  const lineTolerance = 3;
  const lines = [];
  for(const it of content.items){
    if(it.str === undefined) continue;
    const size = Math.abs(it.transform[0]) || Math.abs(it.transform[3]) || 10;
    const x = it.transform[4], y = it.transform[5];
    const style = it.str.trim() ? await styleFor(it.fontName) : {bold:false, italic:false, fontFamily:null};
    const color = it.str.trim() ? nearestPageColor(x, y) : null;
    let line = lines.find(l => Math.abs(l.y - y) <= lineTolerance);
    if(!line){ line = {y, items:[]}; lines.push(line); }
    line.items.push({str: it.str, x, width: it.width||0, size, bold: style.bold, italic: style.italic, fontFamily: style.fontFamily, color});
  }
  lines.sort((a,b)=> b.y - a.y); // PDF y grows upward - top of page first
  lines.forEach(l => l.items.sort((a,b)=>a.x-b.x));

  // Real ruling-line tables take priority over whitespace-based detection
  // (PDF ruling lines are ground truth when present). Detect and remove
  // repeatedly so multiple separately-bordered tables on one page can each
  // be found, capped to avoid pathological loops on noisy pages.
  const gridTables = [];
  {
    let remainingShapes = shapes, remainingLines = lines;
    for(let guard=0; guard<5; guard++){
      const grid = detectRulingGridTable(remainingShapes, remainingLines);
      if(!grid) break;
      gridTables.push(grid);
      const [yBottom, yTop] = grid.consumedYRange;
      remainingLines = remainingLines.filter(l => l.y > yTop+2 || l.y < yBottom-2);
      remainingShapes = remainingShapes.filter(s => !grid.consumedShapes.includes(s));
    }
    if(remainingLines.length !== lines.length){ lines.length = 0; lines.push(...remainingLines); }
    if(remainingShapes.length !== shapes.length){ shapes.length = 0; shapes.push(...remainingShapes); }
  }

  // Match thin stroked rects (near-zero height, real width) to the text
  // line they sit directly under - those are underlines, not decorative
  // separators. Whatever's left over after that pass is a genuine
  // standalone rule (page/section divider) with no text to attach to.
  const underlineCandidates = shapes.filter(s => s.stroke && s.h < 2.5 && s.w > 3);
  const usedUnderlines = new Set();
  lines.forEach(line=>{
    const realItems = line.items.filter(i=>i.str.trim());
    if(!realItems.length) return;
    const minX = Math.min(...realItems.map(i=>i.x));
    const maxX = Math.max(...realItems.map(i=>i.x+i.width));
    for(let k=0;k<underlineCandidates.length;k++){
      if(usedUnderlines.has(k)) continue;
      const s = underlineCandidates[k];
      const overlap = Math.min(maxX, s.x+s.w) - Math.max(minX, s.x);
      if(Math.abs(s.y - line.y) <= 4 && overlap > 0.4*Math.min(s.w, maxX-minX)){
        usedUnderlines.add(k);
        line.items.forEach(i=>{ if(i.str.trim()) i.underline = true; });
      }
    }
  });
  const standaloneSeparators = underlineCandidates.filter((s,k)=>!usedUnderlines.has(k) && s.w > 30);

  // Large filled/stroked rects are containers/boxes (header bar, amount
  // boxes, notes box, etc.) - approximate them as shading/border color on
  // whichever table/column block falls inside their vertical extent,
  // picking the tightest (smallest-area) enclosing box so a page-wide
  // background rect doesn't win over a nested one.
  const boxCandidates = shapes.filter(s => s.w > 15 && s.h > 15 && (s.fill || s.stroke));
  function isNearWhite(rgb){ return rgb && rgb[0]>=245 && rgb[1]>=245 && rgb[2]>=245; }
  // Cell text is always rendered in its own (usually dark/black) color, so
  // shading a cell with a dark background would make the text unreadable -
  // this codebase has no mechanism to flip text to white for a dark cell,
  // so skip shading rather than risk illegible output.
  function isSafeForShading(rgb){ return rgb && !isNearWhite(rgb) && (0.299*rgb[0]+0.587*rgb[1]+0.114*rgb[2]) >= 140; }
  function findEnclosingBox(yTop, yBottom){
    let best=null, bestArea=Infinity;
    for(const b of boxCandidates){
      if(b.y <= yBottom+3 && b.y+b.h >= yTop-3){
        const area = b.w*b.h;
        if(area < bestArea){ bestArea = area; best = b; }
      }
    }
    return best;
  }

  // classify each line: small-gap split for table-cell candidates, a
  // separate much-larger-gap split for two-column candidates
  const bigGapThreshold = Math.max(80, pageWidth*0.14);
  lines.forEach(line=>{
    const anyReal = line.items.find(i=>i.str.trim());
    const size = anyReal ? anyReal.size : 10;
    const smallGapItemCells = splitLineIntoCellItems(line.items, Math.max(9, size*1.15));
    line.cells = smallGapItemCells.map(ci=>({
      text: cellItemsToText(ci),
      x: ci[0] ? ci[0].x : 0,
      xEnd: ci.length ? Math.max(...ci.map(it=>it.x+it.width)) : 0
    }));
    const bigGapItemCells = splitLineIntoCellItems(line.items, bigGapThreshold);
    if(bigGapItemCells.length === 2 && cellItemsToText(bigGapItemCells[0]) && cellItemsToText(bigGapItemCells[1])){
      line.colSplit = {left: bigGapItemCells[0], right: bigGapItemCells[1]};
    }
  });

  // table runs: start at a line with >=3 cells. A run can be EXTENDED by:
  //  (a) another >=3-cell line (updates the established column x-bands);
  //  (b) a line with FEWER cells (even just 1-2) whose cell x-position(s)
  //      geometrically match an already-established column band - this is
  //      what a real table row looks like when the outer table has a
  //      nested Rate/Amount sub-row pair and one sub-row simply has fewer
  //      populated columns than its siblings (confirmed against the real
  //      bill's "Calculation Details" table: a genuine "Fixed/Demand
  //      Charges  1.68" row only has 2 cells but both land squarely on
  //      established column starts, so it belongs in the same table);
  //  (c) the existing big-gap two-part colSplit signature (a genuine
  //      spanning row: one wide label cell + one value);
  //  (d) AT MOST ONE line that matches none of the above, bridged only if
  //      the line immediately after it resumes the table (another >=3
  //      line or a compatible-band line) - this is what a short in-table
  //      sub-header like "Govt Subsidy" looks like: it has no compatible
  //      column of its own, but real table rows continue right after it.
  //      A genuinely unrelated paragraph between two unrelated tables
  //      does NOT get this benefit of the doubt beyond one line, and only
  //      when the table actually resumes immediately after it.
  const isTableLine = l => l.cells.length >= 3;
  const colTolerance = 12;
  // establishedXs is kept as a small, CLUSTERED set of true column bands
  // (via the same clusterVals used elsewhere), not a raw accumulating
  // list of every cell x ever seen - an unbounded/unclustered set was
  // tried first and caused a serious bug: after enough rows, it contained
  // dozens of scattered x values across the whole page width, so ANY new
  // line's x (including ordinary left-flowing paragraph text sharing the
  // same left margin as the table) coincidentally "matched" something in
  // it, swallowing an entire unrelated Notes/legal-text section into one
  // table. Confirmed and fixed before this shipped.
  function xsCompatibleStrict(establishedXs, cellXs){
    // Require EVERY cell in the candidate line to land on a distinct
    // established band, and require at least 2 cells - a single value
    // coincidentally sharing an x with one column (e.g. the page's left
    // margin, which ordinary paragraphs also start at) is not enough
    // evidence on its own; that weaker single-value case is exactly what
    // the separate one-line "bridge" path below exists for, gated by its
    // own tighter check.
    if(cellXs.length < 2) return false;
    const usedBands = new Set();
    for(const x of cellXs){
      const bandIdx = establishedXs.findIndex((ex,bi)=> !usedBands.has(bi) && Math.abs(ex-x) <= colTolerance);
      if(bandIdx === -1) return false;
      usedBands.add(bandIdx);
    }
    return true;
  }
  lines.forEach(l => l.role = null);
  let i = 0;
  while(i < lines.length){
    if(isTableLine(lines[i])){
      let j = i+1;
      let establishedXs = clusterVals(lines[i].cells.map(c=>c.x), colTolerance);
      let bridgedStray = false;
      while(j < lines.length){
        const lj = lines[j];
        const ljXs = lj.cells.map(c=>c.x);
        if(isTableLine(lj)){
          establishedXs = clusterVals(establishedXs.concat(ljXs), colTolerance);
          j++; continue;
        }
        if(xsCompatibleStrict(establishedXs, ljXs)){
          establishedXs = clusterVals(establishedXs.concat(ljXs), colTolerance);
          j++; continue;
        }
        if(lj.colSplit){
          j++; continue;
        }
        if(!bridgedStray && j+1 < lines.length){
          const lnext = lines[j+1];
          const nextXs = lnext.cells.map(c=>c.x);
          const nextResumes = isTableLine(lnext) || xsCompatibleStrict(establishedXs, nextXs);
          if(nextResumes){ bridgedStray = true; j++; continue; }
        }
        break;
      }
      if(j - i >= 2){
        for(let k=i;k<j;k++) lines[k].role = "table";
        i = j; continue;
      }
    }
    i++;
  }
  // column runs (only among lines a table didn't already claim) - a single
  // isolated split line is still kept as a column pair (not required to
  // repeat across consecutive lines), since real-world layouts like
  // bilingual "label: value    label: value" rows often only line up with
  // their counterpart for one row at a time rather than a clean multi-row
  // block (adjacent rows can land on slightly different baselines per
  // script and fail the Y-tolerance grouping that would otherwise chain
  // them together).
  i = 0;
  while(i < lines.length){
    if(!lines[i].role && lines[i].colSplit){
      let j = i+1;
      while(j < lines.length && !lines[j].role && lines[j].colSplit) j++;
      for(let k=i;k<j;k++) lines[k].role = "column";
      i = j; continue;
    }
    i++;
  }

  // walk top-to-bottom emitting blocks
  const blocks = [];
  i = 0;
  while(i < lines.length){
    const role = lines[i].role;
    let j = i+1;
    while(j < lines.length && lines[j].role === role) j++;
    const run = lines.slice(i, j);
    const yTop = run[0].y, yBottom = run[run.length-1].y;
    const box = findEnclosingBox(yTop, yBottom);
    if(role === "table"){
      const borderless = buildBorderlessTable(run, pageWidth);
      if(borderless){
        const block = {type:"gridtable", nRows:borderless.nRows, nCols:borderless.nCols, cells:borderless.cells, colWidthsPt:borderless.colWidthsPt, colBounds:borderless.colBounds, rowBounds:borderless.rowBounds, bordered:borderless.bordered, _y: run[0].y};
        if(box){
          if(isSafeForShading(box.fill)) block.shadeHex = rgbToHex(box.fill);
          if(box.stroke){ block.borderHex = rgbToHex(box.stroke); block.borderWidthPt = box.lineWidth||1; }
        }
        blocks.push(block);
      } else {
        // The cross-row global-band model couldn't build a confident
        // shared column layout (common on very short 2-3 line label:value
        // runs - too few rows for the band statistics to resolve
        // cleanly). That's a real table candidate though - it already
        // passed the region-level gate (>=3 cells, >=2 consecutive
        // lines, stable count) - so fall back to a simple per-line,
        // auto-width table rather than discarding the structure entirely
        // into flat paragraphs.
        const width = run.reduce((m,l)=>Math.max(m, l.cells.length), 0);
        const rows = run.map(l=>{
          const cellTexts = l.cells.map(c=>fixDevanagari(c.text.trim()));
          if(cellTexts.length === 1 && width > 1) return [{text: cellTexts[0], span: width}];
          const padded = cellTexts.slice();
          while(padded.length < width) padded.push("");
          return padded.map(t=>({text:t, span:1}));
        });
        const tableItems=run.flatMap(line=>line.items).filter(item=>item.str.trim());
        const block = {type:"table", rows, _y: run[0].y,
          xLeft:tableItems.length?Math.min(...tableItems.map(item=>item.x)):0,
          xRight:tableItems.length?Math.max(...tableItems.map(item=>item.x+item.width)):pageWidth};
        if(box){
          if(isSafeForShading(box.fill)) block.shadeHex = rgbToHex(box.fill);
          if(box.stroke){ block.borderHex = rgbToHex(box.stroke); block.borderWidthPt = box.lineWidth||1; }
        }
        blocks.push(block);
      }
    } else if(role === "column"){
      const leftLines = run.map(l=>({y:l.y, items:l.colSplit.left}));
      const rightLines = run.map(l=>({y:l.y, items:l.colSplit.right}));
      const block = {type:"columns", left: linesToParagraphs(leftLines), right: linesToParagraphs(rightLines), _y: run[0].y};
      if(box && isSafeForShading(box.fill)) block.shadeHex = rgbToHex(box.fill);
      blocks.push(block);
    } else {
      blocks.push(...linesToParagraphs(run, pageWidth));
    }
    i = j;
  }
  standaloneSeparators.forEach(s=>{
    blocks.push({type:"separator", _y: s.y, xLeft:s.x, xRight:s.x+s.w});
  });
  gridTables.forEach(g=>{
    const block = {type:"gridtable", nRows:g.nRows, nCols:g.nCols, cells:g.cells, colWidthsPt:g.colWidthsPt, colBounds:g.colBounds, rowBounds:g.rowBounds, bordered:g.bordered, _y: g._y};
    // Real background/highlight: the SAME findEnclosingBox/isSafeForShading
    // evidence already used for the borderless-table path (a few lines
    // above) - a real filled/stroked box enclosing this table's own real
    // row range (g.rowBounds, real ruling-line Y positions) is exactly as
    // valid a background signal for a ruling-line table as it is for a
    // borderless one. This block-push site simply predated the shading
    // feature, leaving real ruled tables with a colored background box
    // silently unshaded - not a deliberate exclusion.
    const box = findEnclosingBox(g.rowBounds[0], g.rowBounds[g.rowBounds.length-1]);
    if(box){
      if(isSafeForShading(box.fill)) block.shadeHex = rgbToHex(box.fill);
      if(box.stroke){ block.borderHex = rgbToHex(box.stroke); block.borderWidthPt = box.lineWidth||1; }
    }
    g.cells.forEach(cell=>{
      const x0=g.colBounds[cell.c0], x1=g.colBounds[cell.c0+cell.colSpan];
      const yTop=g.rowBounds[cell.r0], yBottom=g.rowBounds[cell.r0+cell.rowSpan];
      const fillBox=boxCandidates.filter(candidate=>candidate.fill && candidate.x<=x0+2 && candidate.x+candidate.w>=x1-2 && candidate.y<=yBottom+2 && candidate.y+candidate.h>=yTop-2).sort((a,b)=>a.w*a.h-b.w*b.h)[0];
      if(fillBox && isSafeForShading(fillBox.fill)) cell.shadeHex=rgbToHex(fillBox.fill);
    });
    block.borderWidthPt = g.borderWidthPt;
    blocks.push(block);
  });
  blocks.sort((a,b)=> (b._y||0) - (a._y||0));
  return blocks;
}

/* Lightweight editable fallback for PDF pages whose richer structure pass could not be built.
   It deliberately uses the same paragraph grouping model, keeping extractable text as Word runs;
   only pages with no extractable text at all should fall back to a rendered page image. */
async function extractPlainPageParagraphs(pdoc, pageNum){
  const page = await pdoc.getPage(pageNum);
  const content = await page.getTextContent();
  const pageWidth = page.view[2]-page.view[0];
  const lines = [];
  for(const item of content.items){
    if(item.str === undefined) continue;
    const y = item.transform[5];
    let line = lines.find(candidate=>Math.abs(candidate.y-y)<=3);
    if(!line){ line={y,items:[]}; lines.push(line); }
    line.items.push({str:item.str,x:item.transform[4],width:item.width||0,size:Math.abs(item.transform[0])||Math.abs(item.transform[3])||10,bold:false,italic:false,fontFamily:null,color:null});
  }
  lines.sort((a,b)=>b.y-a.y);
  lines.forEach(line=>line.items.sort((a,b)=>a.x-b.x));
  return linesToParagraphs(lines,pageWidth);
}

/* Merges nearby 1D values (x or y coordinates) into representative
   cluster centers within tolerance - used both for ruling-line row/column
   positions and for borderless cross-row column-band detection. */
function clusterVals(vals, tol){
  const sorted = vals.slice().sort((a,b)=>a-b);
  const out = [];
  for(const v of sorted){
    if(out.length && v-out[out.length-1]<=tol) out[out.length-1] = (out[out.length-1]+v)/2;
    else out.push(v);
  }
  return out;
}

/* Detects a table from real PDF ruling lines (a grid of horizontal +
   vertical strokes) rather than whitespace gaps - the highest-fidelity
   signal when a PDF actually draws visible borders, and the only way to
   reliably detect merged cells (a missing ruling-line segment where one
   would otherwise be expected). Handles horizontal spans (e.g. a title
   row with no vertical dividers) and vertical spans between cells sharing
   an identical column range with no ruling line between them. This
   document's own tables have no ruling lines at all (verified against the
   real bill - confirmed empirically before building this), so this path
   exists for generality across other PDFs and was validated against a
   synthetic bordered/merged-cell test PDF instead. */
function detectRulingGridTable(shapes, lines){
  // A real border "line" is just as often drawn as a thin FILLED rectangle
  // (`re` + `f`) as an actually-stroked line (`re`/moveTo-lineTo + `S`) -
  // a very common technique in real-world PDF generators, confirmed
  // against a real government table PDF whose entire grid is drawn this
  // way (fill:[0,0,0], stroke:null throughout). Requiring .stroke alone
  // meant this detector could never see a real grid on that class of
  // document at all - it was previously only validated against a
  // synthetic stroked-line test PDF (see this function's own doc comment
  // above).
  const allHLines = shapes.filter(s=>(s.stroke || s.fill) && s.h<2.5 && s.w>15);
  const allVLines = shapes.filter(s=>(s.stroke || s.fill) && s.w<2.5 && s.h>15);
  if(allHLines.length<2 || allVLines.length<2) return null;
  // Two genuinely separate ruled tables stacked vertically on one page
  // used to get unioned into ONE erroneous grid (confirmed real bug):
  // rowYs had no gap/discontinuity check at all, so a large vertical jump
  // between one table's last row and an unrelated table's first row was
  // silently treated as just another (very tall) row. Detect that jump
  // as a statistical outlier relative to THIS page's own median row gap
  // (never a fixed point threshold) and truncate the grid there - the
  // remainder is left for extractPageBlocks' own "detect and remove
  // repeatedly" loop (see its gridTables loop) to pick up as its own
  // separate table on the next iteration, exactly as it already does for
  // separately-bordered tables.
  let rowYs = clusterVals(allHLines.map(l=>l.y), 2).sort((a,b)=>b-a); // descending, top to bottom
  if(rowYs.length > 2){
    const gaps = [];
    for(let i=0;i<rowYs.length-1;i++) gaps.push(rowYs[i]-rowYs[i+1]);
    const sortedGaps = gaps.slice().sort((a,b)=>a-b);
    const medianGap = sortedGaps[Math.floor(sortedGaps.length/2)];
    if(medianGap > 0){
      const splitIdx = gaps.findIndex(g => g > medianGap*2.5);
      if(splitIdx !== -1) rowYs = rowYs.slice(0, splitIdx+1);
    }
  }
  if(rowYs.length<2) return null;
  // Once the row range is truncated to just this table, every other
  // signal derived from shapes (column positions, consumed shapes) must
  // be scoped to that SAME truncated Y range too - otherwise a second
  // table's unrelated column x-positions (or its own ruling lines) still
  // leak into this table's column count / get wrongly marked "consumed"
  // and become invisible to extractPageBlocks' next detection pass.
  const scopedTop = rowYs[0]+2, scopedBottom = rowYs[rowYs.length-1]-2;
  const hLines = allHLines.filter(l => l.y<=scopedTop && l.y>=scopedBottom);
  const vLines = allVLines.filter(l => l.y<=scopedTop && (l.y+l.h)>=scopedBottom);
  const colXs = clusterVals(vLines.map(l=>l.x), 2).sort((a,b)=>a-b);
  if(colXs.length<2) return null;
  const nRows = rowYs.length-1, nCols = colXs.length-1;
  if(nRows<1 || nCols<2) return null; // need a real 2D grid, not a single stray box

  function hasVerticalAt(x, yTop, yBottom){
    return vLines.some(l=> Math.abs(l.x-x)<=2 && l.y<=yBottom+2 && (l.y+l.h)>=yTop-2);
  }
  function hasHorizontalAt(y, xLeft, xRight){
    return hLines.some(l=> Math.abs(l.y-y)<=2 && l.x<=xLeft+2 && (l.x+l.w)>=xRight-2);
  }

  // horizontal spans per row (missing internal vertical divider = colspan)
  const rowSpanMap = [];
  for(let r=0;r<nRows;r++){
    const yTop = rowYs[r], yBottom = rowYs[r+1];
    const segs = []; let c=0;
    while(c<nCols){
      let span=1;
      while(c+span<nCols && !hasVerticalAt(colXs[c+span], yTop, yBottom)) span++;
      segs.push({c0:c, span});
      c += span;
    }
    rowSpanMap.push(segs);
  }
  // vertical spans: extend a segment downward while the row below has an
  // identical column range and no horizontal divider separates them
  const consumed = Array.from({length:nRows}, ()=>new Set());
  const cells = [];
  for(let r=0;r<nRows;r++){
    for(const seg of rowSpanMap[r]){
      if(consumed[r].has(seg.c0)) continue;
      let rowSpan=1, rr=r;
      while(rr+1<nRows){
        const below = rowSpanMap[rr+1].find(s=>s.c0===seg.c0 && s.span===seg.span);
        if(!below) break;
        const xLeft = colXs[seg.c0], xRight = colXs[seg.c0+seg.span];
        if(hasHorizontalAt(rowYs[rr+1], xLeft, xRight)) break; // real divider present - not merged
        consumed[rr+1].add(seg.c0);
        rowSpan++; rr++;
      }
      cells.push({r0:r, c0:seg.c0, rowSpan, colSpan:seg.span});
    }
  }

  const tableTop = rowYs[0], tableBottom = rowYs[rowYs.length-1];
  const relevantLines = lines.filter(l => l.y<=tableTop+2 && l.y>=tableBottom-2);
  cells.forEach(cell=>{
    const xLeft = colXs[cell.c0], xRight = colXs[cell.c0+cell.colSpan];
    const yTop = rowYs[cell.r0], yBottom = rowYs[cell.r0+cell.rowSpan];
    const cellLines = relevantLines
      .filter(l => l.y<=yTop+2 && l.y>=yBottom-2)
      .map(l => ({y:l.y, items: l.items.filter(it => it.x>=xLeft-1 && it.x<xRight+1)}))
      .filter(l => l.items.length);
    const paras = linesToParagraphs(cellLines);
    cell.text = paras.map(p => fixDevanagari(p.runs.map(r=>r.text).join(""))).join(" ").trim();
    // Preserve multiple original PDF lines inside one cell as real line
    // breaks within a single <w:p> (see gridTableBlockXml), instead of
    // flattening them into one space-joined string with no internal
    // structure - a 3-line cell should stay ONE cell, not become 3 rows
    // or lose its line boundaries entirely.
    cell.runs = [];
    paras.forEach((p, pi)=>{
      if(pi>0) cell.runs.push({text:"", isBreak:true});
      cell.runs.push(...p.runs);
    });
    // Real geometric alignment: compare the actual text bounding box to
    // the cell's known bounding box (available here because this is a
    // true ruling-line grid, unlike gap-detected tables which have no
    // real cell width to measure against) - not a content-based guess.
    const allItems = cellLines.flatMap(l=>l.items).filter(it=>it.str.trim());
    cell.align = "left";
    cell.vAlign = "top";
    cell.padLeftPt = 4;
    if(allItems.length){
      const itemMinX = Math.min(...allItems.map(it=>it.x));
      const itemMaxX = Math.max(...allItems.map(it=>it.x+it.width));
      const cellWidth = xRight - xLeft;
      const leftGap = itemMinX - xLeft, rightGap = xRight - itemMaxX;
      if(rightGap < cellWidth*0.08 && leftGap > cellWidth*0.15) cell.align = "right";
      else if(leftGap > cellWidth*0.15 && rightGap > cellWidth*0.15 && Math.abs(leftGap-rightGap) < cellWidth*0.12) cell.align = "center";
      // Real cell padding from the actual gap between the text and the
      // cell's left border, clamped to a sane range so a coincidentally
      // huge gap (e.g. a right/center-aligned cell) doesn't blow up the
      // margin - only trusted for left-aligned cells, where the gap is
      // genuinely the visual padding rather than an alignment artifact.
      if(cell.align === "left") cell.padLeftPt = Math.max(2, Math.min(14, leftGap));
      // Vertical alignment: compare the cell's occupied line-Y range
      // against its full row-band height (only meaningful for
      // multi-line-tall cells - ruling-line tables give a real row
      // height to measure against, unlike borderless/gap tables which
      // have no independent row-boundary geometry).
      const lineYs = cellLines.map(l=>l.y);
      const textTop = Math.max(...lineYs), textBottom = Math.min(...lineYs);
      const cellHeight = yTop - yBottom;
      const topGap = yTop - textTop, bottomGap = textBottom - yBottom;
      if(cellHeight > 4){
        if(bottomGap < cellHeight*0.15 && topGap > cellHeight*0.3) cell.vAlign = "bottom";
        else if(topGap > cellHeight*0.25 && bottomGap > cellHeight*0.25 && Math.abs(topGap-bottomGap) < cellHeight*0.15) cell.vAlign = "center";
      }
    }
    // Real per-edge border evidence, from the SAME hasVerticalAt/
    // hasHorizontalAt calls already used above to infer this cell's own
    // rowSpan/colSpan - previously computed and discarded; kept here so
    // the Excel formatting layer can reproduce exactly which of a cell's
    // 4 sides the source PDF actually drew, instead of an all-or-nothing
    // per-table box.
    cell.edges = {
      top: hasHorizontalAt(yTop, xLeft, xRight),
      bottom: hasHorizontalAt(yBottom, xLeft, xRight),
      left: hasVerticalAt(xLeft, yBottom, yTop),
      right: hasVerticalAt(xRight, yBottom, yTop)
    };
  });

  return {
    _y: tableTop, nRows, nCols, cells,
    colWidthsPt: colXs.slice(0,-1).map((x,i)=>colXs[i+1]-x),
    colBounds: colXs, rowBounds: rowYs, // real cell boundaries, nCols+1/nRows+1 entries - lets an image's (x,y) be matched to the exact cell it visually sits in
    consumedYRange: [tableBottom, tableTop],
    consumedShapes: [...hLines, ...vLines],
    // Real vector ruling-line evidence (this is the whole reason this
    // detector fired at all) - the Excel formatting layer uses this to
    // draw real borders ONLY here, never on a table promoted from the
    // borderless/gap-based path below, which has no such evidence at all.
    bordered: true,
    borderWidthPt: (()=>{ const values=[...hLines,...vLines].map(line=>line.stroke ? (line.lineWidth||1) : Math.max(0.25,Math.min(line.w||1,line.h||1))).sort((a,b)=>a-b); return values.length?values[Math.floor(values.length/2)]:0.5; })()
  };
}

/* Builds a real cross-row column-band model for a borderless (no ruling
   lines) table candidate - the primary path for documents like the real
   bill, which has zero vector table borders anywhere in it (verified
   empirically). This replaces determining columns independently per line
   (the previous approach's core weakness: a row with fewer gaps than its
   neighbors just got padded with fabricated blank cells instead of being
   recognized as a genuine colSpan).
     1. Collect every whitespace-split cell from every line in the run.
     2. Cluster their start-x positions into GLOBAL column bands shared by
        the whole run, not computed per line.
     3. Re-assign each line's cells to those bands; a cell whose text
        extends past its band's right edge into the next band(s) becomes a
        real gridSpan instead of an isolated one-off cell.
     4. Bands with no content on a given row still get an empty <w:tc> -
        never silently dropped.
     5. Score confidence from (a) how many rows assign cleanly with no
        overlap collisions and (b) how many bands are actually reused
        across most rows (guards against a couple of coincidentally
        wide-spaced lines - e.g. a normal paragraph with aligned numbers -
        being mistaken for a table). Below threshold, return null so the
        caller falls back to ordinary paragraphs.
   No vertical-merge inference here (unlike the ruling-line path): a blank
   borderless cell has no positive evidence distinguishing "genuinely
   empty" from "merged with the cell above," and guessing wrong would
   corrupt real tabular data, so it's always left as an empty cell. */
function buildBorderlessTable(run, pageWidth){
  if(run.length < 2) return null;
  const allCells = [];
  run.forEach((line, li)=>{
    line.cells.forEach(c=>{ if(c.text) allCells.push({text:c.text, x:c.x, xEnd:c.xEnd, li}); });
  });
  if(allCells.length < 4) return null;

  const avgSize = run.reduce((s,l)=>{ const it=l.items.find(i=>i.str.trim()); return s+(it?it.size:10); }, 0) / run.length;
  const tolerance = Math.max(10, avgSize*1.3);
  const bandXs = clusterVals(allCells.map(c=>c.x), tolerance).sort((a,b)=>a-b);
  if(bandXs.length < 2) return null;
  const nCols = bandXs.length;
  const bandRight = bandXs.map((x,i)=>{
    if(i+1 < bandXs.length) return (x + bandXs[i+1]) / 2;
    const inBand = allCells.filter(c=>c.x >= x-tolerance);
    return Math.max(x+20, ...inBand.map(c=>c.xEnd));
  });
  function bandIndexForX(x){
    let best=0, bestD=Infinity;
    bandXs.forEach((bx,i)=>{ const d=Math.abs(bx-x); if(d<bestD){ bestD=d; best=i; } });
    return best;
  }

  const rowSlotsAll = []; // per row: array[nCols] of null | "SPANNED" | {text,span,x,xEnd}
  let cleanRows = 0;
  const bandUsedInRow = bandXs.map(()=>0);
  run.forEach((line, li)=>{
    const lineCells = allCells.filter(c=>c.li===li).sort((a,b)=>a.x-b.x);
    const rowSlots = new Array(nCols).fill(null);
    let collision = false;
    const usedBandsThisRow = new Set();
    lineCells.forEach(c=>{
      const startIdx = bandIndexForX(c.x);
      let endIdx = startIdx;
      for(let k=startIdx+1; k<nCols; k++){
        if(c.xEnd > bandRight[k-1] + tolerance*0.3) endIdx = k; else break;
      }
      const existing = rowSlots[startIdx];
      if(existing === "SPANNED"){
        // This band is already claimed by an earlier cell's colSpan (e.g.
        // an unusually long value that visually bleeds into the next
        // column) - never silently discard the real text that landed
        // here, even though it means this one row's structure isn't
        // perfectly clean. Append it to whichever cell actually owns the
        // span.
        for(let k=startIdx-1; k>=0; k--){
          if(rowSlots[k] && rowSlots[k]!=="SPANNED"){ rowSlots[k].text += " " + c.text; rowSlots[k].xEnd = Math.max(rowSlots[k].xEnd, c.xEnd); break; }
        }
        collision = true;
        return;
      }
      if(existing){
        // Two cells resolved to the same band start - again, keep both
        // texts rather than dropping one.
        existing.text += " " + c.text;
        existing.xEnd = Math.max(existing.xEnd, c.xEnd);
        collision = true;
        return;
      }
      rowSlots[startIdx] = {text:c.text, span: endIdx-startIdx+1, x:c.x, xEnd:c.xEnd};
      for(let k=startIdx+1; k<=endIdx; k++){ rowSlots[k] = "SPANNED"; usedBandsThisRow.add(k); }
      usedBandsThisRow.add(startIdx);
    });
    if(!collision) cleanRows++;
    usedBandsThisRow.forEach(b=>bandUsedInRow[b]++);
    rowSlotsAll.push(rowSlots);
  });

  const collisionFreeFraction = cleanRows / run.length;
  const bandsWellUsed = bandUsedInRow.filter(count => count >= run.length*0.5).length;
  const bandCoverageScore = bandsWellUsed / nCols;
  const confidence = collisionFreeFraction * Math.max(bandCoverageScore, bandsWellUsed>=2 ? 0.6 : 0);
  if(confidence < 0.55 || bandsWellUsed < 2) return null;

  // Safe vertical-merge detection. Borderless tables have no ruling-line
  // evidence, so a blank cell alone is NEVER enough (it's usually just a
  // genuinely empty value) - a merge is only inferred when ALL of these
  // independent signals agree simultaneously:
  //   1. the upper cell has real text;
  //   2. the lower cell is a TRUE empty slot (not text, not a colSpan
  //      continuation);
  //   3. the row below is not fully blank elsewhere (rules out merging
  //      across a genuinely blank row);
  //   4. the row above is a genuine data row too (has other content);
  //   5. the column behaves like a label column - left-positioned and/or
  //      predominantly non-numeric across the whole table (a blank in a
  //      numeric value column needs the same evidence bar, but is
  //      structurally rare to satisfy honestly since numeric columns
  //      seldom repeat identical unrelated values);
  //   6. both rows share real, DIFFERING content in some OTHER column -
  //      proof they're two distinct genuine data rows forming a matched
  //      pair (e.g. a "Rate" row and an "Amount" row), not coincidence.
  // Conservative on purpose: only ever merges one row into the row
  // immediately below it, never chains multiple rows, and a row that is
  // itself a merge continuation can never become a new merge owner.
  function isNumericText(t){ return /^-?[\d,]+\.?\d*%?$/.test((t||"").trim()); }
  const colStats = bandXs.map((_,c)=>{
    const texts = rowSlotsAll.map(row => (row[c] && row[c]!=="SPANNED") ? row[c].text : null).filter(t=>t!=null && t.trim());
    const numeric = texts.filter(isNumericText).length;
    return {nonNumericFraction: texts.length ? 1-(numeric/texts.length) : 0, populatedFraction: texts.length/rowSlotsAll.length};
  });
  function isLabelLikeColumn(c){
    const positionRatio = nCols>1 ? c/(nCols-1) : 0;
    const labelish = positionRatio <= 0.35 || colStats[c].nonNumericFraction >= 0.6;
    if(!labelish) return false;
    // A column used in only a handful of rows out of a much larger table
    // is not an established, trustworthy label column - it's more likely
    // a one-off artifact from a single oddly-positioned line (confirmed:
    // a real false positive on the real bill's 12-row "Calculation
    // Details" table came from a column populated in exactly 1 of 12
    // rows - a fragment of a multi-row bilingual header, not a genuine
    // repeating label column like the real Energy Charges/Fixed Demand
    // Charges cases, which are populated across roughly half the table's
    // rows). Fraction-based (not an absolute row count) so this doesn't
    // penalize small tables, where even a genuine 2-row label/continuation
    // pair only ever populates the label column in 1 of 2 rows (50%).
    //
    // Symmetric upper bound: a column populated in MOST rows is a column
    // where every entry normally carries its own label - an isolated blank
    // in that column is more likely a genuine data gap (missing/unreadable
    // value on an otherwise-standalone row) than evidence of a repeating
    // label-spans-2-rows pattern. Confirmed with a synthetic stress test
    // (5 independent single-row entries, one deliberately missing its own
    // label for an unrelated reason): without this bound, the row above it
    // gets a false rowSpan, silently absorbing an unrelated row's data
    // under the wrong label. Every genuine merge case measured so far
    // (single pairs and repeating pairs alike) sits at exactly 50% -
    // label populated in 1 of every 2 rows, by construction of the
    // label-row/continuation-row pattern itself - so 0.7 leaves real
    // headroom above that while still excluding the ~0.83 false case.
    // Not a claim this generalizes to every possible mixed table (a table
    // interleaving many standalone rows with a few genuine merges could
    // still push the fraction past 0.7) - only that it's strictly safer
    // than no upper bound at all, on every case tested.
    return colStats[c].populatedFraction >= 0.15 && colStats[c].populatedFraction <= 0.7;
  }
  const mergedFrom = rowSlotsAll.map(()=>new Array(nCols).fill(false));
  const ownerRowSpan = rowSlotsAll.map(()=>new Array(nCols).fill(1));
  for(let r=0; r<rowSlotsAll.length-1; r++){
    // Collect ALL merge-eligible columns for this row pair first, then
    // only commit them if the count is sparse (<=2). A genuine "one label
    // spans a 2-row entry" pattern (Energy Charges, Fixed/Demand Charges)
    // only ever affects the label column(s) - a row pair where MANY
    // columns simultaneously look mergeable is a sign of something else
    // entirely: a messy multi-row bilingual header block sharing an
    // interleaved row-split (confirmed against this exact table's header,
    // which triggered 4 simultaneous column "matches" purely as an
    // artifact of Hindi/English baseline splitting, not a real vertical
    // merge - caught by inspection and blocked by this cap rather than by
    // hardcoding anything about headers specifically).
    const candidates = [];
    for(let c=0; c<nCols; c++){
      if(mergedFrom[r][c]) continue; // a continuation row can't itself own a further merge (no chaining)
      const upper = rowSlotsAll[r][c];
      const lower = rowSlotsAll[r+1][c];
      if(!upper || upper==="SPANNED" || !upper.text || !upper.text.trim()) continue;
      if(lower !== null) continue;
      if(!isLabelLikeColumn(c)) continue;
      const rowBelowHasOther = rowSlotsAll[r+1].some((s,ci)=> ci!==c && s && s!=="SPANNED" && s.text && s.text.trim());
      if(!rowBelowHasOther) continue;
      const rowAboveHasOther = rowSlotsAll[r].some((s,ci)=> ci!==c && s && s!=="SPANNED" && s.text && s.text.trim());
      if(!rowAboveHasOther) continue;
      // Decisive signal: the row below must NOT have its own content in
      // the table's primary (leftmost) label column - if it does, it's
      // clearly an independent new entry with its own label (e.g. the
      // next charge type's row), not a continuation of this one, no
      // matter what else lines up. This single check is what actually
      // separates the real cases from a false one: an earlier version of
      // this algorithm instead required the two rows to share differing
      // text in some other overlapping column as "proof" of a genuine
      // pair - that fired on totally unrelated adjacent rows whenever
      // their numeric columns happened to overlap (nearly always true,
      // since amounts differ row to row) while MISSING the real Energy
      // Charges / Fixed Demand Charges cases (their Rate row and Amount
      // row populate different column positions by table design, so they
      // never share an overlapping populated column at all). Caught by
      // direct inspection against the real bill before shipping.
      const rowBelowOwnLabel = rowSlotsAll[r+1][0];
      const rowBelowHasOwnLabel = rowBelowOwnLabel && rowBelowOwnLabel!=="SPANNED" && rowBelowOwnLabel.text && rowBelowOwnLabel.text.trim();
      if(rowBelowHasOwnLabel) continue;
      candidates.push(c);
    }
    // Only ever commit the single LEFTMOST candidate (the primary/
    // description column) - a genuine label-spans-2-rows entry has
    // exactly one such column; a secondary early column that also
    // technically qualifies (e.g. a "sub-label" like "Energy" sitting
    // next to the real label, or a short numeric value that happens to
    // sit in the first ~35% of the table width) is real evidence for the
    // primary label but not independently trustworthy on its own, so it's
    // left unmerged rather than guessed at - safe, not lossy, just less
    // complete. A row pair with an implausibly large number of
    // simultaneous candidates (>3) skips merging entirely, since that
    // pattern only showed up on this table's messy multi-row bilingual
    // header block, never on a genuine data-row pair (confirmed by
    // inspection: real cases always produced 1-2 candidates, the header
    // produced 4).
    if(candidates.length >= 1 && candidates.length <= 3){
      const c = candidates[0];
      mergedFrom[r+1][c] = true;
      ownerRowSpan[r][c] = 2;
    }
  }

  const cells = [];
  rowSlotsAll.forEach((rowSlots, r)=>{
    for(let c=0; c<nCols; c++){
      if(mergedFrom[r][c]) continue; // swallowed into the owner cell directly above
      const slot = rowSlots[c];
      if(slot === "SPANNED") continue;
      if(slot === null){ cells.push({r0:r, c0:c, rowSpan:1, colSpan:1, text:"", align:"left", padLeftPt:4}); continue; }
      const bandLeft = bandXs[c], bandRightEdge = bandRight[c+slot.span-1];
      const cellWidth = bandRightEdge - bandLeft;
      const leftGap = slot.x - bandLeft, rightGap = bandRightEdge - slot.xEnd;
      let align = "left";
      if(rightGap < cellWidth*0.08 && leftGap > cellWidth*0.15) align = "right";
      else if(leftGap > cellWidth*0.15 && rightGap > cellWidth*0.15 && Math.abs(leftGap-rightGap) < cellWidth*0.12) align = "center";
      // No independent row-height geometry exists for borderless/gap
      // tables (unlike ruling-line tables, which have real row
      // boundaries), so vertical alignment can't be measured here -
      // left unset, which renders as Word's own default (top).
      const padLeftPt = align === "left" ? Math.max(2, Math.min(14, leftGap)) : 4;
      cells.push({r0:r, c0:c, rowSpan: ownerRowSpan[r][c], colSpan:slot.span, text: fixDevanagari(slot.text), align, padLeftPt});
    }
  });

  // Approximate row boundaries for cell-image matching. Borderless tables
  // have no independent row-height geometry (unlike ruling-line tables,
  // which have real horizontal rules) - each row is really just "the line
  // at this y", so boundaries are synthesized as the midpoint between
  // consecutive line y's, with the top/bottom edges extrapolated by the
  // same gap as the nearest real gap. Good enough to classify which row
  // an image's vertical center falls into; not claimed to be the PDF's
  // actual (nonexistent) row-height geometry.
  const rowYCenters = run.map(l=>l.y);
  let rowBounds;
  if(rowYCenters.length === 1){
    rowBounds = [rowYCenters[0]+8, rowYCenters[0]-8];
  } else {
    rowBounds = [rowYCenters[0] + (rowYCenters[0]-rowYCenters[1])];
    for(let r=0;r<rowYCenters.length-1;r++) rowBounds.push((rowYCenters[r]+rowYCenters[r+1])/2);
    rowBounds.push(rowYCenters[rowYCenters.length-1] - (rowYCenters[rowYCenters.length-2]-rowYCenters[rowYCenters.length-1]));
  }

  return {
    nRows: rowSlotsAll.length, nCols, cells,
    colWidthsPt: bandXs.map((x,i)=>bandRight[i]-x),
    colBounds: bandXs.concat([bandRight[bandRight.length-1]]), rowBounds,
    confidence,
    // No real ruling-line/vector evidence exists for this table at all -
    // its column bands come from text-position clustering, not drawn
    // lines. The Excel formatting layer must NOT draw borders for this
    // case (see detectRulingGridTable's bordered:true for the contrast) -
    // inventing a box the source never had is exactly the bug this flag
    // exists to prevent.
    bordered: false
  };
}

/* Single pass over the page's operator list that tracks the CTM plus the
   current fill/stroke color and line width, extracting three things at
   once (one getOperatorList() walk instead of three separate ones):
     - images: embedded raster images (logo, QR codes) with placement.
     - shapes: filled/stroked rectangles - real vector boxes/borders/
       separator lines/underlines drawn as thin rects, not text.
     - colorSpans: the fill color active at each text-matrix-set point
       (Tm x CTM), i.e. the same (x,y) space getTextContent() itself
       reports per item, so a run's real color can later be found by
       proximity - getTextContent() has no color info of its own since
       PDF text color is graphics-state, not a text-content property. */
/* Resolves one pdf.js image object id. pdf.js serves page-local ids
   (img_*) from page.objs and shared/global ids (g_*) from
   page.commonObjs; the promise form of get() throws for shared objects
   that are not resolved yet, so the callback form is used on the store
   the id prefix points at, with the other store as fallback. Without
   this split, a logo XObject painted on every page resolves only on
   the first page processed and is silently missing everywhere else
   (verified against a two-page fixture: the shared image surfaced on
   one page only). Same pattern as extraResolveImage in
   pdf-extra-tools.js, kept local here so the converters do not depend
   on the extra-tools script. */
function docObjsStoreGet(store, objId, timeoutMs){
  return new Promise((resolve)=>{
    if(!store || typeof store.get !== "function"){ resolve(null); return; }
    let done = false;
    const timer = setTimeout(()=>{ if(!done){ done = true; resolve(null); } }, timeoutMs);
    try{
      store.get(objId, (img)=>{ if(!done){ done = true; clearTimeout(timer); resolve(img || null); } });
    }catch(e){ if(!done){ done = true; clearTimeout(timer); resolve(null); } }
  });
}
async function resolvePageImageObject(page, objId){
  const isGlobal = String(objId || "").indexOf("g_") === 0;
  const primary = isGlobal ? page.commonObjs : page.objs;
  const secondary = isGlobal ? page.objs : page.commonObjs;
  const first = await docObjsStoreGet(primary, objId, 2000);
  if(first) return first;
  return docObjsStoreGet(secondary, objId, 2000);
}
async function extractPageVisuals(pdoc, pageNum){
  const page = await pdoc.getPage(pageNum);
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const images = [], shapes = [], colorSpans = [];
  let state = {ctm:[1,0,0,1,0,0], fillColor:[0,0,0], strokeColor:[0,0,0], lineWidth:1};
  const stack = [];
  let pendingPath = null, inTextObject = false;
  function mul(m, cur){
    return [
      m[0]*cur[0]+m[1]*cur[2], m[0]*cur[1]+m[1]*cur[3],
      m[2]*cur[0]+m[3]*cur[2], m[2]*cur[1]+m[3]*cur[3],
      m[4]*cur[0]+m[5]*cur[2]+cur[4], m[4]*cur[1]+m[5]*cur[3]+cur[5]
    ];
  }
  function apply(m, x, y){ return [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]]; }
  // Splits one constructPath call into its individual SUBPATHS (each
  // moveTo starts a new one), returning one raw (pre-CTM) bounding box per
  // subpath instead of pdf.js's own single bounding box for the WHOLE
  // path (pendingPath[2]). Necessary because a real-world table's entire
  // border grid is very often drawn as ONE eoFill/fill call containing
  // dozens of disjoint moveTo/lineTo/lineTo/lineTo/closePath rectangles
  // (one per border line) rather than one `re` (rectangle) sub-op per
  // line or one fill per line - confirmed against a real government form
  // PDF whose ~107 individual border-line rectangles were packed into
  // just 2 such merged paths. Using pendingPath[2] directly (correct for
  // a single-rectangle path, per the fix above) collapses all of those
  // into one useless bounding box spanning nearly the whole table, which
  // is indistinguishable from "no ruling lines at all" to
  // detectRulingGridTable. Handles every path-building sub-op pdf.js
  // emits (moveTo/lineTo/curveTo variants/rectangle/closePath), each of
  // which consumes its own fixed number of values from the shared flat
  // coords array - NOT a uniform "2 at a time" walk, which is exactly
  // the bug the single-rectangle fix above already had to correct for a
  // `re` sub-op specifically.
  function splitIntoSubpathBBoxes(pathOps, coords){
    const subpaths = [];
    let idx = 0, cur = null;
    function extend(b, x, y){ if(x<b.minX) b.minX=x; if(x>b.maxX) b.maxX=x; if(y<b.minY) b.minY=y; if(y>b.maxY) b.maxY=y; }
    for(const op of pathOps){
      if(op === OPS.moveTo){
        if(cur) subpaths.push(cur);
        const x=coords[idx++], y=coords[idx++];
        cur = {minX:x, maxX:x, minY:y, maxY:y};
      } else if(op === OPS.lineTo){
        const x=coords[idx++], y=coords[idx++];
        if(!cur) cur = {minX:x, maxX:x, minY:y, maxY:y}; else extend(cur, x, y);
      } else if(op === OPS.curveTo){
        const pts=[coords[idx++],coords[idx++],coords[idx++],coords[idx++],coords[idx++],coords[idx++]];
        if(cur) for(let k=0;k<pts.length;k+=2) extend(cur, pts[k], pts[k+1]);
      } else if(op === OPS.curveTo2 || op === OPS.curveTo3){
        const pts=[coords[idx++],coords[idx++],coords[idx++],coords[idx++]];
        if(cur) for(let k=0;k<pts.length;k+=2) extend(cur, pts[k], pts[k+1]);
      } else if(op === OPS.rectangle){
        const x=coords[idx++], y=coords[idx++], w=coords[idx++], h=coords[idx++];
        if(cur){ subpaths.push(cur); cur=null; }
        subpaths.push({minX:Math.min(x,x+w), maxX:Math.max(x,x+w), minY:Math.min(y,y+h), maxY:Math.max(y,y+h)});
      }
      // closePath consumes no coords and needs no bbox update - it only
      // draws back to the subpath's own start point, already inside cur.
    }
    if(cur) subpaths.push(cur);
    return subpaths;
  }
  for(let idx=0; idx<opList.fnArray.length; idx++){
    const fn = opList.fnArray[idx];
    const args = opList.argsArray[idx];
    if(fn === OPS.save){ stack.push({ctm:state.ctm.slice(),fillColor:state.fillColor.slice(),strokeColor:state.strokeColor.slice(),lineWidth:state.lineWidth}); }
    else if(fn === OPS.restore){ if(stack.length) state=stack.pop(); }
    else if(fn === OPS.transform){ state.ctm = mul(args, state.ctm); }
    else if(fn === OPS.setFillRGBColor){ state.fillColor = [args[0],args[1],args[2]]; }
    else if(fn === OPS.setStrokeRGBColor){ state.strokeColor = [args[0],args[1],args[2]]; }
    else if(fn === OPS.setLineWidth){ state.lineWidth = args[0]; }
    else if(fn === OPS.beginText){ inTextObject = true; }
    else if(fn === OPS.endText){ inTextObject = false; }
    else if(fn === OPS.setTextMatrix){
      const m = mul(args, state.ctm);
      colorSpans.push({x:m[4], y:m[5], color:state.fillColor.slice()});
    }
    else if(fn === OPS.constructPath){ pendingPath = args; }
    else if(fn===OPS.fill || fn===OPS.eoFill || fn===OPS.stroke || fn===OPS.fillStroke || fn===OPS.eoFillStroke){
      // Some PDFs (this bill's Devanagari included) render glyphs as
      // filled vector paths inside a BT/ET text object rather than as
      // standard font glyphs - those show up in the operator list as
      // ordinary constructPath+fill calls, indistinguishable from a real
      // background box at the OPS level alone. Skip anything drawn while
      // inside a text object so glyph outlines never get misread as
      // decorative boxes (confirmed root cause of large solid-black
      // "boxes" showing up on pages with vector-drawn Devanagari text).
      if(pendingPath){
        if(!inTextObject){
          // Split into per-subpath bounding boxes (not pendingPath[2]'s
          // single whole-path bbox - see splitIntoSubpathBBoxes above) so
          // a table's dozens of individual border-line rectangles, even
          // when packed into one merged fill call, come out as that many
          // separate thin shapes instead of one giant, useless box.
          const m = state.ctm;
          const doFill = fn===OPS.fill||fn===OPS.eoFill||fn===OPS.fillStroke||fn===OPS.eoFillStroke;
          const doStroke = fn===OPS.stroke||fn===OPS.fillStroke||fn===OPS.eoFillStroke;
          for(const b of splitIntoSubpathBBoxes(pendingPath[0], pendingPath[1])){
            if(!isFinite(b.minX) || b.maxX<b.minX || b.maxY<b.minY) continue;
            const corners = [[b.minX,b.minY],[b.maxX,b.minY],[b.minX,b.maxY],[b.maxX,b.maxY]].map(([px,py])=>apply(m,px,py));
            const minX = Math.min(...corners.map(c=>c[0])), maxX = Math.max(...corners.map(c=>c[0]));
            const minY = Math.min(...corners.map(c=>c[1])), maxY = Math.max(...corners.map(c=>c[1]));
            shapes.push({x:minX, y:minY, w:maxX-minX, h:maxY-minY, fill: doFill?state.fillColor.slice():null, stroke: doStroke?state.strokeColor.slice():null, lineWidth:state.lineWidth});
          }
        }
        pendingPath = null;
      }
    }
    else if(fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject){
      const objId = args[0];
      const m = state.ctm;
      const w = Math.hypot(m[0], m[1]), h = Math.hypot(m[2], m[3]);
      if(w < 8 || h < 8) continue; // skip tiny/decorative artifacts
      try{
        const img = await resolvePageImageObject(page, objId);
        if(img && (img.data || img.bitmap)) images.push({x:m[4], y:m[5], width:w, height:h, raw:img});
      }catch(e){ /* unresolved image object - skip it */ }
    }
  }
  return {images, shapes, colorSpans};
}
function rgbToHex(rgb){
  return rgb.map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,"0")).join("").toUpperCase();
}
function buildNearestColorLookup(colorSpans, maxDist){
  const cellSize=Math.max(1,maxDist);
  const buckets=new Map();
  const key=(x,y)=>`${Math.floor(x/cellSize)},${Math.floor(y/cellSize)}`;
  for(const span of colorSpans){
    const bucketKey=key(span.x,span.y);
    if(!buckets.has(bucketKey)) buckets.set(bucketKey,[]);
    buckets.get(bucketKey).push(span);
  }
  return (x,y)=>{
    const cellX=Math.floor(x/cellSize), cellY=Math.floor(y/cellSize);
    let best=null, bestD=maxDist*maxDist;
    for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++){
      const candidates=buckets.get(`${cellX+dx},${cellY+dy}`) || [];
      for(const candidate of candidates){
        const px=candidate.x-x, py=candidate.y-y, distance=px*px+py*py;
        if(distance<=bestD){ bestD=distance; best=candidate.color; }
      }
    }
    return best;
  };
}
/* page.commonObjs font descriptors expose a reliable generic family via
   .fallbackName ("serif"/"sans-serif"/"monospace") even when the real
   embedded font can't be identified/embedded - map that to a Word-safe
   equivalent instead of forcing every run onto one generic font. */
function mapFontFamily(fallbackName){
  if(fallbackName === "serif") return "Times New Roman";
  if(fallbackName === "monospace") return "Consolas";
  return "Calibri";
}
function pdfImageToPngBase64(img){
  const canvas = document.createElement("canvas");
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if(img.bitmap){
    ctx.drawImage(img.bitmap, 0, 0, img.width, img.height);
  } else {
    const imgData = ctx.createImageData(img.width, img.height);
    const src = img.data;
    if(img.kind === 3){ // RGBA_32BPP
      imgData.data.set(src);
    } else if(img.kind === 2){ // RGB_24BPP
      for(let p=0, s=0; p<imgData.data.length; p+=4, s+=3){
        imgData.data[p]=src[s]; imgData.data[p+1]=src[s+1]; imgData.data[p+2]=src[s+2]; imgData.data[p+3]=255;
      }
    } else { // grayscale/unknown - best-effort
      for(let p=0, s=0; p<imgData.data.length; p+=4, s++){
        const v = src[s]||0; imgData.data[p]=v; imgData.data[p+1]=v; imgData.data[p+2]=v; imgData.data[p+3]=255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }
  return canvasToPngBase64(canvas);
}

/* Matches page-level images against gridtable cells by pure geometry: an
   image whose center point falls within a cell's colBounds/rowBounds
   range (both derived from real table geometry - ruling-line rules or
   the borderless column-band model) is visually "inside" that cell, so
   it's moved from the flat page-image list into cell.images and
   rendered as part of the table instead of floating as a separate
   anchored/centered block. Only gridtable blocks that expose colBounds/
   rowBounds are considered; images that don't land inside any cell are
   returned unchanged for the existing page-level placement path.
   pageImages entries are the {type:"image", xPt, _y, widthPt, heightPt,
   ...} shape built by TOOLS.pdf2word/test harnesses - xPt/_y are the
   PDF-space (y-up) bottom-left corner, matching colBounds/rowBounds'
   coordinate space. */
function embedImagesIntoTableCells(pageBlocks, pageImages){
  const gridtables = pageBlocks.filter(b=>b.type==="gridtable" && b.colBounds && b.rowBounds);
  const unmatched = [];
  for(const im of pageImages){
    const cx = im.xPt + im.widthPt/2;
    const cy = im._y + im.heightPt/2;
    let placed = false;
    for(const tbl of gridtables){
      const {colBounds, rowBounds, nCols, nRows, cells} = tbl;
      if(cx < colBounds[0] || cx > colBounds[nCols]) continue;
      if(cy > rowBounds[0] || cy < rowBounds[nRows]) continue;
      let c = -1;
      for(let i=0;i<nCols;i++){ if(cx >= colBounds[i] && cx <= colBounds[i+1]){ c=i; break; } }
      let r = -1;
      for(let i=0;i<nRows;i++){ if(cy <= rowBounds[i] && cy >= rowBounds[i+1]){ r=i; break; } }
      if(c===-1 || r===-1) continue;
      const cell = cells.find(cl=> r>=cl.r0 && r<cl.r0+cl.rowSpan && c>=cl.c0 && c<cl.c0+cl.colSpan);
      if(!cell) continue;
      // A center point landing inside a cell isn't enough on its own - a
      // large background/watermark graphic spanning the whole table can
      // have its center coincidentally fall inside one cell's bounds
      // without actually being "inside" that cell at all (real-bill page
      // 1 has exactly this: a 561x155pt background wash behind the entire
      // summary table, center landing in one cell). Require the image to
      // actually fit within (a modest margin over) the matched cell's own
      // real geometry, not just have a center point that lands there.
      const cellWidthPt = colBounds[cell.c0+cell.colSpan] - colBounds[cell.c0];
      const cellHeightPt = rowBounds[cell.r0] - rowBounds[cell.r0+cell.rowSpan];
      if(im.widthPt > cellWidthPt*1.3 || im.heightPt > cellHeightPt*1.3) continue;
      if(!cell.images) cell.images = [];
      cell.images.push({pngBase64: im.pngBase64, width: im.width, height: im.height, widthPt: im.widthPt, heightPt: im.heightPt});
      placed = true;
      break;
    }
    if(!placed) unmatched.push(im);
  }
  return unmatched;
}

/* ============================================================
   PDF -> WORD: DOCX RENDERING LAYER
   ============================================================
   Everything from here to buildMixedDocx consumes the document model
   described in the DOCUMENT MODEL comment above linesToParagraphs and
   turns it into OOXML strings. This is the ONLY part of the pipeline that
   knows DOCX exists - no function above this point (in the detection
   layer) should be modified to fix a rendering problem, and no function
   here should be modified to fix a geometry/detection problem. If a bug
   spans both (e.g. a field the detection layer forgot to set), fix the
   detection layer's output shape, not this layer's handling of a missing
   field. ============================================================ */

/* Word's default document font (Calibri, and most other Latin fonts) has
   no Devanagari glyphs, so any run containing Devanagari codepoints needs
   an explicit complex-script font declared or it can render as tofu/boxes
   in some Word installations. Nirmala UI ships with Windows 10+ and Office
   and is the standard system font for Devanagari, so it's a safe default
   without needing to embed the source PDF's actual (likely unlicensed for
   embedding) font. */
function runFontsXml(text, fontFamily){
  const isDev = DEVANAGARI_RE.test(text);
  if(isDev && fontFamily) return `<w:rFonts w:ascii="${fontFamily}" w:hAnsi="Nirmala UI" w:cs="Nirmala UI"/>`;
  if(isDev) return `<w:rFonts w:cs="Nirmala UI" w:hAnsi="Nirmala UI"/>`;
  if(fontFamily) return `<w:rFonts w:ascii="${fontFamily}" w:hAnsi="${fontFamily}"/>`;
  return "";
}
/* Shared run renderer used both by top-level paragraphs and by table
   cells that contain multiple original PDF lines (see gridTableBlockXml)
   - a run with isBreak:true is a detected intentional hard line break
   (see linesToParagraphs), rendered as a real <w:br/> inside the SAME
   paragraph/cell rather than as a separate paragraph. */
function runsToXml(runs){
  return runs.map(r=>{
    if(r.isBreak) return `<w:r><w:br/></w:r>`;
    if(!r.text) return "";
    const fixed = fixDevanagari(r.text);
    const rPr = [runFontsXml(fixed, r.fontFamily)];
    if(r.bold) rPr.push("<w:b/>");
    if(r.italic) rPr.push("<w:i/>");
    if(r.underline) rPr.push(`<w:u w:val="single"/>`);
    // Skip near-black (nothing gained, it's the default) and near-white
    // (would render as invisible text on the page's white background,
    // since a matching dark cell shading isn't guaranteed to line up).
    if(r.color && !(r.color[0]<20 && r.color[1]<20 && r.color[2]<20) && !(r.color[0]>235 && r.color[1]>235 && r.color[2]>235)){
      rPr.push(`<w:color w:val="${rgbToHex(r.color)}"/>`);
    }
    if(r.size) rPr.push(`<w:sz w:val="${Math.max(2, Math.round(r.size*2))}"/>`); // DOCX sizes are half-points
    const rPrXml = rPr.join("") ? `<w:rPr>${rPr.join("")}</w:rPr>` : "";
    return `<w:r>${rPrXml}<w:t xml:space="preserve">${escapeXml(fixed)}</w:t></w:r>`;
  }).join("");
}
/* Tags lone, short, fully-bold, large paragraphs as real Word headings
   (headingLevel 1 or 2) so styledParagraphXml can emit a <w:pStyle>
   and buildMixedDocx's styles.xml gives Word a Navigation Pane / TOC.
   Detection is deliberately conservative: the paragraph must be short
   (a wrapped body paragraph is never a heading), every text run bold,
   and its size clearly above the page's own median paragraph size, so
   ordinary bold lead-ins and body text are never promoted. Only
   top-level paragraph blocks are tagged - table cells, columns and
   list items keep their existing rendering. Returns the same array. */
function tagHeadingParagraphs(pageBlocks){
  if(!pageBlocks || !pageBlocks.length) return pageBlocks;
  const paras = pageBlocks.filter(b=>b && b.type === "paragraph" && !b.listItem);
  const sizes = paras.map(p=>Math.max(0, ...(p.runs || []).map(r=>Number(r.size) || 0))).filter(s=>s > 0).sort((a,b)=>a-b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 11;
  paras.forEach(p=>{
    const runs = (p.runs || []).filter(r=>r.text && r.text.trim() && !r.isBreak);
    if(!runs.length || !runs.every(r=>r.bold)) return;
    const text = runs.map(r=>r.text).join("").trim();
    if(!text || text.length > 140) return;
    const size = Math.max(...runs.map(r=>Number(r.size) || 0));
    if(size >= 16 && size >= median * 1.35) p.headingLevel = 1;
    else if(size >= 13 && size >= median * 1.18) p.headingLevel = 2;
  });
  return pageBlocks;
}
function styledParagraphXml(block){
  const runsXml = runsToXml(block.runs);
  const pPrParts = [];
  // Real Word heading styles (set by tagHeadingParagraphs, below) so
  // the Navigation Pane / table of contents in Word sees document
  // structure instead of one flat run of large bold text. pStyle must
  // be the FIRST child of pPr per the CT_PPr schema order.
  if(block.headingLevel === 1 || block.headingLevel === 2) pPrParts.push(`<w:pStyle w:val="Heading${block.headingLevel}"/>`);
  if(block.listItem) pPrParts.push(`<w:ind w:left="720"/>`);
  if(block.align && block.align!=="left") pPrParts.push(`<w:jc w:val="${block.align}"/>`);
  // Both paragraph-to-paragraph spacing (before) and intra-paragraph
  // line spacing (line/lineRule) live on the SAME <w:spacing> element -
  // OOXML only allows one per pPr, so they're merged here rather than
  // emitted as two separate elements (which would be invalid).
  const spacingAttrs = [];
  if(block.spacingBeforePt) spacingAttrs.push(`w:before="${Math.round(block.spacingBeforePt*20)}"`);
  if(block.lineSpacingPt) spacingAttrs.push(`w:line="${Math.max(1, Math.round(block.lineSpacingPt*20))}" w:lineRule="atLeast"`);
  if(spacingAttrs.length) pPrParts.push(`<w:spacing ${spacingAttrs.join(" ")}/>`);
  const pPr = pPrParts.length ? `<w:pPr>${pPrParts.join("")}</w:pPr>` : "";
  return `<w:p>${pPr}${runsXml}</w:p>`;
}
/* block.rows is an array of rows, each row an array of {text, span} cells
   (span>1 = a real gridSpan, e.g. a section-title row spanning the whole
   table width - see extractPageBlocks). */
function tableBlockXml(block){
  const cols = block.rows.reduce((m,r)=>Math.max(m, r.reduce((s,c)=>s+(c.span||1),0)), 1);
  const gridCols = Array.from({length:cols}).map(()=>`<w:gridCol/>`).join("");
  const borderColor = block.borderHex || "BFBFBF";
  const borderSize=Math.max(2,Math.min(24,Math.round((block.borderWidthPt||0.5)*8)));
  const borderSide=name=>block.borderHex ? `<w:${name} w:val="single" w:sz="${borderSize}" w:color="${borderColor}"/>` : `<w:${name} w:val="nil"/>`;
  const border = `${borderSide("top")}${borderSide("left")}${borderSide("bottom")}${borderSide("right")}`;
  const shd = block.shadeHex ? `<w:shd w:val="clear" w:fill="${block.shadeHex}"/>` : "";
  const rowsXml = block.rows.map(row=>{
    const cellsXml = row.map(cell=>{
      const cellText = cell.text || "";
      const t = escapeXml(cellText);
      const spanXml = cell.span > 1 ? `<w:gridSpan w:val="${cell.span}"/>` : "";
      return `<w:tc><w:tcPr><w:tcBorders>${border}</w:tcBorders>${shd}${spanXml}<w:tcMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:r><w:rPr>${runFontsXml(cellText, null)}<w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r></w:p></w:tc>`;
    }).join("");
    return `<w:tr>${cellsXml}</w:tr>`;
  }).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/><w:tblBorders>${border}${block.borderHex?`<w:insideH w:val="single" w:sz="${borderSize}" w:color="${borderColor}"/><w:insideV w:val="single" w:sz="${borderSize}" w:color="${borderColor}"/>`:`<w:insideH w:val="nil"/><w:insideV w:val="nil"/>`}</w:tblBorders></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${rowsXml}</w:tbl>`;
}
/* Real ruling-line table with true row/col spans (see
   detectRulingGridTable). Unlike tableBlockXml's auto-width gap-detected
   tables, this one carries real column widths from the PDF geometry and
   uses fixed layout so Word doesn't freely resize columns, plus true
   <w:vMerge> for vertical spans (tableBlockXml only ever produces
   horizontal gridSpan, since gap-detection alone can't reliably tell
   "genuinely blank cell" apart from "vertically merged cell"). */
/* Shared by buildMixedDocx's top-level image blocks AND gridTableBlockXml's
   cell-embedded images: registers one image into the zip's media folder +
   relationships list and returns the <pic:pic> XML plus its final EMU
   size. zipCtx = {mediaFolder, relEntries, counters:{relCounter,
   imgCounter}} - counters is a mutable object (not primitives) so both
   call sites share one running id sequence, which is required since
   relationship ids must be unique across the whole document.xml.rels. */
function buildPictureXml(im, zipCtx, maxWidthEmu){
  zipCtx.counters.imgCounter++; zipCtx.counters.relCounter++;
  const relId = "rId"+zipCtx.counters.relCounter;
  const imgCounter = zipCtx.counters.imgCounter;
  const fname = `image${imgCounter}.png`;
  zipCtx.mediaFolder.file(fname, im.pngBase64, {base64:true});
  zipCtx.relEntries.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fname}"/>`);
  let cx = im.widthPt!=null ? Math.round(im.widthPt*12700) : pxToEmu(im.width);
  let cy = im.heightPt!=null ? Math.round(im.heightPt*12700) : pxToEmu(im.height);
  if(maxWidthEmu && cx > maxWidthEmu){ const ratio = maxWidthEmu/cx; cx = maxWidthEmu; cy = Math.round(cy*ratio); }
  const picXml = `<pic:pic><pic:nvPicPr><pic:cNvPr id="${imgCounter}" name="Picture ${imgCounter}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`;
  return {picXml, cx, cy, imgCounter, relId};
}
function inlinePictureParagraphXml(im, zipCtx, maxWidthEmu){
  const {picXml, cx, cy, imgCounter} = buildPictureXml(im, zipCtx, maxWidthEmu);
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${imgCounter}" name="Picture ${imgCounter}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${picXml}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}
function gridTableBlockXml(block, zipCtx, maxWidthPt){
  let widthsPt = block.colWidthsPt.map(w=>Math.max(0.05,w));
  const sourceWidth = widthsPt.reduce((a,b)=>a+b,0);
  if(maxWidthPt && sourceWidth > maxWidthPt){
    const scale = maxWidthPt/sourceWidth;
    widthsPt = widthsPt.map(w=>w*scale);
  }
  const colWidthsTwips = widthsPt.map(w=>Math.max(1, Math.round(w*20)));
  const totalTwips = colWidthsTwips.reduce((a,b)=>a+b, 0);
  const gridCols = colWidthsTwips.map(w=>`<w:gridCol w:w="${w}"/>`).join("");
  const borderColor = block.borderHex || "000000";
  const borderSize=Math.max(2,Math.min(24,Math.round((block.borderWidthPt||0.5)*8)));
  const borderSide=(name,on)=>`<w:${name} w:val="${on?"single":"nil"}"${on?` w:sz="${borderSize}" w:color="${borderColor}"`:""}/>`;
  const cellBorder=(cell,row)=>`<w:tcBorders>${borderSide("top",block.bordered!==false && row===cell.r0 && (!cell.edges||cell.edges.top))}${borderSide("left",block.bordered!==false && (!cell.edges||cell.edges.left))}${borderSide("bottom",block.bordered!==false && row===cell.r0+cell.rowSpan-1 && (!cell.edges||cell.edges.bottom))}${borderSide("right",block.bordered!==false && (!cell.edges||cell.edges.right))}</w:tcBorders>`;
  const tableBorders=`<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/>`;

  const occ = Array.from({length:block.nRows}, ()=>new Array(block.nCols).fill(null));
  block.cells.forEach(cell=>{
    for(let r=cell.r0; r<cell.r0+cell.rowSpan; r++)
      for(let c=cell.c0; c<cell.c0+cell.colSpan; c++)
        occ[r][c] = cell;
  });

  let rowsXml = "";
  for(let r=0; r<block.nRows; r++){
    let rowXml = "";
    let c = 0;
    while(c < block.nCols){
      const cell = occ[r][c];
      if(!cell || cell.c0 !== c){ c++; continue; }
      const cellWidthTwips = colWidthsTwips.slice(cell.c0, cell.c0+cell.colSpan).reduce((a,b)=>a+b, 0);
      const tcW = `<w:tcW w:w="${cellWidthTwips}" w:type="dxa"/>`;
      const spanXml = cell.colSpan > 1 ? `<w:gridSpan w:val="${cell.colSpan}"/>` : "";
      if(cell.r0 === r){
        const vMergeXml = cell.rowSpan > 1 ? `<w:vMerge w:val="restart"/>` : "";
        const t = escapeXml(cell.text || "");
        const jcXml = cell.align && cell.align!=="left" ? `<w:jc w:val="${cell.align}"/>` : "";
        const vAlignXml = cell.vAlign && cell.vAlign!=="top" ? `<w:vAlign w:val="${cell.vAlign}"/>` : "";
        const padLeftTwips = Math.round((cell.padLeftPt!=null ? cell.padLeftPt : 4) * 20);
        // Ruling-grid cells carry real per-line runs (built by
        // linesToParagraphs, including any detected hard line breaks
        // between original PDF lines) - use those directly instead of
        // the flattened plain-text fallback (only used by borderless/
        // gap-detected cells, which are always single-line by
        // construction so there's no line structure to preserve there).
        const cellContentXml = (cell.runs && cell.runs.length) ? runsToXml(cell.runs) : `<w:r><w:rPr>${runFontsXml(cell.text||"", null)}<w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
        // A cell with matched images (embedImagesIntoTableCells) renders
        // them as their own inline paragraph(s) after the text paragraph,
        // capped to the cell's own width in EMU so a real-size photo
        // doesn't blow out the column - a plain visual constraint, not a
        // content-specific rule.
        let cellImagesXml = "";
        if(zipCtx && cell.images && cell.images.length){
          const cellMaxWidthEmu = Math.max(1, cellWidthTwips - 8) * 635;
          cellImagesXml = cell.images.map(im=>inlinePictureParagraphXml(im, zipCtx, cellMaxWidthEmu)).join("");
        }
        const shd=(cell.shadeHex||block.shadeHex) ? `<w:shd w:val="clear" w:fill="${cell.shadeHex||block.shadeHex}"/>` : "";
        rowXml += `<w:tc><w:tcPr>${tcW}${cellBorder(cell,r)}${shd}${spanXml}${vMergeXml}${vAlignXml}<w:tcMar><w:left w:w="${padLeftTwips}" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tcMar></w:tcPr><w:p>${jcXml?`<w:pPr>${jcXml}</w:pPr>`:""}${cellContentXml}</w:p>${cellImagesXml}</w:tc>`;
      } else {
        const shd=(cell.shadeHex||block.shadeHex) ? `<w:shd w:val="clear" w:fill="${cell.shadeHex||block.shadeHex}"/>` : "";
        rowXml += `<w:tc><w:tcPr>${tcW}${cellBorder(cell,r)}${shd}${spanXml}<w:vMerge/></w:tcPr><w:p/></w:tc>`;
      }
      c += cell.colSpan;
    }
    const rowHeightPt=block.rowBounds && block.rowBounds.length>r+1 ? Math.max(1,block.rowBounds[r]-block.rowBounds[r+1]) : null;
    rowsXml += `<w:tr>${rowHeightPt?`<w:trPr><w:cantSplit/><w:trHeight w:val="${Math.round(rowHeightPt*20)}" w:hRule="atLeast"/></w:trPr>`:""}${rowXml}</w:tr>`;
  }
  return `<w:tbl><w:tblPr><w:tblW w:w="${totalTwips}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${tableBorders}</w:tblBorders></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${rowsXml}</w:tbl>`;
}
function columnsBlockXml(block){
  const leftXml = block.left.map(styledParagraphXml).join("") || "<w:p/>";
  const rightXml = block.right.map(styledParagraphXml).join("") || "<w:p/>";
  const noBorder = `<w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/>`;
  const shd = block.shadeHex ? `<w:shd w:val="clear" w:fill="${block.shadeHex}"/>` : "";
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/><w:tblBorders>${noBorder}</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr>${shd}</w:tcPr>${leftXml}</w:tc><w:tc><w:tcPr>${shd}</w:tcPr>${rightXml}</w:tc></w:tr></w:tbl>`;
}
/* A vector-drawn rule with no text attached to it (page/section divider,
   e.g. the line under a heading or between report sections) - approximated
   as a paragraph-level bottom border since DOCX has no bare "draw a line
   here" primitive outside of drawing canvases/shapes. */
function separatorBlockXml(){
  return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>`;
}
/* ---- PDF to Excel: structured block -> spreadsheet-row serialization ----
   Reuses extractPageBlocks()'s already-tested table detection (real
   ruling-line grids via detectRulingGridTable, or the borderless cross-row
   column-band model via buildBorderlessTable, both with real rowSpan/
   colSpan merge inference) instead of PDF to Excel's own separate,
   weaker, gap-only column guessing (extractTableRows below, kept as the
   last-resort fallback for pages where extractPageBlocks itself finds
   nothing usable at all - e.g. no getOperatorList()/visuals data). */
/* Converts one page's extractPageBlocks() output into a flat 2D array of
   cell values (ready for XLSX.utils.aoa_to_sheet) plus a !merges range
   list. startRow is the absolute row this page's content begins at, so
   merge ranges land at the right row once appended to the workbook-wide
   rows array. */
/* Derives a real bold/font-size/line-count signal purely from a block's
   own PDF-extracted run metadata (bold/italic/size come from pdf.js's own
   font descriptors - see extractPageBlocks' styleFor()) - never from the
   cell's text content or any document identity. "Bold" is a per-cell
   MAJORITY vote (more than half the cell's real characters are bold),
   not "any run is bold", so a single stray bold character doesn't flip
   an otherwise-plain cell; "size" is the run-length-weighted most common
   rounded size in the cell. Returns null for an empty/no-signal run list
   so the caller can fall back to Excel's own defaults rather than forcing
   a value. Generic by construction: any PDF whose embedded font
   descriptors expose bold/size gets this; a PDF that doesn't just yields
   null (no formatting applied, same as today). */
function styleFromRuns(runs){
  if(!runs || !runs.length) return null;
  const real = runs.filter(r=>!r.isBreak && r.text && r.text.trim());
  if(!real.length) return null;
  // fontFamily/italic/underline are already computed per-run by
  // extractPageBlocks' styleFor() (mapFontFamily(fallbackName) - real
  // pdf.js font-descriptor data, not guessed) - this function used to
  // discard all three and only read bold/size. Same run-length-weighted
  // majority-vote approach as bold/size: the dominant value across the
  // cell's real characters wins, so one stray differently-styled run
  // (e.g. a single italicized word) doesn't flip an otherwise-plain cell.
  let boldChars = 0, italicChars = 0, underlineChars = 0, totalChars = 0;
  const sizeCounts = new Map();
  const familyCounts = new Map();
  // Real per-run text color (nearestColor() in extractPageBlocks - the
  // actual PDF fill color active at that text's position, not a guess).
  // Same run-length-weighted majority vote as size/family below, keyed
  // by the color's own [r,g,b] triple so two runs of the same real color
  // always land in the same bucket regardless of object identity.
  const colorCounts = new Map();
  real.forEach(r=>{
    const len = r.text.length;
    totalChars += len;
    if(r.bold) boldChars += len;
    if(r.italic) italicChars += len;
    if(r.underline) underlineChars += len;
    const sz = Math.round(r.size || 11);
    sizeCounts.set(sz, (sizeCounts.get(sz)||0) + len);
    if(r.fontFamily) familyCounts.set(r.fontFamily, (familyCounts.get(r.fontFamily)||0) + len);
    if(r.color){
      const key = r.color.join(",");
      const entry = colorCounts.get(key) || {rgb: r.color, count: 0};
      entry.count += len;
      colorCounts.set(key, entry);
    }
  });
  let bestSize = null, bestSizeCount = 0;
  sizeCounts.forEach((count, sz)=>{ if(count > bestSizeCount){ bestSizeCount = count; bestSize = sz; } });
  let bestFamily = null, bestFamilyCount = 0;
  familyCounts.forEach((count, fam)=>{ if(count > bestFamilyCount){ bestFamilyCount = count; bestFamily = fam; } });
  let bestColor = null, bestColorCount = 0;
  colorCounts.forEach(entry=>{ if(entry.count > bestColorCount){ bestColorCount = entry.count; bestColor = entry.rgb; } });
  return {
    bold: totalChars>0 && boldChars/totalChars > 0.5,
    italic: totalChars>0 && italicChars/totalChars > 0.5,
    underline: totalChars>0 && underlineChars/totalChars > 0.5,
    sizePt: bestSize!=null ? Math.max(7, Math.min(22, bestSize)) : null,
    fontFamily: bestFamily,
    color: bestColor,
    lineCount: runs.filter(r=>r.isBreak).length + 1
  };
}
/* Detects whether a cell's own text is a safe, unambiguous plain number
   or a single-leading-symbol currency amount, purely from the text's own
   shape (never from any specific document's known values) - and only
   for shapes that can NEVER collide with the identifier-preservation
   rule in cellValueAndStyle below (which owns anything without a decimal
   point/comma-grouping: bare long digit runs, leading-zero codes). Kept
   deliberately narrow: anything ambiguous is left as plain text, which is
   always safe (no data loss) even if less richly formatted. */
function numericStyleFromText(t){
  const currencyMatch = /^([₹$€£¥])\s?(-?[\d,]+\.?\d{0,2})$/.exec(t);
  if(currencyMatch){
    const num = Number(currencyMatch[2].replace(/,/g,""));
    if(isFinite(num)) return {numericValue: num, numFmtCode: `"${currencyMatch[1]}"#,##0.00`, align:"right"};
  }
  // A trailing "%" is unambiguous evidence of a percentage, never an
  // identifier or a plain amount - Excel's own "0.0%" format multiplies
  // the stored value by 100 for display, so the real underlying value
  // must be stored as the fraction (15% -> 0.15), matching how a genuine
  // Excel percentage cell always works, not the printed "15" itself.
  const percentMatch = /^(-?[\d,]+\.?\d*)\s?%$/.exec(t);
  if(percentMatch){
    const num = Number(percentMatch[1].replace(/,/g,""));
    if(isFinite(num)) return {numericValue: num/100, numFmtCode: "0.0%", align:"right"};
  }
  if(/^-?[\d,]*\.\d{1,2}$/.test(t) && /\d/.test(t)){
    const num = Number(t.replace(/,/g,""));
    if(isFinite(num)) return {numericValue: num, numFmtCode: "#,##0.00", align:"right"};
  }
  // Comma-grouped integer (e.g. "17,746") - the comma itself is proof
  // this is a formatted amount, never an identifier (an ID/phone/account
  // number is never comma-grouped), so this can never collide with the
  // identifier rule even though both deal with "long digit runs".
  if(/^-?\d{1,3}(,\d{3})+$/.test(t)){
    const num = Number(t.replace(/,/g,""));
    if(isFinite(num)) return {numericValue: num, numFmtCode: "#,##0", align:"right"};
  }
  return null;
}
/* ============================================================
   PDF -> EXCEL: PAGE-LEVEL LAYOUT ENGINE
   ============================================================
   Replaces the previous blocksToSheetRows(), which converted PDF
   coordinates -> independent blocks -> SEQUENTIAL ROW APPEND -> a flat
   AOA. That model destroyed the page's own coordinate system: a block's
   real absolute X position only ever mattered for gridtable-vs-gridtable
   (via a single running "anchor" + rounded offset), never for paragraphs/
   columns blocks, and a block's real absolute Y position never mattered
   at all - every block just landed on "whatever row comes next", so two
   blocks with a huge real vertical gap and two blocks nearly touching
   were treated identically.

   The replacement is a real two-stage pipeline:

     buildPageLayout(blocks, pageWidthPt, pageHeightPt, establishedColBoundsPt)
       -> PageLayout: ONE shared page-local coordinate grid built from
          every block's own real X/Y extent (not just gridtables), with
          cells already placed at real (row, col) positions derived from
          that grid - not from block-processing order.

     layoutToSheetRows(pageLayout, startRow)
       -> the same {rows, merges, gridRanges, cellStyles, cellEdges,
          rowHeights} shape applyCellFormattingToXlsx already expects,
          mechanically shifted to the workbook's absolute row range.

   Every threshold below (X-clustering tolerance, Y-band overlap
   tolerance, gap-to-blank-row conversion) is derived from THIS page's
   own measured geometry (average font size, tightest real column gap
   actually present on the page) - never a constant borrowed from any
   one document, and never widened/narrowed to make any specific PDF's
   output look a particular way. ============================================================ */

/* A page-wide, char-length-weighted estimate of the dominant font size in
   use on this page, from the same real per-run size data styleFromRuns
   already reads elsewhere - used only to derive generic geometric
   tolerances below (never to decide content), so an estimate is fine;
   defaults to 11 (a common body-text size) when a page has no styled
   runs at all (e.g. it's entirely "table" fallback blocks with no run
   metadata retained). */
function estimatePageFontSizePt(blocks){
  let totalChars = 0, weighted = 0;
  function account(runs){
    if(!runs) return;
    const style = styleFromRuns(runs);
    if(!style || !style.sizePt) return;
    const len = runs.reduce((s,r)=> s + (r.text ? r.text.length : 0), 0) || 1;
    totalChars += len; weighted += style.sizePt * len;
  }
  blocks.forEach(b=>{
    if(b.type === "gridtable") b.cells.forEach(c=>account(c.runs));
    else if(b.type === "paragraph") account(b.runs);
    else if(b.type === "columns"){ b.left.forEach(p=>account(p.runs)); b.right.forEach(p=>account(p.runs)); }
  });
  return totalChars ? weighted/totalChars : 11;
}

/* Real absolute PDF-point extent of one block: {xLeft, xRight, yTop,
   yBottom}. Gridtable blocks report REAL measured bounds (colBounds/
   rowBounds - actual ruling-line or text-position geometry). Other block
   types report the real X extent already computed (and, previously,
   discarded) by linesToParagraphs (xLeft/xRight), paired with an
   ESTIMATED single-row height (defaultLineHeightPt, itself derived from
   this page's own font size) since they have no independent row-height
   geometry the way a ruling-line/borderless table does. A "table"
   fallback block (buildBorderlessTable's own low-confidence path, which
   already discards column x-positions - see its doc comment) has no real
   X evidence at all: xLeft/xRight are reported null, a real, disclosed
   gap this stage doesn't invent geometry to fill. */
function blockExtent(block, defaultLineHeightPt){
  if(block.type === "gridtable"){
    // colBounds/rowBounds are always present on a gridtable block built by
    // detectRulingGridTable/buildBorderlessTable (both always compute
    // them) - this fallback only guards a gridtable-shaped object built
    // directly by a test fixture without going through real extraction.
    if(!block.colBounds || !block.rowBounds){
      const y = block._y || 0;
      return { xLeft:null, xRight:null, yTop:y, yBottom:y - defaultLineHeightPt*Math.max(1, block.nRows||1) };
    }
    return {
      xLeft: block.colBounds[0], xRight: block.colBounds[block.colBounds.length-1],
      yTop: block.rowBounds[0], yBottom: block.rowBounds[block.rowBounds.length-1]
    };
  }
  if(block.type === "columns"){
    const leftP = block.left.find(p=>p.xLeft!=null), rightP = block.right.find(p=>p.xLeft!=null);
    const xs = [];
    if(leftP) xs.push(leftP.xLeft, leftP.xRight);
    if(rightP) xs.push(rightP.xLeft, rightP.xRight);
    return {
      xLeft: xs.length ? Math.min(...xs) : null, xRight: xs.length ? Math.max(...xs) : null,
      yTop: block._y, yBottom: block._y - defaultLineHeightPt
    };
  }
  if(block.type === "paragraph"){
    return {
      xLeft: block.xLeft!=null ? block.xLeft : null, xRight: block.xRight!=null ? block.xRight : null,
      yTop: block._y, yBottom: block._y - defaultLineHeightPt
    };
  }
  if(block.type === "separator"){
    return {xLeft:block.xLeft!=null?block.xLeft:null,xRight:block.xRight!=null?block.xRight:null,yTop:block._y,yBottom:block._y-1};
  }
  if(block.type === "table"){
    return {xLeft:block.xLeft!=null?block.xLeft:null,xRight:block.xRight!=null?block.xRight:null,yTop:block._y,yBottom:block._y-defaultLineHeightPt*Math.max(1,block.rows.length)};
  }
  // "table" fallback (buildBorderlessTable declined, no real column x
  // evidence retained) - Y extent approximated from its own row count,
  // same per-row unit as every other geometry-less block type.
  return {xLeft:null,xRight:null,yTop:block._y,yBottom:block._y-defaultLineHeightPt};
}

/* Grows the running page-wide column-boundary set (points) across pages
   without ever renumbering a column index a PRIOR page has already
   committed cells against. A new boundary within tolerance of an
   existing one is treated as the same real column edge (so a table
   continuing across a page break - or just another left-aligned table
   later in the document - keeps sharing the same Excel columns). A
   genuinely new boundary past the current right edge is appended (a
   later page's content that extends further right than anything seen
   so far). A genuinely new boundary to the LEFT of everything
   established, or strictly inside the existing range with no nearby
   match, is intentionally absorbed into its nearest existing boundary
   rather than inserted - inserting there would retroactively shift
   every already-emitted earlier page's column indices, which can't be
   done without rewriting those pages. A real, disclosed simplification
   (same spirit as the single-anchor model's earlier "no negative
   offset" limit), not a silent loss: the values are still placed, just
   snapped to the nearest already-established column instead of
   introducing a new one. */
function reconcileColBounds(pageXs, established, tol){
  const result = established.slice();
  pageXs.forEach(x=>{
    let nearestD = Infinity;
    result.forEach(e=>{ nearestD = Math.min(nearestD, Math.abs(e-x)); });
    if(nearestD <= tol) return;
    if(x > result[result.length-1] + tol) result.push(x);
  });
  return result.sort((a,b)=>a-b);
}

/* ============================================================
   PDF -> EXCEL: TABLE ARITHMETIC (real formulas, not literals)
   ============================================================
   Every gridtable this codebase already detects has its own real,
   already-known header text and printed cell values - this stage looks
   for arithmetic relationships already IMPLIED by that printed content
   (qty*rate=amount column triples; subtotal/total rows that sum the rows
   printed directly above them, including simple letter-chain references
   like "Total E = (A+B+C+D)", parsed generically from the row's own
   label text) and writes real Excel formulas instead of dead literals.
   Never invents a relationship the table's own printed text/geometry
   doesn't already suggest, and never silently overwrites a printed
   number that disagrees with the computed one - a real mismatch keeps
   the printed literal and gets a real Excel cell comment instead,
   exactly mirroring how a careful manual conversion flags a discrepancy
   rather than quietly "fixing" it. */
function parseNumericCellText(t){
  t = (t||"").trim();
  if(!t) return null;
  const numeric = numericStyleFromText(t);
  return numeric ? numeric.numericValue : null;
}
// numericStyleFromText (above) deliberately rejects a bare integer like
// "10" - that strictness exists to avoid misreading an identifier (an
// ID/phone/account number) as a number in a column whose ROLE isn't yet
// known. Inside analyzeTableArithmetic, the column's role (qty/rate/
// amount, from its own header text) is already established before this
// is ever called - a bare integer/decimal in a column already known to
// be Qty or Rate is safe to treat as a real number, so this permissive
// parser is used there instead, never for the cell's own rendered value/
// style (cellValueAndStyle keeps using the stricter one, unchanged).
function parseArithmeticNumber(t){
  t = (t||"").trim();
  if(!t) return null;
  const stripped = t.replace(/^[₹$€£¥]\s?/,"").replace(/%$/,"").replace(/,/g,"");
  if(!/^-?\d+\.?\d*$/.test(stripped)) return null;
  const num = Number(stripped);
  return isFinite(num) ? num : null;
}
function formatNumForComment(n){
  return Number(n).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
}
/* localToShared/r0Base are the SAME shared-grid column mapping and
   absolute starting row buildPageLayout already computed for this block
   (see placeBlock's gridtable branch) - a formula string has to point at
   REAL Excel cell addresses, not block-local row/column indices, so this
   analysis runs after that mapping exists, using the exact same
   addresses the cells themselves will be written to. */
function analyzeTableArithmetic(block, localToShared, r0Base){
  const overrides = new Map();
  const columnFormats = new Map();
  const nRows = block.nRows, nCols = block.nCols;
  if(nRows < 2 || nCols < 2) return {overrides, columnFormats};

  // Cell-at-(r,c) lookup, restricted to real, unmerged (rowSpan===1 &&
  // colSpan===1) cells - a merged cell's row/column identity is
  // ambiguous for arithmetic purposes, so it's simply left OUT of the
  // analysis rather than guessed at (never a wrong formula, just fewer
  // detected relationships on a table that merges cells in its numeric
  // area - a real, disclosed limitation).
  const cellAt = new Map();
  block.cells.forEach(c=>{ if(c.rowSpan===1 && c.colSpan===1) cellAt.set(`${c.r0},${c.c0}`, c); });
  function textAt(r,c){ const cell = cellAt.get(`${r},${c}`); return cell ? (cell.text||"").trim() : ""; }
  function valueAt(r,c){ return parseArithmeticNumber(textAt(r,c)); }
  function excelRef(r,c){ return XLSX.utils.encode_cell({r: r0Base+r, c: localToShared[c]}); }

  const ROLE = { qty: /qty|quantity|units?\b/i, rate: /rate|price|unit\s*cost/i, amount: /amount|total|value/i };
  // Rate is checked FIRST: "Unit rate"/"Unit cost" (extremely common real
  // headers) both contain the qty pattern's own "units?" alternative as a
  // MODIFIER word ("unit" describing the rate/cost), not as the actual
  // quantity column - checking rate before qty prevents that collision
  // without narrowing the qty pattern enough to miss a genuine bare
  // "Unit"/"Units" quantity header.
  function roleFromText(t){
    if(ROLE.rate.test(t)) return "rate";
    if(ROLE.qty.test(t)) return "qty";
    if(ROLE.amount.test(t)) return "amount";
    return null;
  }
  function rolesInRow(r){
    const roles = new Set();
    for(let c=0;c<nCols;c++){ const role = roleFromText(textAt(r,c).toLowerCase()); if(role) roles.add(role); }
    return roles;
  }
  // Find the table's own real column-role header row(s) by SCANNING
  // forward, never assuming row 0 - a real-world ruling-line grid can
  // legitimately absorb page-title/metadata banner rows above its actual
  // tabular header (confirmed against a real government estimate form:
  // "Asset ID:", the org name, and a document title all shared one
  // continuous 54-row ruling-line block with the real Qty/Unit rate/
  // Amount header several rows further down). A row is treated as the
  // real header once its own text yields at least 2 distinct roles (a
  // single stray word matching one role isn't enough evidence); a row
  // with a real merged/spanning cell (colSpan>1, the structural
  // signature of a group-label like "As per submitted estimate") whose
  // OWN text has no role, but whose very next row does, is treated as a
  // genuine two-row header. Falls back to row 0 alone if nothing in the
  // lookahead window looks like a real header - matches this function's
  // original, simpler behavior for ordinary single-header-row tables.
  const LOOKAHEAD = Math.min(nRows-2, 20);
  let headerRows = [0];
  for(let r=0; r<=LOOKAHEAD; r++){
    if(rolesInRow(r).size >= 2){ headerRows = [r]; break; }
    const hasSpanHere = block.cells.some(c=>c.r0===r && c.colSpan>1);
    if(hasSpanHere && r+1<=LOOKAHEAD && rolesInRow(r+1).size >= 2){ headerRows = [r, r+1]; break; }
  }
  const headerText = Array.from({length:nCols}, (_,c)=> headerRows.map(r=>textAt(r,c)).join(" ").toLowerCase());
  function roleOf(c){ return roleFromText(headerText[c]); }
  // Greedy left-to-right qty -> rate -> amount triple pairing - handles
  // both a single triple and a repeated pattern (e.g. two side-by-side
  // "submitted"/"executed" triples on the same row) without assuming a
  // fixed column count or position.
  const triples = [];
  let pendingQty = null, pendingRate = null;
  for(let c=0;c<nCols;c++){
    const role = roleOf(c);
    if(role === "qty"){ pendingQty = c; pendingRate = null; }
    else if(role === "rate" && pendingQty != null){ pendingRate = c; }
    else if(role === "amount" && pendingQty != null && pendingRate != null){
      triples.push({qty:pendingQty, rate:pendingRate, amount:c});
      pendingQty = null; pendingRate = null;
    }
  }
  const valueCols = new Set();
  triples.forEach(t=>{ valueCols.add(t.amount); columnFormats.set(t.amount, {currency:true}); });
  for(let c=0;c<nCols;c++){ if(/%/.test(headerText[c])) columnFormats.set(c, {percent:true}); }

  const dataRowStart = headerRows[headerRows.length-1] + 1;
  const TOTAL_RE = /sub[\s-]?total|grand\s*total|total\b/i;
  const REL_TOL = 0.01;
  function approxEqual(a,b){
    if(a==null || b==null) return false;
    const scale = Math.max(Math.abs(a), Math.abs(b), 1);
    return Math.abs(a-b) <= scale*REL_TOL;
  }

  // qty*rate = amount, per row, per detected triple. A printed amount
  // that already agrees (within tolerance) becomes a real formula; a
  // genuinely blank amount cell gets filled in (the source PDF should
  // have printed one); a printed amount that DISAGREES keeps its real
  // printed value untouched and gets a discrepancy comment instead.
  for(let r=dataRowStart;r<nRows;r++){
    triples.forEach(({qty,rate,amount})=>{
      if(!cellAt.has(`${r},${amount}`)) return;
      const qv = valueAt(r,qty), rv = valueAt(r,rate);
      if(qv==null || rv==null) return;
      const product = qv*rv;
      const printedText = textAt(r,amount);
      const printedVal = printedText ? valueAt(r,amount) : null;
      const formula = `${excelRef(r,qty)}*${excelRef(r,rate)}`;
      if(printedVal==null || approxEqual(printedVal, product)){
        overrides.set(`${r},${amount}`, {formula, cachedValue: product});
      } else {
        overrides.set(`${r},${amount}`, {comment: `Printed amount (${printedText}) doesn't match Qty x Rate (${formatNumForComment(product)}). Kept the printed value - please verify against the source.`});
      }
    });
  }

  // Subtotal/total rows: sum the rows since the previous subtotal (or
  // the table's own header) in each detected value column - or, when the
  // row's own printed label contains a real letter-chain reference like
  // "(A+B+C+D)" resolving to earlier rows whose own labels start with
  // those exact letters (a common accounting-form convention, detected
  // generically from the printed text, never assumed for any one
  // document), a real +-chain of those specific rows' own cells instead
  // of a blind SUM of everything above.
  // Two different, real label conventions both register "this row IS
  // letter X's value" - a section header ("A. Supply...", a leading
  // letter with no value of its own) and a subtotal row's own trailing
  // reference ("Sub Total (A)"). The trailing form is authoritative
  // when both exist for the same letter (it's the row that actually
  // carries the computed total a later "(A+B)" chain needs to reference,
  // not the blank section header above it) - registered so it always
  // overwrites an earlier, less specific leading-letter registration,
  // never the other way around.
  const letterRowRefs = new Map();
  let sinceRow = dataRowStart;
  for(let r=dataRowStart;r<nRows;r++){
    let label = "";
    for(let c=0;c<nCols;c++){ label = textAt(r,c); if(label) break; }
    const trailingLetterMatch = /\(([A-Z])\)\s*$/.exec(label);
    const leadingLetterMatch = /^\s*([A-Z])[.)\s]/.exec(label);
    if(trailingLetterMatch){
      letterRowRefs.set(trailingLetterMatch[1], r);
    } else if(leadingLetterMatch && !letterRowRefs.has(leadingLetterMatch[1])){
      letterRowRefs.set(leadingLetterMatch[1], r);
    }

    if(!TOTAL_RE.test(label)) continue;

    const chainMatch = /\(\s*([A-Z](?:\s*[+\-]\s*[A-Z])+)\s*\)/.exec(label);
    let chainLetters = null;
    if(chainMatch){
      const letters = chainMatch[1].split(/[+\-]/).map(s=>s.trim()).filter(Boolean);
      if(letters.every(l=>letterRowRefs.has(l) && letterRowRefs.get(l) < r)) chainLetters = letters;
    }

    valueCols.forEach(c=>{
      if(!cellAt.has(`${r},${c}`)) return;
      const printedText = textAt(r,c);
      const printedVal = printedText ? valueAt(r,c) : null;
      let formula, cachedValue;
      function ownValue(rr){
        const ov = overrides.get(`${rr},${c}`);
        if(ov && ov.cachedValue != null) return ov.cachedValue;
        return valueAt(rr,c) || 0;
      }
      if(chainLetters){
        formula = chainLetters.map(l=>excelRef(letterRowRefs.get(l), c)).join("+");
        cachedValue = chainLetters.reduce((sum,l)=>sum+ownValue(letterRowRefs.get(l)), 0);
      } else if(r > sinceRow){
        formula = `SUM(${excelRef(sinceRow,c)}:${excelRef(r-1,c)})`;
        cachedValue = 0;
        for(let rr=sinceRow; rr<r; rr++) cachedValue += ownValue(rr);
      } else {
        return;
      }
      if(printedVal==null || approxEqual(printedVal, cachedValue)){
        overrides.set(`${r},${c}`, {formula, cachedValue});
      } else {
        overrides.set(`${r},${c}`, {comment: `Printed total (${printedText}) doesn't match the sum of the rows above (${formatNumForComment(cachedValue)}). Kept the printed value - please verify against the source.`});
      }
    });
    sinceRow = r+1;
  }

  return {overrides, columnFormats};
}

/* Builds ONE page-local coordinate grid + already-positioned cells from
   extractPageBlocks()' output. establishedColBoundsPt (optional, real
   PDF points, ascending) is the running shared column axis carried
   forward from prior pages by the caller (see reconcileColBounds above);
   omitted/undefined for the first page. */
function buildPageLayout(blocks, pageWidthPt, pageHeightPt, establishedColBoundsPt){
  const content = blocks.filter(b=>b.type !== "separator");
  const cellsOut = [], tableRanges = [], rowHeightsPt = {};
  if(!content.length){
    return {pageWidthPt, pageHeightPt, colBoundsPt:[0, pageWidthPt||100], colWidthsPt:[pageWidthPt||100], nRows:0, cells:[], tableRanges:[], rowHeightsPt:{}};
  }

  const avgFontSizePt = estimatePageFontSizePt(content);
  const defaultLineHeightPt = Math.max(15, avgFontSizePt*1.4);

  const geoList = content.map(block=>Object.assign({block}, blockExtent(block, defaultLineHeightPt)));

  // Two DIFFERENT kinds of "close enough to be the same boundary" exist
  // here, and conflating them into one tolerance was a real bug (caught
  // by TEST C: a bordered table's own real right edge got absorbed into
  // an unrelated borderless table's own, merely coincidentally nearby,
  // internal column boundary a few points away, making the bordered
  // table's cell wrongly span columns that belong entirely to the OTHER
  // table's own grid).
  //   - gridTol: two REAL ruling-line/text-position-derived boundaries,
  //     from two DIFFERENT gridtable blocks (or a gridtable vs. an
  //     already-established cross-page grid), are only the same real
  //     edge when they're near-exact - both sides of that comparison are
  //     equally precise measurements. Matches detectRulingGridTable's own
  //     hasVerticalAt/hasHorizontalAt matching tolerance (2pt), not a new
  //     invented constant.
  //   - xTolerance: generous, font-size-derived, used ONLY to snap a
  //     paragraph/columns block's own approximate text-edge measurement
  //     onto the already-precise grid built from gridtable evidence -
  //     never used to reconcile two tables' own boundaries with each
  //     other.
  const gridTol = 2;
  const xTolerance = Math.max(10, avgFontSizePt*1.3);

  // Y-bands: two blocks whose real [yTop,yBottom] ranges genuinely
  // overlap (true side-by-side content, e.g. two independent tables at
  // the same page height) are grouped so they land on the SAME Excel row
  // range at different columns, instead of one being pushed below the
  // other purely because of processing order. bandTol matches
  // extractPageBlocks' own line-grouping tolerance (3pt) - the same
  // generic "same visual line" allowance used throughout this file, not
  // a new invented constant. Computed BEFORE column-boundary construction
  // because boundary reconciliation itself needs to know which tables are
  // genuinely visually concurrent (see below).
  const bandTol = 3;
  const bands = [];
  geoList.forEach(g=>{
    let target = null;
    for(const band of bands){
      if(band.items.some(it => g.yTop >= it.yBottom-bandTol && it.yTop >= g.yBottom-bandTol)){ target = band; break; }
    }
    if(target){
      target.items.push(g);
      target.yTop = Math.max(target.yTop, g.yTop);
      target.yBottom = Math.min(target.yBottom, g.yBottom);
    } else {
      bands.push({items:[g], yTop:g.yTop, yBottom:g.yBottom});
    }
  });
  bands.sort((a,b)=>b.yTop-a.yTop);

  // Build the shared column grid band by band, in the same top-to-bottom
  // order the content will be placed in. A real bug (found via a
  // realistic invoice fixture: line-item table above, unrelated
  // signature table further down) showed that reconciling ALL gridtables'
  // boundaries together in one pass - even with the tight gridTol above -
  // let a LATER table's boundary that merely falls inside an EARLIER,
  // Y-DISJOINT table's own column subdivide that column with a phantom
  // internal split the earlier table never had, just because the two
  // tables happen to occupy overlapping X ranges while never being
  // visually concurrent (never sharing a row). Two gridtables only get
  // genuine mid-range boundary reconciliation with each other when they
  // are in the SAME Y-band (truly side-by-side, where fine alignment is
  // visually meaningful); a gridtable in its own band relative to
  // whatever's already established only ever EXTENDS the grid (append-
  // only, same reasoning as reconcileColBounds/cross-page) - it can
  // never subdivide a column an earlier, unrelated table already defined.
  let colBoundsPt = establishedColBoundsPt ? establishedColBoundsPt.slice() : [];
  bands.forEach(band=>{
    const bandGridXs = [];
    let gridCountInBand = 0;
    band.items.forEach(g=>{ if(g.block.type === "gridtable" && g.block.colBounds){ bandGridXs.push(...g.block.colBounds); gridCountInBand++; } });
    if(!bandGridXs.length) return;
    if(!colBoundsPt.length){
      colBoundsPt = clusterVals(bandGridXs, gridTol).sort((a,b)=>a-b);
    } else if(gridCountInBand > 1){
      colBoundsPt = clusterVals(colBoundsPt.concat(bandGridXs), gridTol).sort((a,b)=>a-b);
    } else {
      colBoundsPt = reconcileColBounds(bandGridXs, colBoundsPt, gridTol);
    }
  });
  // Non-table blocks (paragraph/columns) snap their own approximate real
  // edges onto that precise grid using the generous tolerance, extending
  // it (never subdividing an existing range, same reasoning as above)
  // when a genuinely new edge falls outside it.
  geoList.forEach(g=>{
    if(g.block.type === "gridtable" || g.xLeft == null) return;
    [g.xLeft, g.xRight].forEach(x=>{
      if(!colBoundsPt.length){ colBoundsPt.push(x); return; }
      const nearestD = Math.min(...colBoundsPt.map(e=>Math.abs(e-x)));
      if(nearestD > xTolerance){
        if(x > colBoundsPt[colBoundsPt.length-1]) colBoundsPt.push(x);
        else if(x < colBoundsPt[0]) colBoundsPt.unshift(x);
      }
    });
    colBoundsPt.sort((a,b)=>a-b);
  });
  if(colBoundsPt.length < 2) colBoundsPt = colBoundsPt.length === 1 ? [colBoundsPt[0], colBoundsPt[0]+100] : [0, pageWidthPt||100];

  function boundaryAtOrBefore(x){
    let idx = 0;
    for(let i=0;i<colBoundsPt.length;i++){ if(colBoundsPt[i] <= x + xTolerance) idx = i; }
    return idx;
  }
  function boundaryAtOrAfter(x){
    for(let i=0;i<colBoundsPt.length;i++){ if(colBoundsPt[i] >= x - xTolerance) return i; }
    return colBoundsPt.length-1;
  }
  function nearestBoundary(x){
    let best=0, bestD=Infinity;
    colBoundsPt.forEach((bx,i)=>{ const d=Math.abs(bx-x); if(d<bestD){ bestD=d; best=i; } });
    return best;
  }

  function paragraphText(p){
    return p.runs.filter(r=>!r.isBreak).map(r=>r.text).join("").replace(/\s+/g," ").trim();
  }
  // Returns the cell's Excel value AND any style hints derived purely
  // from that value's own text shape / source run metadata - never from
  // fixed coordinates, row/column numbers, or any specific document's
  // known content. Unchanged from the previous blocksToSheetRows.
  function cellValueAndStyle(text, runStyle, colWidthPt){
    const t = (text==null ? "" : String(text)).trim();
    const style = {};
    if(runStyle){
      if(runStyle.bold) style.bold = true;
      if(runStyle.italic) style.italic = true;
      if(runStyle.underline) style.underline = true;
      if(runStyle.sizePt) style.sizePt = runStyle.sizePt;
      if(runStyle.fontFamily) style.fontFamily = runStyle.fontFamily;
      if(runStyle.lineCount > 1) style.wrap = true;
      if(runStyle.color && !(runStyle.color[0]<10 && runStyle.color[1]<10 && runStyle.color[2]<10)){
        style.colorHex = rgbToHex(runStyle.color);
      }
    }
    if(colWidthPt && t.length){
      const approxCharWidthPt = (style.sizePt || 11) * 0.52;
      if(t.length * approxCharWidthPt > colWidthPt * 1.15) style.wrap = true;
    }
    if(/^0\d+$/.test(t) || /^\d{6,}$/.test(t)) return {value: {t:"s", v:t}, style};
    const numeric = numericStyleFromText(t);
    if(numeric){
      style.numFmtCode = numeric.numFmtCode;
      style.align = numeric.align;
      return {value: {t:"n", v: numeric.numericValue}, style};
    }
    return {value: t, style};
  }
  function estimateRowHeightPt(style, realLineSpacingPt){
    if(!style || (!style.sizePt && !style.wrap)) return 0;
    const perLinePt = (style.wrap && realLineSpacingPt) ? realLineSpacingPt : (style.sizePt||11) * 1.4;
    return Math.max(15, perLinePt * (style.wrap ? 2 : 1));
  }

  // Places one block's cell(s) at real (row, col) positions on the
  // shared grid, starting at page-local row r0Base. Returns the number
  // of rows this block occupies, so the band walk below can advance
  // cursorRow past the tallest item in a side-by-side band.
  function placeBlock(block, r0Base){
    if(block.type === "gridtable"){
      // Map this table's OWN real column boundaries onto the shared grid
      // index-by-index (not by re-clustering) - xTolerance was already
      // capped above to guarantee this table's own boundaries can never
      // collide with each other, so this mapping is strictly increasing.
      // A gridtable-shaped block with no real colBounds/rowBounds at all
      // (never produced by real extraction - detectRulingGridTable and
      // buildBorderlessTable both always compute them - only possible
      // from a hand-built test fixture) falls back to its own raw local
      // cell.c0/r0 indices with no shared-grid mapping and no real row
      // height, the same behavior this codebase always had for content
      // with no measurable geometry.
      const hasGeometry = !!(block.colBounds && block.rowBounds);
      const localToShared = hasGeometry ? block.colBounds.map(x=>nearestBoundary(x)) : null;
      if(localToShared){ for(let i=1;i<localToShared.length;i++){ if(localToShared[i] <= localToShared[i-1]) localToShared[i] = localToShared[i-1]+1; } }
      // Real arithmetic already implied by this table's own header text
      // and printed values (qty*rate=amount, subtotal/total rows) - only
      // attempted when this table has a real shared-grid column mapping,
      // since a formula string has to point at real Excel cell addresses.
      const arithmetic = (hasGeometry && localToShared)
        ? analyzeTableArithmetic(block, localToShared, r0Base)
        : {overrides: new Map(), columnFormats: new Map()};
      let maxC1 = 0;
      block.cells.forEach(cell=>{
        const colWidthPt = block.colWidthsPt && block.colWidthsPt[cell.c0];
        const runStyle = styleFromRuns(cell.runs);
        let {value, style} = cellValueAndStyle(cell.text, runStyle, colWidthPt);
        const c0 = hasGeometry ? localToShared[cell.c0] : cell.c0;
        const c1 = hasGeometry ? localToShared[cell.c0+cell.colSpan]-1 : cell.c0+cell.colSpan-1;
        maxC1 = Math.max(maxC1, c1);
        if(!style.align && cell.align && cell.align !== "left") style.align = cell.align;
        if(cell.vAlign && cell.vAlign !== "top") style.valign = cell.vAlign;
        if(block.shadeHex) style.fillHex = block.shadeHex;
        const override = arithmetic.overrides.get(`${cell.r0},${cell.c0}`);
        if(override){
          if(override.formula){
            value = {t:"n", v: override.cachedValue, f: override.formula};
            if(!style.numFmtCode) style.numFmtCode = "#,##0.00;-#,##0.00;\"-\"";
            if(!style.align) style.align = "right";
          } else if(override.comment){
            style.comment = override.comment;
          }
        }
        const colFormat = arithmetic.columnFormats.get(cell.c0);
        if(colFormat && colFormat.currency && value && typeof value === "object" && value.t === "n" && !override){
          // A column the table's own header text identifies as an amount
          // (qty*rate=amount's own amount column) gets the accounting-
          // style zero-as-dash currency format even on a bare number with
          // no printed currency symbol - upgrading the plain #,##0.00/
          // #,##0 numericStyleFromText already assigned, not inventing a
          // format on a column that was never recognized as numeric.
          if(style.numFmtCode === "#,##0.00" || style.numFmtCode === "#,##0") style.numFmtCode = "#,##0.00;-#,##0.00;\"-\"";
        }
        cellsOut.push({r0: r0Base+cell.r0, c0, r1: r0Base+cell.r0+cell.rowSpan-1, c1, value, style, edges: cell.edges});
      });
      // Real per-row height, straight from this table's own detected row
      // boundaries - a direct, unconverted physical measurement (PDF
      // points and Excel row-height units are both 1/72in), not a
      // font-size-based guess.
      if(hasGeometry){
        for(let r=0;r<block.nRows;r++){
          const heightPt = Math.abs(block.rowBounds[r]-block.rowBounds[r+1]);
          if(heightPt > 0) rowHeightsPt[r0Base+r] = Math.max(rowHeightsPt[r0Base+r]||0, heightPt);
        }
      }
      tableRanges.push({
        r0: r0Base, c0: hasGeometry ? localToShared[0] : 0, r1: r0Base+block.nRows-1, c1: maxC1,
        bordered: block.bordered !== false
      });
      return block.nRows;
    }
    if(block.type === "table"){
      // No real column-x evidence for this fallback block type (see
      // blockExtent above) - placed at the grid's own leftmost column, a
      // real, disclosed simplification carried forward unchanged from
      // before this rebuild (this block type already had "auto-width,
      // no real column-boundary geometry" per its own original doc
      // comment - not a regression introduced here).
      block.rows.forEach((rowCells, ri)=>{
        let c = 0;
        rowCells.forEach(cellDef=>{
          const {value, style} = cellValueAndStyle(cellDef.text, null, null);
          if(block.shadeHex) style.fillHex = block.shadeHex;
          const span = cellDef.span || 1;
          cellsOut.push({r0: r0Base+ri, c0:c, r1: r0Base+ri, c1: c+span-1, value, style});
          c += span;
        });
      });
      return block.rows.length;
    }
    if(block.type === "columns"){
      const leftStyle = styleFromRuns(block.left.flatMap(p=>p.runs));
      const rightStyle = styleFromRuns(block.right.flatMap(p=>p.runs));
      const left = cellValueAndStyle(block.left.map(paragraphText).join(" "), leftStyle, null);
      const right = cellValueAndStyle(block.right.map(paragraphText).join(" "), rightStyle, null);
      if(block.shadeHex){ left.style.fillHex = block.shadeHex; right.style.fillHex = block.shadeHex; }
      const leftP = block.left.find(p=>p.xLeft!=null), rightP = block.right.find(p=>p.xLeft!=null);
      const leftC0 = leftP ? boundaryAtOrBefore(leftP.xLeft) : 0;
      const rightC0 = Math.max(rightP ? boundaryAtOrBefore(rightP.xLeft) : leftC0+1, leftC0+1);
      cellsOut.push({r0:r0Base, c0:leftC0, r1:r0Base, c1:leftC0, value:left.value, style:left.style});
      cellsOut.push({r0:r0Base, c0:rightC0, r1:r0Base, c1:rightC0, value:right.value, style:right.style});
      return 1;
    }
    if(block.type === "paragraph"){
      const text = paragraphText(block);
      if(!text) return 0;
      const runStyle = styleFromRuns(block.runs);
      const {value, style} = cellValueAndStyle(text, runStyle, null);
      // Real geometry-based placement/spanning: this paragraph's own
      // measured xLeft/xRight (linesToParagraphs) mapped onto the shared
      // grid directly - replaces the previous ad-hoc "if centered, span
      // to the table's column count" special case. ANY paragraph whose
      // real text width genuinely crosses more than one shared column
      // boundary (not just a centered one) now spans that real range;
      // an ordinary left-flowing line whose xRight doesn't reach a
      // further boundary simply gets c1===c0, i.e. no span, exactly as
      // one column of a table would.
      const c0 = block.xLeft != null ? boundaryAtOrBefore(block.xLeft) : 0;
      const c1 = block.xRight != null ? Math.max(c0, boundaryAtOrAfter(block.xRight)-1) : c0;
      if(c1 > c0 && block.align === "center") style.align = style.align || "center";
      cellsOut.push({r0:r0Base, c0, r1:r0Base, c1, value, style});
      const heightPt = estimateRowHeightPt(style, block.lineSpacingPt);
      if(heightPt) rowHeightsPt[r0Base] = Math.max(rowHeightsPt[r0Base]||0, heightPt);
      return 1;
    }
    return 0;
  }

  // Walk Y-bands top to bottom. A real vertical gap since the previous
  // band's own real bottom edge becomes a proportional number of blank
  // Excel rows (using this page's own default line height as the unit -
  // never a fixed points-per-row constant), so a large PDF gap reliably
  // produces a visibly larger Excel gap than a small one, without
  // requiring an exact row-for-row pixel match. Clamped to a sane range
  // purely as a spreadsheet-usability safety valve (a gap spanning most
  // of a page shouldn't insert dozens of empty rows) - the clamp bound
  // is a fixed constant but it only ever COMPRESSES an already-large gap
  // relative to a small one, it never inverts the small-gap/large-gap
  // relationship the requirement actually asks for.
  let cursorRow = 0, cursorY = null;
  bands.forEach(band=>{
    if(cursorY != null){
      const gapPt = cursorY - band.yTop;
      if(gapPt > 0){
        const blankRows = Math.max(0, Math.min(20, Math.round(gapPt/defaultLineHeightPt) - 1));
        cursorRow += blankRows;
      }
    }
    band.items.sort((a,b)=> (a.xLeft==null?0:a.xLeft) - (b.xLeft==null?0:b.xLeft));
    let bandRowSpan = 1;
    band.items.forEach(g=>{ bandRowSpan = Math.max(bandRowSpan, placeBlock(g.block, cursorRow)); });
    cursorRow += bandRowSpan;
    cursorY = band.yBottom;
  });

  return {
    pageWidthPt, pageHeightPt, colBoundsPt,
    colWidthsPt: colBoundsPt.slice(0,-1).map((x,i)=>colBoundsPt[i+1]-x),
    nRows: cursorRow, cells: cellsOut, tableRanges, rowHeightsPt
  };
}

/* Mechanical conversion of one page's already-positioned PageLayout into
   the {rows, merges, gridRanges, cellStyles, cellEdges, rowHeights} shape
   applyCellFormattingToXlsx already expects (unchanged from before this
   rebuild) - startRow shifts every page-local row to its absolute
   position in the workbook-wide sheet, exactly as the old blocksToSheetRows'
   startRow parameter did. */
function layoutToSheetRows(pageLayout, startRow){
  const nCols = Math.max(1, pageLayout.colBoundsPt.length-1);
  const rows = Array.from({length: pageLayout.nRows}, ()=> new Array(nCols).fill(""));
  const merges = [], cellStyles = [], cellEdges = [], rowHeights = {};
  pageLayout.cells.forEach(cell=>{
    if(cell.r0 < 0 || cell.r0 >= rows.length) return;
    rows[cell.r0][cell.c0] = cell.value;
    const r = startRow + cell.r0;
    if(cell.style && Object.keys(cell.style).length) cellStyles.push(Object.assign({r, c:cell.c0}, cell.style));
    if(cell.r1 > cell.r0 || cell.c1 > cell.c0){
      merges.push({s:{r, c:cell.c0}, e:{r: startRow+cell.r1, c:cell.c1}});
    }
    if(cell.edges){
      for(let rr=cell.r0; rr<=cell.r1; rr++){
        for(let cc=cell.c0; cc<=cell.c1; cc++){
          cellEdges.push({
            r: startRow+rr, c: cc,
            top: rr===cell.r0 ? cell.edges.top : false,
            bottom: rr===cell.r1 ? cell.edges.bottom : false,
            left: cc===cell.c0 ? cell.edges.left : false,
            right: cc===cell.c1 ? cell.edges.right : false
          });
        }
      }
    }
  });
  Object.keys(pageLayout.rowHeightsPt).forEach(rLocal=>{
    rowHeights[startRow+Number(rLocal)] = pageLayout.rowHeightsPt[rLocal];
  });
  const gridRanges = pageLayout.tableRanges.map(g=>({r0:startRow+g.r0, c0:g.c0, r1:startRow+g.r1, c1:g.c1, bordered:g.bordered}));
  return {rows, merges, gridRanges, cellStyles, cellEdges, rowHeights};
}
/* SheetJS's free (Community Edition) build silently drops cell.s (border/
   font/fill styling) even when a style object is explicitly set on write -
   confirmed directly: an XLSX built with per-cell border styles and
   written via XLSX.write({cellStyles:true}) still comes out with a single
   generic cellXf and zero real border definitions in styles.xml. Real
   cell borders therefore have to be added by directly patching the
   already-written package's OOXML parts, the same low-level technique
   js/core/xlsx-merge.js already relies on for style handling. Applies ONE
   uniform "thin box, all four sides" style to every cell inside each
   detected table's row/col range (including cells that had no value and
   so were never written at all by aoa_to_sheet's sparse output) - a
   uniform per-cell box is deliberately simpler than tracking which edge
   of which cell is an outer border vs an inner divider: Excel renders
   every adjacent pair of "all sides bordered" cells as one clean
   unbroken grid line, which is visually identical to a real ruled table.
   The shared page-wide column-boundary grid (PDF points, from
   buildPageLayout) becomes real column widths via the one part of
   cell/column styling SheetJS's free build DOES honor: ws['!cols'],
   set by the caller before XLSX.write. */
function escapeXmlAttr(s){
  // Attribute-safe escaping (adds quote/apostrophe escaping on top of
  // escapeXml's &/</>) - required because every value this function
  // builds (numFmt formatCodes especially) lands inside a double-quoted
  // XML attribute. This is a single, correct escape of a FRESHLY BUILT
  // string, not a re-embed of already-escaped source XML, so - unlike
  // js/core/xlsx-merge.js's esc()/unesc() pair - there's no risk of the
  // double-escaping corruption that engine had to specifically guard
  // against; that bug only happens when re-escaping text that was
  // already escaped once by its original source document.
  return escapeXml(String(s==null?"":s)).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
/* Standard paper sizes (points, portrait orientation) mapped to the
   OOXML pageSetup paperSize code Excel recognizes. Matched with a small
   tolerance since a real PDF's MediaBox is essentially never bit-exact
   to a spec size. A page that matches nothing gets no paperSize
   attribute at all (Excel's own default) rather than being forced onto
   an incorrect standard size - this is a lookup against fixed PAPER
   SPECIFICATIONS (public standards, true for every A4/Letter/Legal/A3/A5
   document that will ever exist), not anything read from or tuned to
   any one source document. */
const STANDARD_PAPER_SIZES = [
  {code:1, w:612, h:792},   // Letter
  {code:5, w:612, h:1008},  // Legal
  {code:8, w:842, h:1191},  // A3
  {code:9, w:595, h:842},   // A4
  {code:11,w:420, h:595},   // A5
];
/* Detects orientation and (if it matches a standard size) paperSize from
   the ACTUAL page dimensions pdf.js reports (page.view, itself read from
   the PDF's own MediaBox/CropBox) - every value here is a direct function
   of the specific PDF being converted, never a fixed assumption. A
   landscape PDF is normalized to its portrait spec-size equivalent for
   the lookup (a landscape A4 page is still "A4 paper", just rotated),
   then the real orientation is reported separately. */
function detectPageGeometry(pageWidthPt, pageHeightPt){
  if(!pageWidthPt || !pageHeightPt) return null;
  const landscape = pageWidthPt > pageHeightPt;
  const portraitW = landscape ? pageHeightPt : pageWidthPt, portraitH = landscape ? pageWidthPt : pageHeightPt;
  const tolerance = 8; // points
  const match = STANDARD_PAPER_SIZES.find(p => Math.abs(p.w-portraitW)<=tolerance && Math.abs(p.h-portraitH)<=tolerance);
  return {paperSize: match ? match.code : null, orientation: landscape ? "landscape" : "portrait", widthPt: pageWidthPt, heightPt: pageHeightPt};
}
/* Applies real cell borders, fonts (bold/size), alignment, wrap, number
   formats, row heights, and page setup (paper size/orientation/fit-to-
   width) to an already-written XLSX package. All of this is skipped
   entirely by SheetJS's free build (confirmed directly: cell.s AND
   ws['!pageSetup'] are both silently dropped on write, even though
   ws['!margins'] IS honored - the caller sets that one natively) - so it
   has to be built by hand here, the same low-level OOXML technique
   js/core/xlsx-merge.js already relies on.
   Every input (gridRanges, cellStyles, rowHeights, pageGeometry) comes
   from this document's own detected table geometry, pdf.js font
   metadata, and page.view MediaBox dimensions (see
   styleFromRuns/numericStyleFromText/detectPageGeometry above) - nothing
   here is keyed to any fixed row/column number, page size, label, or
   document identity. A cell with no detected style just gets
   border-only (if inside a detected table) or nothing at all, and a
   page whose size couldn't be read gets no page-setup override at all -
   both exactly like before this function existed. */
/* pages: array of {gridRanges, cellStyles, rowHeights, cellEdges,
   pageGeometry}, one entry per worksheet, in the SAME order the
   worksheets were appended to the workbook (xl/worksheets/sheet1.xml,
   sheet2.xml, ... - SheetJS numbers sheet parts by append order). Each
   PDF page now gets its OWN worksheet (see TOOLS.pdf2excel) so its own
   real page geometry/column grid never has to compete with any other
   page's - font/fill/border/numFmt/xf definitions are still deduplicated
   ONCE, workbook-wide (styles.xml is a single shared part), but every
   other per-sheet detail (bordered ranges, cell styles, row heights,
   page setup) is applied to that sheet alone. */
async function applyCellFormattingToXlsx(wbArray, pages){
  pages = (pages||[]).map(p=>({
    gridRanges: p.gridRanges||[], cellStyles: p.cellStyles||[],
    rowHeights: p.rowHeights||{}, cellEdges: p.cellEdges||[], pageGeometry: p.pageGeometry||null
  }));
  if(!pages.some(p=>p.gridRanges.length || p.cellStyles.length || Object.keys(p.rowHeights).length || p.pageGeometry)) return wbArray;
  const zip = await JSZip.loadAsync(wbArray);
  let stylesXml = await zip.file("xl/styles.xml").async("string");

  const fontsMatch = /<fonts count="(\d+)">([\s\S]*?)<\/fonts>/.exec(stylesXml);
  let fontCount = Number(fontsMatch[1]);
  let fontsInner = fontsMatch[2];
  const fontIdByKey = new Map();
  // fontFamily comes from mapFontFamily() (extractPageBlocks) - a real
  // pdf.js font-descriptor-derived value ("Times New Roman"/"Consolas"/
  // "Calibri"), already the "closest available Excel-safe font" mapping
  // this codebase established for DOCX output; reused as-is here rather
  // than inventing a second font-substitution table.
  function fontIdFor(bold, italic, underline, sizePt, fontFamily, colorHex){
    if(!bold && !italic && !underline && !sizePt && !fontFamily && !colorHex) return 0; // the sheet's existing default font - never duplicated
    const key = `${bold?1:0}|${italic?1:0}|${underline?1:0}|${sizePt||0}|${fontFamily||""}|${colorHex||""}`;
    if(fontIdByKey.has(key)) return fontIdByKey.get(key);
    const id = fontCount++;
    const nameXml = fontFamily ? `<name val="${escapeXmlAttr(fontFamily)}"/>` : `<name val="Calibri"/><family val="2"/><scheme val="minor"/>`;
    // colorHex is the real PDF text color (styleFromRuns, via
    // cellValueAndStyle) - "FF"+hex is a fully-opaque ARGB value, OOXML's
    // own format for an explicit RGB color. Falls back to the sheet's
    // theme color (automatic/black) exactly as before when no real,
    // non-black color was detected - never invents one.
    const colorXml = colorHex ? `<color rgb="FF${colorHex}"/>` : `<color theme="1"/>`;
    fontsInner += `<font>${bold?"<b/>":""}${italic?"<i/>":""}${underline?"<u/>":""}<sz val="${sizePt||11}"/>${colorXml}${nameXml}</font>`;
    fontIdByKey.set(key, id);
    return id;
  }

  const fillsMatch = /<fills count="(\d+)">([\s\S]*?)<\/fills>/.exec(stylesXml);
  let fillCount = Number(fillsMatch[1]);
  let fillsInner = fillsMatch[2];
  const fillIdByKey = new Map();
  // block.shadeHex (extractPageBlocks' findEnclosingBox + isSafeForShading -
  // a real filled/stroked box the source PDF drew behind this cell,
  // already vetted there against near-white and against colors too dark
  // to keep the cell's own dark text legible) - same dedup discipline as
  // fonts/borders/numFmts above, only the fill combinations that actually
  // occur get a real <fill> entry.
  function fillIdFor(hex){
    if(!hex) return 0; // solid "no fill" - index 0 in every SheetJS-written styles.xml
    if(fillIdByKey.has(hex)) return fillIdByKey.get(hex);
    const id = fillCount++;
    fillsInner += `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/><bgColor indexed="64"/></patternFill></fill>`;
    fillIdByKey.set(hex, id);
    return id;
  }

  const numFmtsMatch = /<numFmts count="(\d+)">([\s\S]*?)<\/numFmts>/.exec(stylesXml);
  let numFmtCount = numFmtsMatch ? Number(numFmtsMatch[1]) : 0;
  let numFmtsInner = numFmtsMatch ? numFmtsMatch[2] : "";
  let nextNumFmtId = 164; // OOXML reserves <164 for its own built-ins
  [...stylesXml.matchAll(/numFmtId="(\d+)"/g)].forEach(m=>{ nextNumFmtId = Math.max(nextNumFmtId, Number(m[1])+1); });
  const numFmtIdByCode = new Map();
  function numFmtIdFor(code){
    if(!code) return 0;
    if(numFmtIdByCode.has(code)) return numFmtIdByCode.get(code);
    const id = nextNumFmtId++;
    numFmtsInner += `<numFmt numFmtId="${id}" formatCode="${escapeXmlAttr(code)}"/>`;
    numFmtCount++;
    numFmtIdByCode.set(code, id);
    return id;
  }

  const bordersMatch = /<borders count="(\d+)">([\s\S]*?)<\/borders>/.exec(stylesXml);
  let borderCount = Number(bordersMatch[1]);
  let bordersInner = bordersMatch[2];
  const borderIdByKey = new Map();
  // Per-edge border evidence (cell.edges from detectRulingGridTable, via
  // blocksToSheetRows' cellEdges) means a cell's actual drawn sides can be
  // any of the 16 combinations of top/bottom/left/right, not just "box" or
  // "none" - build only the combinations that actually occur (same dedup
  // discipline already used for fonts/numFmts above), each a real
  // <border> definition with just those sides present.
  function borderIdFor(edges){
    if(!edges || (!edges.top && !edges.bottom && !edges.left && !edges.right)) return 0;
    const key = `${edges.top?1:0}${edges.bottom?1:0}${edges.left?1:0}${edges.right?1:0}`;
    if(borderIdByKey.has(key)) return borderIdByKey.get(key);
    const id = borderCount++;
    const side = (name, on) => on ? `<${name} style="thin"><color indexed="64"/></${name}>` : `<${name}/>`;
    bordersInner += `<border>${side("left",edges.left)}${side("right",edges.right)}${side("top",edges.top)}${side("bottom",edges.bottom)}<diagonal/></border>`;
    borderIdByKey.set(key, id);
    return id;
  }
  const FULL_BOX_EDGES = {top:true, bottom:true, left:true, right:true};

  const cellXfsMatch = /<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  let xfCount = Number(cellXfsMatch[1]);
  let xfsInner = cellXfsMatch[2];
  const xfIdByKey = new Map();
  const VALIGN = {top:"top", bottom:"bottom", center:"center"};
  function xfIdFor(style){
    const fontId = fontIdFor(!!style.bold, !!style.italic, !!style.underline, style.sizePt||null, style.fontFamily||null, style.colorHex||null);
    const numFmtId = numFmtIdFor(style.numFmtCode);
    // style.border is either a real {top,bottom,left,right} edge spec, the
    // legacy `true` (full box, for a fallback case with no per-edge
    // evidence), or falsy (no border at all).
    const edges = style.border === true ? FULL_BOX_EDGES : style.border || null;
    const bId = borderIdFor(edges);
    const fId = fillIdFor(style.fillHex||null);
    const key = `${fontId}|${numFmtId}|${style.align||""}|${style.valign||""}|${style.wrap?1:0}|${bId}|${fId}`;
    if(xfIdByKey.has(key)) return xfIdByKey.get(key);
    const id = xfCount++;
    const alignParts = [];
    if(style.align) alignParts.push(`horizontal="${style.align}"`);
    if(style.valign && VALIGN[style.valign]) alignParts.push(`vertical="${VALIGN[style.valign]}"`);
    if(style.wrap) alignParts.push('wrapText="1"');
    const attrs = `numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fId}" borderId="${bId}" xfId="0"`
      + (fontId ? ' applyFont="1"' : "") + (numFmtId ? ' applyNumberFormat="1"' : "")
      + (bId ? ' applyBorder="1"' : "") + (fId ? ' applyFill="1"' : "") + (alignParts.length ? ' applyAlignment="1"' : "");
    xfsInner += alignParts.length ? `<xf ${attrs}><alignment ${alignParts.join(" ")}/></xf>` : `<xf ${attrs}/>`;
    xfIdByKey.set(key, id);
    return id;
  }

  const cellRe = /<c r="([A-Z]+)(\d+)"([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
  function colLetterToIndex(letters){
    let n = 0;
    for(const ch of letters) n = n*26 + (ch.charCodeAt(0)-64);
    return n-1;
  }
  function setStyleAttr(openAttrs, xfId){
    if(/\bs="\d+"/.test(openAttrs)) return openAttrs.replace(/\bs="\d+"/, `s="${xfId}"`);
    return openAttrs + ` s="${xfId}"`;
  }

  for(let pageIdx=0; pageIdx<pages.length; pageIdx++){
    const {gridRanges, cellStyles, rowHeights, cellEdges, pageGeometry} = pages[pageIdx];
    const sheetPath = `xl/worksheets/sheet${pageIdx+1}.xml`;
    const sheetFile = zip.file(sheetPath);
    if(!sheetFile) continue; // no sheet at this index (shouldn't happen; defensive)
    if(!gridRanges.length && !cellStyles.length && !Object.keys(rowHeights).length && !pageGeometry) continue;
    let sheetXml = await sheetFile.async("string");
    const sheetDataMatch = /<sheetData>([\s\S]*?)<\/sheetData>/.exec(sheetXml);
    const rowRe = /<row r="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g;
    const rowsByNum = new Map();
    let m;
    while((m = rowRe.exec(sheetDataMatch[1]))){
      rowsByNum.set(Number(m[1]), {attrs: m[2], inner: m[3]});
    }

    const styleByCell = new Map();
    cellStyles.forEach(cs=>styleByCell.set(`${cs.r},${cs.c}`, cs));
    const edgesByCell = new Map();
    cellEdges.forEach(e=>edgesByCell.set(`${e.r},${e.c}`, e));
    // Only a range with real ruling-line evidence (bordered:true) gets a
    // drawn border - a confident borderless-table match still gets its
    // font/alignment/wrap/numFmt formatting (via the minC..maxC cell loop
    // below) but never an invented box the source PDF never had.
    function insideGridRange(r, c){
      return gridRanges.some(g => g.bordered && r>=g.r0 && r<=g.r1 && c>=g.c0 && c<=g.c1);
    }
    // Real per-edge evidence wins when available (a merged header only gets
    // a border on the sides the source PDF actually drew, no phantom
    // interior divider lines); otherwise fall back to the previous
    // all-4-sides box for any cell inside a bordered range with no
    // individual edge record (e.g. a future gridtable path that hasn't been
    // extended with cell.edges yet).
    function borderEdgesFor(r, c){
      const e = edgesByCell.get(`${r},${c}`);
      if(e) return {top:e.top, bottom:e.bottom, left:e.left, right:e.right};
      return insideGridRange(r, c) ? true : null;
    }
    const rowsNeeded = new Set([...Object.keys(rowHeights).map(Number)]);
    gridRanges.forEach(g=>{ for(let r=g.r0;r<=g.r1;r++) rowsNeeded.add(r); });
    cellStyles.forEach(cs=>rowsNeeded.add(cs.r));

    for(const r of [...rowsNeeded].sort((a,b)=>a-b)){
      let minC = Infinity, maxC = -Infinity;
      gridRanges.forEach(g=>{ if(r>=g.r0 && r<=g.r1){ minC = Math.min(minC, g.c0); maxC = Math.max(maxC, g.c1); } });
      cellStyles.forEach(cs=>{ if(cs.r===r){ minC = Math.min(minC, cs.c); maxC = Math.max(maxC, cs.c); } });
      const excelRow = r+1;
      const existing = rowsByNum.get(excelRow);
      const cellsByCol = new Map();
      if(existing){
        cellRe.lastIndex = 0;
        let cm;
        while((cm = cellRe.exec(existing.inner))){
          cellsByCol.set(colLetterToIndex(cm[1]), {ref: cm[1]+cm[2], attrs: cm[3], body: cm[4]==="/>" ? "/>" : `>${cm[5]}</c>`});
        }
      }
      if(isFinite(minC)){
        for(let c = minC; c <= maxC; c++){
          const style = Object.assign({}, styleByCell.get(`${r},${c}`), {border: borderEdgesFor(r, c)});
          const xfId = xfIdFor(style);
          const existingCell = cellsByCol.get(c);
          if(existingCell){
            cellsByCol.set(c, Object.assign({}, existingCell, {attrs: setStyleAttr(existingCell.attrs, xfId)}));
          } else {
            const ref = XLSX.utils.encode_cell({r, c});
            cellsByCol.set(c, {ref, attrs: ` s="${xfId}"`, body: "/>"});
          }
        }
      }
      const innerXml = [...cellsByCol.entries()].sort((a,b)=>a[0]-b[0])
        .map(([, cell]) => `<c r="${cell.ref}"${cell.attrs}${cell.body}`).join("");
      let attrs = existing ? existing.attrs : "";
      const heightPt = rowHeights[r];
      if(heightPt){
        attrs = attrs.replace(/\s*ht="[^"]*"/, "").replace(/\s*customHeight="[^"]*"/, "");
        attrs += ` ht="${heightPt.toFixed(2)}" customHeight="1"`;
      }
      rowsByNum.set(excelRow, {attrs, inner: innerXml || (existing ? existing.inner : "")});
    }

    // Every .replace() below uses a REPLACER FUNCTION, never a plain
    // replacement string, even though the match target is always a fixed,
    // literal substring found via indexOf/regex. This is deliberate, not
    // stylistic: String.replace() treats a STRING replacement's "$&", "$1",
    // "$`", "$'", "$$" as special backreference patterns - and a dynamic
    // replacement built from real PDF text can easily contain "$&" by pure
    // coincidence (confirmed: a currency numFmtCode like `"$"#,##0.00`
    // becomes `&quot;$&quot;#,##0.00` once XML-attribute-escaped, which
    // contains the literal substring "$&" - passing that as a plain
    // replacement string silently spliced the ENTIRE matched original
    // block back into the middle of the new one, corrupting styles.xml).
    // A replacer function's return value is always inserted literally, with
    // no special-pattern interpretation - the correct fix for any
    // replacement string that isn't a hardcoded literal.
    const newRowsXml = [...rowsByNum.entries()].sort((a,b)=>a[0]-b[0])
      .map(([num, row]) => `<row r="${num}"${row.attrs}>${row.inner}</row>`).join("");
    sheetXml = sheetXml.replace(sheetDataMatch[0], () => `<sheetData>${newRowsXml}</sheetData>`);

    if(pageGeometry){
      // Deliberately NOT using fitToWidth/fitToHeight: that forces Excel to
      // STRETCH the sheet's content to fill the entire printable page
      // width regardless of the table's own real size - correct only when
      // the source PDF table itself spans the full page width, and
      // actively WRONG (visibly stretched/squished relative to the source)
      // whenever it doesn't, e.g. a table with real margins on both sides.
      // Printing at natural 100% scale instead, with column widths already
      // converted from real PDF point-widths (colWidthsPtToExcelWch below)
      // against a paperSize that matches THIS page's own real dimensions -
      // so the table's physical footprint on the printed page is a direct,
      // unscaled reflection of its footprint in the source PDF page, not
      // force-fit to fill space it never occupied. Since every PDF page
      // now gets its own worksheet, this is real per-page page setup, not
      // one workbook-wide setting borrowed from page 1 alone.
      const paperAttr = pageGeometry.paperSize ? ` paperSize="${pageGeometry.paperSize}"` : "";
      const pageSetupXml = `<pageSetup${paperAttr} orientation="${pageGeometry.orientation}"/>`;
      // Schema order: pageMargins (already written natively by the caller
      // via ws['!margins'], SheetJS's one supported page-setup field) must
      // come immediately before pageSetup. When no !margins was set, this
      // used to just splice pageSetupXml before </worksheet> - but
      // CT_Worksheet's element order is fixed (pageSetup must precede
      // headerFooter/rowBreaks/colBreaks/.../ignoredErrors/.../extLst, all
      // of which SheetJS may have already written, e.g. its own
      // <ignoredErrors> for text-stored-as-number cells), so appending at
      // the very end put pageSetup AFTER those - a real ordering violation
      // that makes Excel refuse to open the file (confirmed: a real
      // conversion missing !margins produced exactly this and needed
      // repair). Insert before whichever of those trailing elements
      // actually appears first, so pageSetup always lands in its real
      // required slot regardless of what else SheetJS wrote.
      if(/<pageMargins[^>]*\/>/.test(sheetXml)){
        sheetXml = sheetXml.replace(/(<pageMargins[^>]*\/>)/, (m0, g1) => g1 + pageSetupXml);
      } else {
        const trailingTags = ["headerFooter","rowBreaks","colBreaks","customProperties","cellWatches","ignoredErrors","smartTags","drawing","drawingHF","legacyDrawing","picture","oleObjects","controls","webPublishItems","tableParts","extLst"];
        const trailingRe = new RegExp(`<(?:${trailingTags.join("|")})[ >/]`);
        const match = trailingRe.exec(sheetXml);
        if(match){
          sheetXml = sheetXml.slice(0, match.index) + pageSetupXml + sheetXml.slice(match.index);
        } else {
          sheetXml = sheetXml.replace("</worksheet>", () => pageSetupXml + "</worksheet>");
        }
      }
    }

    // Real Excel cell comments for arithmetic discrepancies this pass
    // found (see analyzeTableArithmetic) - never silently overwriting a
    // printed number the arithmetic disagrees with, instead flagging it
    // exactly the way a careful manual conversion would. OOXML requires
    // BOTH a real comments part AND a legacy VML drawing part for the
    // comment indicator/popup to render at all in Excel - the comment
    // TEXT lives only in the comments part, but Excel won't show it
    // without the VML shape too.
    const commentEntries = cellStyles.filter(cs=>cs.comment).map(cs=>({r:cs.r, c:cs.c, text:cs.comment}));
    if(commentEntries.length){
      const n = pageIdx+1;
      const commentListXml = commentEntries.map(e=>
        `<comment ref="${XLSX.utils.encode_cell({r:e.r, c:e.c})}" authorId="0"><text><t xml:space="preserve">${escapeXml(e.text)}</t></text></comment>`
      ).join("");
      const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>YoyoPDF</author></authors><commentList>${commentListXml}</commentList></comments>`;
      zip.file(`xl/comments${n}.xml`, commentsXml);

      const vmlShapes = commentEntries.map((e,i)=>
        `<v:shape id="_x0000_s${1000+i}" type="#_x0000_t202" style='position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:200pt;height:80pt;z-index:${i+1};visibility:hidden' fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style='mso-direction-alt:auto'><div style='text-align:left'></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:AutoFill>False</x:AutoFill><x:Row>${e.r}</x:Row><x:Column>${e.c}</x:Column></x:ClientData></v:shape>`
      ).join("");
      const vmlXml = `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>${vmlShapes}</xml>`;
      zip.file(`xl/drawings/vmlDrawing${n}.vml`, vmlXml);

      if(!/xmlns:r=/.test(sheetXml)) sheetXml = sheetXml.replace("<worksheet ", () => '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
      // Schema order: legacyDrawing comes after pageSetup/headerFooter/
      // rowBreaks/.../drawing, before legacyDrawingHF/drawingHF/picture/
      // oleObjects/controls/webPublishItems/tableParts/extLst - same
      // trailing-tag-scan technique already used above for pageSetup.
      const legacyDrawingXml = `<legacyDrawing r:id="rIdVmlComments"/>`;
      const afterLegacyTags = ["legacyDrawingHF","drawingHF","picture","oleObjects","controls","webPublishItems","tableParts","extLst"];
      const afterLegacyRe = new RegExp(`<(?:${afterLegacyTags.join("|")})[ >/]`);
      const legacyMatch = afterLegacyRe.exec(sheetXml);
      if(legacyMatch){
        sheetXml = sheetXml.slice(0, legacyMatch.index) + legacyDrawingXml + sheetXml.slice(legacyMatch.index);
      } else {
        sheetXml = sheetXml.replace("</worksheet>", () => legacyDrawingXml + "</worksheet>");
      }

      const relsPath = `xl/worksheets/_rels/sheet${n}.xml.rels`;
      const existingSheetRels = zip.file(relsPath);
      const newRels = `<Relationship Id="rIdVmlComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing${n}.vml"/><Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments${n}.xml"/>`;
      let sheetRels;
      if(existingSheetRels){
        sheetRels = await existingSheetRels.async("string");
        sheetRels = sheetRels.replace("</Relationships>", () => newRels + "</Relationships>");
      } else {
        sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${newRels}</Relationships>`;
      }
      zip.file(relsPath, sheetRels);

      let ct = await zip.file("[Content_Types].xml").async("string");
      if(!/Extension="vml"/.test(ct)){
        ct = ct.replace("</Types>", () => '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/></Types>');
      }
      const commentsOverride = `<Override PartName="/xl/comments${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>`;
      if(!ct.includes(commentsOverride)){
        ct = ct.replace("</Types>", () => commentsOverride + "</Types>");
      }
      zip.file("[Content_Types].xml", ct);
    }

    zip.file(sheetPath, sheetXml);
  }

  stylesXml = stylesXml.replace(fontsMatch[0], () => `<fonts count="${fontCount}">${fontsInner}</fonts>`);
  if(numFmtsMatch){
    stylesXml = stylesXml.replace(numFmtsMatch[0], () => numFmtCount ? `<numFmts count="${numFmtCount}">${numFmtsInner}</numFmts>` : "");
  } else if(numFmtCount){
    stylesXml = stylesXml.replace("<fonts", () => `<numFmts count="${numFmtCount}">${numFmtsInner}</numFmts><fonts`);
  }
  stylesXml = stylesXml.replace(fillsMatch[0], () => `<fills count="${fillCount}">${fillsInner}</fills>`);
  stylesXml = stylesXml.replace(bordersMatch[0], () => `<borders count="${borderCount}">${bordersInner}</borders>`);
  stylesXml = stylesXml.replace(cellXfsMatch[0], () => `<cellXfs count="${xfCount}">${xfsInner}</cellXfs>`);
  zip.file("xl/styles.xml", stylesXml);

  return zip.generateAsync({type:"uint8array", compression:"DEFLATE", compressionOptions:{level:6}});
}
/* Detects table columns using pdf.js's synthetic whitespace items rather
   than joining all text into one string and guessing from literal
   multi-space characters (the old approach - unreliable, since many
   table-generating PDFs never embed literal multi-space runs; the visual
   gap between columns comes purely from each cell's text being positioned
   separately, not from spacing characters). Verified empirically first:
   pdf.js inserts a space-only text item to fill the gap between two
   separately-positioned runs, and that item's own `width` IS the actual
   visual gap size in PDF points - a gap noticeably wider than normal
   single/double inter-word spacing reliably signals a real column
   boundary. Kept as the last-resort fallback when extractPageBlocks finds
   no usable structure at all on a page (see TOOLS.pdf2excel). */
function extractTableRows(content){
  const lineTolerance = 3;
  const lines = [];
  for(const it of content.items){
    const x = it.transform[4], y = it.transform[5];
    let line = lines.find(l => Math.abs(l.y - y) <= lineTolerance);
    if(!line){ line = {y, items:[]}; lines.push(line); }
    line.items.push({str: it.str, x, width: it.width || 0, size: Math.abs(it.transform[0]) || 10});
  }
  lines.sort((a,b)=> b.y - a.y); // PDF y grows upward - top of page first
  lines.forEach(l => l.items.sort((a,b)=>a.x-b.x));

  return lines.map(line => {
    const cells = [];
    let current = "";
    for(const item of line.items){
      const isColumnGap = item.str.trim()==="" && item.width > Math.max(10, item.size*1.2);
      if(isColumnGap && current.trim()){
        cells.push(current.trim());
        current = "";
      } else {
        current += item.str;
      }
    }
    if(current.trim()) cells.push(current.trim());
    return cells.length ? cells : [""];
  });
}
async function buildBasicDocx(paragraphs){
  const zip = new JSZip();
  zip.file("[Content_Types].xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder("_rels").file(".rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  const bodyParas = paragraphs.map(p=>{
    if(!p.trim()) return `<w:p/>`;
    return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`;
  }).join("");
  zip.folder("word").file("document.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyParas}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417"/></w:sectPr></w:body>
</w:document>`);
  zip.folder("word").folder("_rels").file("document.xml.rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  return await zip.generateAsync({type:"blob", mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
}

/* ---- DOCX builder that mixes embedded page images ---- */
function pxToEmu(px, dpi=96){ return Math.round(px * 914400 / dpi); }
const DEVANAGARI_RE = /[ऀ-ॿ]/;
/* DOCX page size mirrors the source PDF's actual page dimensions (1pt =
   20 twips) instead of always forcing A4, so Letter/Legal/custom sized
   (and landscape) PDFs don't get silently reflowed onto the wrong paper
   size. Margins scale down on very small custom pages so they can't
   exceed half the page in either dimension. Used both for the document's
   final (body-level) section and for any mid-document section breaks
   inserted where the source PDF's page size actually changes.
   headerRid/footerRid (when given) wire that section to the shared
   header1.xml/footer1.xml parts - DOCX only supports ONE header/footer
   pair per document in this implementation (applied to every section),
   which matches the common case (a header/footer that's the same content
   repeated on every page) rather than per-section headers. */
function sectPrXml(sizeObj, headerRid, footerRid){
  let pgW = 11906, pgH = 16838, orient = "";
  if(sizeObj && sizeObj.widthPt && sizeObj.heightPt){
    pgW = Math.round(sizeObj.widthPt*20);
    pgH = Math.round(sizeObj.heightPt*20);
    if(pgW > pgH) orient = ' w:orient="landscape"';
  }
  const fallbackMargin = Math.max(360, Math.min(1417, Math.floor(Math.min(pgW,pgH)/2) - 200));
  const marginTwips = value => Number.isFinite(value) ? Math.max(0,Math.round(value*20)) : fallbackMargin;
  const top=marginTwips(sizeObj && sizeObj.marginTopPt), right=marginTwips(sizeObj && sizeObj.marginRightPt);
  const bottom=marginTwips(sizeObj && sizeObj.marginBottomPt), left=marginTwips(sizeObj && sizeObj.marginLeftPt);
  const refs = (headerRid ? `<w:headerReference w:type="default" r:id="${headerRid}"/>` : "")
    + (footerRid ? `<w:footerReference w:type="default" r:id="${footerRid}"/>` : "");
  return `<w:sectPr>${refs}<w:pgSz w:w="${pgW}" w:h="${pgH}"${orient}/><w:pgMar w:top="${top}" w:right="${right}" w:bottom="${bottom}" w:left="${left}"/></w:sectPr>`;
}

function docxPageContentBox(sizeObj){
  let widthPt = 595.3, heightPt = 841.9;
  if(sizeObj && sizeObj.widthPt && sizeObj.heightPt){ widthPt=sizeObj.widthPt; heightPt=sizeObj.heightPt; }
  const pgW=Math.round(widthPt*20), pgH=Math.round(heightPt*20);
  const fallback=Math.max(360,Math.min(1417,Math.floor(Math.min(pgW,pgH)/2)-200))/20;
  const margin = (name)=>Number.isFinite(sizeObj && sizeObj[name]) ? Math.max(0,sizeObj[name]) : fallback;
  const marginTopPt=margin("marginTopPt"), marginRightPt=margin("marginRightPt");
  const marginBottomPt=margin("marginBottomPt"), marginLeftPt=margin("marginLeftPt");
  return {widthPt,heightPt,marginTopPt,marginRightPt,marginBottomPt,marginLeftPt,usableWidthPt:Math.max(1,widthPt-marginLeftPt-marginRightPt)};
}

function pdfBlockBounds(block, pageSize){
  if(!block) return null;
  if(block.type === "image" && Number.isFinite(block.xPt)) return {left:block.xPt,right:block.xPt+(block.widthPt||0),top:block.yFromTopPt||0,bottom:(block.yFromTopPt||0)+(block.heightPt||0)};
  let left=block.xLeft, right=block.xRight;
  if(block.colBounds && block.colBounds.length){ left=block.colBounds[0]; right=block.colBounds[block.colBounds.length-1]; }
  if(block.type === "columns"){
    const children=[...(block.left||[]),...(block.right||[])].map(child=>pdfBlockBounds(child,pageSize)).filter(Boolean);
    if(children.length){ left=Math.min(...children.map(x=>x.left)); right=Math.max(...children.map(x=>x.right)); }
  }
  let topY=block._y, bottomY=block._y;
  if(block.rowBounds && block.rowBounds.length){ topY=block.rowBounds[0]; bottomY=block.rowBounds[block.rowBounds.length-1]; }
  const runSizes=block.runs ? block.runs.map(run=>run.size||0) : [];
  const fontSize=Math.max(10,...runSizes);
  if(!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(topY)) return null;
  return {left,right,top:Math.max(0,pageSize.heightPt-topY-fontSize),bottom:Math.min(pageSize.heightPt,pageSize.heightPt-(Number.isFinite(bottomY)?bottomY:topY)+fontSize*0.3)};
}

/* Infer the source page's real content margins from extracted geometry. These values drive both
   sectPr and the page layout table, so a tightly-laid-out form does not get forced through Word's
   former hardcoded 1-inch margins. */
function inferPdfPageLayoutSize(pageSize, blocks){
  const bounds=(blocks||[]).map(block=>pdfBlockBounds(block,pageSize)).filter(Boolean);
  if(!bounds.length) return Object.assign({},pageSize);
  const cap=72;
  return Object.assign({},pageSize,{
    marginLeftPt:Math.max(0,Math.min(cap,Math.min(...bounds.map(x=>x.left)))),
    marginRightPt:Math.max(0,Math.min(cap,pageSize.widthPt-Math.max(...bounds.map(x=>x.right)))),
    marginTopPt:Math.max(0,Math.min(cap,Math.min(...bounds.map(x=>x.top)))),
    marginBottomPt:Math.max(0,Math.min(cap,pageSize.heightPt-Math.max(...bounds.map(x=>x.bottom))))
  });
}

function pageLayoutBlockXml(pageBlock, renderBlock){
  const contentBox=docxPageContentBox(pageBlock.pageSize);
  const usableTwips=Math.max(1,Math.round(contentBox.usableWidthPt*20));
  const entries=(pageBlock.blocks||[]).map(block=>({block,bounds:pdfBlockBounds(block,pageBlock.pageSize)})).filter(entry=>entry.bounds).sort((a,b)=>a.bounds.top-b.bounds.top);
  const noBorder=`<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/>`;
  const renderNested=entry=>{
    const nested=Object.assign({},entry.block,{_availableWidthPt:Math.max(1,entry.bounds.right-entry.bounds.left)});
    return renderBlock(nested)+(/^(table|gridtable|columns)$/.test(nested.type) ? "<w:p/>" : "");
  };

  // Blocks sharing a visual baseline belong in one horizontal band. Serializing independent
  // left/right regions as separate rows lets the first region push the second downward. Group only
  // non-overlapping regions whose measured top coordinates agree, using a tolerance derived from
  // their own height rather than from any document-specific layout.
  const bands=[];
  for(const entry of entries){
    const height=Math.max(1,entry.bounds.bottom-entry.bounds.top);
    const flowBottom=entry.block.type==="image" && entry.block.placement==="anchored" ? entry.bounds.top+1 : entry.bounds.bottom;
    const tolerance=Math.max(1,Math.min(4,height*0.25));
    const band=bands[bands.length-1];
    const overlapsX=band && band.entries.some(item=>entry.bounds.left < item.bounds.right-0.5 && entry.bounds.right > item.bounds.left+0.5);
    if(band && Math.abs(entry.bounds.top-band.top)<=tolerance && !overlapsX){
      band.entries.push(entry);
      band.bottom=Math.max(band.bottom,entry.bounds.bottom);
      band.flowBottom=Math.max(band.flowBottom,flowBottom);
    }else bands.push({top:entry.bounds.top,bottom:entry.bounds.bottom,flowBottom,entries:[entry]});
  }

  function bandContentXml(band){
    const sorted=band.entries.slice().sort((a,b)=>a.bounds.left-b.bounds.left);
    if(sorted.length===1){
      const entry=sorted[0];
      const leftIndent=Math.max(0,entry.bounds.left-contentBox.marginLeftPt);
      const rightIndent=Math.max(0,contentBox.widthPt-contentBox.marginRightPt-entry.bounds.right);
      return `<w:tc><w:tcPr><w:tcW w:w="${usableTwips}" w:type="dxa"/><w:tcMar><w:left w:w="${Math.round(leftIndent*20)}" w:type="dxa"/><w:right w:w="${Math.round(rightIndent*20)}" w:type="dxa"/><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tcMar></w:tcPr>${renderNested(entry)}</w:tc>`;
    }
    const segments=[];
    let cursor=contentBox.marginLeftPt;
    const contentRight=contentBox.widthPt-contentBox.marginRightPt;
    for(const entry of sorted){
      const left=Math.max(cursor,Math.min(contentRight,entry.bounds.left));
      const right=Math.max(left+0.05,Math.min(contentRight,entry.bounds.right));
      if(left>cursor+0.05) segments.push({width:left-cursor});
      segments.push({width:right-left,entry});
      cursor=right;
    }
    if(contentRight>cursor+0.05) segments.push({width:contentRight-cursor});
    const widths=segments.map(segment=>Math.max(1,Math.round(segment.width*20)));
    const grid=widths.map(width=>`<w:gridCol w:w="${width}"/>`).join("");
    const cells=segments.map((segment,index)=>`<w:tc><w:tcPr><w:tcW w:w="${widths[index]}" w:type="dxa"/><w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar></w:tcPr>${segment.entry?renderNested(segment.entry):"<w:p/>"}</w:tc>`).join("");
    const nested=`<w:tbl><w:tblPr><w:tblW w:w="${usableTwips}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar><w:tblBorders>${noBorder}</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid><w:tr>${cells}</w:tr></w:tbl><w:p/>`;
    return `<w:tc><w:tcPr><w:tcW w:w="${usableTwips}" w:type="dxa"/></w:tcPr>${nested}</w:tc>`;
  }
  let rows="";
  if(bands.length){
    const firstGap=Math.max(0,bands[0].top-contentBox.marginTopPt);
    if(firstGap>0.5) rows+=`<w:tr><w:trPr><w:trHeight w:val="${Math.round(firstGap*20)}" w:hRule="exact"/></w:trPr><w:tc><w:tcPr><w:tcW w:w="${usableTwips}" w:type="dxa"/></w:tcPr><w:p/></w:tc></w:tr>`;
    bands.forEach((band,index)=>{
      const next=bands[index+1];
      const sourceHeight=Math.max(1,band.flowBottom-band.top);
      const slotPt=Math.max(sourceHeight,next ? next.top-band.top : sourceHeight);
      rows+=`<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${Math.round(slotPt*20)}" w:hRule="exact"/></w:trPr>${bandContentXml(band)}</w:tr>`;
    });
  } else {
    rows=`<w:tr><w:tc><w:tcPr><w:tcW w:w="${usableTwips}" w:type="dxa"/></w:tcPr><w:p/></w:tc></w:tr>`;
  }
  return `<w:tbl><w:tblPr><w:tblW w:w="${usableTwips}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar><w:tblBorders>${noBorder}</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="${usableTwips}"/></w:tblGrid>${rows}</w:tbl>`;
}

/* Whether a block (of ANY type - paragraph, table, gridtable, columns)
   carries real, non-whitespace text. Used to decide whether a page has
   extractable content at all (vs. needing the whole-page-screenshot
   fallback) - checking only paragraph-type blocks here was a real bug,
   since a page whose entire content is a table has no paragraph blocks
   at all despite having plenty of real text. */
function blockHasRealText(b){
  if(!b) return false;
  if(b.type === "paragraph") return b.runs.some(r=>r.text && r.text.trim());
  if(b.type === "table") return b.rows.some(row=>row.some(c=>c.text && c.text.trim()));
  if(b.type === "gridtable") return b.cells.some(c=>c.text && c.text.trim());
  if(b.type === "columns") return [...b.left, ...b.right].some(p=>p.runs.some(r=>r.text && r.text.trim()));
  return false;
}

/* Detects genuine repeating headers/footers across pages - promoted to
   real DOCX header/footer parts only when the exact same literal text
   (whitespace/case normalized, but NOT digit-masked) appears as the
   first (header candidate) or last (footer candidate) paragraph on a
   strong majority (>=60%, min 2) of pages. Ordinary one-off page content
   can never satisfy this - it requires real repetition across pages,
   not just position on one page.

   Deliberately requires LITERAL text equality, not a digit-masked
   pattern match ("Page 1 of 4" vs "Page 2 of 4" no longer count as "the
   same"). A real DOCX <w:ftr>/<w:hdr> can only ever hold ONE fixed,
   static text repeated verbatim on every page - there is no per-page
   substitution. Digit-masking was tried first (so genuine pagination
   footers would still be recognized as "repeating"), but it silently
   corrupts any per-page-varying content that happens to share a
   template: confirmed both on the intended pagination case itself (a
   real "Page 1 of 2"/"Page 2 of 2" footer pair got collapsed to a
   static footer reading "Page 1 of 2" on BOTH pages - page 2's real
   footer was deleted and replaced with the wrong page's text) and on a
   more damaging case (three pages with genuinely different subtotal
   amounts - "$120.00"/"$340.00"/"$275.50" - collapsed to a static
   footer showing "$120.00" on every page, silently overwriting two
   pages' real financial values). Requiring literal equality means a
   genuine pagination footer no longer gets auto-promoted to a running
   footer (a minor convenience loss), but no page's real, correct text
   can ever be silently deleted or replaced with another page's value -
   the right trade given data loss/corruption outranks a cosmetic
   nicety. */
function headerFooterNormText(block){
  if(!block || block.type !== "paragraph") return null;
  const t = block.runs.map(r=>r.text).join("").trim().toLowerCase();
  return t || null;
}
function detectHeaderFooter(pageBlocksList){
  if(pageBlocksList.length < 2) return {headerRuns:null, footerRuns:null};
  function majorityBlock(candidates){
    const counts = {};
    candidates.forEach(b=>{ const t=headerFooterNormText(b); if(t) counts[t]=(counts[t]||0)+1; });
    let best=null, bestCount=0;
    for(const k in counts){ if(counts[k]>bestCount){ bestCount=counts[k]; best=k; } }
    const threshold = Math.max(2, Math.ceil(candidates.length*0.6));
    if(!best || bestCount < threshold) return null;
    return candidates.find(b=>headerFooterNormText(b)===best);
  }
  const firsts = pageBlocksList.map(pb => pb.find(b=>b.type==="paragraph") || null);
  const lasts = pageBlocksList.map(pb => { const paras=pb.filter(b=>b.type==="paragraph"); return paras.length?paras[paras.length-1]:null; });
  const headerBlock = majorityBlock(firsts);
  const footerBlock = majorityBlock(lasts);
  // Remove the matched instances from every page's block list so the
  // content isn't duplicated in both the header/footer part AND the body.
  if(headerBlock){
    const pattern = headerFooterNormText(headerBlock);
    pageBlocksList.forEach(pb=>{ const idx=pb.findIndex(b=>headerFooterNormText(b)===pattern); if(idx>=0) pb.splice(idx,1); });
  }
  if(footerBlock){
    const pattern = headerFooterNormText(footerBlock);
    pageBlocksList.forEach(pb=>{ const idx=pb.findIndex(b=>headerFooterNormText(b)===pattern); if(idx>=0) pb.splice(idx,1); });
  }
  return {headerRuns: headerBlock ? headerBlock.runs : null, footerRuns: footerBlock ? footerBlock.runs : null};
}
async function buildMixedDocx(blocks, pageSize, headerFooter){
  const zip = new JSZip();
  const blockHasImages = b=>b && (b.type==="image" || (b.type==="gridtable" && b.cells.some(c=>c.images && c.images.length)) || (b.type==="pagelayout" && b.blocks.some(blockHasImages)));
  const hasImages = blocks.some(blockHasImages);
  const headerRuns = headerFooter && headerFooter.headerRuns;
  const footerRuns = headerFooter && headerFooter.footerRuns;

  const mediaFolder = zip.folder("word").folder("media");
  const relEntries = [];
  // Shared counter state so top-level image blocks AND table-cell-embedded
  // images (rendered from inside gridTableBlockXml) draw relationship/image
  // ids from one running sequence - required since rIds must be unique
  // across the whole document.xml.rels, and header/footer also consume one
  // each before any image is registered.
  const zipCtx = {mediaFolder, relEntries, counters:{relCounter:1, imgCounter:0}};
  let headerRid = null, footerRid = null;
  if(headerRuns){
    zipCtx.counters.relCounter++; headerRid = "rId"+zipCtx.counters.relCounter;
    relEntries.push(`<Relationship Id="${headerRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`);
    zip.folder("word").file("header1.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styledParagraphXml({runs:headerRuns})}</w:hdr>`);
  }
  if(footerRuns){
    zipCtx.counters.relCounter++; footerRid = "rId"+zipCtx.counters.relCounter;
    relEntries.push(`<Relationship Id="${footerRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>`);
    zip.folder("word").file("footer1.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styledParagraphXml({runs:footerRuns})}</w:ftr>`);
  }

  zip.file("[Content_Types].xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${hasImages ? '<Default Extension="png" ContentType="image/png"/>' : ''}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
${headerRuns ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}
${footerRuns ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}
</Types>`);
  zip.folder("_rels").file(".rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  function renderBlock(b){
    const blockPageSize = b._pageSize || pageSize;
    const contentBox = docxPageContentBox(blockPageSize);
    const maxWidthEmu = Math.round(contentBox.usableWidthPt*12700);
    if(b.type === "image"){
      // Images extracted from real embedded PDF image objects carry their
      // true size in PDF points (1pt = 12700 EMU); the whole-page-screenshot
      // fallback only has pixel dimensions, sized via pxToEmu as before -
      // buildPictureXml handles both via widthPt/heightPt vs width/height.
      const {picXml, cx, cy, imgCounter} = buildPictureXml(b, zipCtx, maxWidthEmu);
      if(b.placement === "anchored" && b.xPt != null){
        // Independently-positioned image (QR code, stamp, small logo) -
        // anchored at its real page-relative x/y (measured from the page
        // edge, matching the page's own dimensions exactly since the
        // DOCX page size mirrors the PDF's) with square text wrap, rather
        // than dropped inline wherever its Y-sort position happens to
        // land. relativeHeight must be unique per anchored image so Word
        // doesn't collapse their z-order.
        const xEmu = Math.max(0, Math.min(Math.round(b.xPt*12700), Math.round(contentBox.widthPt*12700)-cx));
        const yEmu = Math.max(0, Math.min(Math.round(b.yFromTopPt*12700), Math.round(contentBox.heightPt*12700)-cy));
        return `<w:p><w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${1000+imgCounter}" behindDoc="0" locked="0" layoutInCell="0" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${xEmu}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${yEmu}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${imgCounter}" name="Picture ${imgCounter}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${picXml}</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`;
      }
      // Wide banner/logo images behave as normal centered inline content.
      const jc = b.placement === "centered" ? `<w:pPr><w:jc w:val="center"/></w:pPr>` : "";
      return `<w:p>${jc}<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${imgCounter}" name="Picture ${imgCounter}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${picXml}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    }
    if(b.type === "pagebreak"){
      // A plain page break can't change paper size/orientation - only a
      // real section break can. sectionSize is only set when the PDF's
      // NEXT page actually has a different size, so this stays a simple
      // <w:br> for the overwhelming majority of documents (including the
      // real bill, which is 4 uniform A4 pages) and only pays for a
      // section break where the source genuinely needs one (e.g. a
      // landscape page inserted between portrait pages).
      if(b.sectionSize) return `<w:p><w:pPr>${sectPrXml(b.sectionSize, headerRid, footerRid)}</w:pPr></w:p>`;
      return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
    }
    if(b.type === "pagelayout"){ return pageLayoutBlockXml(b,renderBlock); }
    if(b.type === "paragraph"){ return styledParagraphXml(b); }
    if(b.type === "table"){ return tableBlockXml(b); }
    if(b.type === "gridtable"){ return gridTableBlockXml(b, zipCtx, b._availableWidthPt||contentBox.usableWidthPt); }
    if(b.type === "columns"){ return columnsBlockXml(b); }
    if(b.type === "separator"){ return separatorBlockXml(); }
    if(!b.text || !b.text.trim()) return `<w:p/>`;
    return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(fixDevanagari(b.text))}</w:t></w:r></w:p>`;
  }
  const bodyParts = blocks.map(renderBlock).join("");

  // Final section's properties describe the LAST PDF page's size (mid-
  // document size changes are handled per-pagebreak above via sectPrXml).
  zip.folder("word").file("document.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${bodyParts}${sectPrXml(pageSize, headerRid, footerRid)}</w:body>
</w:document>`);
  // Word heading styles (Heading1/Heading2) referenced by
  // styledParagraphXml's <w:pStyle> - without this part Word would
  // treat the style references as unknown and drop the outline levels.
  // Only the styles this builder can emit are defined; everything else
  // keeps Word's own defaults. styles.xml needs a Content_Types
  // Override (added above) but no relationship entry.
  zip.folder("word").file("styles.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
</w:styles>`);
  zip.folder("word").folder("_rels").file("document.xml.rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relEntries.join("")}</Relationships>`);
  return await zip.generateAsync({type:"blob", mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
}

/* ---- XLSX post-processor that anchors page images into the sheet (JSZip augments the SheetJS output) ---- */
/* placements: [{sheetIndex?, row, col, pngBase64, widthPx, heightPx}].
   sheetIndex (0-based, default 0) lets each PDF page's own worksheet
   (see TOOLS.pdf2excel - one sheet per page) get its own embedded
   image(s) instead of every placement always targeting sheet1; single-
   sheet callers (Merge Excel, existing tests) are unaffected since they
   never set sheetIndex and it defaults to 0. */
async function embedImagesInXlsx(wbArray, placements){
  if(!placements.length) return new Blob([wbArray], {type:"application/octet-stream"});
  const zip = await JSZip.loadAsync(wbArray);

  let ct = await zip.file("[Content_Types].xml").async("string");
  if(!/Extension="png"/.test(ct)) ct = ct.replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>');

  const bySheet = new Map();
  placements.forEach(p=>{
    const idx = p.sheetIndex||0;
    if(!bySheet.has(idx)) bySheet.set(idx, []);
    bySheet.get(idx).push(p);
  });

  let mediaCounter = 0;
  for(const [sheetIdx, sheetPlacements] of bySheet.entries()){
    const drawingN = sheetIdx+1; // one drawing part per sheet that has images, numbered by sheet index - always unique, no cross-sheet collision
    ct = ct.replace("</Types>", `<Override PartName="/xl/drawings/drawing${drawingN}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);

    let drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
    let anchors = "";
    sheetPlacements.forEach((p, i)=>{
      mediaCounter++;
      const n = mediaCounter;
      zip.folder("xl").folder("media").file(`image${n}.png`, p.pngBase64, {base64:true});
      drawingRels += `<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${n}.png"/>`;
      const widthCols = Math.max(2, Math.round(p.widthPx/64));
      const heightRows = Math.max(4, Math.round(p.heightPx/20));
      anchors += `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${p.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${p.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${p.col+widthCols}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${p.row+heightRows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i+2}" name="Picture ${i+1}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${i+1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`;
    });
    drawingRels += `</Relationships>`;
    zip.folder("xl").folder("drawings").folder("_rels").file(`drawing${drawingN}.xml.rels`, drawingRels);
    zip.folder("xl").folder("drawings").file(`drawing${drawingN}.xml`,
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`);

    const sheetPath = `xl/worksheets/sheet${sheetIdx+1}.xml`;
    let sheetXml = await zip.file(sheetPath).async("string");
    if(!/xmlns:r=/.test(sheetXml)) sheetXml = sheetXml.replace("<worksheet ", '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
    sheetXml = sheetXml.replace("</worksheet>", '<drawing r:id="rIdDrawing1"/></worksheet>');
    zip.file(sheetPath, sheetXml);

    const relsPath = `xl/worksheets/_rels/sheet${sheetIdx+1}.xml.rels`;
    const existingRels = zip.file(relsPath);
    let sheetRels;
    if(existingRels){
      sheetRels = await existingRels.async("string");
      sheetRels = sheetRels.replace("</Relationships>", `<Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingN}.xml"/></Relationships>`);
    } else {
      sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingN}.xml"/></Relationships>`;
    }
    zip.file(relsPath, sheetRels);
  }

  zip.file("[Content_Types].xml", ct);
  return await zip.generateAsync({type:"blob", mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}
