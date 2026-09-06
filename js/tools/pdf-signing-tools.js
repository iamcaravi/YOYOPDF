/* ---- SIGN PDF ----
   Workspace mirrors Crop PDF's: the whole document renders as one
   vertically scrolling stack of real pages (lazy per-page bitmaps via
   IntersectionObserver + a geometry fallback scan, exactly the pattern
   TOOLS.crop established) instead of the old one-page-at-a-time canvas
   with ‹/› page buttons. Scrolling is now the only way to change page.

   Coordinate system: every page gets its OWN .sign-page wrapper whose
   on-screen box IS that page (width set by applyZoomWidth(), height
   following from CSS aspect-ratio built out of the page's real point
   dimensions), and each page carries its own .sign-sig-layer. A
   signature is an absolutely positioned element inside one page's layer,
   sized/placed in PERCENTAGES of that layer - so it is bound to its page
   by construction: scrolling, zooming and window resizing move page and
   signature together, and no viewport coordinate ever leaks into the
   stored placement. The placements themselves are exactly the fractions
   the old single-canvas version already used (xFrac/yFrac of the page's
   own width/height, wFrac of its width, height derived from the image's
   aspect ratio), so "same position on every page", "apply to all pages"
   and the pdf-lib export path below are all unchanged. */
TOOLS.sign = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null, pdoc=null, loadToken=0, numPages=0;
  // One entry per page, created up front in a cheap metadata-only pass
  // so the whole document exists in the scroll flow immediately; pixels
  // are rendered lazily as pages come near the viewport.
  let pagesMeta=[]; // {index, pageNum, widthPt, heightPt, wrapEl, canvasEl, layerEl, rendered, rendering}
  // Reusable signature ASSETS (created once via draw/type/upload) each
  // carrying a default placement plus optional per-page overrides,
  // instead of one independent stamp per page - so a signature is
  // available on every page the moment it's created, without the user
  // repeating "Add Signature" per page. Position/size are stored as
  // fractions of the page's own width/height (not raw canvas px), so
  // the same asset renders/exports correctly regardless of zoom, or of
  // different pages having different dimensions:
  //   asset = { id, img, pngDataUrl, ratio,
  //     defaultPlacement: {xFrac,yFrac,wFrac},   // top-left origin, wFrac of page width
  //     pageOverrides: { [pageNum]: {xFrac,yFrac,wFrac} },
  //     hiddenPages: Set<pageNum> }               // "remove from this page", non-destructive
  // Height is always derived (w/ratio) at render/export time rather than
  // stored, so the signature's true aspect ratio is preserved even on a
  // page whose own aspect ratio differs from the one it was placed on.
  let assets=[], selectedAssetId=null, assetIdCounter=0, panelState="default";
  let drawEndHandler=null;
  function clearDrawEndHandler(){
    if(drawEndHandler){ window.removeEventListener("mouseup", drawEndHandler); drawEndHandler=null; }
  }
  if(typeof registerToolCleanup === "function") registerToolCleanup(clearDrawEndHandler);
  // activePage (1-based) is the page every sidebar control acts on - the
  // page hosting the selected signature, or, with nothing selected,
  // whichever page is most in view. It replaces the `currentPage` the
  // removed ‹/› page buttons used to set.
  let activePage=1, currentPageIndex=0;
  let zoom=1, docObserver=null, fallbackScanHandler=null, resizeHandler=null;
  let drag=null; // {mode:"move"|"resize", asset, meta, startPt, startRect, corner, anchor}

  openPanel(`
    <div class="panel-head"><h3>${t("tools.sign")}</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="signBody">
      <div class="tool-hero" id="signHero">
        <h2 class="tool-hero-title">${t("tools.sign")}</h2>
        <p class="tool-hero-desc">${t("toolSign.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap" id="signUploadWrap">
        ${fileInputHTML("application/pdf", false, t("workspace.selectPdfFiles"))}
      </div>
      <div class="status" role="note">${t("toolSign.legalNote")}</div>
      <p class="tool-privacy-hint" id="signPrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace sign-app-workspace" id="signWorkspace" style="display:none">
        <div class="tool-main-pane sign-main-pane">
          <div class="sign-zoom">
            <button type="button" class="sign-zoom-btn" id="signZoomOut" aria-label="${t("workspace.zoomOut")}">−</button>
            <span class="sign-zoom-level" id="signZoomLevel">100%</span>
            <button type="button" class="sign-zoom-btn" id="signZoomIn" aria-label="${t("workspace.zoomIn")}">+</button>
            <span class="sign-page-indicator" id="signPageIndicator">${t("toolSign.pageIndicator",{n:1,total:1})}</span>
          </div>
          <div class="sign-document-viewport" id="signDocViewport">
            <div class="sign-document" id="signDocument"></div>
          </div>
          <div class="mono" id="signReadout" style="font-size:.78rem;color:var(--ink-soft);text-align:center;margin:6px 0;"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">${t("tools.sign")}</h3>
          <div id="signFileSlot"></div>
          <div class="tool-content-area" id="sigPanelArea"></div>
          <button class="btn tool-toolbar-primary" id="go">${t("tools.sign")}</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("signHero");
  const uploadWrap = document.getElementById("signUploadWrap");
  const privacyHint = document.getElementById("signPrivacyHint");
  const workspace = document.getElementById("signWorkspace");
  const fileSlot = document.getElementById("signFileSlot");
  const body = document.getElementById("signBody");
  const readout = document.getElementById("signReadout");
  const sigPanelArea = document.getElementById("sigPanelArea");
  const docViewport = document.getElementById("signDocViewport");
  const docEl = document.getElementById("signDocument");
  const pageIndicator = document.getElementById("signPageIndicator");
  const zoomInBtn = document.getElementById("signZoomIn");
  const zoomOutBtn = document.getElementById("signZoomOut");
  const zoomLevelEl = document.getElementById("signZoomLevel");

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

  // ---- Sidebar: default view (signature list + per-signature controls
  // + "+ Add Signature") ----
  function effectivePlacement(asset, page){ return asset.pageOverrides[page] || asset.defaultPlacement; }
  function hasOtherPageOverrides(asset){
    return Object.keys(asset.pageOverrides).some(p=>parseInt(p,10)!==activePage);
  }
  function placementStatusText(asset){
    if(asset.hiddenPages.has(activePage)) return t("toolSign.hiddenOnPage",{n:activePage});
    if(asset.pageOverrides[activePage]) return t("toolSign.customPositionOnPage",{n:activePage});
    return t("toolSign.samePositionEveryPage");
  }
  function renderSigListRows(){
    if(assets.length===0) return `<p class="mode-info">${t("toolSign.noSignaturesYet")}</p>`;
    // role="button"/tabindex here (not just the delete button) - this
    // row is otherwise the only way to select a signature at all, and a
    // bare click-only <div> is invisible to keyboard/screen-reader use.
    // Once selected, the viewport keydown handler below (nudge/resize/
    // delete) picks up from here.
    return `<div class="sig-list">` + assets.map(a=>`
      <div class="sig-list-item ${a.id===selectedAssetId?"active":""}" data-asset-id="${a.id}" role="button" tabindex="0" aria-pressed="${a.id===selectedAssetId}" aria-label="${t("toolSign.signatureAlt")}, ${placementStatusText(a)}">
        <img src="${a.pngDataUrl}" alt="${t("toolSign.signatureAlt")}" class="sig-list-thumb">
        <span class="sig-list-meta">${placementStatusText(a)}</span>
        <button type="button" class="sig-list-del" data-del-id="${a.id}" aria-label="${t("toolSign.deleteSignature")}">✕</button>
      </div>`).join("") + `</div>`;
  }
  function showSigDefault(){
    clearDrawEndHandler();
    panelState = "default";
    const selected = assets.find(a=>a.id===selectedAssetId);
    sigPanelArea.innerHTML = `
      <div class="tool-content-area-label">${t("toolSign.signaturesLabel")}</div>
      ${renderSigListRows()}
      ${selected ? `
      <div class="sig-active-controls" id="sigActiveControls">
        <button class="btn secondary btn-sm" id="applyAllBtn" type="button" style="width:100%">${t("toolSign.applyToAllPages")}</button>
        <button class="btn secondary btn-sm" id="toggleHideBtn" type="button" style="width:100%;margin-top:6px">${selected.hiddenPages.has(activePage) ? t("toolSign.showOnPage",{n:activePage}) : t("toolSign.hideOnPage",{n:activePage})}</button>
      </div>` : ``}
      <button class="btn" id="addSigBtn" type="button" style="margin-top:10px;width:100%">${t("toolSign.addSignature")}</button>
    `;
    document.getElementById("addSigBtn").addEventListener("click", showMethodPicker);
    sigPanelArea.querySelectorAll("[data-asset-id]").forEach(row=>{
      row.addEventListener("click", e=>{
        if(e.target.closest("[data-del-id]")) return;
        selectedAssetId = parseInt(row.dataset.assetId, 10);
        redrawAllPages();
        showSigDefault();
      });
      row.addEventListener("keydown", e=>{
        if(e.key===" " || e.key==="Enter"){ e.preventDefault(); row.click(); }
      });
    });
    sigPanelArea.querySelectorAll("[data-del-id]").forEach(btn=>{
      btn.addEventListener("click", e=>{ e.stopPropagation(); deleteAsset(parseInt(btn.dataset.delId, 10)); });
    });
    if(selected){
      document.getElementById("applyAllBtn").addEventListener("click", ()=>{
        if(hasOtherPageOverrides(selected)) showApplyAllConfirm(selected);
        else applyToAllPages(selected);
      });
      document.getElementById("toggleHideBtn").addEventListener("click", ()=> toggleHidden(selected));
    }
  }
  function showApplyAllConfirm(asset){
    const controls = document.getElementById("sigActiveControls");
    if(!controls) return;
    controls.innerHTML = `
      <p class="mode-info" style="margin-bottom:8px">${t("toolSign.confirmApplyAllText")}</p>
      <div class="row">
        <button class="btn secondary btn-sm" id="cancelApplyAll" type="button">${t("workspace.cancel")}</button>
        <button class="btn btn-sm" id="confirmApplyAll" type="button">${t("toolSign.applyToAllPages")}</button>
      </div>
    `;
    document.getElementById("cancelApplyAll").addEventListener("click", showSigDefault);
    document.getElementById("confirmApplyAll").addEventListener("click", ()=> applyToAllPages(asset));
  }
  function applyToAllPages(asset){
    asset.defaultPlacement = {...effectivePlacement(asset, activePage)};
    asset.pageOverrides = {};
    redrawAllPages();
    showSigDefault();
  }
  function toggleHidden(asset){
    if(asset.hiddenPages.has(activePage)){ asset.hiddenPages.delete(activePage); }
    else{
      asset.hiddenPages.add(activePage);
      if(selectedAssetId===asset.id) selectedAssetId=null;
    }
    redrawAllPages();
    showSigDefault();
  }
  function refreshSigListIfIdle(){ if(panelState==="default") showSigDefault(); }

  // ---- Sidebar: method picker ----
  function showMethodPicker(){
    clearDrawEndHandler();
    panelState = "picker";
    sigPanelArea.innerHTML = `
      <div class="tool-content-area-label">${t("toolSign.addSignatureLabel")}</div>
      <div class="sig-method-list">
        <button type="button" class="sig-method-btn" data-method="draw">
          <strong>${t("toolSign.drawSignature")}</strong><span>${t("toolSign.drawSignatureDesc")}</span>
        </button>
        <button type="button" class="sig-method-btn" data-method="type">
          <strong>${t("toolSign.typeSignature")}</strong><span>${t("toolSign.typeSignatureDesc")}</span>
        </button>
        <button type="button" class="sig-method-btn" data-method="upload">
          <strong>${t("toolSign.uploadSignature")}</strong><span>${t("toolSign.uploadSignatureDesc")}</span>
        </button>
      </div>
      <button class="btn secondary" id="cancelAddSig" type="button" style="margin-top:10px;width:100%">${t("workspace.cancel")}</button>
    `;
    sigPanelArea.querySelectorAll("[data-method]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const m = btn.dataset.method;
        if(m==="draw") showDrawMethod();
        else if(m==="type") showTypeMethod();
        else showUploadMethod();
      });
    });
    document.getElementById("cancelAddSig").addEventListener("click", showSigDefault);
  }

  // ---- Sidebar: draw method ----
  function showDrawMethod(){
    clearDrawEndHandler();
    panelState = "draw";
    sigPanelArea.innerHTML = `
      <div class="tool-content-area-label">${t("toolSign.drawSignature")}</div>
      <div class="canvas-wrap"><canvas id="sigDrawCanvas" width="260" height="100"></canvas></div>
      <button class="btn secondary btn-sm" id="clearDrawSig" type="button" style="margin-top:8px">${t("toolSign.clear")}</button>
      <div class="row" style="margin-top:10px">
        <button class="btn secondary" id="cancelDrawSig" type="button">${t("workspace.cancel")}</button>
        <button class="btn" id="useDrawSig" type="button">${t("toolSign.useSignature")}</button>
      </div>
    `;
    const canvas = document.getElementById("sigDrawCanvas");
    const ctx = canvas.getContext("2d");
    ctx.lineWidth=2.4; ctx.lineCap="round"; ctx.strokeStyle="#15181A";
    let drawing=false, hasDrawInk=false;
    function pos(e){ const r=canvas.getBoundingClientRect(); const t=e.touches?e.touches[0]:e; return {x:t.clientX-r.left, y:t.clientY-r.top}; }
    function start(e){ drawing=true; hasDrawInk=true; const p=pos(e); ctx.beginPath(); ctx.moveTo(p.x,p.y); e.preventDefault(); }
    function move(e){ if(!drawing) return; const p=pos(e); ctx.lineTo(p.x,p.y); ctx.stroke(); e.preventDefault(); }
    function end(){ drawing=false; }
    canvas.addEventListener("mousedown",start); canvas.addEventListener("mousemove",move); drawEndHandler=end; window.addEventListener("mouseup",drawEndHandler);
    canvas.addEventListener("touchstart",start); canvas.addEventListener("touchmove",move); canvas.addEventListener("touchend",end);
    document.getElementById("clearDrawSig").addEventListener("click", ()=>{ ctx.clearRect(0,0,canvas.width,canvas.height); hasDrawInk=false; });
    document.getElementById("cancelDrawSig").addEventListener("click", showSigDefault);
    document.getElementById("useDrawSig").addEventListener("click", ()=>{
      if(!hasDrawInk){ toast(t("toolSign.errDrawFirst")); return; }
      const img = new Image();
      img.onload = ()=> addSignature(img);
      img.src = canvas.toDataURL("image/png");
    });
  }

  // ---- Sidebar: type method ----
  function showTypeMethod(){
    clearDrawEndHandler();
    panelState = "type";
    sigPanelArea.innerHTML = `
      <div class="tool-content-area-label">${t("toolSign.typeSignature")}</div>
      <div class="field"><label for="typeSigInput">${t("toolSign.nameLabel")}</label><input type="text" id="typeSigInput" placeholder="${t("toolSign.typeYourNamePlaceholder")}" maxlength="40"></div>
      <div class="field"><label for="typeSigFont">${t("toolSign.styleLabel")}</label>
        <select id="typeSigFont">
          <option value="'Brush Script MT', cursive" selected>${t("toolSign.styleScript")}</option>
          <option value="'Plus Jakarta Sans', sans-serif">${t("toolSign.styleSans")}</option>
          <option value="Georgia, serif">${t("toolSign.styleSerif")}</option>
        </select>
      </div>
      <div class="canvas-wrap"><canvas id="typeSigPreview" width="260" height="100"></canvas></div>
      <div class="row" style="margin-top:10px">
        <button class="btn secondary" id="cancelTypeSig" type="button">${t("workspace.cancel")}</button>
        <button class="btn" id="useTypeSig" type="button">${t("toolSign.useSignature")}</button>
      </div>
    `;
    const input = document.getElementById("typeSigInput");
    const fontSel = document.getElementById("typeSigFont");
    const preview = document.getElementById("typeSigPreview");
    const pctx = preview.getContext("2d");
    function draw(){
      pctx.clearRect(0,0,preview.width,preview.height);
      const text = input.value.trim();
      if(!text) return;
      pctx.fillStyle="#15181A"; pctx.textAlign="center"; pctx.textBaseline="middle";
      let size=44;
      pctx.font = `${size}px ${fontSel.value}`;
      while(pctx.measureText(text).width > preview.width-20 && size>16){ size-=2; pctx.font = `${size}px ${fontSel.value}`; }
      pctx.fillText(text, preview.width/2, preview.height/2);
    }
    input.addEventListener("input", draw);
    fontSel.addEventListener("change", draw);
    document.getElementById("cancelTypeSig").addEventListener("click", showSigDefault);
    document.getElementById("useTypeSig").addEventListener("click", ()=>{
      if(!input.value.trim()){ toast(t("toolSign.errTypeNameFirst")); return; }
      const img = new Image();
      img.onload = ()=> addSignature(img);
      img.src = preview.toDataURL("image/png");
    });
  }

  // ---- Sidebar: upload method ----
  function showUploadMethod(){
    clearDrawEndHandler();
    panelState = "upload";
    sigPanelArea.innerHTML = `
      <div class="tool-content-area-label">${t("toolSign.uploadSignature")}</div>
      <div class="dropzone" id="sigUploadDz" role="button" tabindex="0" aria-label="${t("toolSign.chooseSignatureImage")}" aria-controls="sigUploadInput" style="padding:20px 12px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="28" height="28"><path d="M12 16V4M12 4l-4 4M12 4l4 4"/><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/></svg>
        <div><strong>${t("toolSign.chooseFile")}</strong></div>
        <div class="hint">${t("toolSign.uploadHint")}</div>
        <input type="file" id="sigUploadInput" class="hidden" accept="image/png,image/jpeg,image/webp" aria-label="${t("toolSign.chooseSignatureImage")}">
      </div>
      <div id="sigUploadPreviewWrap" style="display:none;margin-top:10px;text-align:center">
        <div class="canvas-wrap sig-transparency-bg"><img id="sigUploadPreview" alt="${t("toolSign.signatureAlt")}" style="max-width:100%;max-height:140px;display:block;margin:0 auto"></div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn secondary" id="cancelUploadSig" type="button">${t("workspace.cancel")}</button>
        <button class="btn" id="useUploadSig" type="button" disabled>${t("toolSign.useSignature")}</button>
      </div>
    `;
    const dz = document.getElementById("sigUploadDz");
    const input = document.getElementById("sigUploadInput");
    const previewWrap = document.getElementById("sigUploadPreviewWrap");
    const previewImg = document.getElementById("sigUploadPreview");
    const useBtn = document.getElementById("useUploadSig");
    let uploadedImg = null;
    let uploadGeneration = 0;
    async function handleFile(f){
      if(!f) return;
      const generation = ++uploadGeneration;
      try{
        if(typeof validateFileSelection === "function") {
          await validateFileSelection([f], {accept:input.accept, multiple:false});
        } else if(!/^image\/(png|jpeg|webp)$/.test(f.type)) {
          throw new Error(t("toolSign.errChoosePngJpgWebp"));
        }
      }catch(error){
        if(generation === uploadGeneration) toast(error?.message || t("toolSign.errInvalidSignatureImage"));
        return;
      }
      const reader = new FileReader();
      reader.onerror = ()=>{ if(generation === uploadGeneration) toast(t("toolSign.errCouldNotReadImage")); };
      reader.onload = ()=>{
        if(generation !== uploadGeneration) return;
        const img = new Image();
        img.onerror = ()=>{ if(generation === uploadGeneration) toast(t("toolSign.errCouldNotDecodeImage")); };
        img.onload = ()=>{
          if(generation !== uploadGeneration) return;
          const limits = window.YOYO_RUNTIME?.limits;
          const pixels = img.naturalWidth * img.naturalHeight;
          if(!img.naturalWidth || !img.naturalHeight || (limits && (pixels > limits.maxImagePixels || img.naturalWidth > limits.maxImageDimension || img.naturalHeight > limits.maxImageDimension))){
            toast(t("toolSign.errImageTooLarge"));
            return;
          }
          uploadedImg = img;
          previewImg.src = img.src;
          previewWrap.style.display = "";
          useBtn.disabled = false;
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(f);
    }
    dz.addEventListener("click", event=>{ if(event.target !== input) input.click(); });
    dz.addEventListener("keydown", event=>{
      if(event.key === "Enter" || event.key === " "){ event.preventDefault(); input.click(); }
    });
    input.addEventListener("change", ()=>{ const file=input.files[0]; input.value=""; handleFile(file); });
    ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault(); dz.classList.add("drag");}));
    ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault(); dz.classList.remove("drag");}));
    dz.addEventListener("drop", e=>handleFile(e.dataTransfer.files[0]));    document.getElementById("cancelUploadSig").addEventListener("click", showSigDefault);
    useBtn.addEventListener("click", ()=>{ if(uploadedImg) addSignature(uploadedImg); });
  }

  // Normalizes any source (canvas-drawn, typed, or an uploaded PNG/JPG/
  // WEBP) into one PNG data URL up front - preserves transparency where
  // the source has it, and means export only ever needs doc.embedPng(),
  // regardless of which of the 3 methods created the signature.
  function toPngDataUrl(img){
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img,0,0);
    return c.toDataURL("image/png");
  }
  function addSignature(img){
    const meta = pagesMeta[activePage-1] || pagesMeta[0];
    if(!meta){ toast(t("toolSign.errPageNotReady")); return; }
    const pngDataUrl = toPngDataUrl(img);
    const ratio = img.naturalWidth/img.naturalHeight;
    // Default placement: bottom-right, safe margins, moderate size -
    // computed against a reference rendering of the page in view (the
    // same "cap the page at 700px wide" baseline the old single-canvas
    // preview used, so the default size is unchanged), then stored as
    // page-relative fractions so it's immediately valid for every page
    // (including ones not rendered yet).
    const refScale = Math.min(1, 700/meta.widthPt);
    const refW = meta.widthPt*refScale, refH = meta.heightPt*refScale;
    const wPx = Math.min(180, refW*0.42);
    const hPx = wPx/ratio;
    const margin = 20;
    const defaultPlacement = {
      xFrac: (refW - wPx - margin)/refW,
      yFrac: (refH - hPx - margin)/refH,
      wFrac: wPx/refW
    };
    const id = ++assetIdCounter;
    assets.push({id, img, pngDataUrl, ratio, defaultPlacement, pageOverrides:{}, hiddenPages:new Set()});
    selectedAssetId = id;
    redrawAllPages();
    showSigDefault();
  }
  function deleteAsset(id){
    assets = assets.filter(a=>a.id!==id);
    if(selectedAssetId===id) selectedAssetId=null;
    redrawAllPages();
    refreshSigListIfIdle();
  }

  // ---- Signature layers: one per page, rebuilt from the asset model.
  // Every asset not hidden on that page is drawn automatically - a
  // signature never needs re-adding per page. ----

  /** Placement -> page-relative rect, all four values fractions 0..1 of
   * THAT page's own box. Height is derived from the image's aspect ratio
   * and the page's own point dimensions, so the signature keeps its true
   * proportions on pages of any shape.
   *
   * The clamp matters on documents that mix page sizes: a placement made
   * on a portrait page is taller in fractions of a landscape page, so a
   * shared default placed near the bottom can run past the edge there.
   * The export below already clamps exactly this way (its x/y are
   * Math.max(0, Math.min(..., width-w / height-h))), so clamping here
   * too is what makes the preview show the position the signed PDF
   * actually gets, rather than one hanging off the page. */
  function placementRect(asset, meta, placement){
    const w = placement.wFrac;
    const h = (w * meta.widthPt / asset.ratio) / meta.heightPt;
    return {
      x: Math.max(0, Math.min(placement.xFrac, 1-w)),
      y: Math.max(0, Math.min(placement.yFrac, 1-h)),
      w, h
    };
  }
  function redrawPage(meta){
    if(!meta || !meta.layerEl) return;
    meta.layerEl.textContent = "";
    assets.forEach(asset=>{
      if(asset.hiddenPages.has(meta.pageNum)) return;
      const r = placementRect(asset, meta, effectivePlacement(asset, meta.pageNum));
      const isSel = asset.id===selectedAssetId && meta.pageNum===activePage;
      const el = document.createElement("div");
      el.className = "sign-sig" + (isSel ? " sign-sig-selected" : "");
      el.dataset.assetId = String(asset.id);
      el.style.left = (r.x*100)+"%";
      el.style.top = (r.y*100)+"%";
      el.style.width = (r.w*100)+"%";
      el.style.height = (r.h*100)+"%";
      const im = document.createElement("img");
      im.className = "sign-sig-img"; im.src = asset.pngDataUrl; im.alt = t("toolSign.signatureAlt");
      el.appendChild(im);
      if(isSel){
        ["nw","ne","se","sw"].forEach((c,i)=>{
          const hd = document.createElement("div");
          hd.className = "sign-sig-handle "+c; hd.dataset.corner = String(i);
          el.appendChild(hd);
        });
        const del = document.createElement("button");
        del.type = "button"; del.className = "sign-sig-del";
        del.setAttribute("aria-label",t("toolSign.deleteSignature"));
        del.textContent = "×";
        el.appendChild(del);
      }
      meta.layerEl.appendChild(el);
    });
  }
  function redrawAllPages(){
    pagesMeta.forEach(m=>{
      m.wrapEl.classList.toggle("sign-page-active", m.pageNum===activePage && selectedAssetId!==null);
      redrawPage(m);
    });
    updateReadout();
  }
  function updateReadout(){
    readout.textContent = assets.length===0
      ? t("toolSign.readoutEmpty")
      : selectedAssetId
        ? t("toolSign.readoutSelected")
        : t("toolSign.readoutUnselected");
  }

  // ---- Placement interaction, wired per page. Everything is expressed
  // in fractions of the page's OWN box, never in viewport or canvas-
  // bitmap pixels, so scroll position and zoom are irrelevant to the
  // stored placement. ----
  function pageBox(meta){ return meta.wrapEl.getBoundingClientRect(); }
  function commitRect(asset, meta, rect){
    // Clamp inside the page, then store as that page's own override.
    const w = Math.min(rect.w, 1), h = Math.min(rect.h, 1);
    asset.pageOverrides[meta.pageNum] = {
      xFrac: Math.max(0, Math.min(1-w, rect.x)),
      yFrac: Math.max(0, Math.min(1-h, rect.y)),
      wFrac: w
    };
  }
  function setActivePage(pageNum){
    if(activePage === pageNum) return;
    activePage = pageNum;
  }
  function cornerAnchor(rect, corner){
    switch(corner){
      case 0: return {x:rect.x+rect.w, y:rect.y+rect.h};
      case 1: return {x:rect.x, y:rect.y+rect.h};
      case 2: return {x:rect.x, y:rect.y};
      default: return {x:rect.x+rect.w, y:rect.y};
    }
  }
  function wireSigLayer(meta){
    meta.layerEl.addEventListener("pointerdown", e=>{
      if(e.button!=null && e.button!==0) return;
      // Keyboard nudge/resize/delete listens on the viewport, so give it
      // focus on any placement interaction. preventScroll: focusing must
      // never yank the document away from the page just clicked.
      try{ docViewport.focus({preventScroll:true}); }catch(err){ docViewport.focus(); }
      const sigEl = e.target.closest(".sign-sig");
      if(!sigEl){
        if(selectedAssetId!==null){ selectedAssetId=null; redrawAllPages(); refreshSigListIfIdle(); }
        return;
      }
      const asset = assets.find(a=>a.id===parseInt(sigEl.dataset.assetId,10));
      if(!asset) return;
      if(e.target.closest(".sign-sig-del")){ deleteAsset(asset.id); return; }
      // A handle only counts when this signature was ALREADY the
      // selected one on this page - the handles don't exist otherwise,
      // and the first click on an unselected signature just selects it.
      const wasSelectedHere = (selectedAssetId===asset.id && activePage===meta.pageNum);
      const handleEl = wasSelectedHere ? e.target.closest(".sign-sig-handle") : null;
      if(!wasSelectedHere){
        selectedAssetId = asset.id;
        setActivePage(meta.pageNum);
        redrawAllPages();
        refreshSigListIfIdle();
      }
      const box = pageBox(meta);
      if(!box.width || !box.height) return;
      const r = placementRect(asset, meta, effectivePlacement(asset, meta.pageNum));
      const rectPx = {x:r.x*box.width, y:r.y*box.height, w:r.w*box.width, h:r.h*box.height};
      // Capture is best-effort (keeps the drag tracking correctly if the
      // pointer leaves this page's own bounds mid-gesture) - it can throw
      // in some browsers/edge cases, which must not abort the handler.
      try{ meta.layerEl.setPointerCapture(e.pointerId); }catch(err){}
      if(handleEl){
        const corner = parseInt(handleEl.dataset.corner,10);
        drag = {mode:"resize", asset, meta, corner, anchor:cornerAnchor(rectPx, corner)};
      }else{
        drag = {mode:"move", asset, meta, startPt:{x:e.clientX-box.left, y:e.clientY-box.top}, startRect:rectPx};
      }
      e.preventDefault();
    });
    meta.layerEl.addEventListener("pointermove", e=>{
      if(!drag || drag.meta!==meta) return;
      const box = pageBox(meta);
      if(!box.width || !box.height) return;
      const px = e.clientX-box.left, py = e.clientY-box.top;
      let rectPx;
      if(drag.mode==="move"){
        const dx = px-drag.startPt.x, dy = py-drag.startPt.y;
        rectPx = {
          x: Math.max(0, Math.min(box.width-drag.startRect.w, drag.startRect.x+dx)),
          y: Math.max(0, Math.min(box.height-drag.startRect.h, drag.startRect.y+dy)),
          w: drag.startRect.w, h: drag.startRect.h
        };
      }else{
        // The page box and the page's point box are uniformly scaled
        // versions of each other (the wrapper's CSS aspect-ratio IS the
        // page's), so the image's own w/h ratio holds directly in these
        // page pixels - same arithmetic the old canvas version used.
        const ratio = drag.asset.ratio, a = drag.anchor;
        const dx = px-a.x;
        let newW = Math.max(24, Math.abs(dx));
        let newH = newW/ratio;
        if(newH < 24){ newH = 24; newW = newH*ratio; }
        const growRight = drag.corner===1||drag.corner===2;
        const growDown = drag.corner===2||drag.corner===3;
        newW = Math.min(newW, growRight ? box.width-a.x : a.x);
        newH = newW/ratio;
        newH = Math.min(newH, growDown ? box.height-a.y : a.y);
        newW = newH*ratio;
        rectPx = {w:newW, h:newH, x: growRight?a.x:a.x-newW, y: growDown?a.y:a.y-newH};
      }
      commitRect(drag.asset, meta, {x:rectPx.x/box.width, y:rectPx.y/box.height, w:rectPx.w/box.width, h:rectPx.h/box.height});
      redrawPage(meta);
      e.preventDefault();
    });
    function endDrag(){
      if(drag && drag.meta===meta){ drag=null; refreshSigListIfIdle(); }
    }
    meta.layerEl.addEventListener("pointerup", endDrag);
    meta.layerEl.addEventListener("pointercancel", endDrag);
  }

  // Every placement interaction above (drag to move, corner-handle
  // resize, click the × to delete) is pointer-only - a keyboard/screen-
  // reader user could add a signature but then have no way at all to
  // reposition, resize, or remove it. Mirrors the same operations from
  // the keyboard once a signature is selected (from the sidebar list or
  // by tabbing to the document): arrows nudge, Shift+arrow nudges
  // further, +/- resizes (anchored top-left, aspect ratio preserved,
  // same clamping the pointer paths use so a keyboard user can't push a
  // signature off the page either), Delete/Backspace removes it, Escape
  // deselects. Listening on the viewport rather than on a per-signature
  // element keeps this working across the signature-layer rebuilds that
  // every edit triggers.
  docViewport.tabIndex = 0;
  docViewport.setAttribute("role", "application");
  docViewport.setAttribute("aria-label", t("toolSign.docViewportAriaLabel"));
  docViewport.addEventListener("keydown", e=>{
    const meta = pagesMeta[activePage-1];
    const selected = assets.find(a=>a.id===selectedAssetId && !a.hiddenPages.has(activePage));
    if(!selected || !meta) return;
    const box = pageBox(meta);
    if(!box.width || !box.height) return;
    const r = placementRect(selected, meta, effectivePlacement(selected, meta.pageNum));
    const rectPx = {x:r.x*box.width, y:r.y*box.height, w:r.w*box.width, h:r.h*box.height};
    const step = e.shiftKey ? 20 : 4;
    let handled = true;
    if(e.key==="ArrowLeft" || e.key==="ArrowRight" || e.key==="ArrowUp" || e.key==="ArrowDown"){
      const dx = e.key==="ArrowLeft" ? -step : e.key==="ArrowRight" ? step : 0;
      const dy = e.key==="ArrowUp" ? -step : e.key==="ArrowDown" ? step : 0;
      const x = Math.max(0, Math.min(box.width-rectPx.w, rectPx.x+dx));
      const y = Math.max(0, Math.min(box.height-rectPx.h, rectPx.y+dy));
      commitRect(selected, meta, {x:x/box.width, y:y/box.height, w:r.w, h:r.h});
    } else if(e.key==="+" || e.key==="=" || e.key==="-" || e.key==="_"){
      const grow = (e.key==="+" || e.key==="=");
      const factor = grow ? 1.1 : 0.9;
      let newW = Math.max(24, rectPx.w*factor);
      newW = Math.min(newW, box.width-rectPx.x);
      let newH = newW/selected.ratio;
      newH = Math.min(newH, box.height-rectPx.y);
      newW = newH*selected.ratio;
      commitRect(selected, meta, {x:r.x, y:r.y, w:newW/box.width, h:newH/box.height});
    } else if(e.key==="Delete" || e.key==="Backspace"){
      e.preventDefault(); e.stopPropagation();
      deleteAsset(selected.id); // already redraws + refreshes the list itself
      return;
    } else if(e.key==="Escape"){
      // Must stop this from bubbling to document's own Escape handler
      // (closePanel() - see its comment for the identical conflict
      // TOOLS.edit already had to guard against) - without this, Escape
      // while the document is focused doesn't just deselect the
      // signature, it closes the ENTIRE Sign PDF panel and discards all
      // of the user's in-progress signature placement.
      e.preventDefault(); e.stopPropagation();
      selectedAssetId = null;
      redrawAllPages();
      refreshSigListIfIdle();
      return;
    } else {
      handled = false;
    }
    if(handled){ e.preventDefault(); e.stopPropagation(); redrawPage(meta); refreshSigListIfIdle(); }
  });

  // ---- Continuous multi-page document (same architecture as Crop PDF) ----

  /** Tears down the page list/observer/scroll handler and releases every
   * page bitmap - used both when starting a fresh build and when the
   * file is removed, so a second upload can never leave the first
   * document's canvases (or its pdf.js worker data) alive. */
  function resetDocState(){
    if(docObserver){ docObserver.disconnect(); docObserver=null; }
    if(fallbackScanHandler){ docViewport.removeEventListener("scroll", fallbackScanHandler); fallbackScanHandler=null; }
    pagesMeta.forEach(m=>{ if(m.canvasEl){ m.canvasEl.width=0; m.canvasEl.height=0; } });
    pagesMeta=[]; numPages=0; activePage=1; currentPageIndex=0; drag=null;
    docEl.textContent="";
    if(pdoc){ try{ pdoc.destroy(); }catch(e){} pdoc=null; }
  }

  /** Lays out every page up front (cheap metadata-only pass - no pixels
   * rendered yet) so the full document exists in the scroll flow
   * immediately, then wires lazy bitmap rendering + the "current page"
   * tracker off one shared IntersectionObserver. */
  async function buildDocument(myToken){
    for(let i=1; i<=numPages; i++){
      const page = await pdoc.getPage(i);
      if(myToken !== loadToken) return;
      const vp = page.getViewport({scale:1});
      const wrap = document.createElement("div");
      wrap.className = "sign-page";
      wrap.dataset.pageIndex = String(i-1);
      wrap.style.aspectRatio = `${vp.width} / ${vp.height}`;
      wrap.innerHTML = `
        <canvas class="sign-page-canvas"></canvas>
        <div class="sign-page-loading">${t("toolSign.loadingPageN",{n:i})}</div>
        <div class="sign-sig-layer"></div>
        <div class="sign-page-num">${i} / ${numPages}</div>`;
      const meta = {
        index:i-1, pageNum:i, widthPt:vp.width, heightPt:vp.height,
        wrapEl:wrap, canvasEl:wrap.querySelector(".sign-page-canvas"),
        layerEl:wrap.querySelector(".sign-sig-layer"),
        rendered:false, rendering:false
      };
      docEl.appendChild(wrap);
      pagesMeta.push(meta);
      wireSigLayer(meta);
      page.cleanup();
    }
    applyZoomWidth();
    updatePageIndicator();
    redrawAllPages();

    docObserver = new IntersectionObserver((entries)=>{
      let bestIdx = currentPageIndex, bestRatio = 0;
      entries.forEach(entry=>{
        const idx = Number(entry.target.dataset.pageIndex);
        if(entry.isIntersecting){
          renderPageIfNeeded(pagesMeta[idx], myToken);
          if(entry.intersectionRatio > bestRatio){ bestRatio = entry.intersectionRatio; bestIdx = idx; }
        }
      });
      if(bestRatio > 0 && bestIdx !== currentPageIndex){
        currentPageIndex = bestIdx;
        onCurrentPageChanged();
      }
      releaseDistantPages();
    }, {root:docViewport, rootMargin:"600px 0px", threshold:[0,0.15,0.3,0.5,0.75,1]});
    pagesMeta.forEach(m=>docObserver.observe(m.wrapEl));

    // Geometry-based fallback alongside the observer above (not instead
    // of it): IntersectionObserver callbacks are tied to the browser
    // actually producing compositor frames, which some embedded/headless
    // hosts suspend for an offscreen/inactive view - without this, pages
    // could sit permanently unrendered there even though every rect is
    // correct. setTimeout-throttled rather than rAF-throttled for that
    // same reason. Same fallback Crop PDF needed for the same hosts.
    let fallbackQueued = false;
    function fallbackScan(){
      fallbackQueued = false;
      if(myToken !== loadToken) return;
      const vRect = docViewport.getBoundingClientRect();
      let bestIdx = currentPageIndex, bestOverlap = 0;
      pagesMeta.forEach(m=>{
        const r = m.wrapEl.getBoundingClientRect();
        const overlap = Math.max(0, Math.min(r.bottom, vRect.bottom) - Math.max(r.top, vRect.top));
        if(overlap > 0 && r.top < vRect.bottom + 900 && r.bottom > vRect.top - 900){
          renderPageIfNeeded(m, myToken);
        }
        if(overlap > bestOverlap){ bestOverlap = overlap; bestIdx = m.index; }
      });
      if(bestOverlap > 0 && bestIdx !== currentPageIndex){
        currentPageIndex = bestIdx;
        onCurrentPageChanged();
      }
      releaseDistantPages();
    }
    function queueFallbackScan(){
      if(fallbackQueued) return;
      fallbackQueued = true;
      setTimeout(fallbackScan, 100);
    }
    fallbackScanHandler = queueFallbackScan;
    docViewport.addEventListener("scroll", fallbackScanHandler, {passive:true});
    queueFallbackScan();
  }

  async function renderPageIfNeeded(meta, myToken){
    if(!meta || !pdoc || meta.rendered || meta.rendering) return;
    meta.rendering = true;
    try{
      // Fixed bitmap width baseline (not tied to the current CSS zoom
      // level) - stays sharp from 60% to 160% zoom without a re-render
      // per zoom step, since zoom only ever changes the page's CSS width.
      const targetW = 900;
      const scale = targetW / meta.widthPt;
      const rendered = await renderPdfPageCanvas(pdoc, meta.pageNum, scale);
      if(myToken !== loadToken || !meta.canvasEl.isConnected) return;
      meta.canvasEl.width = rendered.width; meta.canvasEl.height = rendered.height;
      meta.canvasEl.getContext("2d").drawImage(rendered, 0, 0);
      meta.rendered = true;
      meta.wrapEl.classList.add("sign-page-rendered");
    }catch(e){
      if(myToken !== loadToken) return;
      const loading = meta.wrapEl.querySelector(".sign-page-loading");
      if(loading) loading.textContent = t("toolSign.errCouldNotRenderPage");
    }finally{
      meta.rendering = false;
    }
  }

  // A 900px-wide page bitmap costs a few MB, so a 100+ page document
  // scrolled end to end would otherwise hold every one of them alive at
  // once. Pages far outside the viewport drop their bitmap and re-render
  // lazily on the way back; the signature layer is plain DOM in page
  // percentages and is never touched, so placements survive the round
  // trip exactly. Only long documents evict - short ones behave exactly
  // as before, with every page staying rendered.
  const KEEP_RADIUS = 8;
  function releaseDistantPages(){
    if(numPages <= 20) return;
    pagesMeta.forEach(m=>{
      if(!m.rendered || m.rendering) return;
      if(Math.abs(m.index - currentPageIndex) <= KEEP_RADIUS) return;
      m.canvasEl.width = 0; m.canvasEl.height = 0;
      m.rendered = false;
      m.wrapEl.classList.remove("sign-page-rendered");
    });
  }

  function onCurrentPageChanged(){
    updatePageIndicator();
    // Scrolling is now the only way to change page, so the page every
    // per-page control acts on ("Hide on page N", "Apply to all pages"
    // reading its source placement, the selection outline) follows the
    // page in view. Without this, selecting a signature from the
    // sidebar list and then scrolling would leave those controls
    // silently pinned to the page the user has scrolled away from. Not
    // while a drag is in flight: retargeting mid-gesture would hand the
    // move/resize to a different page's placement.
    if(drag || activePage === currentPageIndex+1) return;
    const prevMeta = pagesMeta[activePage-1];
    activePage = currentPageIndex+1;
    const nowMeta = pagesMeta[activePage-1];
    // Only the two pages whose selection state actually changed get
    // rebuilt - a full redrawAllPages() here would rebuild every page's
    // layer on every scrolled-past page of a long document.
    if(prevMeta){ prevMeta.wrapEl.classList.remove("sign-page-active"); redrawPage(prevMeta); }
    if(nowMeta){ nowMeta.wrapEl.classList.toggle("sign-page-active", selectedAssetId!==null); redrawPage(nowMeta); }
    refreshSigListIfIdle();
  }
  function updatePageIndicator(){ pageIndicator.textContent = t("toolSign.pageIndicator",{n:currentPageIndex+1, total:Math.max(numPages,1)}); }

  // Fits the page to the actual workspace on BOTH axes, not just width -
  // a portrait page capped only by width can still be taller than the
  // whole viewport, forcing a scroll just to see page 1. Same sizing
  // Crop PDF uses. Signatures need no adjustment on zoom/resize: they
  // are percentages of this same box.
  function applyZoomWidth(){
    if(!pagesMeta.length) return;
    const containerW = docViewport.clientWidth - 32;
    const containerH = docViewport.clientHeight - 44;
    const aspect = pagesMeta[0].widthPt / pagesMeta[0].heightPt;
    const widthFromWidth = containerW || 640;
    const widthFromHeight = (containerH>0 ? containerH : 620) * 0.82 * aspect;
    const base = Math.max(320, Math.min(680, widthFromWidth, widthFromHeight));
    const w = Math.round(base*zoom);
    pagesMeta.forEach(m=>{ m.wrapEl.style.maxWidth = w+"px"; });
  }
  function updateZoomLabel(){ zoomLevelEl.textContent = Math.round(zoom*100)+"%"; }
  zoomInBtn.addEventListener("click", ()=>{ zoom=Math.min(1.6, +(zoom+0.1).toFixed(2)); applyZoomWidth(); updateZoomLabel(); });
  zoomOutBtn.addEventListener("click", ()=>{ zoom=Math.max(0.6, +(zoom-0.1).toFixed(2)); applyZoomWidth(); updateZoomLabel(); });
  // Already guarded workspace.isConnected before this to avoid acting on a
  // detached tree, but never actually unregistered - self-remove instead,
  // same fix as the identical pattern in pdf-page-tools-2.js/image-tools.js.
  // rAF-coalesced (see pdf-page-tools-2.js's identical resizeHandler
  // comment) since applyZoomWidth() here writes a style per pagesMeta
  // entry too.
  let resizeRaf = null;
  resizeHandler = ()=>{
    if(!workspace.isConnected){
      window.removeEventListener("resize", resizeHandler);
      if(resizeRaf) cancelAnimationFrame(resizeRaf);
      return;
    }
    if(resizeRaf) return;
    resizeRaf = requestAnimationFrame(()=>{
      resizeRaf = null;
      if(workspace.style.display!=="none") applyZoomWidth();
    });
  };
  window.addEventListener("resize", resizeHandler);

  showSigDefault();
  updateReadout();

  wireDropzone(async fs=>{
    // Same loadToken guard as every other async wireDropzone tool - a
    // second upload landing mid-render must not let the first one's
    // stale render overwrite it.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null; assets=[]; selectedAssetId=null;
      resetDocState();
      showSigDefault();
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    assets=[]; selectedAssetId=null;
    showSigDefault();
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    let loadedPdoc;
    try{
      loadedPdoc = await loadPdfJsSafe({data:bytes.slice(0)});
    }catch(e){
      if(myToken !== loadToken) return;
      toast(t("toolSign.errCouldNotReadPdf"));
      return;
    }
    if(myToken !== loadToken){ try{ loadedPdoc.destroy(); }catch(e){} return; }
    resetDocState();
    pdoc = loadedPdoc;
    numPages = pdoc.numPages;
    // Workspace must already be laid out (display:flex, real box sizes)
    // before buildDocument() creates the IntersectionObserver - observing
    // targets still inside a display:none subtree means the observer's
    // root never has a size, so pages never get marked as intersecting
    // even after the subtree becomes visible.
    showWorkspace();
    try{
      await buildDocument(myToken);
    }catch(e){
      if(myToken !== loadToken) return;
      toast(t("toolSign.errCouldNotRenderPdf"));
    }
  });

  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out");
    if(!file){ toast(t("toolSign.errChoosePdfFirst")); return; }
    if(assets.length===0){ toast(t("toolSign.errAddSignatureFirst")); return; }
    out.innerHTML=statusEl(assets.length>1 ? t("toolSign.statusPlacingSignatures") : t("toolSign.statusPlacingSignature"));
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    const pageCount = doc.getPageCount();
    // Identical assets only need to be embedded into the PDF once, then
    // reused for every placement across every page - keyed by the
    // normalized PNG data URL.
    const embedCache = new Map();
    let firstPlacedPage = null;
    // Every page gets every non-hidden asset automatically (this is the
    // whole point: one signature, created once, ends up on every page
    // without the user repeating anything) - each page's own real
    // width/height (from pdf-lib, not the on-screen preview) is used so
    // placement and aspect ratio stay correct even if pages differ in
    // size, and a page-specific override (if the user customized that
    // page) wins over the asset's shared default placement.
    for(let pn=0; pn<pageCount; pn++){
      const pageNum = pn+1;
      const page = doc.getPage(pn);
      const {width,height} = page.getSize();
      for(const asset of assets){
        if(asset.hiddenPages.has(pageNum)) continue;
        const placement = asset.pageOverrides[pageNum] || asset.defaultPlacement;
        let embedded = embedCache.get(asset.pngDataUrl);
        if(!embedded){
          const sigBytes = Uint8Array.from(atob(asset.pngDataUrl.split(",")[1]), c=>c.charCodeAt(0));
          embedded = await doc.embedPng(sigBytes);
          embedCache.set(asset.pngDataUrl, embedded);
        }
        const w = placement.wFrac * width;
        const h = w / asset.ratio;
        const x = Math.max(0, Math.min(placement.xFrac*width, width-w));
        const y = Math.max(0, Math.min(height - placement.yFrac*height - h, height-h));
        page.drawImage(embedded, {x, y, width:w, height:h});
        if(firstPlacedPage===null) firstPlacedPage = pageNum;
      }
    }
    const outBytes=await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "signed", "pdf");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas:thumb}=await pdfThumb(outBytes, firstPlacedPage || 1);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:thumb, url, filename:outName}));
  }));
};

/* ---- FILL PDF FORM ---- */
/* ---- FILL PDF FORM ----
   Same page-canvas rendering (renderPdfPageCanvas) and dispScale
   coordinate math Sign PDF/Crop PDF already use. Fields are collected
   once via pdf-lib (already loaded, already used for export - no second
   PDF engine) using each field's widget rectangle (AcroForm position, in
   PDF points) and the widget's page reference matched against
   doc.getPages(), then rendered as real <input>s absolutely positioned
   over the matching page's canvas instead of a plain field-name list
   with no visual connection to the document. */
TOOLS.fillform = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null, doc=null, pdoc=null, currentPage=1, dispScale=1, loadToken=0;
  let fieldsByPage={}, totalFieldCount=0;
  // Field overlays only exist in the DOM for whichever page is currently
  // rendered (renderFieldOverlays() clears+rebuilds them on every page
  // change) - values must be captured into this map as the user types/
  // checks, not read back from the DOM at export time, or navigating
  // to page 2 and filling it would silently discard whatever was
  // entered on page 1. Keyed by field name; radio entries store the
  // selected option's value (or are absent if nothing was chosen).
  let fieldValues={}, fieldTypeByName={};
  openPanel(`
    <div class="panel-head"><h3>${t("tools.fillform")}</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="fillformBody">
      <div class="tool-hero" id="fillformHero">
        <h2 class="tool-hero-title">${t("tools.fillform")}</h2>
        <p class="tool-hero-desc">${t("toolFillform.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap" id="fillformUploadWrap">
        ${fileInputHTML("application/pdf", false, t("workspace.selectPdfFiles"))}
      </div>
      <p class="tool-privacy-hint" id="fillformPrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace" id="fillformWorkspace" style="display:none">
        <div class="tool-main-pane">
          <div class="tool-content-area crop-stage" id="fillformStage">
            <div class="fillform-canvas-wrap" id="fillformCanvasWrap">
              <canvas id="fillformPageCanvas"></canvas>
            </div>
          </div>
          <div class="mono" id="fillformReadout" style="font-size:.78rem;color:var(--ink-soft);text-align:center;margin:6px 0;"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">${t("tools.fillform")}</h3>
          <div id="fillformFileSlot"></div>
          <div class="field" id="fillformPageField" style="display:none">
            <label for="fillformPageNum">${t("toolFillform.pageLabel")}</label>
            <div class="row">
              <button class="btn secondary btn-sm" id="fillformPrevPage" type="button" aria-label="${t("toolFillform.prevPage")}">‹</button>
              <input type="number" id="fillformPageNum" value="1" min="1" style="text-align:center">
              <button class="btn secondary btn-sm" id="fillformNextPage" type="button" aria-label="${t("toolFillform.nextPage")}">›</button>
            </div>
          </div>
          <div id="fillformActions" style="display:none">
            <label style="font-size:.85rem;display:flex;gap:6px;align-items:center;margin-bottom:14px;"><input type="checkbox" id="flat"> ${t("toolFillform.flattenLabel")}</label>
            <button class="btn tool-toolbar-primary" id="go">${t("tools.fillform")}</button>
          </div>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("fillformHero");
  const uploadWrap = document.getElementById("fillformUploadWrap");
  const privacyHint = document.getElementById("fillformPrivacyHint");
  const workspace = document.getElementById("fillformWorkspace");
  const fileSlot = document.getElementById("fillformFileSlot");
  const actions = document.getElementById("fillformActions");
  const body = document.getElementById("fillformBody");
  const pageCanvas = document.getElementById("fillformPageCanvas");
  const canvasWrap = document.getElementById("fillformCanvasWrap");
  const pageField = document.getElementById("fillformPageField");
  const pageNumInput = document.getElementById("fillformPageNum");
  const readout = document.getElementById("fillformReadout");

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

  /* Bumping loadToken invalidates any still-in-flight parse from a
     previous file (upload A -> remove A -> upload B, or upload A ->
     upload B before A finishes parsing): async callbacks below check
     their own captured token against the current one before touching
     the DOM, so a slow/late A can never overwrite B's fields. */
  function resetFormUI(){
    loadToken++;
    // Releases the previous document's worker-side pdf.js resources
    // immediately rather than waiting on GC - same pattern Sign PDF (this
    // file's TOOLS.sign, see its own resetSignState) already uses; this
    // was the one place in the file that dropped `pdoc` without it.
    if(pdoc){ try{ pdoc.destroy(); }catch(e){} }
    doc = null; pdoc = null; fieldsByPage = {}; totalFieldCount = 0;
    fieldValues = {}; fieldTypeByName = {};
    canvasWrap.querySelectorAll(".fillform-field-overlay").forEach(el=>el.remove());
    actions.style.display = "none";
    pageField.style.display = "none";
    showEmptyState();
  }

  /* Collects every AcroForm field's widget(s) - name, type, PDF-point
     rectangle, and (for radio options) which value that widget
     represents - grouped by the 0-based page index each widget actually
     sits on, using pdf-lib's own widget.P() page reference matched
     against doc.getPages(). Runs once per upload, entirely off the
     already-loaded pdf-lib doc - no second parse, no new dependency. */
  function collectFieldsByPage(pdfLibDoc){
    const pageRefs = pdfLibDoc.getPages().map(p=>p.ref);
    const byPage = {};
    let count = 0;
    pdfLibDoc.getForm().getFields().forEach(f=>{
      const isCheckbox = f instanceof PDFLib.PDFCheckBox;
      const isRadio = f instanceof PDFLib.PDFRadioGroup;
      // Radio option values (getOptions()) aren't individually tagged on
      // each widget by pdf-lib's public API - matching by index assumes
      // getWidgets() and getOptions() stay in the same append order,
      // which holds for every PDF this app itself can produce (Sign/
      // Fill are the only tools that create radio groups) and for
      // standard well-formed AcroForms generally.
      const options = isRadio ? f.getOptions() : null;
      f.acroField.getWidgets().forEach((w, i)=>{
        const pageIndex = pageRefs.findIndex(r => r === w.P());
        if(pageIndex === -1) return;
        if(!byPage[pageIndex]) byPage[pageIndex] = [];
        byPage[pageIndex].push({
          name: f.getName(),
          type: isCheckbox ? "check" : (isRadio ? "radio" : "text"),
          rect: w.getRectangle(),
          radioValue: isRadio ? (options[i] || "") : undefined
        });
        fieldTypeByName[f.getName()] = isCheckbox ? "check" : (isRadio ? "radio" : "text");
        count++;
      });
    });
    return {byPage, count};
  }

  function renderFieldOverlays(pageIndex){
    canvasWrap.querySelectorAll(".fillform-field-overlay").forEach(el=>el.remove());
    const fields = fieldsByPage[pageIndex] || [];
    const cw = pageCanvas.width, ch = pageCanvas.height;
    // Percentages of the canvas's own intrinsic size, not fixed px: the
    // canvas is CSS-scaled down (max-width:100%) on narrow viewports so
    // it never causes horizontal overflow, and .fillform-canvas-wrap
    // (position:relative, sized to the canvas's rendered box) shrinks
    // right along with it - percentage-positioned children then track
    // that same scaling automatically. Fixed-px overlays would have
    // stayed put at their unscaled coordinates and drifted off the
    // actual field position the moment the canvas got scaled down.
    fields.forEach(f=>{
      const leftPct = (f.rect.x*dispScale/cw)*100, wPct = (f.rect.width*dispScale/cw)*100;
      const topPct = ((ch-(f.rect.y+f.rect.height)*dispScale)/ch)*100, hPct = (f.rect.height*dispScale/ch)*100;
      const style = `position:absolute;left:${leftPct}%;top:${topPct}%;width:${wPct}%;height:${hPct}%;`;
      let el;
      if(f.type==="check"){
        el = document.createElement("input");
        el.type = "checkbox"; el.style.cssText = style+"margin:0;accent-color:var(--red);";
        el.checked = !!fieldValues[f.name];
        el.addEventListener("change", ()=>{ fieldValues[f.name] = el.checked; });
      } else if(f.type==="radio"){
        el = document.createElement("input");
        el.type = "radio"; el.name = "fillform_rg_"+f.name; el.dataset.value = f.radioValue;
        el.style.cssText = style+"margin:0;accent-color:var(--red);";
        el.checked = fieldValues[f.name] === f.radioValue;
        el.addEventListener("change", ()=>{ if(el.checked) fieldValues[f.name] = f.radioValue; });
      } else {
        el = document.createElement("input");
        el.type = "text";
        el.style.cssText = style+"box-sizing:border-box;padding:0 4px;";
        el.value = fieldValues[f.name] || "";
        el.addEventListener("input", ()=>{ fieldValues[f.name] = el.value; });
      }
      el.className = "fillform-field-overlay";
      el.dataset.fname = f.name; el.dataset.ftype = f.type;
      canvasWrap.appendChild(el);
    });
    readout.textContent = fields.length
      ? t(fields.length>1 ? "toolFillform.fieldsOnPageMany" : "toolFillform.fieldsOnPageOne", {n:fields.length})
      : t("toolFillform.noFieldsOnPage");
  }

  async function renderPage(pageNum, myToken){
    readout.textContent = t("toolFillform.statusRenderingPage");
    let rendered;
    try{
      rendered = await renderPdfPageCanvas(pdoc, pageNum, dispScale);
    }catch(e){
      if(myToken !== loadToken) return false;
      readout.textContent = t("toolFillform.errCouldNotRenderPage");
      return false;
    }
    if(myToken !== loadToken) return false;
    pageCanvas.width = rendered.width; pageCanvas.height = rendered.height;
    pageCanvas.getContext("2d").drawImage(rendered, 0, 0);
    currentPage = pageNum;
    pageNumInput.value = pageNum;
    renderFieldOverlays(pageNum-1);
    return true;
  }

  async function goToPage(n){
    const myToken = loadToken;
    const clamped = Math.min(Math.max(n,1), pdoc.numPages);
    if(clamped === currentPage) return;
    await renderPage(clamped, myToken);
  }
  document.getElementById("fillformPrevPage").addEventListener("click", ()=>goToPage(currentPage-1));
  document.getElementById("fillformNextPage").addEventListener("click", ()=>goToPage(currentPage+1));
  pageNumInput.addEventListener("change", ()=>goToPage(parseInt(pageNumInput.value)||1));

  wireDropzone(async fs=>{
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{ file=null; resetFormUI(); });
    resetFormUI();
    // resetFormUI() bumped loadToken again - recapture so this run's own
    // guard checks below compare against the right value.
    const runToken = loadToken;
    fileSlot.appendChild(document.getElementById("flist"));
    readout.textContent = t("workspace.statusReadingPdf");
    showWorkspace();

    let parsedDoc, loadedPdoc, collected;
    try{
      const bytes = await file.arrayBuffer();
      parsedDoc = await loadPdfSafe(bytes);
      collected = collectFieldsByPage(parsedDoc);
      loadedPdoc = await loadPdfJsSafe({data:bytes.slice(0)});
    }catch(e){
      if(runToken !== loadToken) return;
      readout.textContent = t("toolFillform.errCouldNotReadPdf", {msg: e.message});
      return;
    }
    if(runToken !== loadToken) return;
    doc = parsedDoc; pdoc = loadedPdoc;
    fieldsByPage = collected.byPage; totalFieldCount = collected.count;

    const page1 = await pdoc.getPage(1);
    if(runToken !== loadToken) return;
    const vp1 = page1.getViewport({scale:1});
    dispScale = Math.min(1, 700/vp1.width);
    pageField.style.display = pdoc.numPages>1 ? "block" : "none";
    pageNumInput.max = pdoc.numPages;

    await renderPage(1, runToken);
    if(runToken !== loadToken) return;
    actions.style.display = totalFieldCount>0 ? "block" : "none";
    if(totalFieldCount===0){
      readout.textContent = t("toolFillform.noFillableFields");
    }
  });

  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("toolFillform.statusFillingForm"));
    const form = doc.getForm();
    // Reads from fieldValues (kept in sync by each overlay input's own
    // change/input listener), not the live DOM - only the current page's
    // overlay inputs exist in the DOM at any moment, so a multi-page form
    // filled across several pages would otherwise lose every page but
    // the one visible at export time.
    Object.keys(fieldValues).forEach(name=>{
      const type = fieldTypeByName[name];
      const value = fieldValues[name];
      try{
        if(type==="check"){
          const cb = form.getCheckBox(name);
          value ? cb.check() : cb.uncheck();
        } else if(type==="radio"){
          if(value) form.getRadioGroup(name).select(value);
        } else {
          form.getTextField(name).setText(value);
        }
      }catch(e){}
    });
    if(document.getElementById("flat").checked) form.flatten();
    const outBytes = await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "filled", "pdf");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
  }));
};
