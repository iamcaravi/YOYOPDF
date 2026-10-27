/* ---- Wave D extra tools (new tools + iLovePDF parity) ----
   Classic script, same pattern as the other js/tools/*.js files:
   TOOLS.<id> functions open a panel with openPanel(); the pure
   helpers below it are DOM-free so tests can load this file in a vm
   sandbox exactly like tests/pdf-to-excel.test.js does for
   doc-export-builders.js. Nothing here needs a server, AI, or paid
   service; every tool is free, including the ones iLovePDF gates
   behind Premium (Edit Metadata) or desktop-only flows.

   WIRING NOTE: the PDF tools below call ensurePDFJS()/ensurePDFLib()
   (lazy-loaders.js, loaded synchronously on every page) before
   touching the pdfjsLib/PDFLib globals, and use extractPageBlocks/
   extractPageVisuals from js/core/doc-export-builders.js - so the
   runtime profile for these tools must include doc-export-builders.js
   (see the manifest patch in the Wave D report). If that script is
   ever absent, the tools fail loudly instead of silently producing
   empty output. */

/* ---------- Pure helpers (DOM-free, unit-tested) ---------- */

/* Word/character counts for one text string. Words are maximal
   non-whitespace runs; Devanagari and Latin count identically. */
function countWordsAndChars(text){
  const words = (String(text || "").match(/\S+/g) || []).length;
  return {words, chars: String(text || "").length, charsNoSpaces: String(text || "").replace(/\s/g, "").length};
}

/* ~200 words per minute, the standard reading-speed estimate. 0 words
   (a scanned/image-only page) honestly reports 0, never a fake 1. */
function readingMinutes(words){
  return words === 0 ? 0 : Math.max(1, Math.ceil(words / 200));
}

/* Joins one page's pdf.js text items into reading-order plain text.
   A space is inserted only when the next item starts measurably to
   the right of the previous item's end (geometry, not guessing), and
   a newline is emitted wherever pdf.js marks end-of-line. */
function pageTextFromItems(items){
  let text = "", prevEndX = null, prevSize = 10;
  for(const it of (items || [])){
    if(it.str === undefined) continue;
    if(!it.str){
      if(it.hasEOL) text += "\n";
      continue;
    }
    const size = Math.abs((it.transform && (it.transform[0] || it.transform[3])) || 10) || 10;
    const x = it.transform ? it.transform[4] : 0;
    const w = it.width || 0;
    if(text && prevEndX != null && !text.endsWith("\n") && !text.endsWith(" ")){
      const gap = x - prevEndX;
      if(gap > Math.max(2, prevSize * 0.2)) text += " ";
    }
    text += it.str;
    if(it.hasEOL) text += "\n";
    prevEndX = x + w;
    prevSize = size;
  }
  return text;
}

/* Word-level diff (LCS dynamic programming) between two token arrays.
   Returns coalesced ops: {op:"="|"-"|"+", text}. Pages with a huge
   token product fall back to a whole-page replace so one pathological
   page can never hang the tab on an O(n*m) table. */
