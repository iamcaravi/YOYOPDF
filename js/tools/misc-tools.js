/* ================= TOOL IMPLEMENTATIONS ================= */
const TOOLS = {};

/* ---- ABOUT ----
   Premium page redesign (hero + 3 feature cards + principle strip + CTA),
   built from the same tokens/primitives the homepage's own premium
   sections already use (.section-eyebrow, .feature-card/.ficon,
   .cta-card, --ochre/--brand-shadow-rgb) - see the "PREMIUM CONTENT
   PAGES" block in css/site.css. Renders inside the existing openPanel()
   shell, unchanged; no new modal/routing mechanism. */
TOOLS.about = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  openPanel(`
    <div class="panel-head"><h3>${t("footer.aboutFull")}</h3><div class="panel-head-actions"><button class="panel-close" aria-label="${t("workspace.closePanel")}">✕</button></div></div>
    <div class="panel-body compact">
      <div class="content-page">
        <div class="about-hero-v2">
          <div class="about-orbit" aria-hidden="true">
            <div class="ao-spin-group">
              <div class="ao-ring ao-ring-outer"></div>
              <div class="ao-ring ao-ring-inner"></div>
              <div class="ao-node" style="top:8%;left:50%;--ao-color:#f97316;--ao-bg:rgba(249,115,22,0.14)"><span class="ao-node-icon">${iconFor("organize")}</span></div>
              <div class="ao-node" style="top:20.3%;left:79.7%;--ao-color:#3b82f6;--ao-bg:rgba(59,130,246,0.14)"><span class="ao-node-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2L3 14h7v8l10-12h-7z"/></svg></span></div>
              <div class="ao-node" style="top:50%;left:92%;--ao-color:#a855f7;--ao-bg:rgba(168,85,247,0.14)"><span class="ao-node-icon">${iconFor("sign")}</span></div>
              <div class="ao-node" style="top:79.7%;left:79.7%;--ao-color:#f97316;--ao-bg:rgba(249,115,22,0.14)"><span class="ao-node-icon">${iconFor("imgconvert")}</span></div>
              <div class="ao-node" style="top:92%;left:50%;--ao-color:#14b8a6;--ao-bg:rgba(20,184,166,0.14)"><span class="ao-node-icon">${iconFor("pdf2word")}</span></div>
              <div class="ao-node" style="top:79.7%;left:20.3%;--ao-color:#ef4444;--ao-bg:rgba(239,68,68,0.14)"><span class="ao-node-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/></svg></span></div>
              <div class="ao-node" style="top:50%;left:8%;--ao-color:#f97316;--ao-bg:rgba(249,115,22,0.14)"><span class="ao-node-icon">${iconFor("rotate")}</span></div>
              <div class="ao-node" style="top:20.3%;left:20.3%;--ao-color:#22c55e;--ao-bg:rgba(34,197,94,0.14)"><span class="ao-node-icon">${iconFor("protect")}</span></div>
            </div>
            <div class="ao-doc">
              <svg viewBox="0 0 100 130" xmlns="http://www.w3.org/2000/svg">
                <rect x="4" y="4" width="92" height="122" rx="8" fill="rgba(var(--brand-shadow-rgb),0.05)" stroke="var(--red)" stroke-width="2"/>
                <path d="M68 4v22h22z" fill="none" stroke="var(--red)" stroke-width="2" stroke-linejoin="round"/>
                <path d="M20 46h44M20 60h44M20 74h30M20 88h44M20 102h20" stroke="rgba(var(--brand-shadow-rgb),0.6)" stroke-width="2.5" stroke-linecap="round"/>
              </svg>
            </div>
          </div>
          <div class="about-hero-copy">
            <span class="section-eyebrow">${t("about.eyebrow")}</span>
            <h1>${t("about.headingLine1")} <span class="accent">${t("about.headingAccent1")}</span><br>${t("about.headingLine2")} <span class="accent">${t("about.headingAccent2")}</span></h1>
            <p>${t("about.paragraph")}</p>
            <div class="about-inline-features">
              <div class="aif">
                <div class="aif-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg></div>
                <h4>${t("about.feature1Title")}</h4>
                <p>${t("about.feature1Desc")}</p>
              </div>
              <div class="aif">
                <div class="aif-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h7v8l10-12h-7z"/></svg></div>
                <h4>${t("about.feature2Title")}</h4>
                <p>${t("about.feature2Desc")}</p>
              </div>
              <div class="aif">
                <div class="aif-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg></div>
                <h4>${t("about.feature3Title")}</h4>
                <p>${t("about.feature3Desc")}</p>
              </div>
              <div class="aif">
                <div class="aif-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-4.35-9.5-9C.85 8.5 2 5 5.5 5c2 0 3.5 1.3 4.5 2.8C11 6.3 12.5 5 14.5 5 18 5 19.15 8.5 17.5 12 15 16.65 12 21 12 21z"/></svg></div>
                <h4>${t("about.feature4Title")}</h4>
                <p>${t("about.feature4Desc")}</p>
              </div>
            </div>
          </div>
        </div>

        <div class="about-stats">
          <!-- Every figure below is directly verifiable from the current implementation
               (no server upload code exists anywhere in the project; the site ships 10
               language dictionaries in js/core/i18n.js) - no user/file/popularity counts,
               since those can't actually be measured or substantiated. -->
          <div class="a-stat"><span class="a-stat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2L3 14h7v8l10-12h-7z"/></svg></span><div><strong>0 sec</strong><small>${t("about.statUpload")}</small></div></div>
          <div class="a-stat"><span class="a-stat-ico">${iconFor("protect")}</span><div><strong>${t("about.statPrivateValue")}</strong><small>${t("about.statPrivate")}</small></div></div>
          <div class="a-stat"><span class="a-stat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg></span><div><strong>${t("about.statFreeValue")}</strong><small>${t("about.statFree")}</small></div></div>
          <div class="a-stat"><span class="a-stat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 6 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-6-3.8-9s1.3-6.5 3.8-9z"/></svg></span><div><strong>10</strong><small>${t("about.statLanguages")}</small></div></div>
          <!-- Filled by js/core/ratings.js's mountAboutStatRating() below,
               with the same live overall tool rating the homepage strip
               shows (one shared fetch, see ratingFetchAllShared()) - never
               hardcoded. Empty a-stat markup is harmless if that never runs. -->
          <div class="a-stat" id="aboutRatingStat"></div>
        </div>

        <div class="about-why-box">
          <h2>${t("about.whyHeading")}</h2>
          <div class="why-grid">
            <div class="why-card">
              <div class="why-icon">${iconFor("protect")}</div>
              <h4>${t("about.why1Title")}</h4>
              <p>${t("about.why1Desc")}</p>
            </div>
            <div class="why-card">
              <div class="why-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2L3 14h7v8l10-12h-7z"/></svg></div>
              <h4>${t("about.why2Title")}</h4>
              <p>${t("about.why2Desc")}</p>
            </div>
            <div class="why-card">
              <div class="why-icon">${iconFor("organize")}</div>
              <h4>${t("about.why3Title")}</h4>
              <p>${t("about.why3Desc")}</p>
            </div>
            <div class="why-card">
              <div class="why-icon">${iconFor("rotate")}</div>
              <h4>${t("about.why4Title")}</h4>
              <p>${t("about.why4Desc")}</p>
            </div>
            <div class="why-card">
              <div class="why-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-7-4.35-9.5-9C.85 8.5 2 5 5.5 5c2 0 3.5 1.3 4.5 2.8C11 6.3 12.5 5 14.5 5 18 5 19.15 8.5 17.5 12 15 16.65 12 21 12 21z"/></svg></div>
              <h4>${t("about.why5Title")}</h4>
              <p>${t("about.why5Desc")}</p>
            </div>
          </div>
        </div>

        <div class="cta-section" style="padding:0; margin-top:0;">
          <div class="cta-card">
            <div class="cta-copy">
              <h2>${t("about.ctaHeading")} <span class="accent">${t("about.ctaAccent")}</span></h2>
              <p>${t("about.ctaText")}</p>
              <div class="cta-actions">
                <button type="button" class="btn-cta-primary" id="aboutExploreBtn">${t("about.ctaPrimary")}</button>
                <button type="button" class="btn-cta-secondary" data-open="contact">${t("about.ctaSecondary")}</button>
              </div>
            </div>
            <div class="cta-art" aria-hidden="true">
              <svg viewBox="0 0 220 160" xmlns="http://www.w3.org/2000/svg">
                <circle cx="34" cy="26" r="3" fill="var(--ochre)" opacity="0.5"/>
                <circle cx="190" cy="138" r="2.5" fill="var(--ochre)" opacity="0.4"/>
                <circle cx="18" cy="128" r="2" fill="var(--ochre)" opacity="0.35"/>
                <rect x="10" y="14" width="80" height="104" rx="8" fill="#fff" stroke="var(--line)" stroke-width="2"/>
                <rect x="130" y="14" width="80" height="104" rx="8" fill="#fff" stroke="var(--line)" stroke-width="2"/>
                <rect x="66" y="4" width="88" height="132" rx="10" fill="#fff" stroke="var(--line)" stroke-width="2"/>
              </svg>
            </div>
          </div>
        </div>
      </div>
      ${contentPageTailHTML()}
    </div>`);
  document.getElementById("aboutExploreBtn")?.addEventListener("click", ()=>goHome());
  bindContentPageTail(panel);
  if(typeof mountAboutStatRating === "function") mountAboutStatRating(document.getElementById("aboutRatingStat"));
};

