/* ---- MERGE ---- */
TOOLS.merge = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let files=[];
  openPanel(`
    <div class="panel-head"><h3>${t("nav.merge")}</h3></div>
    <div class="panel-body compact tool-workspace merge-workspace" id="mergeBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("toolMerge.heroTitle")}</h2>
        <p class="tool-hero-desc">${t("toolMerge.heroDesc")}</p>
      </div>
      <p class="page-grid-hint" id="mergeHint" style="display:none">${t("toolMerge.hint")}</p>
      <div class="tool-upload-wrap workspace-host" id="mergeUploadWrap">
        ${fileInputHTML("application/pdf", true, t("workspace.selectPdfFiles"))}
        <div class="workspace-action-stack" id="mergeFileToolbar" style="display:none">
          <button type="button" class="workspace-action-btn workspace-action-primary" id="mergeAddFab" aria-label="${t("workspace.addMoreFiles")}" data-tip="${t("workspace.addMoreFiles")}">
            +<span class="workspace-action-badge" id="mergeFileCount" hidden></span>
          </button>
          <button type="button" class="workspace-action-btn" id="mergeSortBtn" aria-label="${t("toolMerge.sortAria")}" data-tip="${t("toolMerge.sortAria")}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h6M3 12h9M3 18h12"/></svg>
          </button>
        </div>
      </div>
      <div class="tool-content-area merge-info-tip">
        <span class="tip-icon" aria-hidden="true">ℹ️</span><span>${t("toolMerge.tip")}</span>
      </div>
      <div class="tool-toolbar" id="mergeToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go" disabled>${t("toolMerge.goBtn")} <span aria-hidden="true">&rarr;</span></button>
      </div>
      <div id="out"></div>
    </div>`);
  const flistDrag = wireFileCardDrag(()=>files, reordered=>{ files = reordered; refresh(); });
  const refresh = ()=>{
    renderFileList(files, i=>{files.splice(i,1); refresh();});
    document.querySelectorAll("#flist .file-card").forEach((card,i)=>{
      let badge = card.querySelector(".file-card-order");
      if(!badge){ badge = document.createElement("span"); badge.className="file-card-order"; card.prepend(badge); }
      badge.textContent = i+1;
    });
    flistDrag.rewire();
    // wireFileCardDrag()'s own click handler already no-ops a move past
    // either end (index/target bounds check) - this just SHOWS that same
    // boundary up front (disabled + a merge-specific aria-label) instead
    // of a control that silently does nothing when pressed at the first/
    // last position.
    const cards = document.querySelectorAll("#flist .file-card");
    cards.forEach((card,i)=>{
      const left = card.querySelector('.file-card-order-controls button[data-move="-1"]');
      const right = card.querySelector('.file-card-order-controls button[data-move="1"]');
      if(left){ left.disabled = i===0; left.setAttribute("aria-label", t("toolMerge.moveLeft")); }
      if(right){ right.disabled = i===cards.length-1; right.setAttribute("aria-label", t("toolMerge.moveRight")); }
    });
    document.getElementById("go").disabled = files.length<2;
    document.getElementById("mergeToolbar").style.display = files.length ? "flex" : "none";
    document.getElementById("mergeFileToolbar").style.display = files.length ? "flex" : "none";
    // Same empty->loaded hint reveal Delete/Reorder/Organize/Rotate/Split
    // all use for their own #gridHint - the sidebar's .tool-hero-desc
    // (hidden once loaded, see the #mergeBody.is-loaded CSS rule) covers
    // the pre-upload description instead, so exactly one description is
    // ever visible at a time.
    document.getElementById("mergeHint").style.display = files.length ? "block" : "none";
    const countBadge = document.getElementById("mergeFileCount");
    if(files.length){ countBadge.hidden=false; countBadge.textContent = files.length; } else countBadge.hidden = true;
    document.getElementById("mergeBody").classList.toggle("is-loaded", files.length>0);
  };
  document.getElementById("mergeSortBtn").addEventListener("click", ()=>{
    files = [...files].sort((a,b)=>a.name.localeCompare(b.name));
    refresh();
  });
  document.getElementById("mergeAddFab").addEventListener("click", ()=>document.getElementById("fi").click());
  wireDropzone(fs=>{ files = files.concat(fs.filter(f=>f.type==="application/pdf"||f.name.endsWith(".pdf"))); refresh(); });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolMerge.statusMerging"));
    const merged = await PDFDocument.create();
    for(const f of files){
      const bytes = await f.arrayBuffer();
      const src = await loadPdfSafe(bytes);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p=>merged.addPage(p));
    }
    const bytes = await merged.save();
    const blob = new Blob([bytes], {type:"application/pdf"});
    const outName = suffixedName(files[0], "merged", "pdf");
    if(!operation.isCurrent()) return;
    const {url} = downloadBlob(blob, outName);
    const {canvas} = await pdfThumb(bytes);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName, nextTool:{id:"compress", label:t("nav.compress"), question:t("toolMerge.nextToolQuestion")}}));
  }));
};