function diffWordTokens(a, b){
  const A = a || [], B = b || [];
  if(A.length * B.length > 400000){
    if(A.join(" ") === B.join(" ")) return [{op: "=", text: A.join(" ")}];
    return [{op: "-", text: A.join(" ")}, {op: "+", text: B.join(" ")}];
  }
  const n = A.length, m = B.length;
  const dp = Array.from({length: n + 1}, ()=>new Uint32Array(m + 1));
  for(let i = n - 1; i >= 0; i--) for(let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while(i < n && j < m){
    if(A[i] === B[j]){ ops.push({op: "=", text: A[i]}); i++; j++; }
    else if(dp[i + 1][j] >= dp[i][j + 1]){ ops.push({op: "-", text: A[i]}); i++; }
    else { ops.push({op: "+", text: B[j]}); j++; }
  }
  while(i < n){ ops.push({op: "-", text: A[i++]}); }
  while(j < m){ ops.push({op: "+", text: B[j++]}); }
  const out = [];
  for(const o of ops){
    const last = out[out.length - 1];
    if(last && last.op === o.op) last.text += " " + o.text;
    else out.push({op: o.op, text: o.text});
  }
  return out;
}

/* Word counts per diff op, for the Compare summary line. */
function diffSummarize(ops){
  const counts = {added: 0, removed: 0, unchanged: 0};
  for(const o of (ops || [])){
    const n = (o.text.match(/\S+/g) || []).length;
    if(o.op === "+") counts.added += n;
    else if(o.op === "-") counts.removed += n;
    else counts.unchanged += n;
  }
  return counts;
}

/* FNV-1a over a sample of an embedded image's bytes, for deduping the
   same XObject painted on several pages (a logo on every page is ONE
   image, not N). Width/height/byte-length join the key so two
   different images that happen to share a hash prefix stay distinct. */
function imageDedupeKey(img){
  const data = img && img.data;
  let hash = 2166136261;
  if(data){
    const step = Math.max(1, Math.floor(data.length / 2048));
    for(let i = 0; i < data.length; i += step){ hash ^= data[i]; hash = Math.imul(hash, 16777619); }
  }
  return (img ? img.width : 0) + "x" + (img ? img.height : 0) + ":" + (data ? data.length : 0) + ":" + (hash >>> 0);
}

/* Unique embedded images from one page's extractPageVisuals() output.
   Placement geometry is kept for the thumbnail caption; the raw
   pdf.js image object is what gets encoded on download. */
function extractImagesFromVisuals(visuals){
  const seen = new Map();
  for(const im of ((visuals && visuals.images) || [])){
    if(!im.raw) continue;
    const key = imageDedupeKey(im.raw);
    if(!seen.has(key)) seen.set(key, {raw: im.raw, width: im.raw.width, height: im.raw.height, xPt: im.x, yPt: im.y, key});
  }
  return [...seen.values()];
}

/* Resolves one pdf.js image object id. pdf.js serves page-local ids
   (img_*) from page.objs and shared/global ids (g_*) from
   page.commonObjs; the promise form of get() throws for objects that
   are not resolved yet, so the callback form is used on the store the
   id prefix points at, with the other store as fallback. Without this
   split, a logo XObject painted on every page resolves only on the
   first page processed and is silently missing everywhere else:
   extractPageVisuals() awaits page.objs.get() inside a swallowed
   catch, so the second and later pages lose the image entirely
   (verified: a shared PNG drawn on two pages surfaced on one page
   only). The 8pt minimum below skips tiny decorative artifacts,
   matching extractPageVisuals. */
function extraStoreGet(store, objId, timeoutMs){
  return new Promise((resolve)=>{
    if(!store || typeof store.get !== "function"){ resolve(null); return; }
    let done = false;
    const timer = setTimeout(()=>{ if(!done){ done = true; resolve(null); } }, timeoutMs);
    try{
      store.get(objId, (img)=>{ if(!done){ done = true; clearTimeout(timer); resolve(img || null); } });
    }catch(e){ if(!done){ done = true; clearTimeout(timer); resolve(null); } }
  });
}

async function extraResolveImage(page, objId){
  const isGlobal = String(objId || "").indexOf("g_") === 0;
  const primary = isGlobal ? page.commonObjs : page.objs;
  const secondary = isGlobal ? page.objs : page.commonObjs;
  const first = await extraStoreGet(primary, objId, 2000);
  if(first) return first;
  return extraStoreGet(secondary, objId, 2000);
}

/* Enumerates the embedded images painted on one page, with placement
   geometry, resolving shared XObjects correctly on every page (see
   extraResolveImage). Returns the same {x, y, width, height, raw}
   shape extractPageVisuals() produces, so extractImagesFromVisuals()
   dedupes identically. Needs only the pdfjsLib global (ensurePDFJS
   first); it does not depend on doc-export-builders.js. */
async function extraExtractPageImages(pdoc, pageNum){
  const page = await pdoc.getPage(pageNum);
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const mul = (m, cur)=>[
    m[0]*cur[0]+m[1]*cur[2], m[0]*cur[1]+m[1]*cur[3],
    m[2]*cur[0]+m[3]*cur[2], m[2]*cur[1]+m[3]*cur[3],
    m[4]*cur[0]+m[5]*cur[2]+cur[4], m[4]*cur[1]+m[5]*cur[3]+cur[5]
  ];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const found = [];
  for(let idx = 0; idx < opList.fnArray.length; idx++){
    const fn = opList.fnArray[idx], args = opList.argsArray[idx];
    if(fn === OPS.save){ stack.push(ctm.slice()); }
    else if(fn === OPS.restore){ if(stack.length) ctm = stack.pop(); }
    else if(fn === OPS.transform){ ctm = mul(args, ctm); }
    else if(fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject){
      const w = Math.hypot(ctm[0], ctm[1]), h = Math.hypot(ctm[2], ctm[3]);
      if(w < 8 || h < 8) continue;
      const raw = await extraResolveImage(page, args[0]);
      if(raw && (raw.data || raw.bitmap)) found.push({x: ctm[4], y: ctm[5], width: w, height: h, raw});
    }
  }
  return found;
}

/* Renders extractPageBlocks() output as Markdown: ATX headings inferred
   from bold + relative size (the same signal linesToParagraphs already
   computes), GFM pipe tables for both table shapes (spans become empty
   cells so columns stay aligned), lists, and --- separators. Two-column
   blocks flatten left-then-right and are disclosed as partial in the
   tool UI, exactly as the converters disclose multi-column limits. */
function blocksToMarkdown(blocks){
  const sizes = [];
  for(const b of (blocks || [])){
    if(b.type === "paragraph") for(const r of (b.runs || [])) if(r.text && r.text.trim() && r.size) sizes.push(r.size);
  }
  sizes.sort((a, b)=>a - b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 11;
  const lines = [];
  function paraToMd(p){
    let s = (p.runs || []).map(r=>r.text || "").join("").replace(/\s+/g, " ").trim();
    if(!s) return "";
    const runs = (p.runs || []).filter(r=>r.text && r.text.trim());
    const allBold = runs.length > 0 && runs.every(r=>r.bold);
    const maxSize = runs.length ? Math.max(...runs.map(r=>r.size || median)) : median;
    s = s.replace(/^\s*(?:[•●▪‣\-*]|\d{1,3}[.)])\s+/, "");
    if(!s) return "";
    if(p.listItem) return "- " + s;
    if(allBold && s.length <= 140 && maxSize >= median * 1.75) return "# " + s;
    if(allBold && s.length <= 140 && maxSize >= median * 1.3) return "## " + s;
    if(allBold && s.length <= 140 && maxSize > median) return "### " + s;
    return s;
  }
  function escapeCell(v){
    return String(v == null ? "" : v).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  }
  function tableToMd(rows, nCols){
    const norm = (rows || []).map(row=>row.map(c=>escapeCell(c && c.text != null ? c.text : c)));
    if(!norm.length) return "";
    const width = nCols || Math.max(1, ...norm.map(r=>r.length));
    const pad = (r)=>{ const a = r.slice(); while(a.length < width) a.push(""); return a; };
    const out = ["| " + pad(norm[0]).join(" | ") + " |", "| " + pad(norm[0]).map(()=>"---").join(" | ") + " |"];
    for(let i = 1; i < norm.length; i++) out.push("| " + pad(norm[i]).join(" | ") + " |");
    return out.join("\n");
  }
  for(const b of (blocks || [])){
    if(b.type === "paragraph"){ const md = paraToMd(b); if(md) lines.push(md); }
    else if(b.type === "table"){ const md = tableToMd(b.rows || []); if(md) lines.push(md); }
    else if(b.type === "gridtable"){
      const grid = Array.from({length: b.nRows}, ()=>Array(b.nCols).fill(""));
      for(const cell of (b.cells || [])){
        if(cell.r0 < b.nRows && cell.c0 < b.nCols) grid[cell.r0][cell.c0] = escapeCell(cell.text);
      }
      const md = tableToMd(grid, b.nCols);
      if(md) lines.push(md);
    }
    else if(b.type === "columns"){
      for(const p of (b.left || [])){ const md = paraToMd(p); if(md) lines.push(md); }
      for(const p of (b.right || [])){ const md = paraToMd(p); if(md) lines.push(md); }
    }
    else if(b.type === "separator"){ lines.push("---"); }
  }
  return lines.join("\n\n");
}

/* Standard PDF page sizes in points (1pt = 1/72in). */
const PAGE_SIZE_PRESETS_PT = Object.freeze({
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008]
});

/* Pure geometry for Resize Page Size: where the source page lands
   inside the target box. fit = scale-to-fit centred (default);
   fill = scale-to-cover centred (overflow is clipped by the viewer's
   page box); stretch = distort to fill; center = 1:1 centred. */
function resizePageGeometry(srcW, srcH, dstW, dstH, mode){
  if(mode === "stretch") return {x: 0, y: 0, width: dstW, height: dstH};
  if(mode === "center") return {x: (dstW - srcW) / 2, y: (dstH - srcH) / 2, width: srcW, height: srcH};
  const s = mode === "fill" ? Math.max(dstW / srcW, dstH / srcH) : Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * s, h = srcH * s;
  return {x: (dstW - w) / 2, y: (dstH - h) / 2, width: w, height: h};
}

/* Rebuilds a PDF with every page resized to opts.size ([wPt, hPt])
   via embed/draw, so text and vectors scale losslessly (only embedded
   raster images resample visually). Rotated source pages are
   normalized by swapping axes before geometry, matching how the
   embedded page is drawn. Uses the global PDFLib (ensurePDFLib first). */
async function resizePdfPageSize(pdfBytes, opts){
  const src = await PDFLib.PDFDocument.load(pdfBytes);
  const dst = await PDFLib.PDFDocument.create();
  const size = opts.size;
  for(let i = 0; i < src.getPageCount(); i++){
    const srcPage = src.getPage(i);
    const {width: rawW, height: rawH} = srcPage.getSize();
    const angle = (srcPage.getRotation && srcPage.getRotation().angle) || 0;
    const swapped = angle === 90 || angle === 270;
    const srcW = swapped ? rawH : rawW, srcH = swapped ? rawW : rawH;
    const page = dst.addPage([size[0], size[1]]);
    // Blank pages have no Contents entry and pdf-lib refuses to embed
    // them ("Can't embed page with missing Contents"); they become
    // blank pages at the new size instead of failing the whole resize.
    let hasContents = true;
    try{ hasContents = !!srcPage.node.Contents(); }catch(e){ hasContents = true; }
    if(!hasContents) continue;
    const [embedded] = await dst.embedPdf(src, [i]);
    const g = resizePageGeometry(srcW, srcH, size[0], size[1], opts.mode || "fit");
    page.drawPage(embedded, {x: g.x, y: g.y, width: g.width, height: g.height});
  }
  return dst.save();
}