/* ---- EDIT ----------------------------------------------------------------
   Priority 3 (small milestone): mounts the existing editor shell — built
   and QA'd in editor-preview.html, files unchanged here — inside the live
   TOOLS.edit panel. Reuses, unmodified:
     js/editor/render-engine.js, render-queue.js, page-cache.js,
     zoom-manager.js, loading-manager.js, viewport-manager.js,
     thumbnail-engine.js, navigation-manager.js  (Rendering Engine,
       already integrated as of Priority 2)
     js/editor/editor-layout.js, editor-sidebar.js, editor-toolbar.js,
     editor-canvas.js, editor-inspector.js, editor-statusbar.js  (Shell —
       new to this milestone)
     css/editor-workspace.css, css/pdf-viewer.css  (Shell CSS — new to
       this milestone, loaded as-is)
   The shell markup below is copied verbatim from editor-preview.html's
   `.editor-shell` block (minus that file's own demo-only harness bar).
   The init sequence below is copied verbatim from editor-preview.html's
   own inline script. No shell module's logic is changed by any of this.

   The shell is built ONCE and kept alive in a detached holding element
   between opens (see editorHoldingArea / closePanel()) rather than
   rebuilt every time the panel opens — several shell modules register
   window-level listeners (NavigationManager's keydown handler,
   EditorLayout's resize handler) with no corresponding teardown, so
   re-running their init() on every open would silently stack duplicate
   listeners. Reusing the same instance keeps exactly one of each,
   satisfying "close/reopen works correctly" without touching those
   modules to add destroy() methods they don't currently have. */
let editorAssetsLoadPromise = null;
function loadEditorAssets(){
  if (editorAssetsLoadPromise) return editorAssetsLoadPromise;

  // ?v=2: same stale-cache issue js/app.js hit earlier (browsers keep
  // serving an old cached copy of an unversioned <link>/<script> src
  // indefinitely, even across page loads, once one visit has cached it) -
  // these editor assets had no cache-busting param at all, so an
  // edit to any of them (like the --font-body fix below) would silently
  // never reach a browser that had already visited once.
  //
  // Each stylesheet's load/error is tracked (unlike before, where these
  // were pure fire-and-forget) and folded into editorAssetsLoadPromise
  // below alongside the script chain, so a caller awaiting this function
  // is guaranteed the real CSS has applied (or definitively failed) by
  // the time it resolves - not just that the JS has run. Layout reads
  // like ZoomManager's canvasEl.getBoundingClientRect() depend on
  // css/editor-workspace.css's flex rules; measuring before this promise
  // settles could otherwise read the browser's unstyled default box
  // instead. A failed stylesheet resolves (doesn't reject) its own
  // promise - one broken/blocked CSS file shouldn't hang the whole
  // editor open - but is reported via console.warn so it's not silent.
  const cssLoadPromises = ["css/editor-workspace.css", "css/pdf-viewer.css", "css/editor-panel.css", "css/editor-inspector.css", "css/editor-viewer-polish.css", "css/editor-objects.css", "css/editor-product.css"].map(href=>{
    const l = document.createElement("link");
    l.rel = "stylesheet";
    // css/editor-objects.css alone was edited (touch-action rules for
    // pointer-based drag/resize), so only it is bumped to v=21 - a browser
    // that cached the old copy under v=20 would otherwise never fetch it.
    const fullHref = href + (href === "css/editor-objects.css" ? "?v=21" : "?v=20");
    const p = new Promise(resolve=>{
      l.onload = () => resolve();
      l.onerror = () => { console.warn("Editor stylesheet failed to load: " + fullHref); resolve(); };
    });
    l.href = fullHref;
    document.head.appendChild(l);
    return p;
  });

  const files = [
    // Rendering Engine (Priority 2 — unchanged)
    "js/editor/render-engine.js",
    "js/editor/render-queue.js",
    "js/editor/page-cache.js",
    "js/editor/zoom-manager.js",
    "js/editor/loading-manager.js",
    "js/editor/viewport-manager.js",
    "js/editor/thumbnail-engine.js",
    "js/editor/navigation-manager.js",
    // Shell (this milestone)
    "js/editor/editor-layout.js",
    "js/editor/editor-sidebar.js",
    "js/editor/editor-toolbar.js",
    "js/editor/editor-canvas.js",
    "js/editor/editor-inspector.js",
    "js/editor/editor-statusbar.js",
    // Editing engine (Phase 3 — previously referenced everywhere by name
    // but never actually written; see editor-objects.js's own file header)
    "js/editor/editor-text-layout.js",
    "js/editor/editor-objects.js",
    "js/editor/editor-content.js",
    "js/editor/editor-history.js",
    "js/editor/editor-commands.js",
    "js/editor/editor-export.js",
  ];
  const jsLoadPromise = files.reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
    const s = document.createElement("script");
    // v=21: editor-canvas.js's initial-render race fix (see loadFile()) -
    // bumped from v=20 so a browser that already cached these lazy-loaded
    // editor scripts under the old query string actually fetches the fix
    // instead of continuing to run the stale, pre-fix file indefinitely.
    // CSS above is untouched by this fix and stays at v=20.
    s.src = src + "?v=21";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  })), Promise.resolve());
  // A script failure still rejects (unchanged - editor JS is required, so
  // this promise still propagates that failure to callers); CSS failures
  // never reject (see cssLoadPromises above), so this only ever waits
  // longer for CSS, never fails because of it.
  editorAssetsLoadPromise = Promise.all([jsLoadPromise, Promise.all(cssLoadPromises)]).then(() => undefined);
  return editorAssetsLoadPromise;
}

