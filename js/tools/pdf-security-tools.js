/* ---------------- Shared: flatten a pdf.js document into a fresh, unencrypted PDF ----------------
   Renders every page to a raster image and embeds it full-bleed into a new
   pdf-lib document - the same "rip to image" technique pdf2jpg/jpg2pdf
   already use, just chained together instead of exported separately. Used
   by both Unlock PDF (when the file's encryption scheme isn't the simple
   one pdf-crypto.js can structurally decrypt) and Repair PDF (when a file
   is too structurally damaged for pdf-lib/pdf-crypto.js to rebuild). Always
   succeeds if pdf.js could render the pages at all - the honest tradeoff
   (documented in both tools' UI) is that the result's text is no longer
   selectable/searchable, since the page is now one flat image.
   @param {import("pdfjs-dist").PDFDocumentProxy} pdoc
   @param {(page:number, total:number)=>void} [onProgress]
   @returns {Promise<Uint8Array>}
*/
async function flattenPdocToPdfBytes(pdoc, onProgress){
  const doc = await PDFDocument.create();
  for(let i=1;i<=pdoc.numPages;i++){
    if(onProgress) onProgress(i, pdoc.numPages);
    const canvas = await renderPdfPageCanvas(pdoc, i, 2);
    const blob = await new Promise(res=>canvas.toBlob(res, "image/jpeg", 0.92));
    const imgBytes = new Uint8Array(await blob.arrayBuffer());
    const img = await doc.embedJpg(imgBytes);
    const page = doc.addPage([canvas.width, canvas.height]);
    page.drawImage(img, {x:0, y:0, width:canvas.width, height:canvas.height});
  }
  return doc.save();
}