/* Pure geometry for Scan to PDF / image-to-PDF: fit an image inside a
   page box with a margin, centred. */
function fitImageIntoPage(imgW, imgH, pageW, pageH, marginPt){
  const availW = Math.max(1, pageW - 2 * marginPt), availH = Math.max(1, pageH - 2 * marginPt);
  const s = Math.min(availW / imgW, availH / imgH);
  const w = imgW * s, h = imgH * s;
  return {x: marginPt + (availW - w) / 2, y: marginPt + (availH - h) / 2, width: w, height: h};
}

/* Reads the Info-dictionary metadata pdf-lib exposes. Getters are
   guarded: a missing entry returns ""/null, never a throw. */
function readPdfMetadata(doc){
  const get = (fn)=>{ try{ const v = doc[fn](); return v == null ? "" : v; }catch(e){ return ""; } };
  const getDate = (fn)=>{ try{ const d = doc[fn](); return d instanceof Date ? d : null; }catch(e){ return null; } };
  let keywords = get("getKeywords");
  if(Array.isArray(keywords)) keywords = keywords.join(", ");
  return {
    title: get("getTitle"), author: get("getAuthor"), subject: get("getSubject"),
    keywords: keywords || "", creator: get("getCreator"), producer: get("getProducer"),
    creationDate: getDate("getCreationDate"), modificationDate: getDate("getModificationDate")
  };
}

/* Applies metadata fields to a pdf-lib document. clearAll blanks every
   string field and resets both dates to the epoch instead of deleting
   the entries (pdf-lib has no "remove" for these). Keywords are
   stored as an array, split on commas. */
function applyPdfMetadata(doc, fields, clearAll){
  const f = fields || {};
  const val = (v)=>clearAll ? "" : (v || "");
  doc.setTitle(val(f.title));
  doc.setAuthor(val(f.author));
  doc.setSubject(val(f.subject));
  const kw = clearAll ? [] : String(f.keywords || "").split(",").map(s=>s.trim()).filter(Boolean);
  doc.setKeywords(kw);
  doc.setCreator(val(f.creator));
  doc.setProducer(val(f.producer));
  if(clearAll){
    doc.setCreationDate(new Date(0));
    doc.setModificationDate(new Date(0));
  } else {
    if(f.creationDate) doc.setCreationDate(f.creationDate);
    if(f.modificationDate) doc.setModificationDate(f.modificationDate);
  }
}

/* ---------- Shared panel scaffolding (DOM, browser-only) ---------- */

function extraEscHtml(s){
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* Standard panel shape shared by every tool in this file (same shape
   as PDF to Word: panel-head, tool-hero, upload wrap, privacy hint,
   options, hidden toolbar with the primary Go button, #out). */
function extraPanelHtml(t, toolId, accept, multiple, labelKey, heroDescKey, goLabel, optionsHtml){
  return `
    <div class="panel-head"><h3>${t("tools." + toolId)}</h3></div>
    <div class="panel-body compact tool-workspace" id="${toolId}Body">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools." + toolId)}</h2>
        <p class="tool-hero-desc">${t(heroDescKey)}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML(accept, multiple, t(labelKey))}
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFiles")}</p>
      ${optionsHtml || ""}
      <div class="tool-toolbar" id="goToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${goLabel}</button>
      </div>
      <div id="out"></div>
    </div>`;
}

/* Single-file dropzone wiring shared by the PDF tools: clears #out on
   a new selection, renders the file card, reveals the toolbar. The
   caller owns the file variable via onSelect(file, onRemove). */
function extraWireSingleFile(toolId, onSelect){
  wireDropzone(fs=>{
    const file = fs[0];
    document.getElementById("out").innerHTML = "";
    renderFileList([file], ()=>{ onSelect(null); document.getElementById("goToolbar").style.display = "none"; document.getElementById(toolId + "Body").classList.remove("is-loaded"); });
    onSelect(file);
    document.getElementById("goToolbar").style.display = "flex";
    document.getElementById(toolId + "Body").classList.add("is-loaded");
  });
}

/* Copy-to-clipboard for the text tools. On clipboard failure the
   preview is selected so the user can copy manually - never a dead
   button with no recourse. */
function wireCopyButton(btnId, previewId, getText, t){
  const btn = document.getElementById(btnId);
  if(!btn) return;
  btn.addEventListener("click", async ()=>{
    try{
      await navigator.clipboard.writeText(getText());
      toast(t("toolExtra.copied"));
    }catch(e){
      toast(t("toolExtra.copySelectHint"));
      const preview = document.getElementById(previewId);
      if(preview){ preview.focus(); try{ preview.select(); }catch(_){} }
    }
  });
}

/* Delivers a generated text file (.txt/.md) the way the app's other
   tools deliver downloads: a preview block stays visible in #out and
   the standard success/download card follows it. */
function deliverTextResult({text, filename, previewHtml, previewId, copyBtnId, t}){
  const out = document.getElementById("out");
  const blob = new Blob([text], {type: "text/plain;charset=utf-8"});
  const {url} = downloadBlob(blob, filename);
  out.innerHTML = previewHtml;
  if(copyBtnId) wireCopyButton(copyBtnId, previewId, ()=>text, t);
  setStatus(t("workspace.done"), true);
  out.appendChild(resultBox({sizeText: fmtSize(blob.size), sizeGood: true, url, filename}));
}

/* Throws a clear, actionable error when the block-extraction script
   (doc-export-builders.js) is not loaded - the profile wiring for
   these tools must include it. Never silently returns empty output. */
function requireBlockExtraction(){
  if(typeof extractPageBlocks !== "function" || typeof extractPageVisuals !== "function")
    throw new Error("Block extraction is unavailable on this page (doc-export-builders.js did not load).");
}

/* ---- PDF COUNTER ---- */
TOOLS.pdfcounter = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file = null;
  openPanel(extraPanelHtml(t, "pdfcounter", "application/pdf", false, "workspace.selectPdfFiles", "toolPdfCounter.heroDesc", t("toolPdfCounter.countButton"), ""));
  extraWireSingleFile("pdfcounter", (f)=>{ file = f; });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolPdfCounter.statusCounting"));
    await ensurePDFJS();
    const bytes = await file.arrayBuffer();
    const pdoc = operation.track(await loadPdfJsSafe({data: bytes}));
    const perPage = [];
    let totalWords = 0, totalChars = 0, totalCharsNoSpaces = 0, totalImages = 0, imagesKnown = true;
    for(let i = 1; i <= pdoc.numPages; i++){
      setStatus(t("toolPdfCounter.statusCounting"), false, Math.round((i / pdoc.numPages) * 100));
      const page = await pdoc.getPage(i);
      const content = await page.getTextContent();
      const text = pageTextFromItems(content.items);
      const c = countWordsAndChars(text);
      // Local enumerator, not extractPageVisuals: the shared helper
      // silently drops shared XObjects on every page after the first
      // (see extraResolveImage), which would undercount images here.
      let images = null;
      try{ images = (await extraExtractPageImages(pdoc, i)).length; totalImages += images; }
      catch(e){ imagesKnown = false; }
      totalWords += c.words; totalChars += c.chars; totalCharsNoSpaces += c.charsNoSpaces;
      perPage.push({page: i, words: c.words, chars: c.chars, images});
    }
    const minutes = readingMinutes(totalWords);
    const rows = perPage.map(p=>`<tr><td>${p.page}</td><td>${p.words}</td><td>${p.chars}</td><td>${p.images == null ? "—" : p.images}</td></tr>`).join("");
    const scannedNote = totalWords === 0
      ? `<p class="tool-note">${extraEscHtml(t("toolPdfCounter.scannedNote"))}</p>` : "";
    const summaryText = [
      t("toolPdfCounter.pagesLabel") + ": " + pdoc.numPages,
      t("toolPdfCounter.wordsLabel") + ": " + totalWords,
      t("toolPdfCounter.charsLabel") + ": " + totalChars,
      t("toolPdfCounter.charsNoSpacesLabel") + ": " + totalCharsNoSpaces,
      t("toolPdfCounter.imagesLabel") + ": " + (imagesKnown ? totalImages : "—"),
      t("toolPdfCounter.fileSizeLabel") + ": " + fmtSize(file.size),
      t("toolPdfCounter.readingTimeLabel") + ": " + (minutes === 0 ? "—" : t("toolPdfCounter.readingMinutes", {n: minutes}))
    ].join("\n");
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.innerHTML = `
      <div class="tool-result-summary">
        <div class="tool-result-grid">
          <div><span class="tool-result-num">${pdoc.numPages}</span><span class="tool-result-lbl">${extraEscHtml(t("toolPdfCounter.pagesLabel"))}</span></div>
          <div><span class="tool-result-num">${totalWords}</span><span class="tool-result-lbl">${extraEscHtml(t("toolPdfCounter.wordsLabel"))}</span></div>
          <div><span class="tool-result-num">${totalChars}</span><span class="tool-result-lbl">${extraEscHtml(t("toolPdfCounter.charsLabel"))}</span></div>
          <div><span class="tool-result-num">${imagesKnown ? totalImages : "—"}</span><span class="tool-result-lbl">${extraEscHtml(t("toolPdfCounter.imagesLabel"))}</span></div>
          <div><span class="tool-result-num">${fmtSize(file.size)}</span><span class="tool-result-lbl">${extraEscHtml(t("toolPdfCounter.fileSizeLabel"))}</span></div>
          <div><span class="tool-result-num">${minutes === 0 ? "—" : t("toolPdfCounter.readingMinutes", {n: minutes})}</span><span class="tool-result-lbl">${extraEscHtml(t("toolPdfCounter.readingTimeLabel"))}</span></div>
        </div>
        ${scannedNote}
        <table class="tool-result-table"><thead><tr><th>${extraEscHtml(t("toolPdfCounter.pageCol"))}</th><th>${extraEscHtml(t("toolPdfCounter.wordsLabel"))}</th><th>${extraEscHtml(t("toolPdfCounter.charsLabel"))}</th><th>${extraEscHtml(t("toolPdfCounter.imagesLabel"))}</th></tr></thead><tbody>${rows}</tbody></table>
        <button type="button" class="btn secondary" id="copyCounterBtn">${extraEscHtml(t("toolExtra.copyResults"))}</button>
      </div>`;
    document.getElementById("copyCounterBtn").addEventListener("click", async ()=>{
      try{ await navigator.clipboard.writeText(summaryText); toast(t("toolExtra.copied")); }
      catch(e){ toast(t("toolExtra.copySelectHint")); }
    });
  }));
};