/* Builds the shell markup once — identical structure to editor-preview.html's
   `.editor-shell`, so every editor-*.js selector (`.editor-toolbar`,
   `.editor-sidebar`, `.editor-canvas`, `.editor-inspector`, `.editor-statusbar`,
   the two resize handles, the scrim) finds exactly what it already expects. */
function buildEditorShell(){
  const t = window.I18N ? I18N.t : (k)=>k;
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="editor-shell" data-state="empty">
      <div class="editor-toolbar" role="toolbar" aria-label="${t("editor.toolbarAriaLabel")}"></div>
      <div class="editor-pagebar" role="toolbar" aria-label="${t("editor.groupPage")} / ${t("editor.groupZoom")}"></div>
      <div class="editor-body">
        <aside class="editor-sidebar is-collapsed" aria-label="${t("editor.pageThumbnailList")}">
          <div class="editor-sidebar-head">
            <span class="editor-sidebar-head-title">${t("editor.pagesLabel")} (<span data-page-count>0</span>)</span>
            <button type="button" class="btn-icon" data-collapse-target=".editor-sidebar" aria-label="${t("editor.collapsePagePanel")}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
          <div class="editor-thumb-list" role="list" aria-label="${t("editor.pageThumbnailList")}"></div>
          <div class="editor-thumb-rail" aria-hidden="true"></div>
        </aside>
        <div class="editor-resize-handle" data-resize="sidebar"></div>
        <!-- Phase 12: was <main> - this app already has exactly one page-
             level main landmark (index.html's own #main-content, present
             on every route including this one, since edit-pdf.html is
             generated from that same template). A second <main> here made
             every route with the editor open fail axe's landmark-no-
             duplicate-main check. This region is still identified via its
             own aria-label; only the redundant landmark role changes. -->
        <div class="editor-canvas" data-state="empty" role="region" aria-label="${t("editor.documentCanvas")}">
          <div class="editor-canvas-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false"><path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5" stroke-linejoin="round"/></svg>
            <div>${t("editor.emptyStateLine1")}<br>${t("editor.emptyStateLine2")}</div>
            <div class="editor-canvas-empty-error" data-canvas-empty-error role="alert" hidden></div>
          </div>
          <div class="editor-canvas-loading">
            <span class="spinner" aria-hidden="true"></span>
            <div>${t("editor.loadingDocument")}</div>
          </div>
          <div class="editor-canvas-page" role="img" aria-label="${t("editor.placeholderPage")}"></div>
        </div>
        <div class="editor-resize-handle" data-resize="inspector"></div>
        <aside class="editor-inspector is-collapsed" aria-label="${t("editor.inspectorAriaLabel")}">
          <button type="button" class="btn-icon editor-inspector-close" data-collapse-target=".editor-inspector" aria-label="Close properties panel">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>
          </button>
        </aside>
        <div class="editor-scrim"></div>
      </div>
      <div class="editor-statusbar" role="status" aria-label="${t("editor.documentStatus")}">
        <span class="editor-statusbar-item" data-status="zoom">${t("editor.statusZoom",{pct:100})}</span>
        <span class="editor-statusbar-item" data-status="page">${t("editor.statusNoDocument")}</span>
        <span class="editor-statusbar-item" data-status="size" data-optional="true">${t("editor.statusNoDocument")}</span>
        <span class="editor-statusbar-item" data-status="selection" data-optional="true">${t("editor.statusNoSelection")}</span>
        <span class="editor-statusbar-spacer"></span>
        <span class="editor-statusbar-item editor-statusbar-ready"><span class="editor-statusbar-dot" aria-hidden="true"></span>${t("editor.ready")}</span>
      </div>
    </div>`;
  return wrap.firstElementChild;
}

/* Same init sequence as editor-preview.html's own harness script — every
   call below is that file's, unchanged; only the DOM root differs. */
function initEditorShell(shell){
  const canvasEl = shell.querySelector('.editor-canvas');

  ZoomManager.init(
    () => {
      const r = canvasEl.getBoundingClientRect();
      const style = getComputedStyle(canvasEl);
      return {
        width: Math.max(1, r.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
        height: Math.max(1, r.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
      };
    },
    () => window.__currentPageNativeSize || { width: 612, height: 792 }
  );
  ViewportManager.init(shell);
  LoadingManager.init(shell);
  // EditorObjects before NavigationManager: both register a `window`
  // keydown listener for Escape, and listeners on the same target fire
  // in registration order. EditorObjects needs to see Escape first so it
  // can stopPropagation() when it cancels a pending object placement -
  // otherwise NavigationManager's own (correct, by design) "Escape closes
  // the whole workspace" handler fires first and closes the editor out
  // from under an in-progress placement instead of just canceling it.
  EditorObjects.init(shell);
  EditorContent.init(shell);
  EditorCommands.init(shell);
  NavigationManager.init(shell, { getPageCount: () => window.RenderEngine.getNumPages() });

  EditorToolbar.init(shell);
  EditorInspector.init(shell);
  EditorCanvas.init(shell);
  EditorStatusbar.init(shell);
  EditorLayout.init(shell);
  EditorHistory.init();
  EditorExport.init();

  window.addEventListener('editor:pageChange', async (e) => {
    try {
      window.__currentPageNativeSize = await window.RenderEngine.getPageInfo(e.detail.page);
      window.ZoomManager?.refit();
    } catch (_) {}
  });

  // Not part of the reused shell modules — this milestone's own, minimal
  // addition, since the shell is normally hosted full-page with no host
  // chrome around it and has no close action of its own here. The YOYOPDF
  // logo in the header is the only "go home" affordance across the whole
  // app now, so this only needs its own close action, not a second home
  // button.
  const t = window.I18N ? I18N.t : (k)=>k;
  const toolbar = shell.querySelector('.editor-toolbar');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'editor-toolbar-close';
  closeBtn.setAttribute('aria-label', t('editor.closeEditor'));
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', ()=>closePanel());
  toolbar.appendChild(closeBtn);

  // Priority 3G: navigation-manager.js dispatches this on Escape (when no
  // mobile sidebar/inspector overlay is open) — same event-bus pattern as
  // 'editor:requestPanelToggle' already used elsewhere in this shell.
  // initEditorShell() only runs once (see the `!window.__editorShellEl`
  // guard in TOOLS.edit below), so this listener is registered exactly
  // once too — never stacks a duplicate on subsequent opens.
  window.addEventListener('editor:requestClose', closePanel);
}

let editEntryGeneration = 0;

function ensureEditorShell(){
  if (!window.__editorShellEl){
    window.__editorShellEl = buildEditorShell();
    initEditorShell(window.__editorShellEl);
  }
  return window.__editorShellEl;
}

function attachPreparedEditor(){
  openPanel(`<div class="panel-body" id="editWorkspaceMount"></div>`);
  panel.classList.add("panel-fullscreen");
  overlay.classList.add("panel-fullscreen");
  document.getElementById("editWorkspaceMount").appendChild(window.__editorShellEl);
  window.ThumbnailEngine?.init(window.__editorShellEl, window.RenderEngine.getNumPages());
}

async function prepareEditFile(file, generation){
  const body = document.getElementById("editUploadBody");
  const out = document.getElementById("editUploadOut");
  const dropzone = document.getElementById("dz");
  if(!body || !out || !dropzone) return;

  AppSession.clear();
  body.classList.add("is-loaded");
  dropzone.setAttribute("aria-busy", "true");
  renderFileList([file], ()=>{});
  out.innerHTML = statusEl(T("workspace.statusReadingPdf"));
  let editorAttached = false;

  try{
    await loadEditorAssets();
    if(generation !== editEntryGeneration) return;
    const shell = ensureEditorShell();
    window.EditorCanvas.setState("loading");
    const { numPages } = await window.RenderEngine.loadDocument(file);
    if(generation !== editEntryGeneration) return;

    window.EditorObjects.restoreState([]);
    shell.querySelector(".editor-sidebar")?.classList.add("is-collapsed");
    shell.querySelector(".editor-inspector")?.classList.add("is-collapsed");
    // Attach before mounting pages so the editor's initial fit runs before
    // any page canvas starts rendering. Mounting while detached and then
    // attaching can make that fit restart an in-flight render on one canvas.
    attachPreparedEditor();
    editorAttached = true;
    // Root cause of the "wrong initial render, fixed only by clicking
    // Zoom" production bug: mountDocument() below immediately starts an
    // IntersectionObserver that renders in-view pages at whatever scale
    // ZoomManager currently holds (a leftover/default scale) — the real
    // initial-fit calculation only ran afterward, async, via the
    // pageChange event mountDocument() itself dispatches (see
    // editor-layout.js's setupAdaptiveFit, deferred one more tick via
    // setTimeout(0)). On a slow network that gap is wide enough for the
    // wrong-scale render to win the race and stick on screen until the
    // user manually reopens Zoom, which forces one more, uncontested
    // rerenderAtCurrentScale(). Computing the correct scale here, before
    // mountDocument() ever mounts a wrapper or fires the observer, makes
    // the very first render already correct — same getPageInfo()+
    // initialReadable() calls the pageChange listener a few lines below
    // already uses for later page navigation, just sequenced earlier for
    // page 1's initial open.
    try { window.__currentPageNativeSize = await window.RenderEngine.getPageInfo(1); } catch (_) { /* fall back to ZoomManager's existing default */ }
    if(generation !== editEntryGeneration) return;
    window.ZoomManager?.initialReadable();
    await window.ViewportManager.mountDocument(numPages);
    if(generation !== editEntryGeneration) return;
    window.EditorSidebar.init(shell, { pageCount:numPages });
    window.EditorCanvas.setState("page");
    AppSession.set([file], "edit-upload");
    if(location.hash !== "#editor"){
      history.pushState({ editStage:"editor" }, "", location.pathname + "#editor");
    }
  }catch(err){
    if(generation !== editEntryGeneration || err?.name === "AbortError") return;
    AppSession.clear();
    window.EditorCanvas?.setState("empty");
    const message = err?.message || T("workspace.thisFileCouldNotBeOpened");
    if(editorAttached) showEditUpload();
    const errorOut = document.getElementById("editUploadOut") || out;
    errorOut.innerHTML = `<div class="status" role="alert">${escapeAttr(message)}</div>`;
    document.getElementById("dz")?.removeAttribute("aria-busy");
    toast(message);
  }
}

function showEditUpload(){
  editEntryGeneration++;
  panel.classList.remove("panel-fullscreen");
  overlay.classList.remove("panel-fullscreen");
  openPanel(`
    <div class="panel-head"><h3>${T("tools.edit")}</h3></div>
    <div class="panel-body compact tool-workspace" id="editUploadBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${T("tools.edit")}</h2>
        <p class="tool-hero-desc">${T("toolDesc.edit")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, T("workspace.selectPdfFiles"))}
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div id="editUploadOut"></div>
    </div>`);
  wireDropzone(files=>{
    const generation = ++editEntryGeneration;
    return prepareEditFile(files[0], generation);
  });
}

TOOLS.edit = function(){
  if(location.hash === "#editor" && AppSession.currentFile && window.__editorShellEl &&
     window.RenderEngine?.getNumPages() > 0){
    attachPreparedEditor();
    return;
  }
  showEditUpload();
};

/* ---- DONATE ----
   Premium redesign - compact two-column hero + a single donation card
   with a decorative amount picker (visual/UX only: this site has no
   payment gateway, the actual transfer always happens by scanning the
   SAME UPI QR code below and entering the amount inside the user's own
   UPI app - selecting a pill here never changes which QR is shown or
   fires any network request, so "do not change existing functionality"
   holds exactly). qrSrc is read from the homepage's own hidden #donate
   section BEFORE openPanel() replaces #panel's contents - same lookup
   this function already used pre-redesign.

   DONATE_HEART_SVG is a small, self-contained decorative illustration
   (no external asset, nothing to fetch/break) - a glowing heart over a
   soft platform with a few sparkles, all drawn with the site's own
   theme-aware brand tokens (--brand-shadow-rgb/--red/--ochre) so it's
   automatically lime in dark mode and blue in light mode, matching
   every other brand-colored element on this page. Purely decorative
   (aria-hidden on its wrapper), so it never needs alt text or i18n. */
const DONATE_HEART_SVG = `<svg viewBox="0 0 220 190" width="100%" height="100%" role="presentation" focusable="false">
  <defs>
    <radialGradient id="donateHeartGlow" cx="50%" cy="38%" r="60%">
      <stop offset="0%" stop-color="var(--ochre)" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="var(--ochre)" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="donateHeartFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--ochre)" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="var(--ochre)" stop-opacity="0.55"/>
    </linearGradient>
    <radialGradient id="donatePlatformGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="var(--ochre)" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="var(--ochre)" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <ellipse cx="110" cy="150" rx="95" ry="34" fill="url(#donatePlatformGlow)"/>
  <ellipse cx="110" cy="150" rx="58" ry="12" fill="none" stroke="var(--ochre)" stroke-opacity="0.35" stroke-width="1.5"/>
  <circle cx="110" cy="88" r="70" fill="url(#donateHeartGlow)"/>
  <path d="M110 118S66 92 66 60c0-16 13-26 27-24 8 1 14 6 17 12 3-6 9-11 17-12 14-2 27 8 27 24 0 32-44 58-44 58z"
        fill="url(#donateHeartFill)" stroke="var(--ochre)" stroke-width="1.5" stroke-linejoin="round"/>
  <g fill="var(--ochre)">
    <circle cx="45" cy="40" r="2.4"/>
    <circle cx="176" cy="52" r="2"/>
    <circle cx="160" cy="24" r="1.6"/>
    <circle cx="34" cy="78" r="1.6"/>
    <path d="M188 96l2.6 5.4 5.4 2.6-5.4 2.6-2.6 5.4-2.6-5.4-5.4-2.6 5.4-2.6z" opacity="0.85"/>
    <path d="M30 108l2 4.2 4.2 2-4.2 2-2 4.2-2-4.2-4.2-2 4.2-2z" opacity="0.7"/>
  </g>
</svg>`;

TOOLS.donate = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  const qrSrc = document.querySelector(".donate-qr-wrap img")?.getAttribute("src") || "";
  // "YOYOPDF" is a proper noun kept literal in every locale's translation
  // (confirmed - every language's misc.donateHeroLine2 string already
  // contains the untranslated brand name), so a plain substring wrap is
  // safe here without needing a second, HTML-aware string per language.
  // Reuses the SAME .accent class/selector every other content-page hero
  // on this site already uses for its own emphasized word - not a new,
  // parallel accent system.
  const heroLine2Html = escapeAttr(t("misc.donateHeroLine2")).replace(/YOYOPDF/g, '<span class="accent">YOYOPDF</span>');
  const benefits = [
    { icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M3 12h18M12 8V5a2 2 0 114 0v3M8 5a2 2 0 114 0v3"/></svg>', title:"misc.donateBenefit1Title", desc:"misc.donateBenefit1Desc" },
    { icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6l7-3z"/></svg>', title:"misc.donateBenefit2Title", desc:"misc.donateBenefit2Desc" },
    { icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18 14 14 0 010-18z"/></svg>', title:"misc.donateBenefit3Title", desc:"misc.donateBenefit3Desc" },
    { icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8.5" cy="8" r="3"/><circle cx="16" cy="9" r="2.4"/><path d="M2.5 20c0-3.3 2.7-6 6-6s6 2.7 6 6M14.5 14.2c2.6.4 4.5 2.6 4.5 5.3"/></svg>', title:"misc.donateBenefit4Title", desc:"misc.donateBenefit4Desc" },
  ];
  openPanel(`
    <div class="panel-head"><h3>${t("misc.donateTitle")}</h3><div class="panel-head-actions"><button class="panel-close" aria-label="${t("workspace.closePanel")}">✕</button></div></div>
    <div class="panel-body compact">
      <div class="content-page donate-page">
        <div class="donate-hero-grid">
          <div class="donate-hero-copy">
            <svg class="donate-hero-mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20s-7-4.35-9.5-8.5C.5 8 2 4.5 5.5 4c2-.3 3.7.7 4.5 2 .8-1.3 2.5-2.3 4.5-2C18 4.5 19.5 8 17.5 11.5 15 15.65 12 20 12 20z"/></svg>
            <h1><span class="donate-hero-line">${t("misc.donateHeroLine1")}</span><span class="donate-hero-line">${heroLine2Html}</span></h1>
            <p>${t("misc.donateHeroDesc")}</p>
          </div>

          <div class="donate-card">
            <div class="donate-amount-grid" id="donateAmounts" role="group" aria-label="${t("misc.donateTitle")}">
              <button type="button" class="donate-amount-btn" data-amount="100" aria-pressed="false">₹100</button>
              <button type="button" class="donate-amount-btn" data-amount="250" aria-pressed="false">₹250</button>
              <button type="button" class="donate-amount-btn selected" data-amount="500" aria-pressed="true"><span class="donate-badge">${t("misc.donateRecommended")}</span>₹500</button>
              <button type="button" class="donate-amount-btn" data-amount="1000" aria-pressed="false">₹1,000</button>
              <div class="donate-amount-custom">
                <label for="donateCustomAmount" class="visually-hidden">${t("misc.donateCustomAmountPlaceholder")}</label>
                <input type="number" min="1" inputmode="numeric" id="donateCustomAmount" placeholder="${t("misc.donateCustomAmountPlaceholder")}">
              </div>
            </div>
            <button type="button" class="btn" id="donateSupportBtn"><svg class="donate-btn-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20s-7-4.35-9.5-8.5C.5 8 2 4.5 5.5 4c2-.3 3.7.7 4.5 2 .8-1.3 2.5-2.3 4.5-2C18 4.5 19.5 8 17.5 11.5 15 15.65 12 20 12 20z"/></svg>${t("misc.donateTitle")}</button>

            <p class="donate-payment-label">${t("misc.donatePaymentLabel")}</p>
            <div class="donate-qr-wrap donate-qr-wrap-lg">
              <img src="${qrSrc}" alt="${t("misc.donateQrAlt")}" class="donate-modal-qr donate-modal-qr-lg">
              <span>${t("misc.donateScanNote")}</span>
            </div>
            <div class="upi-logos">
              <span class="upi-badge"><span class="dot" style="background:#4285F4"></span>Google Pay</span>
              <span class="upi-badge"><span class="dot" style="background:#5F259F"></span>PhonePe</span>
              <span class="upi-badge"><span class="dot" style="background:#00BAF2"></span>Paytm</span>
              <span class="upi-badge"><span class="dot" style="background:var(--brand-grad)"></span>BHIM UPI</span>
            </div>
          </div>

          <div class="donate-hero-art" aria-hidden="true">${DONATE_HEART_SVG}</div>
        </div>

        <div class="donate-benefit-grid">
          ${benefits.map(b=>`<div class="donate-benefit-card">
            <div class="donate-benefit-icon">${b.icon}</div>
            <div><h3>${t(b.title)}</h3><p>${t(b.desc)}</p></div>
          </div>`).join("")}
        </div>

        <div class="donate-thankyou">
          <p class="donate-thankyou-title"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20s-7-4.35-9.5-8.5C.5 8 2 4.5 5.5 4c2-.3 3.7.7 4.5 2 .8-1.3 2.5-2.3 4.5-2C18 4.5 19.5 8 17.5 11.5 15 15.65 12 20 12 20z"/></svg>${t("misc.donateThankYouTitle")}</p>
          <p class="donate-thankyou-desc">${t("misc.donateThankYouDesc")}</p>
        </div>
      </div>
      ${contentPageTailHTML()}
    </div>`);
  bindContentPageTail(panel);

  const amountBtns = [...document.querySelectorAll(".donate-amount-btn")];
  const customInput = document.getElementById("donateCustomAmount");
  amountBtns.forEach(btn=>{
    btn.addEventListener("click", ()=>{
      amountBtns.forEach(b=>{ b.classList.remove("selected"); b.setAttribute("aria-pressed","false"); });
      btn.classList.add("selected");
      btn.setAttribute("aria-pressed","true");
      customInput.classList.remove("selected");
      customInput.value = "";
    });
  });
  customInput.addEventListener("input", ()=>{
    if(!customInput.value) return;
    amountBtns.forEach(b=>{ b.classList.remove("selected"); b.setAttribute("aria-pressed","false"); });
    customInput.classList.add("selected");
  });
  // The actual donation still only ever happens by scanning the QR code
  // below (no payment gateway on this static site) - this button doesn't
  // fire a transfer itself, it draws attention to the QR the same way a
  // "Support" CTA on a real product page would, without pretending to
  // process a payment client-side.
  document.getElementById("donateSupportBtn")?.addEventListener("click", ()=>{
    const qrWrap = document.querySelector(".donate-card .donate-qr-wrap");
    qrWrap?.scrollIntoView({behavior: MOTION.reduced ? "auto" : "smooth", block:"center"});
    qrWrap?.animate(
      [{boxShadow:"0 0 0 0 rgba(var(--brand-shadow-rgb),0)"},{boxShadow:"0 0 0 6px rgba(var(--brand-shadow-rgb),0.35)"},{boxShadow:"0 0 0 0 rgba(var(--brand-shadow-rgb),0)"}],
      {duration:900, easing:"ease-out"}
    );
  });
};

/* ---- DOCS ---- */
TOOLS.docs = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  openPanel(`
    <div class="panel-head"><h3>${t("misc.docsTitle")}</h3><div class="panel-head-actions"><button class="panel-close" aria-label="${t("workspace.closePanel")}">✕</button></div></div>
    <div class="panel-body">
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">${t("misc.docsP1")}</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">${t("misc.docsP2")}</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">${t("misc.docsP3Pre")} <button type="button" class="link-btn" data-open="contact" style="background:none;border:none;padding:0;color:var(--red);cursor:pointer;font:inherit;text-decoration:underline">${t("footer.contact")}</button> ${t("misc.docsP3Post")}</p>
    </div>`);
};

/* ---- Shared legal-page scroll-spy (Privacy + Terms) ----
   Highlights whichever .legal-content section is currently in view in
   the sticky .legal-nav - IntersectionObserver rather than a scroll
   listener, since .panel-body (not the window) is the actual scroll
   container here. Re-created per panel open/close (panel.innerHTML wipe
   on close already detaches the old observed elements, so there's
   nothing to explicitly tear down - matches this file's existing
   per-open wiring pattern for #go/click handlers elsewhere). */
function initLegalScrollSpy(scrollRoot, navSelector){
  const sections = [...document.querySelectorAll(".legal-content h2[id]")];
  const links = [...document.querySelectorAll(navSelector || ".legal-nav a")];
  if(!sections.length || !links.length) return;
  const linkFor = id => links.find(a=>a.getAttribute("href")===`#${id}`);
  const observer = new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      if(!entry.isIntersecting) return;
      links.forEach(a=>a.classList.remove("active"));
      linkFor(entry.target.id)?.classList.add("active");
    });
  }, {root: scrollRoot, rootMargin: "-10% 0px -70% 0px", threshold: 0});
  sections.forEach(s=>observer.observe(s));
  links[0]?.classList.add("active");
  links.forEach(a=>{
    a.addEventListener("click", e=>{
      e.preventDefault();
      document.getElementById(a.getAttribute("href").slice(1))?.scrollIntoView({behavior: MOTION.reduced ? "auto" : "smooth", block:"start"});
    });
  });
}
const infoIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01" stroke-linecap="round"/></svg>`;

