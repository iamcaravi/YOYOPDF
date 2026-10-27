/* ---- Image tools ---- */
/* Shared by all 6 image tools (compress/resize/crop/convert/watermark/
   invert). A failed <img> load rejects with a raw DOM Event, not an
   Error - left as-is, that surfaces to the user (via the app's global
   unhandledrejection safety net, none of these 6 call sites wrap this
   in their own try/catch) as the literal text "Something went wrong
   ([object Event])" - confirmed by testing a corrupt file through
   Convert Image Format. Wrapping it in a real Error with a clear
   message here fixes the message everywhere this is called from at
   once, rather than patching 6 separate call sites. */
function loadImage(file, {retainObjectUrl=false} = {}){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    const url = URL.createObjectURL(file);
    let settled = false;
    const release = () => {
      if(!retainObjectUrl) URL.revokeObjectURL(url);
    };
    img.onload = ()=>{
      if(settled) return;
      settled = true;
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if(width > YOYO_RESOURCE_LIMITS.maxImageDimension ||
         height > YOYO_RESOURCE_LIMITS.maxImageDimension ||
         width * height > YOYO_RESOURCE_LIMITS.maxImagePixels){
        URL.revokeObjectURL(url);
        reject(new ResourceValidationError(
          T("workspace.errImageTooLargeDimensions", {name: file.name}),
          "image-too-large"
        ));
        return;
      }
      release();
      resolve(img);
    };
    img.onerror = ()=>{
      if(settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      reject(new Error(T("workspace.errCouldNotReadImageNamed", {name: file.name})));
    };
    img.src=url;
  });
}

/* Shared by imgcompress and imgconvert - the two call sites that can
   encode a canvas to JPEG from an arbitrary source format. A blank 2D
   canvas defaults to transparent BLACK; JPEG has no alpha channel, so
   drawing a transparent PNG straight onto it and encoding as JPEG bakes
   the transparent regions in as black instead of white. Filling white
   first is a no-op for already-opaque sources (the source fully covers
   it) and is only applied when the output is actually JPEG, so PNG/WebP
   outputs keep real alpha untouched. */