/* ---- EXTRACT IMAGES FROM PDF ---- */
TOOLS.extractimages = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file = null;
  openPanel(extraPanelHtml(t, "extractimages", "application/pdf", false, "workspace.selectPdfFiles", "toolExtractImages.heroDesc", t("toolExtractImages.extractButton"), ""));
  extraWireSingleFile("extractimages", (f)=>{ file = f; });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolExtractImages.statusExtracting"));
    requireBlockExtraction();
    await ensurePDFJS();
    await ensureJSZip();
    const bytes = await file.arrayBuffer();
    const pdoc = operation.track(await loadPdfJsSafe({data: bytes}));
    // Global dedupe: the same logo XObject painted on every page is
    // ONE image, listed once with every page it appears on.
    const byKey = new Map();
    for(let i = 1; i <= pdoc.numPages; i++){
      setStatus(t("toolExtractImages.statusExtracting"), false, Math.round((i / pdoc.numPages) * 100));
      // Local enumerator: extractPageVisuals silently drops shared
      // XObjects on every page after the first (see extraResolveImage),
      // so the per-page lists below would be incomplete.
      const found = extractImagesFromVisuals({images: await extraExtractPageImages(pdoc, i)});
      for(const entry of found){
        if(!byKey.has(entry.key)) byKey.set(entry.key, {entry, pages: []});
        byKey.get(entry.key).pages.push(i);
      }
    }
    const unique = [...byKey.values()];
    if(!unique.length){
      setStatus(t("toolExtractImages.noneFound"), true);
      if(!operation.isCurrent()) return;
      out.innerHTML = `<p class="tool-note">${extraEscHtml(t("toolExtractImages.noneFound"))}</p>`;
      return;
    }
    // Thumbnails use the same PNG conversion the converters already
    // rely on; if it is ever unavailable the list still downloads.
    const canThumb = typeof pdfImageToPngBase64 === "function";
    const items = [];
    for(let n = 0; n < unique.length; n++){
      const {entry, pages} = unique[n];
      let blob = null, thumbUrl = "";
      try{
        // pdfImageToPngBase64 returns BARE base64 (canvasToPngBase64
        // strips the data: prefix) - decode it directly, no split.
        const b64 = pdfImageToPngBase64(entry.raw);
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for(let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
        blob = new Blob([arr], {type: "image/png"});
        // createObjectURL directly: downloadBlob() revokes the previous
        // result URL, which would break every earlier thumbnail link.
        if(canThumb) thumbUrl = URL.createObjectURL(blob);
      }catch(e){ /* entry stays downloadable only if a blob was built */ }
      items.push({entry, pages, blob, thumbUrl, name: `image-${n + 1}-p${pages[0]}.png`});
    }
    const downloadable = items.filter(it=>it.blob);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    const cards = items.map(it=>`
      <div class="tool-extract-card">
        ${it.thumbUrl ? `<img src="${it.thumbUrl}" alt="">` : `<div class="tool-extract-nothumb">${extraEscHtml(t("toolExtractImages.noPreview"))}</div>`}
        <div class="tool-extract-meta">${extraEscHtml(it.name)} · ${it.entry.width}×${it.entry.height}px · ${extraEscHtml(t("toolExtractImages.pagesLabel", {pages: it.pages.join(", ")}))}</div>
        ${it.blob ? `<a class="dl-link" href="${URL.createObjectURL(it.blob)}" download="${extraEscHtml(it.name)}">⬇ ${extraEscHtml(t("workspace.download"))}</a>` : ""}
      </div>`).join("");
    out.innerHTML = `<div class="tool-extract-grid">${cards}</div>`;
    if(downloadable.length > 1){
      const zip = new JSZip();
      for(const it of downloadable) zip.file(it.name, it.blob);
      const zipBlob = await zip.generateAsync({type: "blob"});
      const zipName = suffixedName(file, "images", "zip");
      const {url} = downloadBlob(zipBlob, zipName);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText: fmtSize(zipBlob.size) + " · " + t("toolImgBatch.doneFiles", {n: downloadable.length}), sizeGood: true, url, filename: zipName}));
    } else if(downloadable.length === 1){
      const {url} = downloadBlob(downloadable[0].blob, downloadable[0].name);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText: fmtSize(downloadable[0].blob.size), sizeGood: true, url, filename: downloadable[0].name}));
    }
  }));
};