/* ---- PRIVACY ----
   Premium legal-document redesign: sticky "On this page" nav + readable
   document layout. The ORIGINAL two paragraphs (unchanged, verbatim) are
   reorganized under real section headings - only sections with an actual
   corresponding sentence in the original text are included (no invented
   legal content - e.g. "Third-party services"/"Your choices" have no
   source sentence to draw from, so they're intentionally omitted rather
   than filled with placeholder claims). */
/* Small inline glyphs for the Privacy redesign's floating orbit nodes -
   none of these exist in TOOL_ICONS (they're privacy concepts, not PDF
   tools), so they're defined here rather than borrowed from an
   unrelated icon set. */
const privacyIcons = {
  lock:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>`,
  shield:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6l7-3z"/></svg>`,
  monitor:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/></svg>`,
  uploadOff:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 16V6M8 10l4-4 4 4"/><path d="M4 20h16"/><path d="M3 3l18 18" stroke-linecap="round"/></svg>`,
  eyeOff:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.7 10.7 0 0112 5c5 0 9 3.5 10 7-.4 1.3-1.1 2.6-2.1 3.7M6.1 6.1C3.9 7.5 2.3 9.6 2 12c1 3.5 5 7 10 7 1.3 0 2.6-.2 3.7-.6"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/></svg>`,
  check:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9"/></svg>`,
};
TOOLS.privacy = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  openPanel(`
    <div class="panel-head"><h3>${t("footer.privacy")}</h3><div class="panel-head-actions"><button class="panel-close" aria-label="${t("workspace.closePanel")}">✕</button></div></div>
    <div class="panel-body compact">
      <div class="privacy-layout">
        <aside class="privacy-sidebar">
          <div class="privacy-nav-label">${t("footer.privacy")}</div>
          <nav class="privacy-nav" aria-label="Privacy Policy sections">
            <a href="#privacy-overview">${t("privacy.navOverview")}</a>
            <a href="#privacy-processing">${t("privacy.navProcessing")}</a>
            <a href="#privacy-analytics">${t("privacy.navAnalytics")}</a>
            <a href="#privacy-cookies">${t("privacy.navCookies")}</a>
            <a href="#privacy-contact">${t("privacy.navContact")}</a>
          </nav>
          <div class="privacy-trust-card">
            <div class="ptc-icon">${privacyIcons.shield}</div>
            <strong>${t("privacy.badge")}</strong>
            <span>${t("privacy.badgeSub")}</span>
          </div>
        </aside>

        <div class="privacy-main">
          <div class="privacy-hero">
            <div class="privacy-hero-copy">
              <div class="legal-meta">${t("privacy.metaUpdated")}</div>
              <h1>${t("privacy.headingLine1")} <span class="accent">${t("privacy.headingAccent1")}</span><br>${t("privacy.headingLine2")} <span class="accent">${t("privacy.headingAccent2")}</span></h1>
              <p>${t("privacy.paragraph")}</p>
              <div class="privacy-feature-row">
                <div class="pf-item">${privacyIcons.shield}<div><strong>${t("privacy.feature1Title")}</strong><span>${t("privacy.feature1Desc")}</span></div></div>
                <div class="pf-item">${privacyIcons.lock}<div><strong>${t("privacy.feature2Title")}</strong><span>${t("privacy.feature2Desc")}</span></div></div>
                <div class="pf-item">${privacyIcons.eyeOff}<div><strong>${t("privacy.feature3Title")}</strong><span>${t("privacy.feature3Desc")}</span></div></div>
              </div>
            </div>
            <div class="privacy-visual" aria-hidden="true">
              <div class="pv-spin-group">
                <div class="pv-ring pv-ring-outer"></div>
                <div class="pv-ring pv-ring-inner"></div>
                <span class="pv-particle" style="top:6%;left:32%"></span>
                <span class="pv-particle" style="top:80%;left:88%"></span>
                <span class="pv-particle" style="top:90%;left:14%"></span>
              </div>
              <div class="pv-node" style="top:6%;left:84%;"><span class="pv-node-icon">${privacyIcons.monitor}</span><small>${t("privacy.nodeLocal")}</small></div>
              <div class="pv-node" style="top:94%;left:84%;"><span class="pv-node-icon">${privacyIcons.uploadOff}</span><small>${t("privacy.nodeNoUploads")}</small></div>
              <div class="pv-node" style="top:94%;left:16%;"><span class="pv-node-icon">${privacyIcons.eyeOff}</span><small>${t("privacy.nodeNoTracking")}</small></div>
              <div class="pv-node" style="top:6%;left:16%;"><span class="pv-node-icon">${privacyIcons.check}</span><small>${t("privacy.nodeControl")}</small></div>
              <div class="pv-shield">
                <svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg">
                  <path d="M50 6l38 14v28c0 30-18 48-38 56-20-8-38-26-38-56V20z" fill="rgba(var(--brand-shadow-rgb),0.06)" stroke="var(--red)" stroke-width="2.5"/>
                  <rect x="38" y="52" width="24" height="20" rx="3" fill="none" stroke="var(--red)" stroke-width="2.5"/>
                  <path d="M42 52v-8a8 8 0 0116 0v8" fill="none" stroke="var(--red)" stroke-width="2.5"/>
                </svg>
              </div>
            </div>
          </div>

          <div class="privacy-principles">
            <div class="pp-item">${privacyIcons.monitor}<span>${t("privacy.principle1")}</span></div>
            <div class="pp-item">${privacyIcons.uploadOff}<span>${t("privacy.principle2")}</span></div>
            <div class="pp-item">${privacyIcons.eyeOff}<span>${t("privacy.principle3")}</span></div>
            <div class="pp-item">${privacyIcons.shield}<span>${t("privacy.principle4")}</span></div>
            <div class="pp-item">${privacyIcons.check}<span>${t("privacy.principle5")}</span></div>
          </div>

          <div class="legal-content">
            <h2 id="privacy-overview">${t("privacy.sectionOverview")}</h2>
            <p>${t("privacy.overviewBody")}</p>

            <h2 id="privacy-processing">${t("privacy.sectionProcessing")}</h2>
            <div class="legal-callout">${infoIconSvg}<span>${t("privacy.processingBody")}</span></div>

            <h2 id="privacy-analytics">${t("privacy.sectionAnalytics")}</h2>
            <p>${t("privacy.analyticsBody")}</p>

            <h2 id="privacy-cookies">${t("privacy.sectionCookies")}</h2>
            <p>${t("privacy.cookiesBody")}</p>

            <h2 id="privacy-contact">${t("privacy.sectionContact")}</h2>
            <p>${t("privacy.contactBody")}</p>
          </div>
        </div>
      </div>
      ${contentPageTailHTML()}
    </div>`);
  initLegalScrollSpy(document.querySelector(".panel-body"), ".privacy-nav a");
  bindContentPageTail(panel);
};