/* ---- SPLIT ---- */
TOOLS.split = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null, gridApi=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>${t("nav.split")}</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell page-workspace" id="splitBody">
      <div class="tool-hero" id="splitHero">
        <h2 class="tool-hero-title">${t("nav.split")}</h2>
        <p class="tool-hero-desc">${t("toolSplit.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap" id="splitUploadWrap">
        ${fileInputHTML("application/pdf", false, t("toolSplit.selectPdfFile"))}
      </div>
      <div class="tool-app-workspace" id="splitWorkspace" style="display:none">
        <div class="tool-main-pane">
          <p class="page-grid-hint" id="gridHint" style="display:none">${t("toolSplit.gridHint")}</p>
          <div class="page-grid tool-content-area" id="pageGrid"></div>
        </div>
        <aside class="tool-side-panel">
          <div id="splitFileSlot"></div>
          <div class="mode-tabs" role="tablist" aria-label="${t("toolSplit.modeLabel")}">
            <button type="button" class="mode-tab active" data-mode="range" role="tab" aria-selected="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h6v6H4zM14 14h6v6h-6z"/><path d="M10 7h4M17 10v4M7 17h4"/></svg>
              ${t("toolSplit.tabRange")}
            </button>
            <button type="button" class="mode-tab" data-mode="pages" role="tab" aria-selected="false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h9l3 3v15H6z"/><path d="M6 9h6M6 13h6M6 17h6"/></svg>
              ${t("toolSplit.tabPages")}
            </button>
            <button type="button" class="mode-tab" data-mode="size" role="tab" aria-selected="false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/></svg>
              ${t("toolSplit.tabSize")}
            </button>
          </div>
          <div class="mode-panel" data-mode-panel="range">
            <div class="mode-seg" role="tablist" aria-label="${t("toolSplit.rangeModeLabel")}">
              <button type="button" class="mode-seg-btn active" data-rangemode="custom" role="tab" aria-selected="true">${t("toolSplit.rangeCustom")}</button>
              <button type="button" class="mode-seg-btn" data-rangemode="fixed" role="tab" aria-selected="false">${t("toolSplit.rangeFixed")}</button>
              <button type="button" class="mode-seg-btn" data-rangemode="smart" role="tab" aria-selected="false">${t("toolSplit.rangeSmart")}</button>
            </div>
            <div data-rangemode-panel="custom">
              <div class="range-rows" id="customRangesList"></div>
              <button type="button" class="add-range-btn" id="addRangeBtn">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
                ${t("toolSplit.addRange")}
              </button>
              <label class="checkbox-row"><input type="checkbox" id="mergeRangesChk"> ${t("toolSplit.mergeRangesChk")}</label>
            </div>
            <div data-rangemode-panel="fixed" hidden>
              <div class="field"><label for="splitEveryN">${t("toolSplit.splitEvery")}</label>
                <div class="row"><input type="number" id="splitEveryN" min="1" value="1"><span style="align-self:center;color:var(--ink-soft);font-size:.85rem;white-space:nowrap">${t("toolSplit.pagesPerFile")}</span></div>
              </div>
            </div>
            <div data-rangemode-panel="smart" hidden>
              <p class="mode-info">${t("toolSplit.smartInfo")}</p>
              <div class="mode-info" id="smartSplitStatus" hidden></div>
              <div class="row" id="quickSelectRow" style="margin-top:8px">
                <button type="button" class="btn secondary btn-sm" id="selOdd">${t("toolSplit.oddPages")}</button>
                <button type="button" class="btn secondary btn-sm" id="selEven">${t("toolSplit.evenPages")}</button>
                <button type="button" class="btn secondary btn-sm" id="selClear">${t("toolSplit.clear")}</button>
              </div>
            </div>
          </div>
          <div class="mode-panel" data-mode-panel="pages" hidden>
            <div class="mode-seg" role="tablist" aria-label="${t("toolSplit.extractModeLabel")}">
              <button type="button" class="mode-seg-btn" data-extractmode="all" role="tab" aria-selected="false">${t("toolSplit.extractAll")}</button>
              <button type="button" class="mode-seg-btn active" data-extractmode="select" role="tab" aria-selected="true">${t("toolSplit.extractSelect")}</button>
            </div>
            <div data-extractmode-panel="all" hidden>
              <p class="mode-info">${t("toolSplit.allExtractedInfo")}</p>
            </div>
            <div data-extractmode-panel="select">
              <div class="field"><label for="pagesToExtract">${t("toolSplit.pagesToExtract")}</label><input type="text" id="pagesToExtract" placeholder="e.g. 1,5-8"></div>
              <div class="mode-info" id="pagesSelectedCount">${t("toolSplit.clickOrType")}</div>
            </div>
            <label class="checkbox-row"><input type="checkbox" id="mergeExtractedChk"> ${t("toolSplit.mergeExtractedChk")}</label>
          </div>
          <div class="mode-panel" data-mode-panel="size" hidden>
            <div class="size-info-box" id="sizeInfoBox"></div>
            <div class="field"><label for="splitMaxSize">${t("toolSplit.maxSizePerFile")}</label>
              <div class="row">
                <input type="number" id="splitMaxSize" min="1" value="1" step="0.1">
                <select id="splitMaxSizeUnit" aria-label="${t("toolSplit.maxSizeUnit")}"><option value="KB">KB</option><option value="MB" selected>MB</option></select>
              </div>
            </div>
            <p class="mode-info">${t("toolSplit.sizePackInfo")}</p>
          </div>
          <div class="split-error" id="splitError" hidden></div>
          <button class="btn tool-toolbar-primary" id="go">${t("toolSplit.goBtnSplit")}</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("splitHero");
  const uploadWrap = document.getElementById("splitUploadWrap");
  const workspace = document.getElementById("splitWorkspace");
  const fileSlot = document.getElementById("splitFileSlot");
  const gridHint = document.getElementById("gridHint");
  const body = document.getElementById("splitBody");
  const goBtn = document.getElementById("go");
  const errorBox = document.getElementById("splitError");

  let totalPages = 0;
  let customRanges = [{from:1, to:1}];

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none";
    workspace.style.display="grid";
    body.classList.add("is-loaded");
  }
  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${msg}</span>`; errorBox.hidden = false; }
    else { errorBox.hidden = true; errorBox.innerHTML = ""; }
  }

  wireDropzone(async fs=>{
    // Guards the two awaits below: if a newer file is picked (or this one
    // removed) while file.arrayBuffer()/buildPageGrid() for THIS one is
    // still in flight, this run's token goes stale and it stops touching
    // shared state/DOM instead of clobbering whatever the newer pick
    // already rendered. Same pattern as Fill PDF Form's loadToken.
    const myToken = ++loadToken;
    gridApi?.destroy(); gridApi=null;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      gridApi?.destroy(); file=null; gridApi=null; totalPages=0;
      document.getElementById("pageGrid").innerHTML="";
      gridHint.style.display="none";
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    gridHint.style.display="block";
    // zoomable dropped - same de-S/M/L-ing as every other standardized
    // page-grid tool (Rotate/Organize); the shared default size is used
    // instead. Its visual toolbar row (Select all + bulk-action bar) is
    // hidden via #splitBody .page-grid-toolbar in index.html, same
    // pattern as Extract/Delete/Organize - selection itself is
    // untouched (click-to-select, Ctrl/Cmd+A, and the Smart panel's own
    // Odd/Even/Clear buttons all keep working through gridApi directly,
    // none of them go through that toolbar).
    const builtGridApi = await buildPageGrid(document.getElementById("pageGrid"), bytes, {mode:"reorder", removable:true, rotatable:true, multiSelect:true});
    if(myToken !== loadToken){ builtGridApi.destroy(); return; }
    gridApi = builtGridApi;
    totalPages = gridApi.getPages().length;
    customRanges = [{from:1, to:totalPages}];
    // Regroups by original page number after any drag - group membership
    // (like the range logic itself) is defined by page number, not by
    // wherever a card currently sits on screen, so a card dropped across
    // a group boundary snaps back to its rightful group instead of the
    // grouping UI silently disagreeing with what Split will actually do.
    document.getElementById("pageGrid").addEventListener("dragend", ()=>{
      if(splitMode==="range" && rangeMode==="custom") regroupSplitPages();
    });
    renderCustomRanges();
    document.getElementById("sizeInfoBox").innerHTML =
      `<span><strong>${t("toolSplit.originalFileSize")}</strong> ${fmtSize(file.size)}</span><span><strong>${t("toolSplit.totalPages")}</strong> ${totalPages}</span>`;
    showWorkspace();
    validate();
  });

  // ---- Range / Custom: structured from-to rows ----
  function renderCustomRanges(){
    const list = document.getElementById("customRangesList");
    list.innerHTML = customRanges.map((r,i)=>{
      const invalid = !(r.from>=1 && r.to>=r.from && r.to<=totalPages);
      return `<div class="range-row${invalid?' invalid':''}" data-i="${i}">
        <div class="range-row-head">
          <span class="range-row-label">${t("toolSplit.rangeN",{n:i+1})}</span>
          ${customRanges.length>1 ? `<button type="button" class="range-row-remove" data-i="${i}" aria-label="${t("toolSplit.removeRangeN",{n:i+1})}">✕</button>` : ""}
        </div>
        <div class="range-row-fields">
          <div class="range-field"><label for="rangeFrom${i}">${t("toolSplit.fromPage")}</label><input type="number" id="rangeFrom${i}" class="range-from" data-i="${i}" min="1" max="${totalPages}" value="${r.from}"></div>
          <div class="range-field"><label for="rangeTo${i}">${t("toolSplit.to")}</label><input type="number" id="rangeTo${i}" class="range-to" data-i="${i}" min="1" max="${totalPages}" value="${r.to}"></div>
        </div>
      </div>`;
    }).join("");
    list.querySelectorAll(".range-from").forEach(inp=>inp.addEventListener("input", ()=>{
      customRanges[+inp.dataset.i].from = parseInt(inp.value)||1;
      regroupSplitPages(); validate();
    }));
    list.querySelectorAll(".range-to").forEach(inp=>inp.addEventListener("input", ()=>{
      customRanges[+inp.dataset.i].to = parseInt(inp.value)||1;
      regroupSplitPages(); validate();
    }));
    list.querySelectorAll(".range-row-remove").forEach(btn=>btn.addEventListener("click", ()=>{
      customRanges.splice(+btn.dataset.i, 1);
      renderCustomRanges(); regroupSplitPages(); validate();
    }));
    regroupSplitPages();
  }
  document.getElementById("addRangeBtn").addEventListener("click", ()=>{
    customRanges.push({from:1, to:totalPages||1});
    renderCustomRanges(); validate();
  });

  /* Visually groups the page grid into one dashed, labeled box per
     user-defined Custom range - iLovePDF's own "which pages become which
     output file" grouping - so the workspace reacts to the sidebar instead
     of Range 1/2/3 only existing as sidebar rows with no visible effect on
     the pages themselves. Only .page-card elements already built by
     buildPageGrid() move around (into/out of .range-group wrappers); none
     are cloned or rebuilt, so drag reorder, selection, rotation and
     removal all keep operating on the exact same nodes. Idempotent and
     safe to call from any state - always flattens back to the plain grid
     first, so it never compounds nested wrappers from a previous call. */
  function regroupSplitPages(){
    if(!gridApi) return;
    const cardsWrap = document.querySelector("#pageGrid .page-grid-cards");
    if(!cardsWrap) return;
    const cards = [...cardsWrap.querySelectorAll(".page-card")];
    cards.forEach(c=>cardsWrap.appendChild(c));
    cardsWrap.querySelectorAll(".range-group").forEach(g=>g.remove());
    if(!(splitMode==="range" && rangeMode==="custom")) return;
    const claimed = new Set();
    customRanges.forEach((r,i)=>{
      if(!(r.from>=1 && r.to>=r.from)) return;
      const members = cards.filter(c=>{
        if(claimed.has(c)) return false;
        const pageNum = parseInt(c.dataset.page)+1;
        return pageNum>=r.from && pageNum<=r.to && pageNum<=totalPages;
      });
      if(!members.length) return;
      members.forEach(c=>claimed.add(c));
      const group = document.createElement("div");
      group.className = "range-group";
      const label = document.createElement("span");
      label.className = "range-group-label";
      label.textContent = t("toolSplit.rangeN",{n:i+1});
      const cardsBox = document.createElement("div");
      cardsBox.className = "range-group-cards";
      members.forEach(c=>cardsBox.appendChild(c));
      group.append(label, cardsBox);
      cardsWrap.appendChild(group);
    });
    cards.filter(c=>!claimed.has(c)).forEach(c=>cardsWrap.appendChild(c));
  }

  document.getElementById("selOdd").addEventListener("click", ()=>gridApi && gridApi.selectOddEven("odd"));
  document.getElementById("selEven").addEventListener("click", ()=>gridApi && gridApi.selectOddEven("even"));
  document.getElementById("selClear").addEventListener("click", ()=>gridApi && gridApi.clearSelection());

  let splitMode = "range";
  let rangeMode = "custom";
  let extractMode = "select";

  document.querySelectorAll(".mode-tab").forEach(tab=>{
    tab.addEventListener("click", ()=>{
      splitMode = tab.dataset.mode;
      document.querySelectorAll(".mode-tab").forEach(t=>{
        t.classList.toggle("active", t===tab);
        t.setAttribute("aria-selected", t===tab ? "true" : "false");
      });
      document.querySelectorAll("[data-mode-panel]").forEach(p=>{
        p.hidden = p.dataset.modePanel !== splitMode;
      });
      if(gridApi){
        if(splitMode!=="pages") gridApi.clearSelection();
        regroupSplitPages();
      }
      goBtn.textContent = splitMode==="size" ? t("toolSplit.goBtnSize") : (splitMode==="pages" ? t("toolSplit.goBtnExtract") : t("toolSplit.goBtnSplit"));
      validate();
    });
  });
  document.querySelectorAll('[data-rangemode]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      rangeMode = btn.dataset.rangemode;
      document.querySelectorAll('[data-rangemode]').forEach(b=>{
        b.classList.toggle("active", b===btn);
        b.setAttribute("aria-selected", b===btn ? "true" : "false");
      });
      document.querySelectorAll('[data-rangemode-panel]').forEach(p=>{ p.hidden = p.dataset.rangemodePanel !== rangeMode; });
      regroupSplitPages();
      validate();
    });
  });
  document.querySelectorAll('[data-extractmode]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      extractMode = btn.dataset.extractmode;
      document.querySelectorAll('[data-extractmode]').forEach(b=>{
        b.classList.toggle("active", b===btn);
        b.setAttribute("aria-selected", b===btn ? "true" : "false");
      });
      document.querySelectorAll('[data-extractmode-panel]').forEach(p=>{ p.hidden = p.dataset.extractmodePanel !== extractMode; });
      validate();
    });
  });
  document.getElementById("pagesToExtract").addEventListener("input", validate);
  document.getElementById("splitEveryN").addEventListener("input", validate);
  document.getElementById("splitMaxSize").addEventListener("input", validate);
  document.getElementById("splitMaxSizeUnit").addEventListener("change", validate);
  document.getElementById("mergeRangesChk").addEventListener("change", validate);
  document.getElementById("mergeExtractedChk").addEventListener("change", validate);

  /** Returns {ok, msg} - whether the current mode's configuration is ready to split. */
  function validateConfig(){
    if(!file) return {ok:false, msg:null};
    if(splitMode==="range"){
      if(rangeMode==="custom"){
        for(const r of customRanges){
          if(!(r.from>=1 && r.to>=r.from && r.to<=totalPages)){
            return {ok:false, msg:t("toolSplit.errRangeMinMax",{total:totalPages})};
          }
        }
        return {ok:true};
      }
      if(rangeMode==="fixed"){
        const n = parseInt(document.getElementById("splitEveryN").value);
        if(!Number.isInteger(n) || n<1) return {ok:false, msg:t("toolSplit.errFixedCount")};
        return {ok:true};
      }
      // smart - always allowed to try; real validity is decided at split time
      return {ok:true};
    }
    if(splitMode==="pages"){
      if(extractMode==="all") return {ok:true};
      const text = document.getElementById("pagesToExtract").value.trim();
      if(text){
        const parsed = parsePageList(text, totalPages);
        if(!parsed) return {ok:false, msg:t("toolSplit.errPageNumbers",{total:totalPages})};
        return {ok:true};
      }
      const selected = gridApi ? gridApi.getSelectedPages().length : 0;
      if(selected===0) return {ok:false, msg:t("toolSplit.clickOrTypeExtract")};
      return {ok:true};
    }
    if(splitMode==="size"){
      const raw = parseFloat(document.getElementById("splitMaxSize").value);
      if(!(raw>0)) return {ok:false, msg:t("toolSplit.errMaxSize")};
      return {ok:true};
    }
    return {ok:true};
  }
  function validate(){
    const {ok, msg} = validateConfig();
    goBtn.disabled = !file || !ok;
    showError(file ? msg : null);
    if(splitMode==="pages" && extractMode==="select" && gridApi){
      const n = gridApi.getSelectedPages().length;
      document.getElementById("pagesSelectedCount").textContent =
        n>0 ? (n>1 ? t("toolSplit.pagesSelectedMany",{n}) : t("toolSplit.pagesSelectedOne")) : t("toolSplit.clickOrType");
    }
  }
  // Re-validate whenever the grid selection changes (Pages/Select relies on it).
  document.getElementById("pageGrid").addEventListener("click", ()=>setTimeout(validate, 0));

  /** Real blank-page detection: renders each page small and measures how
   * much of it is non-white. Pages below the threshold are treated as
   * separator sheets - dropped from the output, with runs of non-blank
   * pages between them becoming one file each. */
  async function detectBlankPages(bytes, onProgress){
    const pdoc = await loadPdfJsSafe({data:bytes.slice(0)});
    const blanks = [];
    for(let i=1;i<=pdoc.numPages;i++){
      try{
        const page = await pdoc.getPage(i);
        const vp = page.getViewport({scale:0.25});
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(vp.width));
        canvas.height = Math.max(1, Math.round(vp.height));
        const ctx = canvas.getContext("2d");
        // A page with literally no content stream (a true blank separator
        // sheet) never gets a background paint from pdf.js - the canvas is
        // left at its default fully-transparent black, which would read as
        // "100% inked" to the pixel check below unless painted white first
        // (real PDF pages are opaque white paper; the canvas needs to
        // start that way too).
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await Promise.race([
          page.render({canvasContext:ctx, viewport:vp}).promise,
          new Promise((_, reject)=>setTimeout(()=>reject(new Error("timeout")), 10000))
        ]);
        const {data} = ctx.getImageData(0,0,canvas.width,canvas.height);
        let nonWhite=0;
        for(let p=0;p<data.length;p+=4){
          if(data[p]<245 || data[p+1]<245 || data[p+2]<245) nonWhite++;
        }
        blanks.push((nonWhite/(data.length/4)) < 0.004);
      }catch(e){ blanks.push(false); }
      if(onProgress) onProgress(i, pdoc.numPages);
    }
    await pdoc.destroy();
    return blanks;
  }
  function groupsFromBlanks(blanks){
    const groups = [];
    let current = [];
    blanks.forEach((isBlank, i)=>{
      if(isBlank){
        if(current.length){ groups.push(current); current=[]; }
      } else {
        current.push({index:i, rotation:0});
      }
    });
    if(current.length) groups.push(current);
    return groups;
  }

  goBtn.addEventListener("click", withToolOperation(goBtn, async (_event, operation)=>{
    const {ok, msg} = validateConfig();
    if(!ok){ showError(msg); return; }
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolSplit.statusSplitting"));
    const bytes = await file.arrayBuffer();
    const src = await loadPdfSafe(bytes);
    let groups;
    let mergeOutput = false;

    // The page grid's own hint text promises "hover a page to rotate or
    // remove it" as a real, effective action - but every mode below used
    // to build its output purely from raw index arithmetic against
    // totalPages/customRanges, never once consulting the live grid.
    // Confirmed by testing: rotating a card 90deg, then splitting in
    // Range mode, produced an export with EVERY page at 0deg rotation;
    // removing a card left it in the DOM count at 3 of 4, but the actual
    // downloaded PDF still had all 4 pages. liveIndexRotation is the
    // single source of truth every mode below now filters/maps through -
    // a removed page's original index is simply absent from this map, so
    // every mode drops it the same way; a rotated page's current
    // rotation replaces the old hardcoded 0.
    const liveIndexRotation = new Map();
    gridApi.getPages().forEach(p=>liveIndexRotation.set(p.index, p.rotation));

    if(splitMode==="range" && rangeMode==="fixed"){
      const n = Math.max(1, parseInt(document.getElementById("splitEveryN").value) || 1);
      const liveOrdered = Array.from({length:totalPages}, (_,i)=>i).filter(i=>liveIndexRotation.has(i));
      groups = [];
      for(let i=0;i<liveOrdered.length;i+=n){
        groups.push(liveOrdered.slice(i, i+n).map(index=>({index, rotation:liveIndexRotation.get(index)})));
      }
    } else if(splitMode==="range" && rangeMode==="smart"){
      setStatus(t("toolSplit.statusScanning"), false, 0);
      const blanks = await detectBlankPages(bytes, (done,total)=>setStatus(t("toolSplit.statusScanning"), false, Math.round((done/total)*100)));
      groups = groupsFromBlanks(blanks)
        .map(g=>g.filter(p=>liveIndexRotation.has(p.index)).map(p=>({index:p.index, rotation:liveIndexRotation.get(p.index)})))
        .filter(g=>g.length>0);
      if(groups.length===0) groups = [gridApi.getPages()];
      if(!blanks.some(Boolean)){
        const statusEl2 = document.getElementById("smartSplitStatus");
        statusEl2.hidden = false;
        statusEl2.textContent = t("toolSplit.noBlankPages");
      }
    } else if(splitMode==="range"){ // custom
      groups = customRanges
        .map(r=>Array.from({length:r.to-r.from+1}, (_,i)=>r.from-1+i).filter(index=>liveIndexRotation.has(index)).map(index=>({index, rotation:liveIndexRotation.get(index)})))
        .filter(g=>g.length>0);
      mergeOutput = document.getElementById("mergeRangesChk").checked;
    } else if(splitMode==="size"){
      const rawSize = parseFloat(document.getElementById("splitMaxSize").value) || 1;
      const unit = document.getElementById("splitMaxSizeUnit").value;
      const maxBytes = Math.round(rawSize * (unit==="MB" ? 1024*1024 : 1024));
      setStatus(t("toolSplit.statusPacking"), false, 0);
      groups = await splitBySize(src, maxBytes, (done,total)=>setStatus(t("toolSplit.statusPacking"), false, Math.round((done/total)*100)), liveIndexRotation);
    } else { // pages
      let pageIndices;
      if(extractMode==="all"){
        pageIndices = Array.from({length:totalPages}, (_,i)=>i).filter(i=>liveIndexRotation.has(i));
      } else {
        const text = document.getElementById("pagesToExtract").value.trim();
        // A typed list keeps ascending numeric order (that's what typing
        // "1,5-8" means); a click-to-select extraction instead follows
        // the grid's own current on-screen order - previously force-
        // sorted back to original page order, silently discarding
        // exactly the drag-to-reorder the hint text advertises. Either
        // way, a page removed from the grid is excluded even if it was
        // explicitly typed, for the same "removal always means removed"
        // consistency as every other mode above.
        pageIndices = text
          ? parsePageList(text, totalPages).filter(i=>liveIndexRotation.has(i))
          : gridApi.getSelectedPages().map(p=>p.index);
      }
      mergeOutput = document.getElementById("mergeExtractedChk").checked;
      groups = mergeOutput
        ? [pageIndices.map(index=>({index, rotation:liveIndexRotation.get(index) ?? 0}))]
        : pageIndices.map(index=>[{index, rotation:liveIndexRotation.get(index) ?? 0}]);
    }
    if(mergeOutput && groups.length>1){
      groups = [groups.flat()];
    }
    if(!groups || groups.length===0 || groups.some(g=>g.length===0)){
      toast(t("toolSplit.nothingToSplit"));
      out.innerHTML="";
      return;
    }
    setStatus(t("toolSplit.statusSplitting"), false, 0);
    if(groups.length===1){
      const doc = await buildPdfFromPages(src, groups[0]);
      const b = await doc.save();
      const blob = new Blob([b], {type:"application/pdf"});
      const outName = suffixedName(file, "split", "pdf");
      if(!operation.isCurrent()) return;
      const {url} = downloadBlob(blob, outName);
      const {canvas} = await pdfThumb(b);
      setStatus(t("workspace.done"), true);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName, nextTool:{id:"organize", label:t("tools.organize"), question:t("toolSplit.nextToolQuestion")}}));
    } else {
      await ensureJSZip();
      const zip = new JSZip();
      for(let i=0;i<groups.length;i++){
        setStatus(t("toolSplit.statusSplitting"), false, Math.round((i/groups.length)*100));
        const doc = await buildPdfFromPages(src, groups[i]);
        const b = await doc.save();
        zip.file(`part_${i+1}.pdf`, b);
      }
      const zipBlob = await zip.generateAsync({type:"blob"});
      const outName = suffixedName(file, "split_parts", "zip");
      if(!operation.isCurrent()) return;
      const {url} = downloadBlob(zipBlob, outName);
      setStatus(t("toolSplit.doneFiles",{n:groups.length}), true);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText:fmtSize(zipBlob.size), sizeGood:true, url, filename:outName, nextTool:{id:"organize", label:t("tools.organize"), question:t("toolSplit.nextToolQuestion")}}));
    }
  }));
};

/* ---- COMPRESS (asks exact KB target) ---- */
TOOLS.compress = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let files=[];
  openPanel(`
    <div class="panel-head"><h3>${t("nav.compress")}</h3></div>
    <div class="panel-body compact tool-workspace compress-workspace" id="compressBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("nav.compress")}</h2>
        <p class="tool-hero-desc">${t("toolCompress.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap workspace-host" id="compressUploadWrap">
        ${fileInputHTML("application/pdf", true, t("workspace.selectPdfFiles"))}
        <div class="workspace-action-stack" id="compressFileToolbar" style="display:none">
          <button type="button" class="workspace-action-btn workspace-action-primary" id="compressAddFab" aria-label="${t("workspace.addMoreFiles")}" title="${t("workspace.addMoreFiles")}">
            +<span class="workspace-action-badge" id="compressFileCount" hidden></span>
          </button>
        </div>
      </div>
      <div class="tool-content-area tool-content-area--flat" id="compressOptions" style="display:none">
        <div class="tool-content-area-label">${t("toolCompress.levelLabel")}</div>
        <div class="level-picker" id="compressLevelPicker" role="radiogroup" aria-label="${t("toolCompress.levelLabel")}">
          <button type="button" class="level-row" data-preset="max" role="radio" aria-checked="false">
            <span class="level-row-text"><span class="level-row-title">${t("toolCompress.level1Title")}</span><span class="level-row-desc">${t("toolCompress.level1Desc")}</span></span>
            <span class="level-row-check">✓</span>
          </button>
          <button type="button" class="level-row active" data-preset="recommended" role="radio" aria-checked="true">
            <span class="level-row-text"><span class="level-row-title">${t("toolCompress.level2Title")}</span><span class="level-row-desc">${t("toolCompress.level2Desc")}</span></span>
            <span class="level-row-check">✓</span>
          </button>
          <button type="button" class="level-row" data-preset="high" role="radio" aria-checked="false">
            <span class="level-row-text"><span class="level-row-title">${t("toolCompress.level3Title")}</span><span class="level-row-desc">${t("toolCompress.level3Desc")}</span></span>
            <span class="level-row-check">✓</span>
          </button>
          <button type="button" class="level-row" data-preset="custom" role="radio" aria-checked="false">
            <span class="level-row-text"><span class="level-row-title">${t("toolCompress.level4Title")}</span><span class="level-row-desc">${t("toolCompress.level4Desc")}</span></span>
            <span class="level-row-check">✓</span>
          </button>
        </div>
        <div id="customSizePanel" hidden>
          <div class="field"><label for="customTargetKB">${t("toolCompress.targetSizeLabel")}</label>
            <div class="row"><input type="number" id="customTargetKB" min="1" step="1" placeholder="e.g. 500"><span style="align-self:center;color:var(--ink-soft);font-size:.85rem;">KB</span></div>
          </div>
          <p class="mode-info">${t("toolCompress.targetSizeHint")}</p>
        </div>
        <div class="split-error" id="compressError" hidden></div>
        <p style="margin:10px 0 0;color:var(--ink-soft);font-size:.78rem;line-height:1.5">${t("toolCompress.footnote")}</p>
      </div>
      <div class="tool-toolbar" id="compressToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("nav.compress")} <span aria-hidden="true">&rarr;</span></button>
        <button class="btn secondary" id="cancelCompress" type="button" style="display:none">${t("common.cancel")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  let preset = "recommended";
  // Set for the duration of a single goBtn click (single-file or the
  // whole batch loop) and cleared once it settles - only consulted by
  // the main-thread fallback's own cooperative yield points
  // (pdf-processing-utils.js), so it has zero effect when the Worker
  // path is actually running (that path's cancellation is unchanged:
  // cancelCompressWorker()'s Worker.terminate()).
  let fallbackAbortController = null;
  const customPanel = document.getElementById("customSizePanel");
  const errorBox = document.getElementById("compressError");
  const goBtn = document.getElementById("go");
  const cancelBtn = document.getElementById("cancelCompress");
  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${msg}</span>`; errorBox.hidden=false; }
    else { errorBox.hidden=true; errorBox.innerHTML=""; }
  }
  function validate(){
    if(files.length===0){ goBtn.disabled = true; return; }
    if(preset==="custom"){
      const raw = document.getElementById("customTargetKB").value;
      const n = parseFloat(raw);
      if(raw.trim()==="" || !(n>0)){
        showError(t("toolCompress.targetSizeError"));
        goBtn.disabled = true;
        return;
      }
    }
    showError(null);
    goBtn.disabled = false;
  }
  document.querySelectorAll("#compressLevelPicker .level-row").forEach(row=>{
    row.addEventListener("click", ()=>{
      preset = row.dataset.preset;
      document.querySelectorAll("#compressLevelPicker .level-row").forEach(r=>{
        r.classList.toggle("active", r===row);
        r.setAttribute("aria-checked", r===row ? "true" : "false");
      });
      customPanel.hidden = preset!=="custom";
      validate();
    });
  });
  document.getElementById("customTargetKB").addEventListener("input", validate);
  const refresh = ()=>{
    renderFileList(files, i=>{ files.splice(i,1); refresh(); });
    document.getElementById("compressOptions").style.display = files.length ? "block" : "none";
    document.getElementById("compressToolbar").style.display = files.length ? "flex" : "none";
    document.getElementById("compressFileToolbar").style.display = files.length ? "flex" : "none";
    document.getElementById("compressBody").classList.toggle("is-loaded", files.length>0);
    const countBadge = document.getElementById("compressFileCount");
    if(files.length){ countBadge.hidden=false; countBadge.textContent = files.length; } else countBadge.hidden = true;
    validate();
  };
  document.getElementById("compressAddFab").addEventListener("click", ()=>document.getElementById("fi").click());
  wireDropzone(fs=>{
    files = files.concat(fs.filter(f=>f.type==="application/pdf"||f.name.endsWith(".pdf")));
    refresh();
  });
  /** Runs the selected preset/target against one file's bytes, applying the
   * same "never hand back something bigger than the original" safety net
   * every mode already had - shared here so the single- and multi-file
   * paths below both go through identical compression behavior. */
  // Below this, a "successful" compression is not worth showing as one -
  // the size difference is noise, not a meaningful result, so the
  // original is kept and the user is told the PDF was already optimized
  // rather than seeing an inflated-looking "1%  smaller". Target-size
  // mode is exempt: the user explicitly asked for a specific size, so
  // even a small necessary reduction there is the actual point.
  const MIN_MEANINGFUL_SAVINGS_PCT = 4;
  async function compressOne(bytes, onProgress, signal){
    let finalBytes, usedOriginal=false, imagesRecompressed=0, targetMissed=false, alreadyUnderTarget=false, negligibleSavings=false;
    if(preset==="custom"){
      const targetBytes = Math.round(parseFloat(document.getElementById("customTargetKB").value) * 1024);
      const result = await compressToTarget(bytes, targetBytes, onProgress, signal);
      imagesRecompressed = result.imagesRecompressed;
      targetMissed = !result.achieved && !result.alreadyUnderTarget;
      alreadyUnderTarget = !!result.alreadyUnderTarget;
      if(result.bytes.length >= bytes.byteLength){ finalBytes = new Uint8Array(bytes); usedOriginal = true; }
      else finalBytes = result.bytes;
    } else {
      // Per-image progress, not just a spinner - large/image-heavy PDFs
      // previously gave zero feedback during this loop, which was
      // indistinguishable from a hung tab.
      const result = await recompressPdfImages(bytes, preset, onProgress, signal);
      imagesRecompressed = result.imagesRecompressed;
      if(result.bytes.length >= bytes.byteLength){
        finalBytes = new Uint8Array(bytes); usedOriginal = true;
      } else {
        const savedPct = (1 - result.bytes.length/bytes.byteLength) * 100;
        if(savedPct < MIN_MEANINGFUL_SAVINGS_PCT){
          finalBytes = new Uint8Array(bytes); usedOriginal = true; negligibleSavings = true;
        } else {
          finalBytes = result.bytes;
        }
      }
    }
    // Validate before ever calling this a success: reload both the
    // original and the compressed output and require the same page
    // count. A compressed PDF that fails to reload, or silently lost a
    // page, must never be handed to the user as "Done" - fall back to
    // the pristine original instead (the existing "kept the original
    // file" messaging below already covers this path).
    if(!usedOriginal){
      try{
        const [origDoc, newDoc] = await Promise.all([loadPdfSafe(bytes), loadPdfSafe(finalBytes)]);
        if(newDoc.getPageCount() !== origDoc.getPageCount()){
          finalBytes = new Uint8Array(bytes); usedOriginal = true;
        }
      }catch(e){
        finalBytes = new Uint8Array(bytes); usedOriginal = true;
      }
    }
    return {finalBytes, usedOriginal, imagesRecompressed, targetMissed, alreadyUnderTarget, negligibleSavings};
  }
  cancelBtn.addEventListener("click", ()=>{
    // Compression normally runs in a Web Worker (see recompressPdfImages/
    // compressToTarget in pdf-processing-utils.js) specifically so a real,
    // immediate cancel is possible - killing the worker mid-doc.save() is
    // the only way to interrupt it, since pdf-lib's serialization has no
    // cooperative cancel point to check a flag against. The click handler
    // below's try/catch treats the resulting CompressionCancelled error as
    // a normal, non-error outcome.
    cancelCompressWorker();
    // On browsers where the Worker/OffscreenCanvas path isn't available,
    // compression runs on the main thread instead - this button used to
    // be a no-op there (cancelCompressWorker() only ever touches an
    // actual worker instance, and the fallback never created one), so
    // Cancel silently did nothing on exactly the path where the operation
    // can visibly stall. fallbackAbortController is only ever consulted
    // at the fallback's own cooperative yield points (never mid-synchronous
    // work, since nothing can interrupt that in JS) - aborting it here is
    // a no-op if the Worker path is actually the one running.
    fallbackAbortController?.abort();
  });
  goBtn.addEventListener("click", withToolOperation(goBtn, async (_event, operation)=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolCompress.statusAnalyzing"));
    goBtn.disabled = true;
    cancelBtn.style.display = "";
    fallbackAbortController = new AbortController();
    try {
      if(files.length===1){
        const file = files[0];
        const bytes = await file.arrayBuffer();
        setStatus(t("toolCompress.statusCompressingImages"), false, 5);
        const onProgress = preset==="custom"
          ? (step,total,size)=> setStatus(t("toolCompress.statusCompressingTowardTarget", {step, total, size: fmtSize(size)}), false, Math.round((step/total)*100))
          : (step,total)=> total>1 && setStatus(t("toolCompress.statusCompressingImageN", {step, total}), false, Math.round((step/total)*90));
        const {finalBytes, usedOriginal, imagesRecompressed, targetMissed, alreadyUnderTarget, negligibleSavings} = await compressOne(bytes, onProgress, fallbackAbortController.signal);
        setStatus(t("toolCompress.statusFinalizing"), false, 95);
        const blob = new Blob([finalBytes], {type:"application/pdf"});
        const outName = suffixedName(file, "compressed", "pdf");
        if(!operation.isCurrent()) return;
        const {url} = downloadBlob(blob, outName);
        const {canvas} = await pdfThumb(finalBytes);
        const savedPct = Math.round((1 - blob.size/bytes.byteLength) * 100);
        if(alreadyUnderTarget){
          setStatus(t("toolCompress.doneAlreadyUnderTarget", {size: fmtSize(bytes.byteLength)}), true);
        } else if(negligibleSavings){
          setStatus(t("toolCompress.doneNegligibleSavings"), true);
        } else if(usedOriginal){
          setStatus(imagesRecompressed===0
            ? t("toolCompress.doneNoImagesFound")
            : t("toolCompress.doneNoReduction"), true);
        } else if(targetMissed){
          setStatus(t("toolCompress.doneTargetMissed", {size: fmtSize(blob.size), target: fmtSize(Math.round(parseFloat(document.getElementById("customTargetKB").value)*1024))}), true);
        } else {
          setStatus(t("toolCompress.doneSuccess", {from: fmtSize(bytes.byteLength), to: fmtSize(blob.size), pct: savedPct}), true);
        }
        if(!operation.isCurrent()) return;
        out.appendChild(resultBox({sizeText:`${fmtSize(blob.size)}${usedOriginal?"":` (was ${fmtSize(bytes.byteLength)})`}`, sizeGood:!usedOriginal, previewNode:canvas, url, filename:outName, nextTool:{id:"edit", label:t("tools.edit"), question:t("toolCompress.nextToolQuestion")}}));
      } else {
        await ensureJSZip();
        const zip = new JSZip();
        let anyMissedTarget = false;
        // Per-file before/after, not just the zip's total size - a batch
        // of 10 PDFs previously only ever showed one opaque zip size, with
        // no way to tell which files actually compressed well (or at all)
        // without opening the zip and comparing manually. Mirrors the
        // single-file path's "X -> Y (Z% smaller)" reporting, per-file.
        const perFileResults = [];
        let totalOriginal = 0, totalCompressed = 0;
        for(let i=0;i<files.length;i++){
          setStatus(t("toolCompress.statusCompressingNamed", {name: files[i].name}), false, Math.round((i/files.length)*100));
          const bytes = await files[i].arrayBuffer();
          const {finalBytes, targetMissed, usedOriginal} = await compressOne(bytes, null, fallbackAbortController.signal);
          if(targetMissed) anyMissedTarget = true;
          zip.file(suffixedName(files[i], "compressed", "pdf"), finalBytes);
          totalOriginal += bytes.byteLength;
          totalCompressed += finalBytes.length;
          perFileResults.push({name: files[i].name, originalSize: bytes.byteLength, compressedSize: finalBytes.length, usedOriginal});
        }
        const zipBlob = await zip.generateAsync({type:"blob"});
        const outName = "compressed_pdfs.zip";
        if(!operation.isCurrent()) return;
        const {url} = downloadBlob(zipBlob, outName);
        const totalSavedPct = totalOriginal>0 ? Math.round((1 - totalCompressed/totalOriginal) * 100) : 0;
        setStatus(t("toolCompress.doneBatch", {count: files.length, from: fmtSize(totalOriginal), to: fmtSize(totalCompressed), pct: totalSavedPct}) + (anyMissedTarget ? t("toolCompress.batchTargetNote") : ""), true);
        const box = resultBox({sizeText:fmtSize(zipBlob.size), sizeGood:true, url, filename:outName});
        const breakdown = document.createElement("div");
        breakdown.className = "compress-batch-breakdown";
        breakdown.innerHTML = perFileResults.map(r=>{
          const pct = r.originalSize>0 ? Math.round((1 - r.compressedSize/r.originalSize) * 100) : 0;
          return `<div class="compress-batch-row">
            <span class="compress-batch-name" title="${escapeAttr(r.name)}">${escapeAttr(r.name)}</span>
            <span class="compress-batch-sizes mono">${r.usedOriginal ? t("toolCompress.alreadyOptimized") : t("toolCompress.batchRowSizes", {from: fmtSize(r.originalSize), to: fmtSize(r.compressedSize), pct})}</span>
          </div>`;
        }).join("");
        const dlLink = box.querySelector(".dl-link");
        if(dlLink) box.insertBefore(breakdown, dlLink); else box.appendChild(breakdown);
        out.appendChild(box);
      }
    } catch(e) {
      if(e && e.name === "CompressionCancelled"){
        out.innerHTML = `<div class="status">${t("toolCompress.errCancelled")}</div>`;
      } else {
        // Encrypted/password-protected input is the one specific, common
        // failure worth naming explicitly (pdf-lib throws EncryptedPDFError
        // for it) - everything else keeps the original generic message
        // rather than guessing at a cause. Either way the user's original
        // file is untouched and still selected, so they can retry or pick
        // a different one.
        const isEncrypted = /encrypt/i.test(e.name||"") || /encrypt/i.test(e.message||"");
        out.innerHTML = `<div class="status" style="color:var(--rose)">${
          isEncrypted
            ? t("toolCompress.errEncrypted")
            : t("toolCompress.errGenericFailed", {msg: escapeAttr(e.message)})
        }</div>`;
      }
    } finally {
      cancelBtn.style.display = "none";
      fallbackAbortController = null;
      validate(); // re-syncs goBtn.disabled from current files/preset state
    }
  }));
};

/* ---- ROTATE ---- */
TOOLS.rotate = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null, gridApi=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.rotate")}</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell page-workspace" id="rotateBody">
      <div class="tool-hero" id="rotateHero">
        <h2 class="tool-hero-title">${t("tools.rotate")}</h2>
        <p class="tool-hero-desc">${t("toolRotate.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap" id="rotateUploadWrap">
        ${fileInputHTML("application/pdf", false, t("toolSplit.selectPdfFile"))}
      </div>
      <div class="tool-app-workspace" id="rotateWorkspace" style="display:none">
        <div class="tool-main-pane">
          <p class="page-grid-hint" id="gridHint" style="display:none">${t("toolRotate.gridHint")}</p>
          <div class="page-grid tool-content-area" id="pageGrid"></div>
        </div>
        <aside class="tool-side-panel">
          <div id="rotateFileSlot"></div>
          <div class="field"><label for="deg">${t("toolRotate.rotationLabel")}</label>
            <select id="deg"><option value="90">${t("toolRotate.deg90")}</option><option value="180">${t("toolRotate.deg180")}</option><option value="270">${t("toolRotate.deg270")}</option></select>
          </div>
          <button type="button" class="btn secondary" id="rotAll">${t("toolRotate.applyBtn")}</button>
          <button class="btn tool-toolbar-primary" id="go">${t("tools.rotate")}</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("rotateHero");
  const uploadWrap = document.getElementById("rotateUploadWrap");
  const workspace = document.getElementById("rotateWorkspace");
  const fileSlot = document.getElementById("rotateFileSlot");
  const gridHint = document.getElementById("gridHint");
  const body = document.getElementById("rotateBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none";
    workspace.style.display="grid";
    body.classList.add("is-loaded");
  }

  wireDropzone(async fs=>{
    // See Split PDF's identical guard for why: a newer pick (or removal)
    // while this one's arrayBuffer()/buildPageGrid() is still in flight
    // must not let this stale run overwrite it.
    const myToken = ++loadToken;
    gridApi?.destroy(); gridApi=null;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      gridApi?.destroy(); file=null; gridApi=null;
      document.getElementById("pageGrid").innerHTML="";
      gridHint.style.display="none";
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    gridHint.style.display="block";
    // zoomable dropped - Rotate's own S/M/L size toggle was the one
    // thing making its workspace look like a separate tool instead of
    // the standard Reorder/Organize/Delete page-grid; every other
    // page-management tool just uses the shared default (zoom-m) size,
    // so Rotate now does too. removable:true adds the same per-card ✕
    // Delete Pages already uses (see appendCard()'s own comment - the
    // mode:"select"+removable combination was already made to work
    // there, so this needs no further changes to buildPageGrid itself).
    const builtGridApi = await buildPageGrid(document.getElementById("pageGrid"), bytes, {mode:"select", rotatable:true, removable:true});
    if(myToken !== loadToken){ builtGridApi.destroy(); return; }
    gridApi = builtGridApi;
    showWorkspace();
  });
  document.getElementById("rotAll").addEventListener("click", ()=>{
    if(!gridApi) return;
    const deg = parseInt(document.getElementById("deg").value);
    // Honor the grid's own selection, matching what the hint text above
    // already promises ("select several pages and use 'Apply to
    // selected/all' below") - rotateAll() unconditionally hits every
    // page regardless of selection, which silently contradicted that
    // promise before this fix.
    if(gridApi.getSelected().size > 0) gridApi.rotateSelected(deg);
    else gridApi.rotateAll(deg);
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("toolRotate.statusRotating"));
    const bytes=await file.arrayBuffer();
    const src=await loadPdfSafe(bytes);
    const pagesSpec = gridApi.getPages();
    // Rotate's ✕ is new (removable:true, added alongside the rest of
    // this phase's grid standardization) - same "don't let every page
    // get deleted out from under the export" guard Organize/Delete
    // Pages already use.
    if(pagesSpec.length===0){ toast(t("toolRotate.errAtLeastOne")); out.innerHTML=""; return; }
    const newDoc = await buildPdfFromPages(src, pagesSpec);
    const outBytes=await newDoc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "rotated", "pdf");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus(t("workspace.done"),true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  }));
};

/* ---- DELETE PAGES ----
   Same thumbnail workspace as Extract Pages (buildPageGrid mode:"select"
   + the shared page-range field/parser), with the meaning of "selected"
   flipped - here selection marks pages to REMOVE, so the action button
   reads "Delete N Pages" and export keeps everything NOT selected.
   Also passes removable:true for a direct per-thumbnail ✕ (the one
   compatibility change this needed in buildPageGrid: its ✕ button was
   previously reorder-mode only - see appendCard()'s own comment). */
TOOLS.deletepages = function(){
  let file=null, gridApi=null, loadToken=0, totalPages=0;
  // See Extract Pages' identical guard: true only while
  // applyWantedSelection() is programmatically clicking cards to match a
  // typed range, so those clicks don't re-enter the thumbnails->text
  // sync and fight the field the user is actively typing into.
  let suppressClickSync = false;

  openPanel(`
    <div class="panel-head"><h3>Delete Pages</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell page-workspace" id="deleteBody">
      <div class="tool-hero" id="deleteHero">
        <h2 class="tool-hero-title">Delete Pages</h2>
        <p class="tool-hero-desc">Select the pages you don't need and remove them from the PDF.</p>
      </div>
      <div class="tool-upload-wrap" id="deleteUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="deletePrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace" id="deleteWorkspace" style="display:none">
        <div class="tool-main-pane">
          <p class="page-grid-hint" id="gridHint" style="display:none">Click the pages you want to delete, or use ✕ on a thumbnail.</p>
          <div class="page-grid tool-content-area" id="pageGrid"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Delete Pages</h3>
          <div id="deleteFileSlot"></div>
          <div class="field"><label for="deleteRangeInput">Pages to delete</label>
            <input type="text" id="deleteRangeInput" placeholder="e.g. 1,3,5-8" autocomplete="off">
          </div>
          <div class="row">
            <button class="btn secondary btn-sm" id="deleteSelectAll" type="button" style="flex:1">Select all</button>
            <button class="btn secondary btn-sm" id="deleteClearSel" type="button" style="flex:1">Clear</button>
          </div>
          <button class="btn tool-toolbar-primary" id="go" disabled>Delete Pages</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("deleteHero");
  const uploadWrap = document.getElementById("deleteUploadWrap");
  const privacyHint = document.getElementById("deletePrivacyHint");
  const workspace = document.getElementById("deleteWorkspace");
  const fileSlot = document.getElementById("deleteFileSlot");
  const gridHint = document.getElementById("gridHint");
  const body = document.getElementById("deleteBody");
  const pageGrid = document.getElementById("pageGrid");
  const rangeInput = document.getElementById("deleteRangeInput");
  const goBtn = document.getElementById("go");

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

  function selected1Based(){ return [...gridApi.getSelected()].map(i=>i+1).sort((a,b)=>a-b); }
  function updateGoButton(count){
    goBtn.disabled = count===0;
    goBtn.textContent = count===0 ? "Delete Pages" : `Delete ${count} Page${count===1?"":"s"}`;
  }
  function syncFromThumbnails(){
    const sel = selected1Based();
    rangeInput.value = sel.join(",");
    updateGoButton(sel.length);
  }
  function applyWantedSelection(wanted1Based){
    const wanted = new Set(wanted1Based);
    const cur = new Set(selected1Based());
    suppressClickSync = true;
    pageGrid.querySelectorAll(".page-card").forEach(c=>{
      const pageNum = parseInt(c.dataset.page)+1;
      if(wanted.has(pageNum) !== cur.has(pageNum)) c.click();
    });
    suppressClickSync = false;
  }
  rangeInput.addEventListener("input", ()=>{
    if(!gridApi) return;
    const wanted = parsePageRangeInput(rangeInput.value, totalPages);
    applyWantedSelection(wanted);
    updateGoButton(wanted.length);
  });
  pageGrid.addEventListener("click", e=>{
    if(suppressClickSync || !gridApi) return;
    if(e.target.closest(".page-remove")) return; // handled below via gridObserver, not a selection toggle
    if(e.target.closest(".page-card")) syncFromThumbnails();
  });
  // A direct ✕ removes the card entirely (see wireCard()'s .page-remove
  // handler in buildPageGrid) rather than toggling .selected, so the
  // click listener above intentionally ignores it - stopPropagation()
  // on that same handler also means a bubble-phase listener here would
  // never see the click anyway. Watching for the actual DOM removal
  // instead is what keeps the range field/button correct regardless of
  // exactly how a card disappears, without needing any of that.
  new MutationObserver(muts=>{
    if(gridApi && muts.some(m=>[...m.removedNodes].some(n=>n.nodeType===1 && n.classList?.contains("page-card")))){
      syncFromThumbnails();
    }
  }).observe(pageGrid, {childList:true, subtree:true});
  document.getElementById("deleteSelectAll").addEventListener("click", ()=>{
    if(!gridApi) return;
    gridApi.selectAll();
    syncFromThumbnails();
  });
  document.getElementById("deleteClearSel").addEventListener("click", ()=>{
    if(!gridApi) return;
    gridApi.clearSelection();
    syncFromThumbnails();
  });

  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    gridApi?.destroy(); gridApi=null;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++; gridApi?.destroy(); file=null; gridApi=null; totalPages=0;
      pageGrid.innerHTML=""; gridHint.style.display="none"; rangeInput.value="";
      updateGoButton(0);
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    gridHint.style.display="block";
    // removable:true - see appendCard()'s comment above; mode:"select"
    // never has drag enabled, so the ✕ can't collide with reordering.
    const builtGridApi = await buildPageGrid(pageGrid, bytes, {mode:"select", removable:true});
    if(myToken !== loadToken){ builtGridApi.destroy(); return; }
    gridApi = builtGridApi;
    totalPages = gridApi.getPages().length;
    syncFromThumbnails();
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Processing...");
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    const del = gridApi.getSelected();
    // getPages() is already in ascending original order (mode:"select"
    // never reorders cards) - filtering out the deleted ones keeps that
    // order and each kept page's existing rotation, then
    // buildPdfFromPages() (shared with Reorder/Extract/Split/Organize/
    // Rotate) does the actual copy, same as every other page-grid tool.
    const keepSpec = gridApi.getPages().filter(p=>!del.has(p.index));
    if(keepSpec.length===0){ toast("At least one page must remain"); out.innerHTML=""; return; }
    const newDoc = await buildPdfFromPages(doc, keepSpec);
    const outBytes = await newDoc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "pages_removed", "pdf");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done — "+keepSpec.length+" pages remaining", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  }));
};

/**
 * Parses a comma-separated page-list/range string ("5,6,7,10",
 * "5-7,10", "1,3,5-8") into a sorted, de-duplicated array of 1-based
 * page numbers within [1,maxPage]. Reversed ranges ("7-5") are
 * normalized; malformed or out-of-range tokens are silently dropped
 * rather than erroring, so one typo doesn't block the rest of a valid
 * list - same "degrade gracefully" approach every other free-text input
 * in this app already takes.
 * @param {string} str
 * @param {number} maxPage
 * @returns {number[]}
 */
function parsePageRangeInput(str, maxPage){
  const set = new Set();
  String(str||"").split(",").forEach(tok=>{
    tok = tok.trim();
    if(!tok) return;
    const range = tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if(range){
      let a = parseInt(range[1],10), b = parseInt(range[2],10);
      if(a>b) [a,b] = [b,a];
      for(let n=a; n<=b; n++){ if(n>=1 && n<=maxPage) set.add(n); }
    } else if(/^\d+$/.test(tok)){
      const n = parseInt(tok,10);
      if(n>=1 && n<=maxPage) set.add(n);
    }
  });
  return [...set].sort((a,b)=>a-b);
}
/* ---- EXTRACT PAGES ----
   Same buildPageGrid() thumbnail workspace Reorder/Add Blank Page use
   (mode:"select" - already existed, unchanged here) plus a compact
   page-range text field kept in sync with thumbnail selection in both
   directions: typing a range selects the matching thumbnails, and
   clicking thumbnails updates the text field. Both directions reuse
   gridApi's own existing selection API (getSelected/selectAll/
   clearSelection) and, for text->thumbnails, the grid's OWN real click
   handling (via a genuine card.click(), not a class toggled from
   outside) - buildPageGrid()/wirePageGridDrag() are not modified at all. */
TOOLS.extractpages = function(){
  let file=null, gridApi=null, loadToken=0, totalPages=0;
  // Set only while applyWantedSelection() is programmatically clicking
  // cards to match a typed range - without this, each of those clicks
  // would also trigger the thumbnails->text sync below and overwrite
  // rangeInput.value mid-typing (or mid-batch), fighting the very
  // input that triggered them.
  let suppressClickSync = false;

  openPanel(`
    <div class="panel-head"><h3>Extract Pages</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell page-workspace" id="extractBody">
      <div class="tool-hero" id="extractHero">
        <h2 class="tool-hero-title">Extract Pages</h2>
        <p class="tool-hero-desc">Select the pages you want to keep and save them as a new PDF.</p>
      </div>
      <div class="tool-upload-wrap" id="extractUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="extractPrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace" id="extractWorkspace" style="display:none">
        <div class="tool-main-pane">
          <p class="page-grid-hint" id="gridHint" style="display:none">Click the pages you want to keep.</p>
          <div class="page-grid tool-content-area" id="pageGrid"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Extract Pages</h3>
          <div id="extractFileSlot"></div>
          <div class="field"><label for="extractRangeInput">Pages to extract</label>
            <input type="text" id="extractRangeInput" placeholder="e.g. 1,3,5-8" autocomplete="off">
          </div>
          <div class="row">
            <button class="btn secondary btn-sm" id="extractSelectAll" type="button" style="flex:1">Select all</button>
            <button class="btn secondary btn-sm" id="extractClearSel" type="button" style="flex:1">Clear</button>
          </div>
          <button class="btn tool-toolbar-primary" id="go" disabled>Extract Pages</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("extractHero");
  const uploadWrap = document.getElementById("extractUploadWrap");
  const privacyHint = document.getElementById("extractPrivacyHint");
  const workspace = document.getElementById("extractWorkspace");
  const fileSlot = document.getElementById("extractFileSlot");
  const gridHint = document.getElementById("gridHint");
  const body = document.getElementById("extractBody");
  const pageGrid = document.getElementById("pageGrid");
  const rangeInput = document.getElementById("extractRangeInput");
  const goBtn = document.getElementById("go");

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

  function selected1Based(){ return [...gridApi.getSelected()].map(i=>i+1).sort((a,b)=>a-b); }
  function updateGoButton(count){
    goBtn.disabled = count===0;
    goBtn.textContent = count===0 ? "Extract Pages" : `Extract ${count} Page${count===1?"":"s"}`;
  }
  // Thumbnails -> text field + button. Triggered by a real click on a
  // card (delegated), or right after Select all/Clear.
  function syncFromThumbnails(){
    const sel = selected1Based();
    rangeInput.value = sel.join(",");
    updateGoButton(sel.length);
  }
  // Text field -> thumbnails + button. Deliberately never writes back to
  // rangeInput.value itself (see suppressClickSync above for why).
  function applyWantedSelection(wanted1Based){
    const wanted = new Set(wanted1Based);
    const cur = new Set(selected1Based());
    suppressClickSync = true;
    pageGrid.querySelectorAll(".page-card").forEach(c=>{
      const pageNum = parseInt(c.dataset.page)+1;
      if(wanted.has(pageNum) !== cur.has(pageNum)) c.click();
    });
    suppressClickSync = false;
  }
  rangeInput.addEventListener("input", ()=>{
    if(!gridApi) return;
    const wanted = parsePageRangeInput(rangeInput.value, totalPages);
    applyWantedSelection(wanted);
    updateGoButton(wanted.length);
  });
  pageGrid.addEventListener("click", e=>{
    if(suppressClickSync || !gridApi) return;
    if(e.target.closest(".page-card")) syncFromThumbnails();
  });
  document.getElementById("extractSelectAll").addEventListener("click", ()=>{
    if(!gridApi) return;
    gridApi.selectAll();
    syncFromThumbnails();
  });
  document.getElementById("extractClearSel").addEventListener("click", ()=>{
    if(!gridApi) return;
    gridApi.clearSelection();
    syncFromThumbnails();
  });

  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    gridApi?.destroy(); gridApi=null;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++; gridApi?.destroy(); file=null; gridApi=null; totalPages=0;
      pageGrid.innerHTML=""; gridHint.style.display="none"; rangeInput.value="";
      updateGoButton(0);
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    gridHint.style.display="block";
    const builtGridApi = await buildPageGrid(pageGrid, bytes, {mode:"select"});
    if(myToken !== loadToken){ builtGridApi.destroy(); return; }
    gridApi = builtGridApi;
    totalPages = gridApi.getPages().length;
    syncFromThumbnails();
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Processing...");
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    // getSelectedPages() (not a raw index list) - carries each selected
    // card's existing rotation through buildPdfFromPages() (the same
    // helper Reorder/Split/Organize/Rotate already use), and is already
    // in ascending original-page order since mode:"select" never
    // reorders cards, so no extra sort is needed.
    const selectedPages = gridApi.getSelectedPages();
    if(selectedPages.length===0){ toast("Select at least one page to keep"); out.innerHTML=""; return; }
    const newDoc = await buildPdfFromPages(doc, selectedPages);
    const outBytes = await newDoc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "extracted", "pdf");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  }));
};

/* ---- REORDER ---- */
TOOLS.reorder = function(){
  let file=null, gridApi=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Reorder Pages</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell page-workspace" id="reorderBody">
      <div class="tool-hero" id="reorderHero">
        <h2 class="tool-hero-title">Reorder Pages</h2>
        <p class="tool-hero-desc">Drag pages into the order you want, then download the reordered PDF.</p>
      </div>
      <div class="tool-upload-wrap" id="reorderUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="reorderPrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace" id="reorderWorkspace" style="display:none">
        <div class="tool-main-pane">
          <p class="page-grid-hint" id="gridHint" style="display:none">Drag pages into the order you want.</p>
          <div class="page-grid tool-content-area" id="pageGrid"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Reorder Pages</h3>
          <div id="reorderFileSlot"></div>
          <button class="btn tool-toolbar-primary" id="go">Reorder Pages</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("reorderHero");
  const uploadWrap = document.getElementById("reorderUploadWrap");
  const privacyHint = document.getElementById("reorderPrivacyHint");
  const workspace = document.getElementById("reorderWorkspace");
  const fileSlot = document.getElementById("reorderFileSlot");
  const gridHint = document.getElementById("gridHint");
  const body = document.getElementById("reorderBody");

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
    gridApi?.destroy(); gridApi=null;
    file=fs[0];
    renderFileList([file], ()=>{ loadToken++; gridApi?.destroy(); file=null; gridApi=null; document.getElementById("pageGrid").innerHTML=""; gridHint.style.display="none"; showEmptyState(); });
    fileSlot.appendChild(document.getElementById("flist"));
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    gridHint.style.display="block";
    // rotatable/removable reuse the exact same per-card controls (rotate
    // left/right, ✕ to delete) Split/Organize already ship, rather than
    // building a second implementation - see wireCard()/appendCard() in
    // buildPageGrid(). multiSelect stays off: Reorder's own drag-to-
    // reorder is still the primary interaction, click-to-select would
    // conflict with dragging a card by its whole surface.
    const builtGridApi = await buildPageGrid(document.getElementById("pageGrid"), bytes, {mode:"reorder", removable:true, rotatable:true});
    if(myToken !== loadToken){ builtGridApi.destroy(); return; }
    gridApi = builtGridApi;
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Processing...");
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    // getPages() (not just getOrder()) - carries each card's current
    // rotation too, and buildPdfFromPages() (the same helper Split/
    // Organize/Rotate already use) applies it on top of the page's
    // existing rotation. Using only getOrder() here previously meant a
    // rotation dialed in on a thumbnail was a purely visual change that
    // silently vanished from the downloaded file.
    const newDoc = await buildPdfFromPages(doc, gridApi.getPages());
    const outBytes = await newDoc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "reordered", "pdf");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  }));
};

/* ---- ADD BLANK PAGE ----
   Same thumbnail-grid workspace as Reorder Pages (buildPageGrid() with
   mode:"reorder", removable+rotatable) instead of a blind "position
   number + one Add button" flow with no visual feedback - the grid
   gives drag-to-reorder/rotate/delete on every existing page for free,
   and buildPageGrid()'s insertBlankPage() (see its own comment) slots a
   real blank card into that exact same grid, wired through the exact
   same rotate/remove/drag machinery every other card already uses. Export
   goes through buildPdfFromPages() (shared with Reorder Pages/Split/
   Organize/Rotate), extended there to recognize a blank card's
   {blank:true, width, height} entry and insert a real blank PDFPage at
   that exact position instead of copying from the source document. */
TOOLS.addblank = function(){
  let file=null, gridApi=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Add Blank Page</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell page-workspace" id="addblankBody">
      <div class="tool-hero" id="addblankHero">
        <h2 class="tool-hero-title">Add Blank Page</h2>
        <p class="tool-hero-desc">Insert a blank page anywhere in your document, then download the result.</p>
      </div>
      <div class="tool-upload-wrap" id="addblankUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="addblankPrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace" id="addblankWorkspace" style="display:none">
        <div class="tool-main-pane">
          <p class="page-grid-hint" id="addblankGridHint" style="display:none">Drag pages to reorder, or insert a blank page below.</p>
          <div class="page-grid tool-content-area" id="pageGrid"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Add Blank Page</h3>
          <div id="addblankFileSlot"></div>
          <div class="field"><label for="addblankPos">Insert after page</label>
            <input type="number" id="addblankPos" value="0" min="0">
          </div>
          <button class="btn secondary" id="insertBlank" type="button" style="width:100%">+ Add Blank Page</button>
          <button class="btn tool-toolbar-primary" id="go">Download PDF</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("addblankHero");
  const uploadWrap = document.getElementById("addblankUploadWrap");
  const privacyHint = document.getElementById("addblankPrivacyHint");
  const workspace = document.getElementById("addblankWorkspace");
  const fileSlot = document.getElementById("addblankFileSlot");
  const gridHint = document.getElementById("addblankGridHint");
  const body = document.getElementById("addblankBody");
  const posInput = document.getElementById("addblankPos");

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
  // Keeps the position field bounded to the grid's current card count
  // (blank cards included) so "Insert after page" can never be pointed
  // past the end of the document - defaults to "append at the end",
  // the most common intent, but stays editable for inserting in the
  // middle.
  function syncPosBounds(){
    const count = document.querySelectorAll("#pageGrid .page-card").length;
    posInput.max = count;
    if(posInput.value==="" || parseInt(posInput.value) > count) posInput.value = count;
  }

  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    gridApi?.destroy(); gridApi=null;
    file=fs[0];
    renderFileList([file], ()=>{ loadToken++; gridApi?.destroy(); file=null; gridApi=null; document.getElementById("pageGrid").innerHTML=""; gridHint.style.display="none"; showEmptyState(); });
    fileSlot.appendChild(document.getElementById("flist"));
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    gridHint.style.display="block";
    const builtGridApi = await buildPageGrid(document.getElementById("pageGrid"), bytes, {mode:"reorder", removable:true, rotatable:true});
    if(myToken !== loadToken){ builtGridApi.destroy(); return; }
    gridApi = builtGridApi;
    syncPosBounds();
    showWorkspace();
  });

  document.getElementById("insertBlank").addEventListener("click", async ()=>{
    if(!gridApi) return;
    const afterIndex = Math.max(0, parseInt(posInput.value)||0);
    const card = await gridApi.insertBlankPage(afterIndex);
    // Scrolls the new card into view and briefly pulses it so "where did
    // it go" is never a question, even in a long document where the
    // insertion point might be off-screen.
    card.scrollIntoView({block:"center", behavior: MOTION.reduced ? "auto" : "smooth"});
    if(window.gsap && !MOTION.reduced) gsap.fromTo(card, {filter:"brightness(1.6)"}, {filter:"brightness(1)", duration:.5, ease:"power2.out"});
    syncPosBounds();
  });

  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Processing...");
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    // Same getPages()+buildPdfFromPages() export path Reorder Pages uses -
    // blank cards flow through automatically via the {blank:true,...}
    // shape getPages() now emits for them.
    const newDoc = await buildPdfFromPages(doc, gridApi.getPages());
    const outBytes = await newDoc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "with_blank", "pdf");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  }));
};

/* ---- PAGE NUMBERS ---- */
/* Builds the actual displayed string for one stamped page - shared by
   the preview and the real export so "Page 3 of 12" in the preview is
   guaranteed to be the same string pdf-lib writes. displayNum already
   has startNumber folded in by the caller (the Nth page actually being
   numbered, not its raw position in the document - front matter before
   the numbering range doesn't shift what "start at 5" means). */
function pageNumberText(format, displayNum, totalPages){
  switch(format){
    case "n": return `${displayNum}`;
    case "page-n": return `Page ${displayNum}`;
    case "page-n-of-total": return `Page ${displayNum} of ${totalPages}`;
    default: return `${displayNum} / ${totalPages}`; // "n-of-total"
  }
}
TOOLS.pagenumbers = function(){
  let file=null, pdoc=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Add Page Numbers</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="pagenumbersBody">
      <div class="tool-hero" id="pnHero">
        <h2 class="tool-hero-title">Add Page Numbers</h2>
        <p class="tool-hero-desc">Number every page of your PDF, positioned and formatted however you like.</p>
      </div>
      <div class="tool-upload-wrap" id="pnUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="pnPrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace" id="pnWorkspace" style="display:none">
        <div class="tool-main-pane">
          <div class="tool-content-area crop-stage" id="pnStage">
            <canvas id="pnCanvas"></canvas>
          </div>
          <div class="mono" id="pnReadout" style="font-size:.78rem;color:var(--ink-soft);text-align:center;margin:6px 0;">Preview of page 1.</div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Add Page Numbers</h3>
          <div id="pnFileSlot"></div>
          <div class="field"><label for="pnpos">Position</label>
            <select id="pnpos">
              <option value="bottom-right" selected>Bottom right</option>
              <option value="bottom-center">Bottom center</option>
              <option value="bottom-left">Bottom left</option>
              <option value="top-right">Top right</option>
              <option value="top-center">Top center</option>
              <option value="top-left">Top left</option>
            </select>
          </div>
          <div class="field"><label for="pnformat">Format</label>
            <select id="pnformat">
              <option value="n-of-total" selected>1 / 10</option>
              <option value="n">1</option>
              <option value="page-n">Page 1</option>
              <option value="page-n-of-total">Page 1 of 10</option>
            </select>
          </div>
          <div class="row">
            <div class="field" style="margin:0"><label for="pnstart">Start at</label><input type="number" id="pnstart" value="1" min="1"></div>
            <div class="field" style="margin:0"><label for="pnsize">Font size</label><input type="number" id="pnsize" value="10" min="6" max="24"></div>
          </div>
          <div class="field"><label for="pnpages">Pages (optional)</label><input type="text" id="pnpages" placeholder="e.g. 1,3-5 - leave blank for all pages"></div>
          <div class="split-error" id="pnError" hidden></div>
          <button class="btn tool-toolbar-primary" id="go">Add Page Numbers</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("pnHero");
  const uploadWrap = document.getElementById("pnUploadWrap");
  const privacyHint = document.getElementById("pnPrivacyHint");
  const workspace = document.getElementById("pnWorkspace");
  const fileSlot = document.getElementById("pnFileSlot");
  const body = document.getElementById("pagenumbersBody");
  const canvas = document.getElementById("pnCanvas");
  const readout = document.getElementById("pnReadout");
  const errorBox = document.getElementById("pnError");
  const goBtn = document.getElementById("go");
  let dispScale = 1, pageBgImageData = null, page1Size = {width:612,height:792};
  const MARGIN_X = 30, MARGIN_Y = 20;

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
  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${msg}</span>`; errorBox.hidden=false; }
    else { errorBox.hidden=true; errorBox.innerHTML=""; }
  }
  function currentSettings(){
    const [vAlign, hAlign] = document.getElementById("pnpos").value.split("-");
    return {
      vAlign, hAlign,
      format: document.getElementById("pnformat").value,
      startNumber: Math.max(1, parseInt(document.getElementById("pnstart").value) || 1),
      fontSize: Math.max(6, parseInt(document.getElementById("pnsize").value) || 10),
    };
  }
  function validate(){
    if(!file){ goBtn.disabled = true; return; }
    const pagesRaw = document.getElementById("pnpages").value.trim();
    if(pagesRaw && pdoc && !parsePageList(pagesRaw, pdoc.numPages)){
      showError(`Enter page numbers between 1 and ${pdoc.numPages}, e.g. 1,3-5.`);
      goBtn.disabled = true;
      return;
    }
    showError(null);
    goBtn.disabled = false;
  }
  function redrawPreview(){
    if(!pageBgImageData) return;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(pageBgImageData, 0, 0);
    const {vAlign, hAlign, format, startNumber, fontSize} = currentSettings();
    // Page 1's own displayed number: startNumber, UNLESS an explicit page
    // range is given and page 1 isn't in it - then show the number it
    // would actually get based on its position among the numbered pages
    // (matches the real export's per-page counting below exactly).
    const pagesRaw = document.getElementById("pnpages").value.trim();
    const totalPages = pdoc ? pdoc.numPages : 1;
    const targetIndices = pagesRaw ? parsePageList(pagesRaw, totalPages) : null;
    let displayNum = startNumber, showOnPage1 = true;
    if(targetIndices){
      const pos = targetIndices.indexOf(0);
      if(pos===-1) showOnPage1 = false; else displayNum = startNumber + pos;
    }
    if(!showOnPage1){ readout.textContent = "Page 1 isn't in the selected range - shown here is where it will NOT appear."; return; }
    readout.textContent = "Preview of page 1.";
    // "of Total" must be the LAST number actually shown, not just a raw
    // page count - with startNumber>1, count alone drifts from what's on
    // the page (start=5 over 5 pages would count up to 9, but a fixed
    // "of 5" would make page 2 read "6 of 5", which is nonsense).
    const numberedCount = targetIndices ? targetIndices.length : totalPages;
    const lastDisplayNum = startNumber + numberedCount - 1;
    const text = pageNumberText(format, displayNum, lastDisplayNum);
    const scaledSize = fontSize * dispScale;
    ctx.font = `${scaledSize}px Helvetica, Arial, sans-serif`;
    ctx.fillStyle = "rgb(51,51,51)";
    ctx.textBaseline = "alphabetic";
    const tw = ctx.measureText(text).width / dispScale;
    const x = headerFooterAnchor(hAlign, page1Size.width, tw, MARGIN_X) * dispScale;
    // Same baseline logic as Header & Footer: pdf-lib's y IS the
    // baseline, so canvasY = (pageHeight - pdfBaselineY) * dispScale,
    // which simplifies to MARGIN_Y*dispScale (bottom) or
    // canvas.height - MARGIN_Y*dispScale (top, since pdfY = height-MARGIN_Y there).
    const y = vAlign==="top" ? MARGIN_Y * dispScale : canvas.height - MARGIN_Y * dispScale;
    ctx.fillText(text, x, y);
  }
  ["pnpos","pnformat","pnstart","pnsize"].forEach(id=>{
    document.getElementById(id).addEventListener("input", redrawPreview);
  });
  document.getElementById("pnpages").addEventListener("input", ()=>{ validate(); redrawPreview(); });

  wireDropzone(async fs=>{
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null; pdoc=null; pageBgImageData=null;
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    validate();
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    const loadedPdoc = await loadPdfJsSafe({data:bytes.slice(0)});
    if(myToken !== loadToken) return;
    pdoc = loadedPdoc;
    const page1 = await pdoc.getPage(1);
    if(myToken !== loadToken) return;
    const vp1 = page1.getViewport({scale:1});
    page1Size = {width:vp1.width, height:vp1.height};
    const maxW = 700;
    dispScale = Math.min(1, maxW/vp1.width);
    showWorkspace();
    try{
      const rendered = await renderPdfPageCanvas(pdoc, 1, dispScale);
      if(myToken !== loadToken) return;
      canvas.width = rendered.width; canvas.height = rendered.height;
      canvas.getContext("2d").drawImage(rendered, 0, 0);
      pageBgImageData = canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
      redrawPreview();
    }catch(e){
      readout.textContent = "Couldn't render a preview, but page numbers will still apply correctly on download.";
    }
    validate();
  });

  goBtn.addEventListener("click", withToolOperation(goBtn, async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl(T("workspace.statusReadingPdf"));
    const {vAlign, hAlign, format, startNumber, fontSize} = currentSettings();
    const pagesRaw = document.getElementById("pnpages").value.trim();
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    const targetIndices = pagesRaw ? parsePageList(pagesRaw, pages.length) : null;
    // Same "of Total" fix as the preview above - the last number actually
    // reached, not a raw page count that can drift once startNumber>1.
    const numberedCount = targetIndices ? targetIndices.length : pages.length;
    const totalForFormat = startNumber + numberedCount - 1;
    setStatus("Numbering pages...");
    let counter = 0;
    pages.forEach((p,i)=>{
      if(targetIndices && !targetIndices.includes(i)) return;
      const displayNum = startNumber + counter;
      counter++;
      const text = pageNumberText(format, displayNum, totalForFormat);
      const {width, height} = p.getSize();
      const tw = font.widthOfTextAtSize(text, fontSize);
      const x = headerFooterAnchor(hAlign, width, tw, MARGIN_X);
      const y = vAlign==="top" ? height-MARGIN_Y : MARGIN_Y;
      p.drawText(text, {x, y, size:fontSize, font, color:rgb(0.2,0.2,0.2)});
    });
    const outBytes=await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "numbered", "pdf");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas:thumb}=await pdfThumb(outBytes);
    setStatus("Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:thumb, url, filename:outName}));
  }));
};