/* ---- EXTRACT TEXT FROM PDF ---- */
TOOLS.extracttext = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file = null, pageCount = 0;
  const optionsHtml = `<div id="pagePick" style="display:none"><div class="field"><label>${t("toolExtractText.pagesLabel")}</label><div id="pagePickList"></div></div></div>
    <p class="tool-note" id="extractTextNote" hidden>${extraEscHtml(t("toolExtractText.scannedNote"))}</p>`;
  openPanel(extraPanelHtml(t, "extracttext", "application/pdf", false, "workspace.selectPdfFiles", "toolExtractText.heroDesc", t("toolExtractText.extractButton"), optionsHtml));
  wireDropzone(async fs=>{
    file = fs[0];
    document.getElementById("out").innerHTML = "";
    document.getElementById("extractTextNote").hidden = true;
    renderFileList([file], ()=>{ file = null; pageCount = 0; document.getElementById("goToolbar").style.display = "none"; document.getElementById("pagePick").style.display = "none"; document.getElementById("extracttextBody").classList.remove("is-loaded"); });
    document.getElementById("goToolbar").style.display = "flex";
    document.getElementById("extracttextBody").classList.add("is-loaded");
    // Page list needs the page count up front; the document is opened
    // here only to count pages and destroyed again - extraction opens
    // it fresh in the Go handler.
    try{
      await ensurePDFJS();
      const bytes = await file.arrayBuffer();
      const pdoc = await loadPdfJsSafe({data: bytes});
      pageCount = pdoc.numPages;
      try{ await pdoc.destroy(); }catch(e){}
      const list = document.getElementById("pagePickList");
      list.innerHTML = Array.from({length: pageCount}, (_, i)=>`<label style="font-size:.85rem;display:inline-flex;gap:4px;align-items:center;margin:0 10px 4px 0;"><input type="checkbox" class="extracttext-page" value="${i + 1}" checked> ${i + 1}</label>`).join("");
      document.getElementById("pagePick").style.display = "";
    }catch(e){
      toast(e.message || t("workspace.thisFileCouldNotBeOpened"));
    }
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolExtractText.statusExtracting"));
    await ensurePDFJS();
    const bytes = await file.arrayBuffer();
    const pdoc = operation.track(await loadPdfJsSafe({data: bytes}));
    const picked = [...document.querySelectorAll(".extracttext-page:checked")].map(cb=>parseInt(cb.value, 10)).sort((a, b)=>a - b);
    const pages = picked.length ? picked : Array.from({length: pdoc.numPages}, (_, i)=>i + 1);
    const parts = [];
    for(const n of pages){
      setStatus(t("toolExtractText.statusExtracting"), false, Math.round((pages.indexOf(n) + 1) / pages.length * 100));
      const page = await pdoc.getPage(n);
      const content = await page.getTextContent();
      const text = pageTextFromItems(content.items).trim();
      parts.push((parts.length ? "\n\n--- " + t("toolExtractText.pageMarker", {n}) + " ---\n\n" : "") + text);
    }
    const fullText = parts.join("");
    if(!fullText.trim()){
      setStatus(t("workspace.done"), true);
      if(!operation.isCurrent()) return;
      document.getElementById("extractTextNote").hidden = false;
      out.innerHTML = `<p class="tool-note">${extraEscHtml(t("toolExtractText.scannedNote"))}</p>`;
      return;
    }
    // Preview is capped for display only; the download holds everything.
    const PREVIEW_LIMIT = 200000;
    const preview = fullText.length > PREVIEW_LIMIT ? fullText.slice(0, PREVIEW_LIMIT) + "\n\n… (" + t("toolExtractText.previewTruncated") + ")" : fullText;
    const previewHtml = `<div class="field"><label for="extraTextPreview">${extraEscHtml(t("toolExtractText.previewLabel"))}</label>
      <textarea id="extraTextPreview" readonly rows="12" style="width:100%">${extraEscHtml(preview)}</textarea></div>
      <button type="button" class="btn secondary" id="copyTextBtn">${extraEscHtml(t("toolExtra.copyResults"))}</button>`;
    if(!operation.isCurrent()) return;
    deliverTextResult({text: fullText, filename: suffixedName(file, "extracted", "txt"), previewHtml, previewId: "extraTextPreview", copyBtnId: "copyTextBtn", t});
  }));
};

/* ---- EDIT PDF METADATA ---- */
TOOLS.pdfmetadata = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file = null, srcBytes = null;
  function localDateTimeInput(d){
    if(!(d instanceof Date) || isNaN(d)) return "";
    const p = (n)=>String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  const optionsHtml = `<div id="metaForm" style="display:none">
      <div class="field"><label for="metaTitle">${t("toolPdfMetadata.titleLabel")}</label><input type="text" id="metaTitle"></div>
      <div class="field"><label for="metaAuthor">${t("toolPdfMetadata.authorLabel")}</label><input type="text" id="metaAuthor"></div>
      <div class="field"><label for="metaSubject">${t("toolPdfMetadata.subjectLabel")}</label><input type="text" id="metaSubject"></div>
      <div class="field"><label for="metaKeywords">${t("toolPdfMetadata.keywordsLabel")}</label><input type="text" id="metaKeywords"></div>
      <div class="field"><label for="metaCreator">${t("toolPdfMetadata.creatorLabel")}</label><input type="text" id="metaCreator"></div>
      <div class="field"><label for="metaProducer">${t("toolPdfMetadata.producerLabel")}</label><input type="text" id="metaProducer"></div>
      <div class="field"><label for="metaCreated">${t("toolPdfMetadata.createdLabel")}</label><input type="datetime-local" id="metaCreated"></div>
      <div class="field"><label for="metaModified">${t("toolPdfMetadata.modifiedLabel")}</label><input type="datetime-local" id="metaModified"></div>
      <label style="font-size:.85rem;display:flex;gap:6px;align-items:center;"><input type="checkbox" id="metaClearAll"> ${t("toolPdfMetadata.clearAllLabel")}</label>
    </div>`;
  openPanel(extraPanelHtml(t, "pdfmetadata", "application/pdf", false, "workspace.selectPdfFiles", "toolPdfMetadata.heroDesc", t("toolPdfMetadata.saveButton"), optionsHtml));
  wireDropzone(async fs=>{
    file = fs[0];
    srcBytes = null;
    document.getElementById("out").innerHTML = "";
    document.getElementById("metaForm").style.display = "none";
    renderFileList([file], ()=>{ file = null; srcBytes = null; document.getElementById("goToolbar").style.display = "none"; document.getElementById("metaForm").style.display = "none"; document.getElementById("pdfmetadataBody").classList.remove("is-loaded"); });
    document.getElementById("goToolbar").style.display = "flex";
    document.getElementById("pdfmetadataBody").classList.add("is-loaded");
    try{
      await ensurePDFLib();
      srcBytes = await file.arrayBuffer();
      const doc = await loadPdfSafe(srcBytes.slice(0));
      const meta = readPdfMetadata(doc);
      document.getElementById("metaTitle").value = meta.title;
      document.getElementById("metaAuthor").value = meta.author;
      document.getElementById("metaSubject").value = meta.subject;
      document.getElementById("metaKeywords").value = meta.keywords;
      document.getElementById("metaCreator").value = meta.creator;
      document.getElementById("metaProducer").value = meta.producer;
      document.getElementById("metaCreated").value = localDateTimeInput(meta.creationDate);
      document.getElementById("metaModified").value = localDateTimeInput(meta.modificationDate);
      document.getElementById("metaForm").style.display = "";
    }catch(e){
      toast(e.message || t("workspace.thisFileCouldNotBeOpened"));
    }
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolPdfMetadata.statusSaving"));
    await ensurePDFLib();
    const doc = await loadPdfSafe(srcBytes.slice(0));
    const clearAll = document.getElementById("metaClearAll").checked;
    const createdVal = document.getElementById("metaCreated").value;
    const modifiedVal = document.getElementById("metaModified").value;
    applyPdfMetadata(doc, {
      title: document.getElementById("metaTitle").value,
      author: document.getElementById("metaAuthor").value,
      subject: document.getElementById("metaSubject").value,
      keywords: document.getElementById("metaKeywords").value,
      creator: document.getElementById("metaCreator").value,
      producer: document.getElementById("metaProducer").value,
      creationDate: createdVal ? new Date(createdVal) : null,
      modificationDate: modifiedVal ? new Date(modifiedVal) : null
    }, clearAll);
    const bytes = await doc.save();
    const blob = new Blob([bytes], {type: "application/pdf"});
    const outName = suffixedName(file, "metadata_updated", "pdf");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url} = downloadBlob(blob, outName);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText: fmtSize(blob.size), sizeGood: true, url, filename: outName}));
  }));
};