/* ---- TERMS ----
   Same legal-document design language as Privacy above. The three
   ORIGINAL paragraphs (unchanged, verbatim) are reorganized under real
   section headings; sections with no corresponding original sentence
   (Acceptance of Terms, Intellectual Property, Service Availability) are
   intentionally omitted rather than filled with invented clauses. Title
   shown as "Terms of Service" (a label, not a change in legal meaning -
   the underlying text is identical to what "Terms of Use" already said). */
const termsIcons = {
  layers:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>`,
  check:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9"/></svg>`,
};
TOOLS.terms = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  openPanel(`
    <div class="panel-head"><h3>${t("footer.terms")}</h3><div class="panel-head-actions"><button class="panel-close" aria-label="${t("workspace.closePanel")}">✕</button></div></div>
    <div class="panel-body compact">
      <div class="terms-page">
        <div class="terms-hero">
          <div class="terms-hero-copy">
            <div class="terms-badge">${termsIcons.check}<span>${t("terms.badge")}</span></div>
            <h1>${t("terms.heading")}</h1>
            <p>${t("terms.subheading")}</p>
            <div class="legal-meta">${t("terms.metaUpdated")}</div>
          </div>
          <div class="terms-visual" aria-hidden="true">
            <span class="tv-shape tv-shape-circle"></span>
            <span class="tv-shape tv-shape-square"></span>
            <svg viewBox="0 0 120 140" xmlns="http://www.w3.org/2000/svg">
              <rect x="10" y="6" width="80" height="112" rx="8" fill="rgba(var(--brand-shadow-rgb),0.05)" stroke="var(--red)" stroke-width="2"/>
              <path d="M66 6v20h20z" fill="none" stroke="var(--red)" stroke-width="2" stroke-linejoin="round"/>
              <path d="M24 46h44M24 60h44M24 74h30M24 88h44" stroke="rgba(var(--brand-shadow-rgb),0.4)" stroke-width="2" stroke-linecap="round"/>
              <circle cx="86" cy="112" r="16" fill="rgba(5,5,5,0.9)" stroke="var(--red)" stroke-width="2"/>
              <path d="M79 112l5 5 9-10" fill="none" stroke="var(--red)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
        </div>

        <div class="terms-layout">
          <aside class="terms-sidebar">
            <div class="privacy-nav-label">${t("nav.allToolsShort")}</div>
            <nav class="terms-nav" aria-label="Terms of Service sections">
              <a href="#terms-using">${t("terms.navUsing")}</a>
              <a href="#terms-responsibilities">${t("terms.navResponsibilities")}</a>
              <a href="#terms-disclaimers">${t("terms.navDisclaimers")}</a>
              <a href="#terms-changes">${t("terms.navChanges")}</a>
              <a href="#terms-contact">${t("terms.navContact")}</a>
            </nav>
          </aside>

          <div class="terms-main">
            <div class="legal-callout">${infoIconSvg}<span>${t("terms.calloutIntro")}</span></div>

            <div class="terms-cards">
              <div class="terms-card"><div class="tc-icon">${privacyIcons.shield}</div><h4>${t("terms.card1Title")}</h4><p>${t("terms.card1Desc")}</p></div>
              <div class="terms-card"><div class="tc-icon">${termsIcons.layers}</div><h4>${t("terms.card2Title")}</h4><p>${t("terms.card2Desc")}</p></div>
              <div class="terms-card"><div class="tc-icon">${infoIconSvg}</div><h4>${t("terms.card3Title")}</h4><p>${t("terms.card3Desc")}</p></div>
            </div>

            <div class="legal-content">
              <h2 id="terms-using">${t("terms.sectionUsing")}</h2>
              <p>${t("terms.usingBody")}</p>

              <h2 id="terms-responsibilities">${t("terms.sectionResponsibilities")}</h2>
              <p>${t("terms.responsibilitiesBody")}</p>

              <h2 id="terms-disclaimers">${t("terms.sectionDisclaimers")}</h2>
              <p>${t("terms.disclaimersBody")}</p>

              <h2 id="terms-changes">${t("terms.sectionChanges")}</h2>
              <p>${t("terms.changesBody")}</p>

              <h2 id="terms-contact">${t("terms.sectionContact")}</h2>
              <p>${t("terms.contactBody")}</p>
              <div class="terms-cta">
                <div><strong>${t("terms.ctaTitle")}</strong><span>${t("terms.ctaSub")}</span></div>
                <button type="button" class="btn-cta-primary" data-open="contact">${t("terms.ctaBtn")}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      ${contentPageTailHTML()}
    </div>`);
  initLegalScrollSpy(document.querySelector(".panel-body"), ".terms-nav a");
  bindContentPageTail(panel);
};