/* ---- PROTECT PDF (add an open password, 40-bit RC4) ---- */
TOOLS.protect = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.protect")}</h3></div>
    <div class="panel-body compact tool-workspace" id="protectBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.protect")}</h2>
        <p class="tool-hero-desc">${t("toolProtect.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, t("toolSplit.selectPdfFile"))}
      </div>
      <div class="tool-content-area" id="protectFields" style="display:none">
        <div class="status" role="note" id="protectEncNote">${t("toolProtect.strongNote")}</div>
        <div class="field">
          <div class="tool-content-area-label">${t("toolProtect.encryptionLabel")}</div>
          <label class="checkbox-row"><input type="radio" name="protectStrength" id="protectStrong" value="aes" checked> ${t("toolProtect.encryptionStrong")}</label>
          <label class="checkbox-row"><input type="radio" name="protectStrength" id="protectLegacy" value="legacy"> ${t("toolProtect.encryptionLegacy")}</label>
        </div>
        <div class="field"><label for="protectPw">${t("toolProtect.openPasswordLabel")}</label><input type="password" id="protectPw" autocomplete="new-password"></div>
        <div class="field"><label for="protectPw2">${t("toolProtect.confirmPasswordLabel")}</label><input type="password" id="protectPw2" autocomplete="new-password"></div>
        <div class="field"><label for="protectOwnerPw">${t("toolProtect.permissionsPasswordLabel")}</label><input type="password" id="protectOwnerPw" autocomplete="new-password"></div>
        <div class="field"><label for="protectOwnerPw2">${t("toolProtect.confirmPermissionsPasswordLabel")}</label><input type="password" id="protectOwnerPw2" autocomplete="new-password"></div>
        <div class="status" id="protectWeakWarning" style="color:var(--amber, #b45309)" hidden>${t("toolProtect.weakPasswordWarning")}</div>
        <div class="field">
          <div class="tool-content-area-label">${t("toolProtect.permissionsLabel")}</div>
          <label class="checkbox-row"><input type="checkbox" id="permPrint" checked> ${t("toolProtect.permPrint")}</label>
          <label class="checkbox-row"><input type="checkbox" id="permCopy" checked> ${t("toolProtect.permCopy")}</label>
          <label class="checkbox-row"><input type="checkbox" id="permModify" checked> ${t("toolProtect.permModify")}</label>
          <label class="checkbox-row"><input type="checkbox" id="permAnnotate" checked> ${t("toolProtect.permAnnotate")}</label>
          <label class="checkbox-row"><input type="checkbox" id="permFillForms" checked> ${t("toolProtect.permFillForms")}</label>
          <label class="checkbox-row"><input type="checkbox" id="permExtractAccessibility" checked> ${t("toolProtect.permExtractAccessibility")}</label>
          <label class="checkbox-row"><input type="checkbox" id="permAssemble" checked> ${t("toolProtect.permAssemble")}</label>
          <label class="checkbox-row"><input type="checkbox" id="permPrintHighRes" checked> ${t("toolProtect.permPrintHighRes")}</label>
        </div>
        <div class="status" id="protectError" style="color:var(--rose)" hidden></div>
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintPassword")}</p>
      <div class="tool-toolbar" id="protectToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("tools.protect")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{
      file=null;
      document.getElementById("protectToolbar").style.display="none";
      document.getElementById("protectFields").style.display="none";
      document.getElementById("protectBody").classList.remove("is-loaded");
    });
    document.getElementById("protectToolbar").style.display="flex";
    document.getElementById("protectFields").style.display="block";
    document.getElementById("protectBody").classList.add("is-loaded");
  });
  // The encryption note describes the SELECTED strength: strong AES-256
  // by default, the legacy RC4 warning only when legacy is chosen.
  const encNote = document.getElementById("protectEncNote");
  document.querySelectorAll('input[name="protectStrength"]').forEach(radio=>{
    radio.addEventListener("change", ()=>{
      encNote.textContent = document.getElementById("protectLegacy").checked
        ? t("toolProtect.legacyWarning") : t("toolProtect.strongNote");
    });
  });
  // Weak-password guidance is a warning, never a block: short or
  // single-class passwords still protect the file, just less strongly.
  const weakWarning = document.getElementById("protectWeakWarning");
  document.getElementById("protectPw").addEventListener("input", (e)=>{
    const v = e.target.value;
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re=>re.test(v)).length;
    weakWarning.hidden = !(v && (v.length < 8 || classes < 2));
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out = document.getElementById("out");
    const errEl = document.getElementById("protectError");
    errEl.hidden = true;
    const pw = document.getElementById("protectPw").value;
    const pw2 = document.getElementById("protectPw2").value;
    const ownerPw = document.getElementById("protectOwnerPw").value;
    const ownerPw2 = document.getElementById("protectOwnerPw2").value;
    // Either password may be empty on its own (open-without-password but
    // restricted, or restrictions lifted by the open password alone),
    // but at least one must be set, and each non-empty password must
    // match its confirmation.
    if(!pw && !ownerPw){ errEl.hidden=false; errEl.textContent = t("toolProtect.errAtLeastOnePassword"); return; }
    if(pw !== pw2){ errEl.hidden=false; errEl.textContent = t("toolProtect.errPasswordMismatch"); return; }
    if(ownerPw !== ownerPw2){ errEl.hidden=false; errEl.textContent = t("toolProtect.errPermissionsMismatch"); return; }
    const permissions = {
      print: document.getElementById("permPrint").checked,
      copy: document.getElementById("permCopy").checked,
      modify: document.getElementById("permModify").checked,
      annotate: document.getElementById("permAnnotate").checked,
      fillForms: document.getElementById("permFillForms").checked,
      extractAccessibility: document.getElementById("permExtractAccessibility").checked,
      assemble: document.getElementById("permAssemble").checked,
      printHighRes: document.getElementById("permPrintHighRes").checked,
    };
    const useLegacy = document.getElementById("protectLegacy").checked;
    out.innerHTML = statusEl(T("workspace.statusReadingPdf"));
    // Guards the same rapid-file-replacement/double-click race every
    // Go-button handler in this app needs (see pdf-page-tools-1.js's
    // Compress PDF for the established pattern).
    goBtn.disabled = true;
    try{
      const bytes = await file.arrayBuffer();
      let doc;
      try{
        doc = await loadPdfSafe(bytes);
      }catch(e){
        const isEncrypted = /encrypt/i.test(e.name||"") || /encrypt/i.test(e.message||"");
        throw new Error(isEncrypted ? t("toolProtect.errAlreadyProtected") : e.message);
      }
      setStatus(T("workspace.statusPreparingDocument"));
      // useObjectStreams:false - pdf-crypto.js's raw-byte rewriter only
      // understands a classic xref table with top-level indirect objects,
      // not PDF 1.5+ compressed object streams. See that file's header.
      const rawBytes = await doc.save({useObjectStreams:false});
      setStatus(t("toolProtect.statusEncrypting"));
      let protectedBytes;
      if(useLegacy){
        // Legacy opt-in: the same 40-bit RC4 scheme as before, with the
        // user and owner passwords now independent (an empty open
        // password + a permissions password is a restrictions-only file).
        protectedBytes = encryptPdfBytes(rawBytes, {userPassword:pw, ownerPassword:ownerPw || pw, permissions});
      } else {
        try{
          protectedBytes = await encryptPdfBytesAES256(rawBytes, {userPassword:pw, ownerPassword:ownerPw || undefined, permissions});
        }catch(e){
          // WebCrypto unavailable (non-secure context): say so plainly
          // and point at the legacy option instead of failing silently.
          throw new Error(/WebCrypto|secure/i.test(e.message||"") ? t("toolProtect.errNoSubtle") : e.message);
        }
      }
      // Runtime self-check: independently re-open the result with pdf.js
      // (a mature, separately-implemented decryptor) using the open
      // password - or with no password for a permissions-only file.
      // This is the actual correctness guarantee for a hand-rolled
      // encryption routine - a failure here means the output would not
      // be a valid protected PDF, so it's never handed to the user.
      let verifyPage1;
      try{
        const verifyParams = {data: protectedBytes.slice(0)};
        if(pw) verifyParams.password = pw;
        const verifyDoc = operation.track(await loadPdfJsSafe(verifyParams));
        verifyPage1 = await verifyDoc.getPage(1);
      }catch(e){
        throw new Error(t("toolProtect.errFailedGeneric"));
      }
      setStatus(T("workspace.statusPreparingDownload"));
      const blob = new Blob([protectedBytes], {type:"application/pdf"});
      const outName = suffixedName(file, "protected", "pdf");
      if(!operation.isCurrent()) return;
      const {url} = downloadBlob(blob, outName);
      const previewScale = 220 / verifyPage1.getViewport({scale:1}).height;
      const canvas = document.createElement("canvas");
      const vp = verifyPage1.getViewport({scale: previewScale});
      canvas.width = vp.width; canvas.height = vp.height;
      await verifyPage1.render({canvasContext:canvas.getContext("2d"), viewport:vp}).promise;
      setStatus(t("workspace.done"), true);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">${escapeAttr(e.message)}</div>`;
    }finally{
      goBtn.disabled = false;
    }
  }));
};