/* Whether a page's blocks carry any real text (local equivalent of the
   converters' blockHasRealText - that helper lives in the convert
   profile, which these tools do not load). */
function extraBlocksHaveText(blocks){
  return (blocks || []).some(b=>{
    if(b.type === "paragraph") return (b.runs || []).some(r=>r.text && r.text.trim());
    if(b.type === "table") return (b.rows || []).some(row=>row.some(c=>c.text && String(c.text).trim()));
    if(b.type === "gridtable") return (b.cells || []).some(c=>c.text && String(c.text).trim());
    if(b.type === "columns") return [...(b.left || []), ...(b.right || [])].some(p=>(p.runs || []).some(r=>r.text && r.text.trim()));
    return false;
  });
}

/* ---- PDF TO MARKDOWN ---- */
TOOLS.pdf2md = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file = null;
  const optionsHtml = `<p class="tool-note">${extraEscHtml(t("toolPdf2md.columnsNote"))}</p>`;
  openPanel(extraPanelHtml(t, "pdf2md", "application/pdf", false, "workspace.selectPdfFiles", "toolPdf2md.heroDesc", t("toolPdf2md.convertButton"), optionsHtml));
  extraWireSingleFile("pdf2md", (f)=>{ file = f; });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolPdf2md.statusConverting"));
    requireBlockExtraction();
    await ensurePDFJS();
    const bytes = await file.arrayBuffer();
    const pdoc = operation.track(await loadPdfJsSafe({data: bytes}));
    const pageMds = [];
    for(let i = 1; i <= pdoc.numPages; i++){
      setStatus(t("toolPdf2md.statusConverting"), false, Math.round((i / pdoc.numPages) * 100));
      let visuals = {images: [], shapes: [], colorSpans: []};
      try{ visuals = await extractPageVisuals(pdoc, i); }catch(e){ /* text still extracts fine */ }
      let blocks = [];
      try{ blocks = await extractPageBlocks(pdoc, i, visuals); }catch(e){ /* fall through to the plain fallback */ }
      if(!extraBlocksHaveText(blocks)){
        try{
          const fallback = await extractPlainPageParagraphs(pdoc, i);
          if(extraBlocksHaveText(fallback)) blocks = fallback;
        }catch(e){ /* a genuinely textless page contributes nothing */ }
      }
      pageMds.push(blocksToMarkdown(blocks));
    }
    const anyContent = pageMds.some(md=>md.trim());
    const fullMd = pageMds.map((md, idx)=>"<!-- " + t("toolPdf2md.pageMarker", {n: idx + 1}) + " -->\n\n" + md).join("\n\n").trim() + "\n";
    if(!anyContent){
      setStatus(t("workspace.done"), true);
      if(!operation.isCurrent()) return;
      out.innerHTML = `<p class="tool-note">${extraEscHtml(t("toolPdf2md.scannedNote"))}</p>`;
      return;
    }
    const PREVIEW_LIMIT = 100000;
    const preview = fullMd.length > PREVIEW_LIMIT ? fullMd.slice(0, PREVIEW_LIMIT) + "\n\n… (" + t("toolExtractText.previewTruncated") + ")" : fullMd;
    const previewHtml = `<div class="field"><label for="extraMdPreview">${extraEscHtml(t("toolPdf2md.previewLabel"))}</label>
      <textarea id="extraMdPreview" readonly rows="14" style="width:100%;font-family:monospace">${extraEscHtml(preview)}</textarea></div>
      <button type="button" class="btn secondary" id="copyMdBtn">${extraEscHtml(t("toolExtra.copyResults"))}</button>`;
    if(!operation.isCurrent()) return;
    deliverTextResult({text: fullMd, filename: suffixedName(file, "markdown", "md"), previewHtml, previewId: "extraMdPreview", copyBtnId: "copyMdBtn", t});
  }));
};

/* ---- RESIZE PAGE SIZE ---- */
TOOLS.resizepages = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file = null;
  const optionsHtml = `
    <div class="field"><label for="rsSize">${t("toolResizePages.sizeLabel")}</label>
      <select id="rsSize">
        <option value="a4">A4 (595 × 842 pt)</option>
        <option value="letter">US Letter (612 × 792 pt)</option>
        <option value="legal">US Legal (612 × 1008 pt)</option>
        <option value="custom">${t("toolResizePages.customSize")}</option>
      </select>
    </div>
    <div class="field" id="rsCustomField" style="display:none">
      <label for="rsCustomW">${t("toolResizePages.customWidthLabel")}</label><input type="number" id="rsCustomW" value="595" min="36" max="2000">
      <label for="rsCustomH" style="margin-top:6px">${t("toolResizePages.customHeightLabel")}</label><input type="number" id="rsCustomH" value="842" min="36" max="2000">
    </div>
    <div class="field"><label for="rsOrient">${t("toolResizePages.orientationLabel")}</label>
      <select id="rsOrient"><option value="portrait">${t("toolResizePages.portrait")}</option><option value="landscape">${t("toolResizePages.landscape")}</option></select>
    </div>
    <div class="field"><label for="rsFitMode">${t("toolResizePages.fitLabel")}</label>
      <select id="rsFitMode">
        <option value="fit">${t("toolResizePages.fitMode")}</option>
        <option value="fill">${t("toolResizePages.fillMode")}</option>
        <option value="stretch">${t("toolResizePages.stretchMode")}</option>
        <option value="center">${t("toolResizePages.centerMode")}</option>
      </select>
    </div>
    <p class="tool-note">${extraEscHtml(t("toolResizePages.note"))}</p>`;
  openPanel(extraPanelHtml(t, "resizepages", "application/pdf", false, "workspace.selectPdfFiles", "toolResizePages.heroDesc", t("toolResizePages.resizeButton"), optionsHtml));
  extraWireSingleFile("resizepages", (f)=>{ file = f; });
  document.getElementById("rsSize").addEventListener("change", ()=>{
    document.getElementById("rsCustomField").style.display = document.getElementById("rsSize").value === "custom" ? "" : "none";
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolResizePages.statusResizing"));
    await ensurePDFLib();
    const preset = document.getElementById("rsSize").value;
    let size = preset === "custom"
      ? [Math.max(36, parseFloat(document.getElementById("rsCustomW").value) || 595), Math.max(36, parseFloat(document.getElementById("rsCustomH").value) || 842)]
      : PAGE_SIZE_PRESETS_PT[preset].slice();
    if(document.getElementById("rsOrient").value === "landscape" && size[0] < size[1]) size = [size[1], size[0]];
    if(document.getElementById("rsOrient").value === "portrait" && size[0] > size[1]) size = [size[1], size[0]];
    const mode = document.getElementById("rsFitMode").value;
    const bytes = await file.arrayBuffer();
    const outBytes = await resizePdfPageSize(bytes, {size, mode});
    const blob = new Blob([outBytes], {type: "application/pdf"});
    const outName = suffixedName(file, "resized", "pdf");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url} = downloadBlob(blob, outName);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText: fmtSize(blob.size), sizeGood: true, url, filename: outName}));
  }));
};