function canvasContextForOutput(canvas, mime){
  const ctx = canvas.getContext("2d");
  if(mime === "image/jpeg"){
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return ctx;
}

/* ---- Shared batch helpers (Wave D) ----
   iLoveIMG's free tier processes 30 files at once; these six tools
   were single-file only. Every batch below caps at IMG_BATCH_LIMIT
   (below the app-wide 40-file budget in YOYO_RESOURCE_LIMITS) and
   processes files SEQUENTIALLY - decoding many large images in
   parallel can exhaust the tab. A file that fails to decode is
   skipped and counted, never silently dropped from the result. */
const IMG_BATCH_LIMIT = 30;

/* Pure: which files a batch keeps, and how many the cap trimmed. */
function imgBatchPlan(files, limit){
  const list = Array.from(files || []);
  return {kept: list.slice(0, limit), dropped: Math.max(0, list.length - limit)};
}

/* Pure: output dimensions for the three resize modes. Percent and
   fit-within are computed per source image; exact mode uses the
   caller's numbers verbatim. */
function imgResizeDimensions(srcW, srcH, mode, opts){
  opts = opts || {};
  if(mode === "percent"){
    const pct = Math.max(1, Math.min(400, Number(opts.percent) || 100));
    return {w: Math.max(1, Math.round(srcW * pct / 100)), h: Math.max(1, Math.round(srcH * pct / 100))};
  }
  if(mode === "fit"){
    const maxW = Math.max(1, Number(opts.maxW) || srcW);
    const maxH = Math.max(1, Number(opts.maxH) || srcH);
    const scale = Math.min(1, maxW / srcW, maxH / srcH);
    return {w: Math.max(1, Math.round(srcW * scale)), h: Math.max(1, Math.round(srcH * scale))};
  }
  return {w: Math.max(1, Math.round(Number(opts.w) || srcW)), h: Math.max(1, Math.round(Number(opts.h) || srcH))};
}

/* Pure: centre crop rectangle (natural pixels) for a target aspect
   ratio (width/height) - the batch-crop default per file. */
function cropRectForAspect(srcW, srcH, ratio){
  const r = ratio > 0 ? ratio : srcW / srcH;
  let sw = srcW, sh = Math.round(srcW / r);
  if(sh > srcH){ sh = srcH; sw = Math.round(srcH * r); }
  return {sx: Math.round((srcW - sw) / 2), sy: Math.round((srcH - sh) / 2), sw, sh};
}

/* Pure: canvas size needed to hold a w×h image rotated by angleDeg
   (90/270 swap axes; arbitrary angles use the bounding box). */
function rotateCanvasDimensions(w, h, angleDeg){
  const rad = ((angleDeg % 360) * Math.PI) / 180;
  // Snap cos/sin near 0/1: cos(270deg) is -1.8e-16, not 0, and ceil()
  // would otherwise make a 270-degree canvas 1px too big on each axis.
  const snap = (v)=>{ const a = Math.abs(v); return a < 1e-12 ? 0 : (Math.abs(a - 1) < 1e-12 ? 1 : a); };
  const cos = snap(Math.cos(rad)), sin = snap(Math.sin(rad));
  return {w: Math.max(1, Math.ceil(w * cos + h * sin)), h: Math.max(1, Math.ceil(w * sin + h * cos))};
}

/* Pure: top-left anchor for a watermark of (wmW×wmH) inside (w×h).
   position is "top-left" | "top-center" | ... | "bottom-right" (or
   "center"); margin keeps the stamp off the exact edge. */
function watermarkAnchor(w, h, wmW, wmH, position, margin){
  const m = Math.max(0, margin || 0);
  const xs = {left: m, center: Math.round((w - wmW) / 2), right: w - wmW - m};
  const ys = {top: m, middle: Math.round((h - wmH) / 2), bottom: h - wmH - m};
  const parts = String(position || "center").split("-");
  return {x: xs[parts[1]] != null ? xs[parts[1]] : xs.center, y: ys[parts[0]] != null ? ys[parts[0]] : ys.middle};
}

/* Runs processOne(file, index) sequentially over files; processOne
   returns {blob, meta?}. A failure skips that file and is counted,
   never aborting the rest of the batch. */
async function runImageBatch(files, processOne, onProgress){
  const results = [], failures = [];
  for(let i = 0; i < files.length; i++){
    try{
      const r = await processOne(files[i], i);
      if(r && r.blob) results.push({file: files[i], blob: r.blob, meta: r.meta || null});
      else failures.push(files[i].name);
    }catch(e){ failures.push(files[i].name); }
    if(onProgress) onProgress(i + 1, files.length);
  }
  return {results, failures};
}

/* Delivers batch results the way Compress PDF's multi-file ZIP already
   does: one file -> its own download; several -> one ZIP. Returns null
   when nothing succeeded (caller toasts). extFor(file, blob) picks the
   output extension per input file. doneMsg overrides the generic done
   status (used by Compress's target-reached wording for one file). */
async function deliverImageResults({results, failures, suffix, extFor, doneMsg, t, operation}){
  const out = document.getElementById("out");
  if(!results.length){ toast(t("toolImgBatch.errAllFailed")); return null; }
  let blob, outName;
  if(results.length === 1){
    blob = results[0].blob;
    outName = suffixedName(results[0].file, suffix, extFor(results[0].file, blob));
  } else {
    await ensureJSZip();
    const zip = new JSZip();
    for(const r of results) zip.file(suffixedName(r.file, suffix, extFor(r.file, r.blob)), r.blob);
    blob = await zip.generateAsync({type: "blob"});
    outName = (results[0].file.name.replace(/\.[^.]+$/, "") || "images") + "-" + suffix + ".zip";
  }
  setStatus(T("workspace.statusPreparingDownload"));
  if(operation && !operation.isCurrent()) return null;
  const {url} = downloadBlob(blob, outName);
  const failedNote = failures.length ? " " + t("toolImgBatch.skippedFiles", {n: failures.length}) : "";
  setStatus((doneMsg || t("workspace.done")) + failedNote, true);
  if(operation && !operation.isCurrent()) return null;
  const previewNode = document.createElement("img");
  previewNode.src = results.length === 1 ? url : URL.createObjectURL(results[0].blob);
  const sizeText = fmtSize(blob.size) + (results.length > 1 ? " · " + t("toolImgBatch.doneFiles", {n: results.length}) : "");
  out.appendChild(resultBox({sizeText, sizeGood: true, previewNode, url, filename: outName}));
  return {url, filename: outName};
}

TOOLS.imgcompress = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let files=[];
  openPanel(`
    <div class="panel-head"><h3>${t("tools.imgcompress")}</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="imgcompressBody">
      <div class="tool-hero" id="imgcompressHero">
        <h2 class="tool-hero-title">${t("tools.imgcompress")}</h2>
        <p class="tool-hero-desc">${t("toolImgCompress.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap" id="imgcompressUploadWrap">
        ${fileInputHTML("image/*", true, t("workspace.selectImages"))}
      </div>
      <p class="tool-privacy-hint" id="imgcompressPrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace" id="imgcompressWorkspace" style="display:none">
        <div class="tool-main-pane" id="imgcompressPreviewPane"></div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">${t("tools.imgcompress")}</h3>
          <div id="imgcompressFileSlot"></div>
          <div class="field"><label>${t("toolImgCompress.modeLabel")}</label>
            <label style="font-size:.85rem;display:flex;gap:6px;align-items:center;"><input type="radio" name="cmpMode" value="auto" checked> ${t("toolImgCompress.modeAuto")}</label>
            <label style="font-size:.85rem;display:flex;gap:6px;align-items:center;"><input type="radio" name="cmpMode" value="target"> ${t("toolImgCompress.modeTarget")}</label>
          </div>
          <div class="field"><label for="outFmt">${t("toolImgCompress.formatLabel")}</label>
            <select id="outFmt"><option value="keep">${t("toolImgCompress.formatKeep")}</option><option value="image/jpeg">JPG</option><option value="image/png">PNG</option><option value="image/webp">WebP</option></select>
          </div>
          <div class="field" id="targetKbField" style="display:none"><label for="targetKb">${t("toolImgCompress.targetSizeLabel")}</label><input type="number" id="targetKb" placeholder="e.g. 100"></div>
          <button class="btn tool-toolbar-primary" id="go">${t("toolImgCompress.compressImage")}</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("imgcompressHero");
  const uploadWrap = document.getElementById("imgcompressUploadWrap");
  const privacyHint = document.getElementById("imgcompressPrivacyHint");
  const workspace = document.getElementById("imgcompressWorkspace");
  const fileSlot = document.getElementById("imgcompressFileSlot");
  const previewPane = document.getElementById("imgcompressPreviewPane");
  const body = document.getElementById("imgcompressBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="grid";
    body.classList.add("is-loaded");
  }

  document.querySelectorAll('input[name="cmpMode"]').forEach(r=>r.addEventListener("change", ()=>{
    document.getElementById("targetKbField").style.display = document.querySelector('input[name="cmpMode"]:checked').value === "target" ? "" : "none";
  }));

  function renderFiles(){
    renderFileList(files, (i)=>{ files.splice(i, 1); if(!files.length){ showEmptyState(); } else { renderFiles(); } });
    fileSlot.appendChild(document.getElementById("flist"));
    previewPane.appendChild(document.getElementById("quickPreview"));
  }
  wireDropzone(fs=>{
    const plan = imgBatchPlan(fs, IMG_BATCH_LIMIT);
    files = plan.kept;
    if(plan.dropped) toast(t("toolImgBatch.batchLimitNote", {n: IMG_BATCH_LIMIT, dropped: plan.dropped}));
    renderFiles();
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out");
    const mode = document.querySelector('input[name="cmpMode"]:checked').value;
    const fmtChoice = document.getElementById("outFmt").value;
    let targetBytes = 0;
    if(mode === "target"){
      const targetKb = parseInt(document.getElementById("targetKb").value);
      if(!targetKb){ toast(t("toolImgCompress.errEnterTargetSize")); return; }
      targetBytes = targetKb * 1024;
    }
    out.innerHTML=statusEl(t("workspace.statusReadingImage"));
    // Auto mode walks a longer ladder and keeps the smallest encode
    // overall; target mode keeps the original 10-pass shape (quality
    // first, then downscale) and stops as soon as the target is met.
    const attempts = mode === "auto"
      ? [[0.92,1],[0.85,1],[0.75,1],[0.65,1],[0.55,1],[0.45,1],[0.35,1],[0.3,1],[0.55,0.8],[0.55,0.6],[0.55,0.45],[0.55,0.32]]
      : [[0.85,1],[0.75,1],[0.65,1],[0.55,1],[0.45,1],[0.35,1],[0.3,1],[0.7,0.85],[0.7,0.7],[0.7,0.55]];
    const {results, failures} = await runImageBatch(files, async (file)=>{
      const img = await loadImage(file);
      const fmt = fmtChoice === "keep" ? imgOutputFormat(file) : {mime: fmtChoice, ext: fmtChoice.split("/")[1]};
      let best = null, noGainStreak = 0;
      for(let i = 0; i < attempts.length; i++){
        const [quality, scale] = attempts[i];
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvasContextForOutput(canvas, fmt.mime).drawImage(img, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((res, rej)=>canvas.toBlob(b=>b ? res(b) : rej(new Error(t("toolImgCompress.errEncodeFailed"))), fmt.mime, quality));
        if(!best || blob.size < best.size){ best = blob; noGainStreak = 0; }
        else if(mode === "auto" && ++noGainStreak >= 2) break;
        if(mode === "target" && blob.size <= targetBytes) break;
      }
      let usedOriginal = false;
      if(best.size >= file.size){ best = file; usedOriginal = true; }
      return {blob: best, meta: {usedOriginal, targetKb: mode === "target" ? targetBytes / 1024 : 0}};
    }, (done, total)=>setStatus(t("toolImgBatch.statusProcessing", {n: done, total}), false, Math.round((done / total) * 100)));
    if(!operation.isCurrent()) return;
    let doneMsg = null;
    if(results.length === 1 && results[0].meta){
      const m = results[0].meta;
      doneMsg = m.usedOriginal ? t("toolImgCompress.doneKeptOriginal", {size: fmtSize(results[0].blob.size)})
        : (mode === "target"
          ? (results[0].blob.size <= targetBytes ? t("toolImgCompress.doneTargetReached") : t("toolImgCompress.doneBestPossible", {size: fmtSize(results[0].blob.size)}))
          : t("toolImgCompress.doneAuto", {size: fmtSize(results[0].blob.size)}));
    }
    await deliverImageResults({results, failures, suffix: "compressed",
      extFor: (file, blob)=>{
        if(blob === file) return (file.name.split(".").pop() || "jpg").toLowerCase();
        return fmtChoice === "keep" ? imgOutputFormat(file).ext : fmtChoice.split("/")[1];
      },
      doneMsg, t, operation});
  }));
};

TOOLS.imgresize = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let files=[], loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.imgresize")}</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="imgresizeBody">
      <div class="tool-hero" id="imgresizeHero">
        <h2 class="tool-hero-title">${t("tools.imgresize")}</h2>
        <p class="tool-hero-desc">${t("toolImgResize.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap" id="imgresizeUploadWrap">
        ${fileInputHTML("image/*", true, t("workspace.selectImages"))}
      </div>
      <p class="tool-privacy-hint" id="imgresizePrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace" id="imgresizeWorkspace" style="display:none">
        <div class="tool-main-pane" id="imgresizePreviewPane"></div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">${t("tools.imgresize")}</h3>
          <div id="imgresizeFileSlot"></div>
          <div class="field"><label for="rsMode">${t("toolImgResize.modeLabel")}</label>
            <select id="rsMode"><option value="exact">${t("toolImgResize.modeExact")}</option><option value="percent">${t("toolImgResize.modePercent")}</option><option value="fit">${t("toolImgResize.modeFit")}</option></select>
          </div>
          <div class="field"><label for="rsPreset">${t("toolImgResize.presetLabel")}</label>
            <select id="rsPreset"><option value="custom">${t("toolImgResize.presetCustom")}</option><option value="1920">1920 px wide</option><option value="1280">1280 px wide</option><option value="800">800 px wide</option><option value="50">50%</option><option value="25">25%</option></select>
          </div>
          <div class="field"><label for="rw">${t("toolImgResize.widthLabel")}</label><input type="number" id="rw" placeholder="800"></div>
          <div class="field"><label for="rh">${t("toolImgResize.heightLabel")}</label><input type="number" id="rh" placeholder="600"></div>
          <div class="field" id="rsPctField" style="display:none"><label for="rsPct">${t("toolImgResize.percentLabel")}</label><input type="number" id="rsPct" value="50" min="1" max="400"></div>
          <div class="field" id="rsFitField" style="display:none"><label for="rsMaxW">${t("toolImgResize.maxWidthLabel")}</label><input type="number" id="rsMaxW" placeholder="1920"><label for="rsMaxH" style="margin-top:6px">${t("toolImgResize.maxHeightLabel")}</label><input type="number" id="rsMaxH" placeholder="1080"></div>
          <label style="font-size:.85rem;display:flex;gap:6px;align-items:center;"><input type="checkbox" id="keepRatio" checked> ${t("toolImgResize.maintainAspectRatio")}</label>
          <button class="btn tool-toolbar-primary" id="go">${t("toolImgResize.resizeImage")}</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("imgresizeHero");
  const uploadWrap = document.getElementById("imgresizeUploadWrap");
  const privacyHint = document.getElementById("imgresizePrivacyHint");
  const workspace = document.getElementById("imgresizeWorkspace");
  const fileSlot = document.getElementById("imgresizeFileSlot");
  const previewPane = document.getElementById("imgresizePreviewPane");
  const body = document.getElementById("imgresizeBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="grid";
    body.classList.add("is-loaded");
  }

  let imgRef=null;
  function renderResizeFiles(){
    renderFileList(files, (i)=>{ loadToken++; files.splice(i, 1); imgRef = null; if(!files.length){ showEmptyState(); } else { renderResizeFiles(); } });
    fileSlot.appendChild(document.getElementById("flist"));
    previewPane.appendChild(document.getElementById("quickPreview"));
  }
  function syncRsModeFields(){
    const mode = document.getElementById("rsMode").value;
    document.getElementById("rsPctField").style.display = mode === "percent" ? "" : "none";
    document.getElementById("rsFitField").style.display = mode === "fit" ? "" : "none";
  }
  document.getElementById("rsMode").addEventListener("change", syncRsModeFields);
  document.getElementById("rsPreset").addEventListener("change", ()=>{
    const v = document.getElementById("rsPreset").value;
    if(v === "custom" || !imgRef) return;
    if(v === "50" || v === "25"){
      document.getElementById("rsMode").value = "percent";
      document.getElementById("rsPct").value = v;
    } else {
      document.getElementById("rsMode").value = "exact";
      document.getElementById("rw").value = v;
      document.getElementById("rh").value = Math.round(v * imgRef.height / imgRef.width);
    }
    syncRsModeFields();
  });

  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    const plan = imgBatchPlan(fs, IMG_BATCH_LIMIT);
    files = plan.kept;
    if(plan.dropped) toast(t("toolImgBatch.batchLimitNote", {n: IMG_BATCH_LIMIT, dropped: plan.dropped}));
    renderResizeFiles();
    // Was unguarded: a corrupt/unreadable file rejected here with
    // nothing catching it - the file card still appeared (renderFileList
    // above already ran), but the workspace never showed and nothing
    // told the user why. Confirmed by testing: the panel just sat there
    // silently forever. Every one of this tool's siblings that loads the
    // image at drop-time (Crop/Watermark/Invert Image) has the identical
    // pattern, fixed the same way.
    let loadedImg;
    try{ loadedImg = await loadImage(files[0]); }
    catch(e){
      if(myToken !== loadToken) return;
      toast(e.message || t("workspace.errCouldNotReadImageGeneric"));
      files=[]; imgRef=null; showEmptyState();
      return;
    }
    if(myToken !== loadToken) return;
    imgRef = loadedImg;
    document.getElementById("rw").value=imgRef.width;
    document.getElementById("rh").value=imgRef.height;
    showWorkspace();
  });
  document.getElementById("rw").addEventListener("input", ()=>{
    if(document.getElementById("keepRatio").checked && imgRef){
      document.getElementById("rh").value = Math.round(document.getElementById("rw").value * imgRef.height/imgRef.width);
    }
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("toolImgResize.statusResizing"));
    const mode = document.getElementById("rsMode").value;
    const wInput=+document.getElementById("rw").value, hInput=+document.getElementById("rh").value;
    const pct=+document.getElementById("rsPct").value;
    const maxW=+document.getElementById("rsMaxW").value, maxH=+document.getElementById("rsMaxH").value;
    const {results, failures} = await runImageBatch(files, async (file)=>{
      const img = await loadImage(file);
      const {w, h} = imgResizeDimensions(img.width, img.height, mode, {w: wInput, h: hInput, percent: pct, maxW, maxH});
      const canvas=document.createElement("canvas"); canvas.width=w; canvas.height=h;
      canvas.getContext("2d").drawImage(img,0,0,w,h);
      const {mime, ext} = imgOutputFormat(file);
      const blob = await new Promise((res, rej)=>canvas.toBlob(b=>b ? res(b) : rej(new Error(t("toolImgResize.errEncodeFailed"))), mime, 0.92));
      return {blob, meta: {ext}};
    }, (done, total)=>setStatus(t("toolImgBatch.statusProcessing", {n: done, total}), false, Math.round((done / total) * 100)));
    if(!operation.isCurrent()) return;
    await deliverImageResults({results, failures, suffix: "resized", extFor: (file)=>imgOutputFormat(file).ext, t, operation});
  }));
};

/* ---- CROP IMAGE ----
   Matches the Crop PDF workspace redesign: normalized (0..1) coordinates
   relative to the DISPLAYED image element's own box, so the selection
   stays correct across zoom/resize/DPI for free - no canvas-pixel/zoom
   math needed. The image itself is a real <img> (not a canvas redraw),
   so on-screen display is always crisp regardless of zoom; the actual
   crop output is drawn fresh from imgRef at its ORIGINAL natural pixel
   size (never from whatever downscaled/zoomed size happened to be on
   screen), so cropping a 4000px photo never silently degrades it to
   whatever the editor's display width was capped at. */
TOOLS.imgcrop = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null, imgRef=null, objectUrl=null, loadToken=0;
  let batchMode=false, batchFiles=[];
  let normRect=null; // {x0,y0,x1,y1} 0..1, fractions of the displayed image box
  let zoom=1; // multiplier over the computed "fit" width
  let activeRatio=null; // target pixel width/height, or null = free
  let rectEl=null;
  const MIN_SIZE=0.02;

  openPanel(`
    <div class="panel-head"><h3>${t("tools.imgcrop")}</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="imgcropBody">
      <div class="tool-hero" id="imgcropHero">
        <h2 class="tool-hero-title">${t("tools.imgcrop")}</h2>
        <p class="tool-hero-desc">${t("toolImgCrop.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap" id="imgcropUploadWrap">
        ${fileInputHTML("image/*", true, t("workspace.selectImages"))}
      </div>
      <p class="tool-privacy-hint" id="imgcropPrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace imgcrop-app-workspace" id="imgcropWorkspace" style="display:none">
        <div class="tool-main-pane imgcrop-main-pane">
          <div class="imgcrop-zoom">
            <button type="button" class="imgcrop-zoom-btn" id="imgZoomOut" aria-label="${t("workspace.zoomOut")}">−</button>
            <span class="imgcrop-zoom-level" id="imgZoomLevel">100%</span>
            <button type="button" class="imgcrop-zoom-btn" id="imgZoomIn" aria-label="${t("workspace.zoomIn")}">+</button>
            <button type="button" class="imgcrop-zoom-fit" id="imgZoomFit">${t("toolImgCrop.zoomFit")}</button>
          </div>
          <div class="imgcrop-viewport" id="imgcropViewport">
            <div class="imgcrop-canvas-wrap" id="imgcropCanvasWrap">
              <img id="imgcropImg" alt="" draggable="false">
              <div class="imgcrop-select-layer" id="imgcropSelectLayer"></div>
            </div>
          </div>
        </div>
        <aside class="tool-side-panel imgcrop-side-panel">
          <h3 class="tool-side-panel-title">${t("tools.imgcrop")}</h3>
          <div class="imgcrop-file-card">
            <div class="imgcrop-file-thumb" id="imgcropThumb"></div>
            <div class="imgcrop-file-meta">
              <div class="imgcrop-file-name" id="imgcropFileName"></div>
              <div class="imgcrop-file-dims" id="imgcropFileDims"></div>
            </div>
            <button type="button" class="imgcrop-file-remove" id="imgcropRemove" aria-label="${t("toolImgCrop.removeImage")}">✕</button>
          </div>
          <div class="imgcrop-instruction-card">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></svg>
            <div>
              <strong>${t("toolImgCrop.instructionTitle")}</strong>
              <p>${t("toolImgCrop.instructionDesc")}</p>
            </div>
          </div>
          <div>
            <span class="tool-side-panel-section-label">${t("toolImgCrop.aspectRatioLabel")}</span>
            <div class="imgcrop-ratio-grid" id="imgcropRatioGrid" style="margin-top:6px;">
              <button type="button" class="imgcrop-ratio-btn active" data-ratio="free">${t("toolImgCrop.ratioFree")}</button>
              <button type="button" class="imgcrop-ratio-btn" data-ratio="1:1">1:1</button>
              <button type="button" class="imgcrop-ratio-btn" data-ratio="4:5">4:5</button>
              <button type="button" class="imgcrop-ratio-btn" data-ratio="16:9">16:9</button>
              <button type="button" class="imgcrop-ratio-btn" data-ratio="3:2">3:2</button>
              <button type="button" class="imgcrop-ratio-btn" data-ratio="4:3">4:3</button>
              <button type="button" class="imgcrop-ratio-btn" data-ratio="5:4">5:4</button>
              <button type="button" class="imgcrop-ratio-btn" data-ratio="3:4">3:4</button>
              <button type="button" class="imgcrop-ratio-btn" data-ratio="2:3">2:3</button>
              <button type="button" class="imgcrop-ratio-btn" data-ratio="original">${t("toolImgCrop.ratioOriginal")}</button>
            </div>
          </div>
          <div id="imgcropBatchNote" style="font-size:.85rem;color:var(--ink-soft)" hidden></div>
          <label class="imgcrop-lock-row"><input type="checkbox" id="imgcropLock"> ${t("toolImgCrop.lockRatio")}</label>
          <div class="split-error" id="imgcropError" hidden></div>
          <div class="imgcrop-side-actions">
            <button class="btn secondary" id="resetCrop" type="button">${t("toolImgCrop.resetSelection")}</button>
            <button class="btn tool-toolbar-primary" id="go" disabled>${t("toolImgCrop.cropImageArrow")}</button>
          </div>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("imgcropHero");
  const uploadWrap = document.getElementById("imgcropUploadWrap");
  const privacyHint = document.getElementById("imgcropPrivacyHint");
  const workspace = document.getElementById("imgcropWorkspace");
  const body = document.getElementById("imgcropBody");
  const errorBox = document.getElementById("imgcropError");
  const goBtn = document.getElementById("go");
  const resetBtn = document.getElementById("resetCrop");
  const viewport = document.getElementById("imgcropViewport");
  const canvasWrap = document.getElementById("imgcropCanvasWrap");
  const imgEl = document.getElementById("imgcropImg");
  const selectLayer = document.getElementById("imgcropSelectLayer");
  const zoomInBtn = document.getElementById("imgZoomIn");
  const zoomOutBtn = document.getElementById("imgZoomOut");
  const zoomFitBtn = document.getElementById("imgZoomFit");
  const zoomLevelEl = document.getElementById("imgZoomLevel");
  const lockCheckbox = document.getElementById("imgcropLock");
  const ratioBtns = [...document.querySelectorAll(".imgcrop-ratio-btn")];

  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${msg}</span>`; errorBox.hidden=false; }
    else { errorBox.hidden=true; errorBox.innerHTML=""; }
  }
  function updateGoState(){ goBtn.disabled = !file; }

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="grid";
    body.classList.add("is-loaded");
    motionEnter([document.querySelector(".imgcrop-side-panel")], {fromY:10, duration:MOTION.fast});
  }

  function setActiveRatioBtn(key){
    ratioBtns.forEach(b=>b.classList.toggle("active", b.dataset.ratio===key));
  }
  function resetImageState(){
    if(objectUrl){ URL.revokeObjectURL(objectUrl); objectUrl=null; }
    imgRef=null; normRect=null; zoom=1; activeRatio=null;
    if(rectEl){ rectEl.remove(); rectEl=null; }
    lockCheckbox.checked=false;
    setActiveRatioBtn("free");
  }
  function removeFile(){
    loadToken++;
    file=null;
    batchMode=false; batchFiles=[];
    document.getElementById("imgcropBatchNote").hidden = true;
    canvasWrap.style.display = "";
    resetImageState();
    showEmptyState();
  }
  document.getElementById("imgcropRemove").addEventListener("click", removeFile);

  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    // Batch: more than one file skips the interactive editor entirely -
    // every file is centre-cropped to the chosen aspect ratio instead.
    if(fs.length > 1){
      const plan = imgBatchPlan(fs, IMG_BATCH_LIMIT);
      batchFiles = plan.kept;
      if(plan.dropped) toast(t("toolImgBatch.batchLimitNote", {n: IMG_BATCH_LIMIT, dropped: plan.dropped}));
      batchMode = true;
      file = batchFiles[0];
      showError(null);
      const note = document.getElementById("imgcropBatchNote");
      note.hidden = false;
      note.textContent = t("toolImgCrop.batchNote", {n: batchFiles.length});
      document.getElementById("imgcropFileName").textContent = t("toolImgBatch.doneFiles", {n: batchFiles.length});
      document.getElementById("imgcropFileDims").textContent = "";
      document.getElementById("imgcropThumb").innerHTML = "";
      canvasWrap.style.display = "none";
      showWorkspace();
      updateGoState();
      return;
    }
    batchMode = false;
    batchFiles = [];
    document.getElementById("imgcropBatchNote").hidden = true;
    canvasWrap.style.display = "";
    file=fs[0];
    showError(null); updateGoState();
    let loadedImg, newUrl;
    try{
      newUrl = URL.createObjectURL(file);
      loadedImg = await new Promise((res,rej)=>{
        const img=new Image();
        img.onload=()=>res(img);
        img.onerror=()=>rej(new Error(T("workspace.errCouldNotReadImageNamed", {name: file.name})));
        img.src=newUrl;
      });
    }catch(e){
      if(newUrl) URL.revokeObjectURL(newUrl);
      if(myToken !== loadToken) return;
      toast(e.message || t("workspace.errCouldNotReadImageGeneric"));
      file=null;
      showEmptyState();
      return;
    }
    if(myToken !== loadToken){ URL.revokeObjectURL(newUrl); return; }
    resetImageState();
    objectUrl = newUrl;
    imgRef = loadedImg;
    const qp = document.getElementById("quickPreview"); if(qp) qp.innerHTML = "";
    imgEl.src = objectUrl;
    const thumb = document.getElementById("imgcropThumb");
    thumb.innerHTML = "";
    const thumbImg = document.createElement("img"); thumbImg.src = objectUrl; thumb.appendChild(thumbImg);
    document.getElementById("imgcropFileName").textContent = file.name;
    document.getElementById("imgcropFileDims").textContent = `${imgRef.naturalWidth} × ${imgRef.naturalHeight}px · ${fmtSize(file.size)}`;
    showWorkspace();
    applyZoom();
    wireSelectLayer();
    updateGoState();
  });

  function applyZoom(){
    if(!imgRef) return;
    const availW = Math.max(80, viewport.clientWidth - 48);
    const availH = Math.max(80, viewport.clientHeight - 48);
    const aspect = imgRef.naturalWidth / imgRef.naturalHeight;
    // Capped at the image's own natural width so "fit" (zoom = 1) never
    // UPSCALES a small image just to fill the viewport - a 200px thumbnail
    // was being blown up to ~600px and rendering visibly soft. Large
    // images still scale down to fit as before. Explicit zoom-in past
    // 100% remains available, since that's user-initiated.
    const fitW = Math.min(availW, availH*aspect, imgRef.naturalWidth);
    const w = Math.max(60, Math.round(fitW*zoom));
    const h = Math.round(w/aspect);
    canvasWrap.style.width = w+"px";
    canvasWrap.style.height = h+"px";
    zoomLevelEl.textContent = Math.round(zoom*100)+"%";
  }
  zoomInBtn.addEventListener("click", ()=>{ zoom=Math.min(4, +(zoom*1.25).toFixed(3)); applyZoom(); });
  zoomOutBtn.addEventListener("click", ()=>{ zoom=Math.max(0.1, +(zoom/1.25).toFixed(3)); applyZoom(); });
  zoomFitBtn.addEventListener("click", ()=>{ zoom=1; applyZoom(); });
  // Self-removes on the first post-close resize - see pdf-page-tools-2.js's
  // identical resizeHandler comment for why window-level listeners need
  // this (panel.innerHTML replacement doesn't detach them automatically).
  function resizeHandler(){
    if(!workspace.isConnected){ window.removeEventListener("resize", resizeHandler); return; }
    if(workspace.style.display!=="none") applyZoom();
  }
  window.addEventListener("resize", resizeHandler);

  function ensureRectEl(){
    if(rectEl) return rectEl;
    const el = document.createElement("div");
    el.className = "imgcrop-rect"; el.hidden = true;
    ["nw","n","ne","e","se","s","sw","w"].forEach(h=>{
      const hd = document.createElement("div");
      hd.className = "imgcrop-handle "+h; hd.dataset.handle = h;
      el.appendChild(hd);
    });
    canvasWrap.appendChild(el);
    rectEl = el;
    return el;
  }
  function redrawRect(animate){
    if(!normRect){
      if(rectEl) rectEl.hidden = true;
      updateGoState();
      return;
    }
    const el = ensureRectEl();
    el.hidden = false;
    el.style.left = (normRect.x0*100)+"%";
    el.style.top = (normRect.y0*100)+"%";
    el.style.width = ((normRect.x1-normRect.x0)*100)+"%";
    el.style.height = ((normRect.y1-normRect.y0)*100)+"%";
    if(animate && window.gsap && !MOTION.reduced){
      gsap.fromTo(el, {opacity:0, scale:0.98}, {opacity:1, scale:1, duration:MOTION.fast, ease:MOTION.ease.enter, overwrite:"auto"});
      setTimeout(()=>{ if(el.isConnected){ el.style.opacity=""; el.style.transform=""; } }, 500);
    }
    updateGoState();
  }
  function pulseRect(el){
    if(!el || !window.gsap || MOTION.reduced) return;
    gsap.fromTo(el, {filter:"brightness(1.7)"}, {filter:"brightness(1)", duration:.35, ease:"power2.out", overwrite:"auto"});
    setTimeout(()=>{ if(el.isConnected) el.style.filter=""; }, 600);
  }

  // Fraction-space dy-per-dx needed to hold a target PIXEL ratio (w/h) -
  // a 1:1 PIXEL square is NOT a 1:1 fraction square unless the source
  // image itself is square, since x-fraction scales by naturalWidth and
  // y-fraction scales by naturalHeight independently.
  function fractionK(){
    if(activeRatio==null || !imgRef) return null;
    return (imgRef.naturalWidth/imgRef.naturalHeight) / activeRatio;
  }

  function wireSelectLayer(){
    let mode=null, handle=null, startPt=null, startRect=null;
    function localPos(clientX, clientY){
      const r = canvasWrap.getBoundingClientRect();
      const x=(clientX-r.left)/r.width, y=(clientY-r.top)/r.height;
      return {x:Math.max(0,Math.min(1,x)), y:Math.max(0,Math.min(1,y))};
    }
    function hitHandle(p){
      if(!normRect) return null;
      const pts = {
        nw:{x:normRect.x0,y:normRect.y0}, n:{x:(normRect.x0+normRect.x1)/2,y:normRect.y0}, ne:{x:normRect.x1,y:normRect.y0},
        e:{x:normRect.x1,y:(normRect.y0+normRect.y1)/2}, se:{x:normRect.x1,y:normRect.y1}, s:{x:(normRect.x0+normRect.x1)/2,y:normRect.y1},
        sw:{x:normRect.x0,y:normRect.y1}, w:{x:normRect.x0,y:(normRect.y0+normRect.y1)/2}
      };
      const r = canvasWrap.getBoundingClientRect();
      const tolX = 14/r.width, tolY = 14/r.height;
      for(const k in pts){ if(Math.abs(p.x-pts[k].x)<=tolX && Math.abs(p.y-pts[k].y)<=tolY) return k; }
      return null;
    }
    function inside(p){
      if(!normRect) return false;
      return p.x>normRect.x0 && p.x<normRect.x1 && p.y>normRect.y0 && p.y<normRect.y1;
    }
    selectLayer.addEventListener("pointerdown", e=>{
      if(e.button!=null && e.button!==0) return;
      try{ selectLayer.setPointerCapture(e.pointerId); }catch(err){}
      const p = localPos(e.clientX, e.clientY);
      startPt = p; startRect = normRect ? {...normRect} : null;
      const h = hitHandle(p);
      if(h){ mode="resize"; handle=h; }
      else if(inside(p)){ mode="move"; rectEl && rectEl.classList.add("imgcrop-rect-dragging"); }
      else {
        mode = "new";
        normRect = {x0:p.x, y0:p.y, x1:p.x, y1:p.y};
        redrawRect(true);
      }
    });
    selectLayer.addEventListener("pointermove", e=>{
      if(!mode){
        const p = localPos(e.clientX, e.clientY);
        if(normRect) selectLayer.style.cursor = hitHandle(p) ? "" : (inside(p) ? "grab" : "crosshair");
        else selectLayer.style.cursor = "crosshair";
        return;
      }
      const p = localPos(e.clientX, e.clientY);
      const k = fractionK();
      if(mode==="new"){
        if(k!=null){
          const dx=p.x-startPt.x, dy=p.y-startPt.y;
          const w=Math.abs(dx), h=w*k;
          const signX = dx<0?-1:1, signY = dy<0?-1:1;
          const x1=startPt.x+signX*w, y1=startPt.y+signY*h;
          normRect = {x0:Math.min(startPt.x,x1), y0:Math.min(startPt.y,y1), x1:Math.max(startPt.x,x1), y1:Math.max(startPt.y,y1)};
        } else {
          normRect = {x0:Math.min(startPt.x,p.x), y0:Math.min(startPt.y,p.y), x1:Math.max(startPt.x,p.x), y1:Math.max(startPt.y,p.y)};
        }
      } else if(mode==="move"){
        const dx=p.x-startPt.x, dy=p.y-startPt.y;
        const w=startRect.x1-startRect.x0, h=startRect.y1-startRect.y0;
        const x0 = Math.max(0, Math.min(1-w, startRect.x0+dx));
        const y0 = Math.max(0, Math.min(1-h, startRect.y0+dy));
        normRect = {x0, y0, x1:x0+w, y1:y0+h};
      } else if(mode==="resize"){
        let {x0,y0,x1,y1} = startRect;
        const dx=p.x-startPt.x, dy=p.y-startPt.y;
        const isCorner = handle.length===2;
        if(k!=null && isCorner){
          // Anchor the corner OPPOSITE the one being dragged; derive
          // height from the dragged corner's new horizontal distance to
          // that anchor via the locked ratio, instead of resizing both
          // dimensions independently.
          const anchorX = handle.includes("w") ? x1 : x0;
          const anchorY = handle.includes("n") ? y1 : y0;
          const draggedX = (handle.includes("w") ? x0 : x1) + dx;
          const w = Math.max(MIN_SIZE, Math.abs(draggedX-anchorX));
          const h = w*k;
          const dirX = draggedX<anchorX ? -1 : 1;
          const dirY = handle.includes("n") ? -1 : 1;
          x0 = Math.min(anchorX, anchorX+dirX*w); x1 = Math.max(anchorX, anchorX+dirX*w);
          y0 = Math.min(anchorY, anchorY+dirY*h); y1 = Math.max(anchorY, anchorY+dirY*h);
        } else {
          if(handle.includes("n")) y0 = Math.min(y0+dy, y1-MIN_SIZE);
          if(handle.includes("s")) y1 = Math.max(y1+dy, y0+MIN_SIZE);
          if(handle.includes("w")) x0 = Math.min(x0+dx, x1-MIN_SIZE);
          if(handle.includes("e")) x1 = Math.max(x1+dx, x0+MIN_SIZE);
        }
        normRect = {x0:Math.max(0,x0), y0:Math.max(0,y0), x1:Math.min(1,x1), y1:Math.min(1,y1)};
      }
      redrawRect(false);
    });
    function endDrag(){
      if(mode && rectEl){ rectEl.classList.remove("imgcrop-rect-dragging"); pulseRect(rectEl); }
      mode=null; handle=null;
    }
    selectLayer.addEventListener("pointerup", endDrag);
    selectLayer.addEventListener("pointercancel", endDrag);
  }

  function resetSelection(){
    normRect = null;
    if(rectEl) rectEl.hidden = true;
    updateGoState();
  }
  resetBtn.addEventListener("click", resetSelection);

  ratioBtns.forEach(btn=>{
    btn.addEventListener("click", ()=>{
      setActiveRatioBtn(btn.dataset.ratio);
      const key = btn.dataset.ratio;
      if(key==="free"){ activeRatio=null; lockCheckbox.checked=false; }
      else if(key==="original"){ activeRatio = imgRef ? imgRef.naturalWidth/imgRef.naturalHeight : null; lockCheckbox.checked=true; }
      else { const [a,b] = key.split(":").map(Number); activeRatio = a/b; lockCheckbox.checked=true; }
    });
  });
  lockCheckbox.addEventListener("change", ()=>{
    if(lockCheckbox.checked){
      if(activeRatio==null){
        // Lock whatever ratio the current selection already has, or a
        // sensible 1:1 default if nothing's been drawn yet.
        if(normRect && imgRef){
          const w=(normRect.x1-normRect.x0)*imgRef.naturalWidth, h=(normRect.y1-normRect.y0)*imgRef.naturalHeight;
          activeRatio = h>0 ? w/h : 1;
        } else activeRatio = 1;
      }
    } else {
      activeRatio = null;
      setActiveRatioBtn("free");
    }
  });

  function imgcropKeyHandler(e){
    // Same self-cleanup as Crop PDF's identical cropKeyHandler (see its
    // comment in js/tools/pdf-page-tools-2.js): panel.innerHTML replacement
    // detaches `workspace` with no close hook to unregister this listener,
    // so without this it leaked one dead document-level listener (and its
    // whole closure) per Crop Image open/close cycle for the tab's life.
    if(!workspace.isConnected){ document.removeEventListener("keydown", imgcropKeyHandler, true); return; }
    if(workspace.style.display==="none") return;
    const active = document.activeElement;
    if(active && /INPUT|TEXTAREA/.test(active.tagName)) return;
    if((e.key==="Escape" || e.key==="Delete" || e.key==="Backspace") && normRect){
      resetSelection();
      e.preventDefault();
      // Capture-phase + stopPropagation, same reasoning as Crop PDF's
      // identical guard: without this, the sitewide bubble-phase
      // Escape-closes-the-panel handler (registered at module load,
      // long before this tool ever opens) would close the whole panel
      // on the very same Escape meant to just clear the selection.
      e.stopPropagation();
    }
  }
  document.addEventListener("keydown", imgcropKeyHandler, true);

  goBtn.addEventListener("click", withToolOperation(goBtn, async (_event, operation)=>{
    if(batchMode){
      const out=document.getElementById("out"); out.innerHTML=statusEl(t("toolImgCrop.statusCropping"));
      goBtn.disabled = true;
      try{
        if(activeRatio == null){ out.innerHTML=""; showError(t("toolImgCrop.errChooseRatio")); return; }
        const {results, failures} = await runImageBatch(batchFiles, async (bf)=>{
          const img = await loadImage(bf);
          const r = cropRectForAspect(img.naturalWidth, img.naturalHeight, activeRatio);
          const canvas = document.createElement("canvas"); canvas.width=r.sw; canvas.height=r.sh;
          canvas.getContext("2d").drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
          const {mime, ext} = imgOutputFormat(bf);
          const blob = await new Promise((res, rej)=>canvas.toBlob(b=>b ? res(b) : rej(new Error(t("toolImgCrop.errCouldNotExport"))), mime, 0.92));
          return {blob, meta: {ext}};
        }, (done, total)=>setStatus(t("toolImgBatch.statusProcessing", {n: done, total}), false, Math.round((done / total) * 100)));
        if(!operation.isCurrent()) return;
        await deliverImageResults({results, failures, suffix: "cropped", extFor: (f)=>imgOutputFormat(f).ext, t, operation});
      }finally{
        updateGoState();
      }
      return;
    }
    if(!imgRef) return;
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("toolImgCrop.statusCropping"));
    goBtn.disabled = true; const goLabel = goBtn.textContent; goBtn.textContent = t("toolImgCrop.statusCropping");
    try{
      const nw = imgRef.naturalWidth, nh = imgRef.naturalHeight;
      const r = normRect || {x0:0, y0:0, x1:1, y1:1};
      const sx = Math.round(r.x0*nw), sy = Math.round(r.y0*nh);
      const sw = Math.max(1, Math.round((r.x1-r.x0)*nw)), sh = Math.max(1, Math.round((r.y1-r.y0)*nh));
      // Always sampled from imgRef at its ORIGINAL natural resolution -
      // never from the on-screen (possibly zoomed/downscaled) display
      // size, so the output is never silently degraded below source
      // quality and editor zoom never upscales the actual crop.
      const canvas = document.createElement("canvas"); canvas.width=sw; canvas.height=sh;
      canvas.getContext("2d").drawImage(imgRef, sx,sy,sw,sh, 0,0,sw,sh);
      const {mime, ext} = imgOutputFormat(file);
      const blob = await new Promise((res,rej)=>canvas.toBlob(b=>b?res(b):rej(new Error(t("toolImgCrop.errCouldNotExport"))), mime, 0.92));
      const outName = suffixedName(file, "cropped", ext);
      setStatus(T("workspace.statusPreparingDownload"));
      if(!operation.isCurrent()) return;
      const {url} = downloadBlob(blob, outName);
      const im = document.createElement("img"); im.src=url;
      setStatus(t("workspace.done"), true);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:im, url, filename:outName}));
    }catch(e){
      out.innerHTML = "";
      showError(t("toolImgCrop.errGenericFailed"));
    }finally{
      goBtn.textContent = goLabel; updateGoState();
    }
  }));
};

TOOLS.imgconvert = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let files=[];
  openPanel(`
    <div class="panel-head"><h3>${t("tools.imgconvert")}</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="imgconvertBody">
      <div class="tool-hero" id="imgconvertHero">
        <h2 class="tool-hero-title">${t("tools.imgconvert")}</h2>
        <p class="tool-hero-desc">${t("toolImgConvert.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap" id="imgconvertUploadWrap">
        ${fileInputHTML("image/*", true, t("workspace.selectImages"))}
      </div>
      <p class="tool-privacy-hint" id="imgconvertPrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace" id="imgconvertWorkspace" style="display:none">
        <div class="tool-main-pane" id="imgconvertPreviewPane"></div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">${t("tools.imgconvert")}</h3>
          <div id="imgconvertFileSlot"></div>
          <div class="field"><label for="fmt">${t("toolImgConvert.targetFormatLabel")}</label>
            <select id="fmt"><option value="image/png">PNG</option><option value="image/jpeg">JPG</option><option value="image/webp">WebP</option></select>
          </div>
          <button class="btn tool-toolbar-primary" id="go">${t("toolImgConvert.convertImage")}</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("imgconvertHero");
  const uploadWrap = document.getElementById("imgconvertUploadWrap");
  const privacyHint = document.getElementById("imgconvertPrivacyHint");
  const workspace = document.getElementById("imgconvertWorkspace");
  const fileSlot = document.getElementById("imgconvertFileSlot");
  const previewPane = document.getElementById("imgconvertPreviewPane");
  const body = document.getElementById("imgconvertBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="grid";
    body.classList.add("is-loaded");
  }

  wireDropzone(fs=>{
    const plan = imgBatchPlan(fs, IMG_BATCH_LIMIT);
    files = plan.kept;
    if(plan.dropped) toast(t("toolImgBatch.batchLimitNote", {n: IMG_BATCH_LIMIT, dropped: plan.dropped}));
    renderFileList(files, (i)=>{ files.splice(i, 1); if(!files.length){ showEmptyState(); } else { fileSlot.appendChild(document.getElementById("flist")); previewPane.appendChild(document.getElementById("quickPreview")); } });
    fileSlot.appendChild(document.getElementById("flist"));
    previewPane.appendChild(document.getElementById("quickPreview"));
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("workspace.statusReadingImage"));
    const fmt = document.getElementById("fmt").value;
    const ext = fmt.split("/")[1];
    const {results, failures} = await runImageBatch(files, async (file)=>{
      const img = await loadImage(file);
      const canvas=document.createElement("canvas"); canvas.width=img.width; canvas.height=img.height;
      canvasContextForOutput(canvas, fmt).drawImage(img,0,0);
      setStatus(t("toolImgConvert.statusConverting"));
      const blob = await new Promise((res, rej)=>canvas.toBlob(b=>b ? res(b) : rej(new Error(t("toolImgConvert.errEncodeFailed"))), fmt, 0.92));
      return {blob, meta: {ext}};
    }, (done, total)=>setStatus(t("toolImgBatch.statusProcessing", {n: done, total}), false, Math.round((done / total) * 100)));
    if(!operation.isCurrent()) return;
    await deliverImageResults({results, failures, suffix: "converted", extFor: ()=>ext, t, operation});
  }));
};

TOOLS.imgwatermark = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let files=[], imgRef=null, loadToken=0, logoImg=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.imgwatermark")}</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="imgwatermarkBody">
      <div class="tool-hero" id="imgwatermarkHero">
        <h2 class="tool-hero-title">${t("tools.imgwatermark")}</h2>
        <p class="tool-hero-desc">${t("toolImgWatermark.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap" id="imgwatermarkUploadWrap">
        ${fileInputHTML("image/*", true, t("workspace.selectImages"))}
      </div>
      <p class="tool-privacy-hint" id="imgwatermarkPrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace" id="imgwatermarkWorkspace" style="display:none">
        <div class="tool-main-pane" id="imgwatermarkPreviewPane"></div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">${t("toolImgWatermark.addWatermark")}</h3>
          <div id="imgwatermarkFileSlot"></div>
          <div class="field"><label for="wmType">${t("toolImgWatermark.typeLabel")}</label>
            <select id="wmType"><option value="text">${t("toolImgWatermark.typeText")}</option><option value="image">${t("toolImgWatermark.typeImage")}</option></select>
          </div>
          <div class="field" id="wmTextField"><label for="wtext">${t("toolImgWatermark.watermarkTextLabel")}</label><input type="text" id="wtext" placeholder="${t("toolImgWatermark.watermarkTextPlaceholder")}"></div>
          <div class="field" id="wmLogoField" style="display:none"><label for="wmLogo">${t("toolImgWatermark.logoLabel")}</label><input type="file" id="wmLogo" accept="image/*"></div>
          <div class="field"><label for="opac">${t("toolImgWatermark.opacityLabel")}</label><input type="number" id="opac" value="0.4" step="0.05" min="0.05" max="1"></div>
          <div class="field"><label for="fsize">${t("toolImgWatermark.fontSizeLabel")}</label><input type="number" id="fsize" value="36"></div>
          <div class="field"><label for="wmPos">${t("toolImgWatermark.positionLabel")}</label>
            <select id="wmPos">
              <option value="top-left">${t("toolImgWatermark.posTopLeft")}</option>
              <option value="top-center">${t("toolImgWatermark.posTopCenter")}</option>
              <option value="top-right">${t("toolImgWatermark.posTopRight")}</option>
              <option value="middle-left">${t("toolImgWatermark.posMiddleLeft")}</option>
              <option value="middle-center" selected>${t("toolImgWatermark.posCenter")}</option>
              <option value="middle-right">${t("toolImgWatermark.posMiddleRight")}</option>
              <option value="bottom-left">${t("toolImgWatermark.posBottomLeft")}</option>
              <option value="bottom-center">${t("toolImgWatermark.posBottomCenter")}</option>
              <option value="bottom-right">${t("toolImgWatermark.posBottomRight")}</option>
            </select>
          </div>
          <label style="font-size:.85rem;display:flex;gap:6px;align-items:center;"><input type="checkbox" id="wmTile"> ${t("toolImgWatermark.tileLabel")}</label>
          <button class="btn tool-toolbar-primary" id="go">${t("toolImgWatermark.addWatermark")}</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("imgwatermarkHero");
  const uploadWrap = document.getElementById("imgwatermarkUploadWrap");
  const privacyHint = document.getElementById("imgwatermarkPrivacyHint");
  const workspace = document.getElementById("imgwatermarkWorkspace");
  const fileSlot = document.getElementById("imgwatermarkFileSlot");
  const previewPane = document.getElementById("imgwatermarkPreviewPane");
  const body = document.getElementById("imgwatermarkBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="grid";
    body.classList.add("is-loaded");
  }

  document.getElementById("wmType").addEventListener("change", ()=>{
    const isImage = document.getElementById("wmType").value === "image";
    document.getElementById("wmTextField").style.display = isImage ? "none" : "";
    document.getElementById("wmLogoField").style.display = isImage ? "" : "none";
  });
  document.getElementById("wmLogo").addEventListener("change", async (e)=>{
    const f = e.target.files && e.target.files[0];
    if(!f){ logoImg = null; return; }
    try{ logoImg = await loadImage(f); }
    catch(err){ toast(err.message || t("workspace.errCouldNotReadImageGeneric")); logoImg = null; e.target.value = ""; }
  });

  function renderWatermarkFiles(){
    renderFileList(files, (i)=>{ loadToken++; files.splice(i, 1); imgRef = null; if(!files.length){ showEmptyState(); } else { renderWatermarkFiles(); } });
    fileSlot.appendChild(document.getElementById("flist"));
    previewPane.appendChild(document.getElementById("quickPreview"));
  }
  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    const plan = imgBatchPlan(fs, IMG_BATCH_LIMIT);
    files = plan.kept;
    if(plan.dropped) toast(t("toolImgBatch.batchLimitNote", {n: IMG_BATCH_LIMIT, dropped: plan.dropped}));
    renderWatermarkFiles();
    // See Resize Image's identical fix - was unguarded, silently stuck
    // the panel forever on a corrupt/unreadable file.
    let loadedImg;
    try{ loadedImg = await loadImage(files[0]); }
    catch(e){
      if(myToken !== loadToken) return;
      toast(e.message || t("workspace.errCouldNotReadImageGeneric"));
      files=[]; imgRef=null; showEmptyState();
      return;
    }
    if(myToken !== loadToken) return;
    imgRef = loadedImg;
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("workspace.statusProcessingImage"));
    const wmType = document.getElementById("wmType").value;
    const text = document.getElementById("wtext").value || "WATERMARK";
    const opac = parseFloat(document.getElementById("opac").value)||0.4;
    const fsize = parseInt(document.getElementById("fsize").value)||36;
    const position = document.getElementById("wmPos").value;
    const tile = document.getElementById("wmTile").checked;
    if(wmType === "image" && !logoImg){ toast(t("toolImgWatermark.errChooseLogo")); return; }
    const {results, failures} = await runImageBatch(files, async (file)=>{
      const img = await loadImage(file);
      const canvas=document.createElement("canvas"); canvas.width=img.width; canvas.height=img.height;
      const ctx=canvas.getContext("2d"); ctx.drawImage(img,0,0);
      ctx.save();
      ctx.globalAlpha = opac;
      if(wmType === "image"){
        // Logo keeps its own transparency; drawn at 25% of the image width.
        const scale = (canvas.width * 0.25) / logoImg.width;
        const wmW = Math.max(1, Math.round(logoImg.width * scale)), wmH = Math.max(1, Math.round(logoImg.height * scale));
        if(tile){
          const stepX = Math.max(wmW, Math.round(wmW * 1.6)), stepY = Math.max(wmH, Math.round(wmH * 1.6));
          for(let y = 0; y < canvas.height; y += stepY) for(let x = 0; x < canvas.width; x += stepX) ctx.drawImage(logoImg, x, y, wmW, wmH);
        } else {
          const a = watermarkAnchor(canvas.width, canvas.height, wmW, wmH, position, 16);
          ctx.drawImage(logoImg, a.x, a.y, wmW, wmH);
        }
      } else {
        ctx.fillStyle="#ffffff"; ctx.strokeStyle="rgba(0,0,0,0.3)"; ctx.lineWidth=2;
        ctx.font = `700 ${fsize}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign="center"; ctx.textBaseline="middle";
        if(tile){
          // Tiling uses upright stamps on a grid (rotation would overlap unevenly).
          const tw = Math.max(1, Math.round(ctx.measureText(text).width) + 40);
          const th = Math.max(1, fsize * 2);
          for(let y = th / 2; y < canvas.height + th; y += th * 2) for(let x = tw / 2; x < canvas.width + tw; x += tw){
            ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
          }
        } else {
          const tw = ctx.measureText(text).width, th = fsize;
          const a = watermarkAnchor(canvas.width, canvas.height, tw, th, position, 16);
          ctx.translate(a.x + tw / 2, a.y + th / 2);
          ctx.rotate(-Math.PI/8);
          ctx.strokeText(text,0,0); ctx.fillText(text,0,0);
        }
      }
      ctx.restore();
      const {mime, ext} = imgOutputFormat(file);
      const blob = await new Promise((res, rej)=>canvas.toBlob(b=>b ? res(b) : rej(new Error(t("toolImgWatermark.errEncodeFailed"))), mime, 0.92));
      return {blob, meta: {ext}};
    }, (done, total)=>setStatus(t("toolImgBatch.statusProcessing", {n: done, total}), false, Math.round((done / total) * 100)));
    if(!operation.isCurrent()) return;
    await deliverImageResults({results, failures, suffix: "watermarked", extFor: (file)=>imgOutputFormat(file).ext, t, operation});
  }));
};

TOOLS.imginvert = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let files=[], imgRef=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.imginvert")}</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="imginvertBody">
      <div class="tool-hero" id="imginvertHero">
        <h2 class="tool-hero-title">${t("tools.imginvert")}</h2>
        <p class="tool-hero-desc">${t("toolImgInvert.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap" id="imginvertUploadWrap">
        ${fileInputHTML("image/*", true, t("workspace.selectImages"))}
      </div>
      <p class="tool-privacy-hint" id="imginvertPrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace" id="imginvertWorkspace" style="display:none">
        <div class="tool-main-pane" id="imginvertPreviewPane"></div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">${t("tools.imginvert")}</h3>
          <div id="imginvertFileSlot"></div>
          <button class="btn tool-toolbar-primary" id="go">${t("toolImgInvert.invertImage")}</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("imginvertHero");
  const uploadWrap = document.getElementById("imginvertUploadWrap");
  const privacyHint = document.getElementById("imginvertPrivacyHint");
  const workspace = document.getElementById("imginvertWorkspace");
  const fileSlot = document.getElementById("imginvertFileSlot");
  const previewPane = document.getElementById("imginvertPreviewPane");
  const body = document.getElementById("imginvertBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="grid";
    body.classList.add("is-loaded");
  }

  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    const plan = imgBatchPlan(fs, IMG_BATCH_LIMIT);
    files = plan.kept;
    if(plan.dropped) toast(t("toolImgBatch.batchLimitNote", {n: IMG_BATCH_LIMIT, dropped: plan.dropped}));
    renderFileList(files, (i)=>{ loadToken++; files.splice(i, 1); imgRef = null; if(!files.length){ showEmptyState(); } else { fileSlot.appendChild(document.getElementById("flist")); previewPane.appendChild(document.getElementById("quickPreview")); } });
    fileSlot.appendChild(document.getElementById("flist"));
    previewPane.appendChild(document.getElementById("quickPreview"));
    // See Resize Image's identical fix - was unguarded, silently stuck
    // the panel forever on a corrupt/unreadable file.
    let loadedImg;
    try{ loadedImg = await loadImage(files[0]); }
    catch(e){
      if(myToken !== loadToken) return;
      toast(e.message || t("workspace.errCouldNotReadImageGeneric"));
      files=[]; imgRef=null; showEmptyState();
      return;
    }
    if(myToken !== loadToken) return;
    imgRef = loadedImg;
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("workspace.statusProcessingImage"));
    const {results, failures} = await runImageBatch(files, async (file)=>{
      const img = await loadImage(file);
      const canvas=document.createElement("canvas"); canvas.width=img.width; canvas.height=img.height;
      const ctx=canvas.getContext("2d"); ctx.drawImage(img,0,0);
      const imgData = ctx.getImageData(0,0,canvas.width,canvas.height);
      const d = imgData.data;
      for(let px=0; px<d.length; px+=4){ d[px]=255-d[px]; d[px+1]=255-d[px+1]; d[px+2]=255-d[px+2]; }
      ctx.putImageData(imgData,0,0);
      const {mime, ext} = imgOutputFormat(file);
      const blob = await new Promise((res, rej)=>canvas.toBlob(b=>b ? res(b) : rej(new Error(t("toolImgInvert.errEncodeFailed"))), mime, 0.92));
      return {blob, meta: {ext}};
    }, (done, total)=>setStatus(t("toolImgBatch.statusProcessing", {n: done, total}), false, Math.round((done / total) * 100)));
    if(!operation.isCurrent()) return;
    await deliverImageResults({results, failures, suffix: "inverted", extFor: (file)=>imgOutputFormat(file).ext, t, operation});
  }));
};

/* ---- ROTATE IMAGE (Wave D: iLoveIMG offers this; YOYOPDF had no
   image-rotate tool - TOOLS.rotate only rotates PDF pages) ---- */
TOOLS.imgrotate = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let files=[];
  openPanel(`
    <div class="panel-head"><h3>${t("tools.imgrotate")}</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="imgrotateBody">
      <div class="tool-hero" id="imgrotateHero">
        <h2 class="tool-hero-title">${t("tools.imgrotate")}</h2>
        <p class="tool-hero-desc">${t("toolImgRotate.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap" id="imgrotateUploadWrap">
        ${fileInputHTML("image/*", true, t("workspace.selectImages"))}
      </div>
      <p class="tool-privacy-hint" id="imgrotatePrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace" id="imgrotateWorkspace" style="display:none">
        <div class="tool-main-pane" id="imgrotatePreviewPane"></div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">${t("tools.imgrotate")}</h3>
          <div id="imgrotateFileSlot"></div>
          <div class="field"><label for="rotAngle">${t("toolImgRotate.angleLabel")}</label>
            <select id="rotAngle"><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option><option value="custom">${t("toolImgRotate.customAngle")}</option></select>
          </div>
          <div class="field" id="rotCustomField" style="display:none"><label for="rotCustom">${t("toolImgRotate.customAngleLabel")}</label><input type="number" id="rotCustom" value="45" min="-360" max="360"></div>
          <button class="btn tool-toolbar-primary" id="go">${t("toolImgRotate.rotateImage")}</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("imgrotateHero");
  const uploadWrap = document.getElementById("imgrotateUploadWrap");
  const privacyHint = document.getElementById("imgrotatePrivacyHint");
  const workspace = document.getElementById("imgrotateWorkspace");
  const fileSlot = document.getElementById("imgrotateFileSlot");
  const previewPane = document.getElementById("imgrotatePreviewPane");
  const body = document.getElementById("imgrotateBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="grid";
    body.classList.add("is-loaded");
  }

  document.getElementById("rotAngle").addEventListener("change", ()=>{
    document.getElementById("rotCustomField").style.display = document.getElementById("rotAngle").value === "custom" ? "" : "none";
  });
  wireDropzone(fs=>{
    const plan = imgBatchPlan(fs, IMG_BATCH_LIMIT);
    files = plan.kept;
    if(plan.dropped) toast(t("toolImgBatch.batchLimitNote", {n: IMG_BATCH_LIMIT, dropped: plan.dropped}));
    renderFileList(files, (i)=>{ files.splice(i, 1); if(!files.length){ showEmptyState(); } else { fileSlot.appendChild(document.getElementById("flist")); previewPane.appendChild(document.getElementById("quickPreview")); } });
    fileSlot.appendChild(document.getElementById("flist"));
    previewPane.appendChild(document.getElementById("quickPreview"));
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("toolImgRotate.statusRotating"));
    const angleChoice = document.getElementById("rotAngle").value;
    const angle = angleChoice === "custom" ? (parseFloat(document.getElementById("rotCustom").value) || 0) : parseFloat(angleChoice);
    const rad = angle * Math.PI / 180;
    const {results, failures} = await runImageBatch(files, async (file)=>{
      const img = await loadImage(file);
      const dims = rotateCanvasDimensions(img.width, img.height, angle);
      const canvas=document.createElement("canvas"); canvas.width=dims.w; canvas.height=dims.h;
      const ctx=canvas.getContext("2d");
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(rad);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      const {mime, ext} = imgOutputFormat(file);
      const blob = await new Promise((res, rej)=>canvas.toBlob(b=>b ? res(b) : rej(new Error(t("toolImgRotate.errEncodeFailed"))), mime, 0.92));
      return {blob, meta: {ext}};
    }, (done, total)=>setStatus(t("toolImgBatch.statusProcessing", {n: done, total}), false, Math.round((done / total) * 100)));
    if(!operation.isCurrent()) return;
    await deliverImageResults({results, failures, suffix: "rotated", extFor: (file)=>imgOutputFormat(file).ext, t, operation});
  }));
};