/* ---- UNLOCK PDF (remove a known password) ---- */
TOOLS.unlock = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null, fileBytes=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.unlock")}</h3></div>
    <div class="panel-body compact tool-workspace" id="unlockBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.unlock")}</h2>
        <p class="tool-hero-desc">${t("toolUnlock.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, t("workspace.selectPdfFiles"))}
      </div>
      <div class="tool-content-area" id="unlockFields" style="display:none">
        <div class="status" id="unlockStatus"></div>
        <div class="field" id="unlockPwField" style="display:none">
          <label for="unlockPw">${t("toolUnlock.passwordLabel")}</label>
          <input type="password" id="unlockPw" autocomplete="current-password">
        </div>
        <div class="status" id="unlockError" style="color:var(--rose)" hidden></div>
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFilePassword")}</p>
      <div class="tool-toolbar" id="unlockToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go" disabled>${t("tools.unlock")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  const statusBox = document.getElementById("unlockStatus");
  const pwField = document.getElementById("unlockPwField");
  const pwInput = document.getElementById("unlockPw");
  const errEl = document.getElementById("unlockError");
  const goBtn = document.getElementById("go");
  let needsPassword = false;
  // Set when the user explicitly accepts image-based unlocking for a
  // file whose encryption can't be removed structurally; reset on
  // every new file so consent never carries over to another document.
  let flattenConsent = false;
  let permissionsOnly = false;

  async function inspectFile(){
    errEl.hidden = true;
    flattenConsent = false;
    permissionsOnly = false;
    try{
      const inspectionDoc = await loadPdfJsSafe({data: fileBytes.slice(0)});
      await inspectionDoc.destroy();
      needsPassword = false;
      pwField.style.display = "none";
      // pdf.js opens the file without a password, but it may still
      // carry an /Encrypt dictionary (a permissions-only file: empty
      // user password, restrictions enforced by an owner password).
      // Those restrictions CAN be removed - offer the flatten-or-decrypt
      // path instead of reporting the file as unprotected.
      let encDict = null;
      try{ encDict = readExistingEncryptDict(bytesToBinaryString(fileBytes)); }catch(e){ encDict = null; }
      if(encDict){
        permissionsOnly = true;
        statusBox.textContent = t("toolUnlock.statusPermissionsOnly");
        goBtn.disabled = false;
      } else {
        statusBox.textContent = t("toolUnlock.statusNotProtected");
        goBtn.disabled = true;
      }
    }catch(e){
      if(e && e.name === "PasswordException"){
        needsPassword = true;
        pwField.style.display = "block";
        statusBox.textContent = t("toolUnlock.statusProtectedEnterPw");
        goBtn.disabled = false;
        pwInput.focus();
      } else {
        needsPassword = false;
        pwField.style.display = "none";
        statusBox.textContent = t("toolUnlock.statusCouldNotRead");
        goBtn.disabled = true;
      }
    }
  }
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{
      file=null; fileBytes=null; flattenConsent=false; permissionsOnly=false;
      document.getElementById("unlockToolbar").style.display="none";
      document.getElementById("unlockFields").style.display="none";
      document.getElementById("unlockBody").classList.remove("is-loaded");
    });
    document.getElementById("unlockToolbar").style.display="flex";
    document.getElementById("unlockFields").style.display="block";
    document.getElementById("unlockBody").classList.add("is-loaded");
    statusBox.textContent = t("toolUnlock.statusCheckingFile");
    pwField.style.display = "none";
    goBtn.disabled = true;
    file.arrayBuffer().then(buf=>{ fileBytes = new Uint8Array(buf); inspectFile(); });
  });
  goBtn.addEventListener("click", withToolOperation(goBtn, async (_event, operation)=>{
    const out = document.getElementById("out");
    errEl.hidden = true;
    const password = needsPassword ? pwInput.value : "";
    if(needsPassword && !password){ errEl.hidden=false; errEl.textContent=t("toolUnlock.errEnterPassword"); return; }
    out.innerHTML = statusEl(t("toolUnlock.statusOpeningPdf"));
    let pdoc;
    try{
      pdoc = operation.track(await loadPdfJsSafe({data: fileBytes.slice(0), password}));
    }catch(e){
      out.innerHTML = "";
      errEl.hidden = false;
      errEl.textContent = (e && e.name === "PasswordException") ? t("toolUnlock.errIncorrectPassword") : t("toolUnlock.errCouldNotOpen");
      return;
    }
    try{
      let outBytes = null;
      // Fast paths: the exact schemes pdf-crypto.js fully understands
      // are decrypted in place, keeping every page fully vector/text.
      // The R=2 path first (this app's legacy output), then the V=5
      // AES-256 path (this app's default output, and other producers'
      // R=5/R=6 files) - both verified by re-opening with no password.
      const fast = tryDecryptSimplePdfBytes(fileBytes, password);
      if(fast && fast.bytes){
        try{
          operation.track(await loadPdfJsSafe({data: fast.bytes.slice(0)})); // self-check: must now open with NO password
          outBytes = fast.bytes;
        }catch(e){ outBytes = null; } // fall through to the AES path, then flatten
      }
      if(!outBytes){
        const aesFast = await tryDecryptAesPdfBytes(fileBytes, password);
        if(aesFast && aesFast.bytes){
          try{
            operation.track(await loadPdfJsSafe({data: aesFast.bytes.slice(0)})); // self-check: must now open with NO password
            outBytes = aesFast.bytes;
          }catch(e){ outBytes = null; }
        }
      }
      const flattened = !outBytes;
      if(flattened && !flattenConsent){
        // Flattening destroys the text layer. That tradeoff must be
        // the user's explicit choice, made BEFORE any page is
        // rasterised - not a surprise in the done message afterwards.
        // Continue re-runs this same handler with consent recorded;
        // Cancel just clears the prompt.
        out.innerHTML = "";
        const consentBox = document.createElement("div");
        consentBox.className = "status";
        consentBox.style.color = "var(--rose)";
        consentBox.textContent = t("toolUnlock.flattenConsentText");
        const row = document.createElement("div");
        row.className = "row";
        row.style.marginTop = "10px";
        const continueBtn = document.createElement("button");
        continueBtn.type = "button";
        continueBtn.className = "btn btn-sm";
        continueBtn.textContent = t("toolUnlock.flattenConsentContinue");
        continueBtn.addEventListener("click", ()=>{ flattenConsent = true; goBtn.click(); });
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "btn secondary btn-sm";
        cancelBtn.textContent = t("toolUnlock.flattenConsentCancel");
        cancelBtn.addEventListener("click", ()=>{ out.innerHTML = ""; });
        row.appendChild(continueBtn);
        row.appendChild(cancelBtn);
        consentBox.appendChild(row);
        out.appendChild(consentBox);
        return;
      }
      if(flattened){
        setStatus(t("toolUnlock.statusRenderingPages"));
        outBytes = await flattenPdocToPdfBytes(pdoc, (p,total)=>setStatus(t("toolUnlock.statusRenderingPages"), false, Math.round((p/total)*100)));
      }
      setStatus(T("workspace.statusPreparingDownload"));
      const blob = new Blob([outBytes], {type:"application/pdf"});
      const outName = suffixedName(file, "unlocked", "pdf");
      if(!operation.isCurrent()) return;
      const {url} = downloadBlob(blob, outName);
      const {canvas} = await pdfThumb(outBytes);
      setStatus(flattened ? t("toolUnlock.doneFlattened") : t("workspace.done"), true);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolUnlock.errCouldNotUnlock", {msg: escapeAttr(e.message)})}</div>`;
    }
  }));
};