/* ---- COMPARE PDF ---- */
TOOLS.comparepdf = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let fileA = null, fileB = null;
  const optionsHtml = `
    <div class="field"><label for="compareFileB">${t("toolCompare.secondFileLabel")}</label><input type="file" id="compareFileB" accept="application/pdf,.pdf"></div>
    <div id="compareFileBName" class="tool-note" hidden></div>
    <p class="tool-note">${extraEscHtml(t("toolCompare.scannedNote"))}</p>`;
  openPanel(extraPanelHtml(t, "comparepdf", "application/pdf", false, "workspace.selectPdfFiles", "toolCompare.heroDesc", t("toolCompare.compareButton"), optionsHtml));
  wireDropzone(fs=>{
    fileA = fs[0];
    document.getElementById("out").innerHTML = "";
    renderFileList([fileA], ()=>{ fileA = null; document.getElementById("goToolbar").style.display = "none"; document.getElementById("comparepdfBody").classList.remove("is-loaded"); });
    document.getElementById("goToolbar").style.display = "flex";
    document.getElementById("comparepdfBody").classList.add("is-loaded");
  });
  document.getElementById("compareFileB").addEventListener("change", (e)=>{
    const f = e.target.files && e.target.files[0];
    fileB = null;
    const nameEl = document.getElementById("compareFileBName");
    if(!f){ nameEl.hidden = true; return; }
    if(f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")){
      toast(t("toolCompare.errSecondMustBePdf"));
      e.target.value = "";
      return;
    }
    fileB = f;
    nameEl.hidden = false;
    nameEl.textContent = f.name + " · " + fmtSize(f.size);
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    if(!fileA || !fileB){ toast(t("toolCompare.errChooseBoth")); return; }
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolCompare.statusComparing"));
    await ensurePDFJS();
    const bytesA = await fileA.arrayBuffer();
    const bytesB = await fileB.arrayBuffer();
    const docA = operation.track(await loadPdfJsSafe({data: bytesA}));
    const docB = operation.track(await loadPdfJsSafe({data: bytesB}));
    const maxPages = Math.max(docA.numPages, docB.numPages);
    let added = 0, removed = 0, changedPages = 0;
    const sections = [];
    const noTextNote = extraEscHtml(t("toolCompare.noText"));
    for(let i = 1; i <= maxPages; i++){
      setStatus(t("toolCompare.statusComparing"), false, Math.round((i / maxPages) * 100));
      async function pageText(doc, n){
        if(n > doc.numPages) return null;
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        return pageTextFromItems(content.items).trim();
      }
      const textA = await pageText(docA, i);
      const textB = await pageText(docB, i);
      const missing = (t2)=>t2 == null || t2 === "";
      let leftHtml, rightHtml, pageChanged;
      if(missing(textA) && missing(textB)){
        leftHtml = `<p class="tool-note">${noTextNote}</p>`;
        rightHtml = `<p class="tool-note">${noTextNote}</p>`;
        pageChanged = false;
      } else if(missing(textA) || missing(textB)){
        // One side has no extractable text (scanned page, or the page
        // does not exist in that file): show what exists, mark changed.
        leftHtml = missing(textA) ? `<p class="tool-note">${noTextNote}</p>` : `<p>${extraEscHtml(textA)}</p>`;
        rightHtml = missing(textB) ? `<p class="tool-note">${noTextNote}</p>` : `<p>${extraEscHtml(textB)}</p>`;
        pageChanged = true;
        const counts = countWordsAndChars(missing(textA) ? textB : textA);
        if(missing(textA)) added += counts.words; else removed += counts.words;
      } else {
        const ops = diffWordTokens(textA.match(/\S+/g) || [], textB.match(/\S+/g) || []);
        const sum = diffSummarize(ops);
        added += sum.added; removed += sum.removed;
        pageChanged = sum.added > 0 || sum.removed > 0;
        const render = (side)=>{
          let html = "";
          for(const o of ops){
            if(side === "a" && o.op === "+") continue;
            if(side === "b" && o.op === "-") continue;
            const esc = extraEscHtml(o.text);
            if(o.op === "=") html += esc + " ";
            else if(o.op === "-") html += `<del class="cmp-del">${esc}</del> `;
            else html += `<ins class="cmp-ins">${esc}</ins> `;
          }
          return `<p>${html}</p>`;
        };
        leftHtml = render("a");
        rightHtml = render("b");
      }
      if(pageChanged) changedPages++;
      sections.push(`<div class="cmp-page" data-page="${i}">
        <div class="cmp-page-head">${extraEscHtml(t("toolCompare.pageLabel", {n: i}))}${pageChanged ? ` <span class="cmp-changed">${extraEscHtml(t("toolCompare.changedLabel"))}</span>` : ` <span class="cmp-same">${extraEscHtml(t("toolCompare.unchangedLabel"))}</span>`}</div>
        <div class="cmp-cols">
          <div class="cmp-pane" data-pane="a" style="max-height:320px;overflow:auto">${leftHtml}</div>
          <div class="cmp-pane" data-pane="b" style="max-height:320px;overflow:auto">${rightHtml}</div>
        </div>
      </div>`);
    }
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.innerHTML = `
      <div class="tool-result-summary">
        <p>${extraEscHtml(t("toolCompare.summary", {pages: maxPages, changed: changedPages, added, removed}))}</p>
        ${sections.join("")}
      </div>`;
    // Scroll sync within each page pair (guarded so syncing one pane
    // never ping-pongs back from the other).
    out.querySelectorAll(".cmp-page").forEach(section=>{
      const a = section.querySelector('[data-pane="a"]');
      const b = section.querySelector('[data-pane="b"]');
      let syncing = false;
      const sync = (from, to)=>{
        if(syncing) return;
        syncing = true;
        to.scrollTop = from.scrollTop;
        to.scrollLeft = from.scrollLeft;
        syncing = false;
      };
      a.addEventListener("scroll", ()=>sync(a, b));
      b.addEventListener("scroll", ()=>sync(b, a));
    });
  }));
};