/* ---- CONTACT US ----
   Premium two-column redesign. Send logic is UNCHANGED from before this
   redesign: a mailto: link built from the same fields, opened in the
   user's own mail client - no server, no storage. Two new fields
   (Reason for contacting, an optional attachment) are additive: a
   mailto: link cannot actually attach a file, so a selected file's name
   is noted in the message body as a reminder to attach it manually
   before sending, rather than silently pretending the file went along. */
TOOLS.contact = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  openPanel(`
    <div class="panel-head"><h3>${t("nav.contact")}</h3><div class="panel-head-actions"><button class="panel-close" aria-label="${t("workspace.closePanel")}">✕</button></div></div>
    <div class="panel-body compact">
      <div class="contact-layout">
        <div class="contact-info">
          <span class="section-eyebrow">${t("misc.contactEyebrow")}</span>
          <h1>${t("misc.contactHeroTitle")}</h1>
          <p>${t("misc.contactHeroDesc")}</p>
          <div class="contact-info-cards">
            <div class="contact-info-card">
              <div class="ficon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h7v8l10-12h-7z"/></svg></div>
              <div><h3>${t("misc.contactCard1Title")}</h3><p>${t("misc.contactCard1Desc")}</p></div>
            </div>
            <div class="contact-info-card">
              <div class="ficon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg></div>
              <div><h3>${t("misc.contactCard2Title")}</h3><p>${t("misc.contactCard2Desc")}</p></div>
            </div>
            <div class="contact-info-card">
              <div class="ficon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2-2.4 3.7M12 17h.01"/></svg></div>
              <div><h3>${t("misc.contactCard3Title")}</h3><p>${t("misc.contactCard3Desc")}</p></div>
            </div>
          </div>
        </div>

        <div class="contact-form-wrap">
          <div class="contact-form-card">
            <div class="row">
              <div class="field"><label for="cFirst">${t("misc.contactFirstName")}</label><input type="text" id="cFirst"></div>
              <div class="field"><label for="cLast">${t("misc.contactLastName")}</label><input type="text" id="cLast"></div>
            </div>
            <div class="field"><label for="cEmail">${t("misc.contactYourEmail")}</label><input type="text" id="cEmail" placeholder="you@example.com"></div>
            <div class="field">
              <label for="cReason">${t("misc.contactReasonLabel")}</label>
              <select id="cReason">
                <option value="Feature Request">${t("misc.contactCard1Title")}</option>
                <option value="Bug Report">${t("misc.contactCard2Title")}</option>
                <option value="General Question" selected>${t("misc.contactCard3Title")}</option>
              </select>
            </div>
            <div class="field"><label for="cMessage">${t("misc.contactMessageLabel")}</label><textarea id="cMessage" placeholder="${t("misc.contactHeroTitle")}"></textarea></div>
            <div class="field"><label for="cAttachment">${t("misc.contactAttachmentLabel")}</label><input type="file" id="cAttachment"></div>
            <button class="btn" id="go">${t("misc.contactSendMessage")}</button>
            <div class="contact-privacy-note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6l7-3z"/></svg><span>${t("misc.contactPrivacyNote")}</span></div>
            <div id="out"></div>
          </div>
        </div>
      </div>
      ${contentPageTailHTML()}
    </div>`);
  bindContentPageTail(panel);
  document.getElementById("go").addEventListener("click", ()=>{
    const first = document.getElementById("cFirst").value.trim();
    const last = document.getElementById("cLast").value.trim();
    const email = document.getElementById("cEmail").value.trim();
    const reason = document.getElementById("cReason").value;
    const message = document.getElementById("cMessage").value.trim();
    const attachment = document.getElementById("cAttachment").files[0];
    if(!message){ toast(t("misc.contactErrWriteMessage")); return; }
    const subject = encodeURIComponent(`YOYOPDF contact form (${reason}) — ${first} ${last}`.trim());
    const attachmentNote = attachment ? `\n\n(Attachment noted — please attach "${attachment.name}" manually before sending, mailto links can't include files.)` : "";
    const body = encodeURIComponent(`Name: ${first} ${last}\nEmail: ${email}\nReason: ${reason}\n\n${message}${attachmentNote}`);
    window.location.href = `mailto:ca.ravimishra5@gmail.com?subject=${subject}&body=${body}`;
    const out = document.getElementById("out");
    out.innerHTML = `<div class="status">${t("misc.contactEmailOpened", {email: "ca.ravimishra5@gmail.com"})}</div>`;
  });
};