/* ---- REPAIR PDF (recover a malformed/corrupt file) ---- */
TOOLS.repair = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let files=[];
  // Filled only when a file turns out to be password-protected: the
  // password field appears, and the next Go click retries with it.
  let repairPassword = "";
  openPanel(`
    <div class="panel-head"><h3>${t("tools.repair")}</h3></div>
    <div class="panel-body compact tool-workspace" id="repairBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.repair")}</h2>
        <p class="tool-hero-desc">${t("toolRepair.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", true, t("workspace.selectPdfFiles"))}
      </div>
      <div class="tool-content-area" id="repairPwField" style="display:none">
        <div class="field"><label for="repairPw">${t("toolRepair.passwordLabel")}</label><input type="password" id="repairPw" autocomplete="current-password"></div>
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFile")}</p>
      <div class="tool-toolbar" id="repairToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("tools.repair")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    files = fs.filter(f=>f.type==="application/pdf" || f.name.endsWith(".pdf"));
    renderFileList(files, (i)=>{
      files.splice(i, 1);
      if(!files.length){ document.getElementById("repairToolbar").style.display="none"; document.getElementById("repairBody").classList.remove("is-loaded"); }
    });
    document.getElementById("repairToolbar").style.display="flex";
    document.getElementById("repairBody").classList.add("is-loaded");
  });
  /** Renders one pdf.js page to a JPEG and embeds it in `doc` - the
   * shared "recover this page as an image" step for both salvage levels
   * below (same scale/quality flattenPdocToPdfBytes above already uses). */
  async function renderPageAsJpg(doc, pdoc, pageNum){
    const canvas = await renderPdfPageCanvas(pdoc, pageNum, 2);
    const blob = await new Promise(res=>canvas.toBlob(res, "image/jpeg", 0.92));
    if(!blob) throw new Error("render failed");
    const imgBytes = new Uint8Array(await blob.arrayBuffer());
    const img = await doc.embedJpg(imgBytes);
    return {img, width: canvas.width, height: canvas.height};
  }
  /**
   * Repairs one file's bytes. Returns null when nothing could be
   * recovered, or {outBytes, kind, raster, total, skipped}:
   * - "full": whole-document rebuild, every page kept as text/vectors.
   * - "partial": page-by-page salvage - pages that still parse are
   *   copied as vectors, only damaged pages become images, pages that
   *   neither parse nor render are skipped (and counted, honestly).
   * - "flattened": every recoverable page rendered as an image.
   * Throws an error with `.passwordNeeded` when pdf.js reports the
   * file is password-protected, so the caller can prompt for the
   * password instead of calling the file unrepairable.
   */
  async function repairOne(bytes, password, operation, onProgress){
    // pdf-lib's own tolerant parser, kept across the levels below: a
    // document that LOADS but won't re-save cleanly is exactly what
    // per-page salvage can still recover from.
    let srcDoc = null;
    try{
      srcDoc = await loadPdfSafe(bytes, {
        ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false,
      });
    }catch(e){ srcDoc = null; }
    // Level 1: a plain re-save already fixes a large class of real-world
    // damage (a broken/stale xref table, dangling references pdf-lib's
    // loader recovers from) since it rebuilds the whole file structure
    // from the parsed object graph rather than patching bytes in place.
    if(srcDoc){
      try{
        const rebuilt = await srcDoc.save();
        operation.track(await loadPdfJsSafe({data: rebuilt.slice(0)})); // self-check: must actually open
        return {outBytes: rebuilt, kind:"full", raster:0, total: srcDoc.getPageCount(), skipped:0};
      }catch(e){ /* fall through to per-page salvage */ }
    }
    // pdf.js is often more forgiving than pdf-lib about damaged xref
    // tables, and supplies the render fallback for both levels below.
    let pdoc;
    try{
      const params = {data: bytes.slice(0), stopAtErrors:false};
      if(password) params.password = password;
      pdoc = operation.track(await loadPdfJsSafe(params));
    }catch(e){
      if(e && e.name === "PasswordException"){
        const err = new Error("password-protected");
        err.passwordNeeded = true;
        throw err;
      }
      return null;
    }
    const total = pdoc.numPages;
    if(total < 1) return null;
    // Level 1.5: salvage page by page. A single bad page used to force
    // the WHOLE document to images; now only the pages that fail both
    // a vector copy and a render become images (or are skipped).
    if(srcDoc){
      try{
        setStatus(t("toolRepair.statusSalvagingPages"));
        const out = await PDFDocument.create();
        let raster = 0, skipped = 0;
        for(let i=0;i<total;i++){
          let copied = false;
          try{
            const [cp] = await out.copyPages(srcDoc, [i]);
            out.addPage(cp);
            copied = true;
          }catch(e){ copied = false; }
          if(!copied){
            try{
              const {img, width, height} = await renderPageAsJpg(out, pdoc, i+1);
              const pg = out.addPage([width, height]);
              pg.drawImage(img, {x:0, y:0, width, height});
              raster++;
            }catch(e){ skipped++; }
          }
          if(onProgress) onProgress(i+1, total);
        }
        if(out.getPageCount() > 0){
          const rebuilt = await out.save();
          const check = operation.track(await loadPdfJsSafe({data: rebuilt.slice(0)}));
          if(check.numPages === out.getPageCount()){
            return {outBytes: rebuilt, kind:(raster>0 || skipped>0) ? "partial" : "full", raster, total, skipped};
          }
        }
      }catch(e){ /* fall through to full visual recovery */ }
    }
    // Level 2: recover every page that still renders as a flattened,
    // image-based PDF rather than giving up - an honest "recovered,
    // but no longer editable text" result beats no result at all.
    // Pages that won't even render are skipped and counted.
    try{
      setStatus(t("toolRepair.statusTryingVisualRecovery"));
      const out = await PDFDocument.create();
      let rendered = 0, skipped = 0;
      for(let i=1;i<=total;i++){
        try{
          const {img, width, height} = await renderPageAsJpg(out, pdoc, i);
          const pg = out.addPage([width, height]);
          pg.drawImage(img, {x:0, y:0, width, height});
          rendered++;
        }catch(e){ skipped++; }
        if(onProgress) onProgress(i, total);
      }
      if(rendered === 0) return null;
      const rebuilt = await out.save();
      operation.track(await loadPdfJsSafe({data: rebuilt.slice(0)}));
      return {outBytes: rebuilt, kind:"flattened", raster: rendered, total, skipped};
    }catch(e){ return null; }
  }
  function repairStatusText(r){
    if(r.kind === "full") return t("workspace.done");
    if(r.kind === "partial" && r.skipped > 0) return t("toolRepair.donePartialSkipped", {raster: r.raster, total: r.total, skipped: r.skipped});
    if(r.kind === "partial") return t("toolRepair.donePartial", {raster: r.raster, total: r.total});
    if(r.skipped > 0) return t("toolRepair.donePartialSkipped", {raster: r.raster, total: r.total, skipped: r.skipped});
    return t("toolRepair.doneFlattened");
  }
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolRepair.statusAnalyzing"));
    // Same rapid-file-replacement/double-click guard as Protect PDF above.
    goBtn.disabled = true;
    try {
      repairPassword = document.getElementById("repairPw").value || "";
      const results = [];
      let needsPassword = false;
      for(let i=0;i<files.length;i++){
        const f = files[i];
        setStatus(t("toolRepair.statusAnalyzing"), false, files.length>1 ? Math.round((i/files.length)*100) : 0);
        const bytes = await f.arrayBuffer();
        let result = null;
        try{
          result = await repairOne(bytes, repairPassword, operation, (p,total)=>setStatus(t("toolRepair.statusRecoveringPages"), false, Math.round((p/total)*100)));
        }catch(e){
          if(e && e.passwordNeeded) needsPassword = true;
          result = null;
        }
        results.push({file: f, result});
      }
      if(needsPassword && !repairPassword){
        // Encrypted AND damaged: ask for the password and retry, rather
        // than misreporting the file as too damaged to repair.
        document.getElementById("repairPwField").style.display = "block";
        out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolRepair.statusPasswordNeeded")}</div>`;
        document.getElementById("repairPw").focus();
        return;
      }
      const succeeded = results.filter(r=>r.result);
      if(succeeded.length === 0){
        out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolRepair.errTooDamaged")}</div>`;
        return;
      }
      setStatus(T("workspace.statusPreparingDownload"));
      if(results.length === 1){
        const {file, result} = succeeded[0];
        const blob = new Blob([result.outBytes], {type:"application/pdf"});
        const outName = suffixedName(file, "repaired", "pdf");
        if(!operation.isCurrent()) return;
        const {url} = downloadBlob(blob, outName);
        const {canvas} = await pdfThumb(result.outBytes);
        setStatus(repairStatusText(result), true);
        if(!operation.isCurrent()) return;
        out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
      } else {
        // Batch: one ZIP, same pattern as Compress PDF's batch path,
        // with a per-file outcome list so a failed file is named, not
        // silently dropped from the zip.
        await ensureJSZip();
        const zip = new JSZip();
        const lines = [];
        for(const {file, result} of results){
          if(result){
            zip.file(suffixedName(file, "repaired", "pdf"), result.outBytes);
            lines.push(`<div class="compress-batch-row"><span class="compress-batch-name" title="${escapeAttr(file.name)}">${escapeAttr(file.name)}</span><span class="compress-batch-sizes mono">${escapeAttr(repairStatusText(result))}</span></div>`);
          } else {
            lines.push(`<div class="compress-batch-row"><span class="compress-batch-name" title="${escapeAttr(file.name)}">${escapeAttr(file.name)}</span><span class="compress-batch-sizes mono">${escapeAttr(t("toolRepair.errTooDamaged"))}</span></div>`);
          }
        }
        const zipBlob = await zip.generateAsync({type:"blob"});
        const outName = "repaired_pdfs.zip";
        if(!operation.isCurrent()) return;
        const {url} = downloadBlob(zipBlob, outName);
        setStatus(t("toolRepair.doneBatch", {count: succeeded.length}), true);
        if(!operation.isCurrent()) return;
        const box = resultBox({sizeText:fmtSize(zipBlob.size), sizeGood:true, url, filename:outName});
        const breakdown = document.createElement("div");
        breakdown.className = "compress-batch-breakdown";
        breakdown.innerHTML = lines.join("");
        const dlLink = box.querySelector(".dl-link");
        if(dlLink) box.insertBefore(breakdown, dlLink); else box.appendChild(breakdown);
        out.appendChild(box);
      }
    } finally {
      goBtn.disabled = false;
    }
  }));
};