/* ---- SCAN TO PDF (camera capture only - NO OCR, no "make searchable") ---- */
TOOLS.scantopdf = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let shots = [];
  let stream = null, stopStreamCleanup = null;
  function stopCamera(){
    if(stream){ stream.getTracks().forEach(tr=>{ try{ tr.stop(); }catch(e){} }); stream = null; }
    const video = document.getElementById("scanVideo");
    if(video) video.srcObject = null;
  }
  const cameraSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  openPanel(`
    <div class="panel-head"><h3>${t("tools.scantopdf")}</h3></div>
    <div class="panel-body compact tool-workspace" id="scantopdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.scantopdf")}</h2>
        <p class="tool-hero-desc">${t("toolScan.heroDesc")}</p>
      </div>
      <div id="scanCameraBlock" ${cameraSupported ? "" : 'style="display:none"'}>
        <video id="scanVideo" autoplay playsinline muted style="width:100%;max-height:360px;background:#000"></video>
        <div style="display:flex;gap:8px;margin:8px 0;flex-wrap:wrap">
          <button type="button" class="btn secondary" id="scanStart">${t("toolScan.startCamera")}</button>
          <button type="button" class="btn tool-toolbar-primary" id="scanCapture" disabled>${t("toolScan.capture")}</button>
          <button type="button" class="btn secondary" id="scanStop" disabled>${t("toolScan.stopCamera")}</button>
        </div>
      </div>
      <p class="tool-note" ${cameraSupported ? 'hidden id="scanNoCameraNote"' : 'id="scanNoCameraNote"'}>${extraEscHtml(t("toolScan.cameraUnavailable"))}</p>
      <div id="scanShots" style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0"></div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("image/*", true, t("toolScan.uploadImages"))}
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="field"><label for="scanSize">${t("toolScan.pageSizeLabel")}</label>
        <select id="scanSize"><option value="fit">${t("toolScan.sizeFit")}</option><option value="a4">A4</option><option value="letter">US Letter</option></select>
      </div>
      <div class="field"><label for="scanMargin">${t("toolScan.marginLabel")}</label>
        <select id="scanMargin"><option value="0">${t("toolScan.marginNone")}</option><option value="36">${t("toolScan.marginSmall")}</option><option value="72">${t("toolScan.marginBig")}</option></select>
      </div>
      <p class="tool-note">${extraEscHtml(t("toolScan.noOcrNote"))}</p>
      <div class="tool-toolbar" id="goToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("toolScan.buildPdf")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  if(typeof registerToolCleanup === "function") stopStreamCleanup = registerToolCleanup(stopCamera);

  function renderShots(){
    const strip = document.getElementById("scanShots");
    strip.innerHTML = "";
    shots.forEach((shot, idx)=>{
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:relative;width:110px";
      const im = document.createElement("img");
      im.src = shot.url;
      im.style.cssText = "width:110px;height:150px;object-fit:cover;display:block";
      wrap.appendChild(im);
      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;gap:4px;margin-top:4px";
      const mkBtn = (label, fn, disabled)=>{
        const b = document.createElement("button");
        b.type = "button"; b.className = "btn secondary"; b.textContent = label; b.disabled = !!disabled;
        b.style.cssText = "padding:2px 6px;font-size:.75rem";
        b.addEventListener("click", fn);
        return b;
      };
      bar.appendChild(mkBtn("↑", ()=>{ if(idx > 0){ const s = shots.splice(idx, 1)[0]; shots.splice(idx - 1, 0, s); renderShots(); } }, idx === 0));
      bar.appendChild(mkBtn("↓", ()=>{ if(idx < shots.length - 1){ const s = shots.splice(idx, 1)[0]; shots.splice(idx + 1, 0, s); renderShots(); } }, idx === shots.length - 1));
      bar.appendChild(mkBtn("✕", ()=>{ URL.revokeObjectURL(shot.url); shots.splice(idx, 1); renderShots(); }));
      wrap.appendChild(bar);
      strip.appendChild(wrap);
    });
    document.getElementById("goToolbar").style.display = shots.length ? "flex" : "none";
    document.getElementById("scantopdfBody").classList.toggle("is-loaded", shots.length > 0);
  }
  function addShot(blob, name){
    shots.push({blob, url: URL.createObjectURL(blob), name: name || ("shot-" + (shots.length + 1) + ".jpg")});
    renderShots();
  }
  document.getElementById("scanStart").addEventListener("click", async ()=>{
    try{
      stopCamera();
      stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: "environment"}, audio: false});
      const video = document.getElementById("scanVideo");
      video.srcObject = stream;
      document.getElementById("scanCapture").disabled = false;
      document.getElementById("scanStop").disabled = false;
    }catch(e){
      toast(t("toolScan.cameraFailed"));
      document.getElementById("scanNoCameraNote").hidden = false;
    }
  });
  document.getElementById("scanStop").addEventListener("click", ()=>{
    stopCamera();
    document.getElementById("scanCapture").disabled = true;
    document.getElementById("scanStop").disabled = true;
  });
  document.getElementById("scanCapture").addEventListener("click", async ()=>{
    const video = document.getElementById("scanVideo");
    if(!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const blob = await new Promise(res=>canvas.toBlob(res, "image/jpeg", 0.92));
    if(blob) addShot(blob, "shot-" + (shots.length + 1) + ".jpg");
  });
  wireDropzone(fs=>{
    document.getElementById("out").innerHTML = "";
    for(const f of fs) addShot(f, f.name);
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolScan.statusBuilding"));
    await ensurePDFLib();
    const sizeChoice = document.getElementById("scanSize").value;
    const margin = parseFloat(document.getElementById("scanMargin").value) || 0;
    const doc = await PDFLib.PDFDocument.create();
    for(let i = 0; i < shots.length; i++){
      setStatus(t("toolScan.statusBuilding"), false, Math.round(((i + 1) / shots.length) * 100));
      const bytes = new Uint8Array(await shots[i].blob.arrayBuffer());
      let embedded, imgW, imgH;
      if(shots[i].blob.type === "image/jpeg" || shots[i].name.toLowerCase().endsWith(".jpg") || shots[i].name.toLowerCase().endsWith(".jpeg")){
        embedded = await doc.embedJpg(bytes);
      } else if(shots[i].blob.type === "image/png" || shots[i].name.toLowerCase().endsWith(".png")){
        embedded = await doc.embedPng(bytes);
      } else {
        // WebP/AVIF/GIF and friends: decode through the browser and
        // re-encode as PNG so pdf-lib can embed them.
        const bitmap = await createImageBitmap(shots[i].blob);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        const pngBlob = await new Promise(res=>canvas.toBlob(res, "image/png"));
        embedded = await doc.embedPng(new Uint8Array(await pngBlob.arrayBuffer()));
      }
      imgW = embedded.width; imgH = embedded.height;
      let page, dims;
      if(sizeChoice === "fit"){
        page = doc.addPage([imgW, imgH]);
        dims = {x: 0, y: 0, width: imgW, height: imgH};
      } else {
        const preset = PAGE_SIZE_PRESETS_PT[sizeChoice];
        page = doc.addPage([preset[0], preset[1]]);
        dims = fitImageIntoPage(imgW, imgH, preset[0], preset[1], margin);
      }
      page.drawImage(embedded, dims);
    }
    const pdfBytes = await doc.save();
    stopCamera();
    if(stopStreamCleanup) stopStreamCleanup();
    const blob = new Blob([pdfBytes], {type: "application/pdf"});
    const outName = "scan.pdf";
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url} = downloadBlob(blob, outName);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText: fmtSize(blob.size), sizeGood: true, url, filename: outName}));
  }));
};