/* ---- WATERMARK ---- */
/* Shared by TOOLS.watermark's live preview canvas AND its real pdf-lib
   export - one formula, not two that could quietly drift apart (the
   previous version had NO preview at all, so this risk didn't exist yet,
   but a preview that used different math than the actual export would
   be worse than no preview - it would show the user something the
   output doesn't match). Returns the text's bottom-left draw anchor in
   PDF-point space (origin bottom-left, y-up), before rotation is
   applied - matches how pdf-lib's own rotate:degrees(...) pivots
   drawText around that same anchor, so a corner placement rotates in
   place exactly the same way on screen and in the exported file. */
/* Shared page-range parser: 1-based comma list + ranges ("1,3-5"),
   returns 0-based indices or null on empty/invalid input. Was duplicated
   locally in Split and Watermark (2 copies, same ~15 lines) - promoted
   here once Header & Footer became the 3rd tool needing it, rather than
   writing a 3rd copy. */
function parsePageList(str, max){
  str = str.trim();
  if(!str) return null;
  const out = [];
  for(const part of str.split(",")){
    const p = part.trim();
    if(!p) continue;
    if(p.includes("-")){
      const [a,b] = p.split("-").map(n=>parseInt(n.trim()));
      if(!Number.isInteger(a) || !Number.isInteger(b) || a<1 || b<a || (max && b>max)) return null;
      for(let i=a;i<=b;i++) out.push(i-1);
    } else {
      const n = parseInt(p);
      if(!Number.isInteger(n) || n<1 || (max && n>max)) return null;
      out.push(n-1);
    }
  }
  return out.length ? out : null;
}
function watermarkAnchor(position, pageWidth, pageHeight, textWidth, fontSize){
  const margin = Math.min(60, pageWidth*0.08, pageHeight*0.08);
  switch(position){
    case "top-left": return {x:margin, y:pageHeight-margin-fontSize};
    case "top-right": return {x:pageWidth-margin-textWidth, y:pageHeight-margin-fontSize};
    case "bottom-left": return {x:margin, y:margin};
    case "bottom-right": return {x:pageWidth-margin-textWidth, y:margin};
    default: return {x:pageWidth/2-textWidth/2, y:pageHeight/2}; // center
  }
}
TOOLS.watermark = function(){
  let file=null, pdoc=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Add Watermark</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="watermarkBody">
      <div class="tool-hero" id="watermarkHero">
        <h2 class="tool-hero-title">Add Watermark</h2>
        <p class="tool-hero-desc">Stamp text across every page of your PDF - see exactly how it'll look before you download.</p>
      </div>
      <div class="tool-upload-wrap" id="watermarkUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="watermarkPrivacyHint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-app-workspace" id="watermarkWorkspace" style="display:none">
        <div class="tool-main-pane">
          <div class="tool-content-area crop-stage" id="watermarkStage">
            <canvas id="watermarkCanvas"></canvas>
          </div>
          <div class="mono" id="watermarkReadout" style="font-size:.78rem;color:var(--ink-soft);text-align:center;margin:6px 0;">Preview of page 1 - every page gets the same watermark.</div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Add Watermark</h3>
          <div id="watermarkFileSlot"></div>
          <div class="field"><label for="wtext">Watermark text</label><input type="text" id="wtext" placeholder="e.g. CONFIDENTIAL" value="CONFIDENTIAL"></div>
          <div class="field"><label for="wposition">Position</label>
            <select id="wposition">
              <option value="center" selected>Center (diagonal)</option>
              <option value="top-left">Top left</option>
              <option value="top-right">Top right</option>
              <option value="bottom-left">Bottom left</option>
              <option value="bottom-right">Bottom right</option>
            </select>
          </div>
          <div class="row">
            <div class="field" style="margin:0"><label for="wrotate">Rotation (°)</label><input type="number" id="wrotate" value="45" min="0" max="359" step="5"></div>
            <div class="field" style="margin:0"><label for="opac">Opacity</label><input type="number" id="opac" value="0.25" step="0.05" min="0.05" max="1"></div>
          </div>
          <div class="field"><label for="fsize">Font size</label><input type="number" id="fsize" value="48" min="6" max="200"></div>
          <div class="field"><label for="wpages">Pages (optional)</label><input type="text" id="wpages" placeholder="e.g. 1,3-5 - leave blank for all pages"></div>
          <div class="split-error" id="watermarkError" hidden></div>
          <button class="btn tool-toolbar-primary" id="go">Add Watermark</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("watermarkHero");
  const uploadWrap = document.getElementById("watermarkUploadWrap");
  const privacyHint = document.getElementById("watermarkPrivacyHint");
  const workspace = document.getElementById("watermarkWorkspace");
  const fileSlot = document.getElementById("watermarkFileSlot");
  const body = document.getElementById("watermarkBody");
  const canvas = document.getElementById("watermarkCanvas");
  const readout = document.getElementById("watermarkReadout");
  const errorBox = document.getElementById("watermarkError");
  const goBtn = document.getElementById("go");
  let dispScale = 1, pageBgImageData = null, page1Size = {width:612,height:792};

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
  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${msg}</span>`; errorBox.hidden=false; }
    else { errorBox.hidden=true; errorBox.innerHTML=""; }
  }
  function currentSettings(){
    return {
      text: document.getElementById("wtext").value || "WATERMARK",
      position: document.getElementById("wposition").value,
      rotation: parseFloat(document.getElementById("wrotate").value) || 0,
      opacity: Math.max(0.05, Math.min(1, parseFloat(document.getElementById("opac").value) || 0.25)),
      fontSize: Math.max(6, parseInt(document.getElementById("fsize").value) || 48),
    };
  }
  function validate(){
    if(!file){ goBtn.disabled = true; return; }
    const pagesRaw = document.getElementById("wpages").value.trim();
    if(pagesRaw && pdoc && !parsePageList(pagesRaw, pdoc.numPages)){
      showError(`Enter page numbers between 1 and ${pdoc.numPages}, e.g. 1,3-5.`);
      goBtn.disabled = true;
      return;
    }
    showError(null);
    goBtn.disabled = false;
  }
  // Draws the exact same watermark the export will produce, using
  // watermarkAnchor() for position math and a canvas rotate() around
  // that same anchor - the one thing a plain-text config form can't
  // convey on its own is what "45deg, bottom-right, 0.25 opacity" will
  // actually look like on THIS document, so this is the highest-value
  // single addition to this tool (previously: none at all).
  function redrawPreview(){
    if(!pageBgImageData) return;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(pageBgImageData, 0, 0);
    const {text, position, rotation, opacity, fontSize} = currentSettings();
    const safeText = winAnsiSafe(text);
    if(!safeText.trim()) return;
    const scaledSize = fontSize * dispScale;
    ctx.font = `bold ${scaledSize}px Helvetica, Arial, sans-serif`;
    const textWidth = ctx.measureText(safeText).width / dispScale; // back to PDF-point space, matching watermarkAnchor's units
    const anchorPt = watermarkAnchor(position, page1Size.width, page1Size.height, textWidth, fontSize);
    // PDF points (bottom-up) -> canvas px (top-down), then apply the
    // canvas's own displayed scale.
    const ax = anchorPt.x * dispScale;
    const ay = (page1Size.height - anchorPt.y) * dispScale;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = "rgb(128,128,128)";
    ctx.translate(ax, ay);
    ctx.rotate(-rotation * Math.PI/180); // canvas rotates clockwise for +angle; PDF rotates counter-clockwise - negate to match
    ctx.textBaseline = "alphabetic";
    ctx.fillText(safeText, 0, 0);
    ctx.restore();
  }
  ["wtext","wposition","wrotate","opac","fsize"].forEach(id=>{
    document.getElementById(id).addEventListener("input", redrawPreview);
  });
  document.getElementById("wpages").addEventListener("input", validate);

  wireDropzone(async fs=>{
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null; pdoc=null; pageBgImageData=null;
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    validate();
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    const loadedPdoc = await loadPdfJsSafe({data:bytes.slice(0)});
    if(myToken !== loadToken) return;
    pdoc = loadedPdoc;
    const page1 = await pdoc.getPage(1);
    if(myToken !== loadToken) return;
    const vp1 = page1.getViewport({scale:1});
    page1Size = {width:vp1.width, height:vp1.height};
    const maxW = 700;
    dispScale = Math.min(1, maxW/vp1.width);
    showWorkspace();
    try{
      const rendered = await renderPdfPageCanvas(pdoc, 1, dispScale);
      if(myToken !== loadToken) return;
      canvas.width = rendered.width; canvas.height = rendered.height;
      canvas.getContext("2d").drawImage(rendered, 0, 0);
      pageBgImageData = canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
      redrawPreview();
    }catch(e){
      readout.textContent = "Couldn't render a preview, but the watermark will still apply correctly on download.";
    }
    validate();
  });

  goBtn.addEventListener("click", withToolOperation(goBtn, async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl(T("workspace.statusReadingPdf"));
    const {text, position, rotation, opacity, fontSize} = currentSettings();
    const safeText = winAnsiSafe(text);
    const pagesRaw = document.getElementById("wpages").value.trim();
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const targetIndices = pagesRaw ? parsePageList(pagesRaw, doc.getPageCount()) : null;
    setStatus("Adding watermark...");
    const tw = font.widthOfTextAtSize(safeText, fontSize);
    doc.getPages().forEach((p,i)=>{
      if(targetIndices && !targetIndices.includes(i)) return;
      const {width,height} = p.getSize();
      const anchor = watermarkAnchor(position, width, height, tw, fontSize);
      p.drawText(safeText, {x:anchor.x, y:anchor.y, size:fontSize, font, color:rgb(0.5,0.5,0.5), opacity, rotate:degrees(rotation)});
    });
    const outBytes=await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "watermarked", "pdf");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas:thumb}=await pdfThumb(outBytes);
    setStatus("Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:thumb, url, filename:outName}));
  }));
};
