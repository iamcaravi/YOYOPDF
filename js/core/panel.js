/* ---------------- Modal plumbing ---------------- */
const overlay = document.getElementById("overlay");
const panel = document.getElementById("panel");
const siteHeader = document.querySelector("header");
let panelLastFocus = null;
/* Detached (never appended to the visible DOM) — just a place for
   TOOLS.edit to park its one persistent shell instance between
   closes/reopens. See closePanel() and TOOLS.edit. */
const editorHoldingArea = document.createElement("div");
// Phase 12: every non-tool panel's own template (About/Support/Docs/
// Privacy/Terms/Contact, in js/tools/misc-tools.js) used to render its
// close button as onclick="closePanel()" inline in the HTML string it
// hands to openPanel() below — the one thing blocking script-src
// 'unsafe-inline' from ever being removed from the CSP. One delegated
// listener here, added once, covers every current and future panel's
// .panel-close button (openPanel() replaces #panel's contents wholesale
// each time, so a listener bound to #panel itself survives that swap —
// no per-template rewiring needed, and no call site can forget it).
panel.addEventListener("click", (e)=>{
  if(e.target.closest(".panel-close")) closePanel();
});
/* Splits a tool panel's content into a left "main" column (file drop
   zone, file list, page grid, any instructional text) and a right
   "sidebar" column (option fields + the primary action button) —
   matches iLovePDF's file-management workspace layout. Runs generically
   against whatever openPanel() just rendered rather than requiring every
   TOOLS.xxx template to be rewritten: each column is an independent
   block container (not a shared CSS grid), so mismatched element counts
   between the two sides just stack normally instead of overlapping.
   Panels with no .field/#go (About, Contact, Privacy, TOOLS.edit's own
   fullscreen shell, etc.) have nothing to move into a sidebar and are
   left as a single column, unchanged. */
function layoutTwoColumn(){
  const body = document.querySelector(".panel-body");
  if(!body) return;
  // Bespoke .tool-app-shell tools (Split/Organize/Rotate/Delete/Extract/
  // etc) build their own two-column .tool-app-workspace/.tool-side-panel
  // by hand instead of going through the auto-layout below, but still
  // want the SAME "tool name + description at the top of the right
  // panel" iLovePDF gives its sidebar - reads from the one .tool-hero
  // already in every tool's template (same source the auto-layout
  // system reparents below) instead of duplicating that copy a second
  // time in ~19 separate TOOLS.xxx functions. A CLONE, not a move: every
  // one of those ~19 functions already toggles the ORIGINAL .tool-hero's
  // own inline style.display directly (empty-state show/hide, e.g.
  // Split's own hero.style.display="none" once a file loads) - moving
  // the real node into the sidebar would still leave it subject to that
  // per-tool inline toggling and go blank the moment a file loads
  // (confirmed live: exactly what happened before switching to a
  // clone). A static copy of its title+description markup, inserted
  // once and left alone, sidesteps that entirely without touching any
  // of those 19 call sites. Guarded so a re-run (layoutTwoColumn() fires
  // on every openPanel()) never inserts a second copy.
  const sidePanel = body.querySelector(".tool-side-panel");
  const shellHero = body.querySelector(".tool-hero");
  if(sidePanel && shellHero && !sidePanel.querySelector(".tool-sidebar-hero")){
    const sidebarHero = document.createElement("div");
    sidebarHero.className = "tool-hero tool-sidebar-hero";
    sidebarHero.innerHTML = shellHero.innerHTML;
    sidePanel.prepend(sidebarHero);
  }
  if(body.querySelector(".tool-layout")) return;
  // Opt-out for tools building their own bespoke page-grid + sidebar
  // workspace by hand (Split/Organize/Rotate/etc, marked .tool-app-shell)
  // instead of the shared auto-layout below.
  if(body.classList.contains("no-auto-layout")) return;
  const out = document.getElementById("out");
  const hero = body.querySelector(".tool-hero");
  // Two per-tool authoring styles both end up here: older tools lay out
  // bare .field/.row elements + a bare #go button directly; newer ones
  // (Compress's compression-level picker, every .tool-toolbar's primary
  // button) wrap the same content in a bounded .tool-content-area/
  // .tool-toolbar box for the "inside a defined panel" look. Only
  // considering *direct children* of body (not body.querySelectorAll,
  // which would also match fields nested inside those boxes) and moving
  // whichever level actually is the direct child - the whole box for the
  // newer style, or the bare field/button for the older one - keeps both
  // working without moving a box's children out from under it and
  // leaving an empty shell behind in the main column.
  const isSidebarEl = el => el.matches(".field, .row, .tool-content-area, .tool-toolbar, #go");
  // .tool-privacy-hint duplicates the sidebar's own injected .tool-sidebar-tip
  // (same "everything happens in your browser" message) - drop it rather
  // than showing the same reassurance twice once a sidebar exists.
  body.querySelector(".tool-privacy-hint")?.remove();
  const candidates = [...body.children].filter(el => el!==out && el!==hero);
  const sidebarEls = candidates.filter(isSidebarEl);
  const mainEls = candidates.filter(el => !isSidebarEl(el));
  if(sidebarEls.length === 0) return;
  // Tools with no dropzone are entirely .field/#go - splitting them would
  // leave main empty and dump everything into a cramped 440px sidebar,
  // which looks worse than just keeping the single centered column.
  if(mainEls.length === 0) return;

  const wrap = document.createElement("div");
  wrap.className = "tool-layout";
  const main = document.createElement("div");
  main.className = "tool-main";
  const sidebar = document.createElement("div");
  sidebar.className = "tool-sidebar";

  // The sidebar owns the tool's title + short instruction (iLovePDF's own
  // hierarchy) instead of duplicating it in a big centered hero above the
  // workspace - .tool-hero already has both (h2 title + description), so
  // it's reused/reparented here (restyled left-aligned+compact via
  // .tool-sidebar-hero in CSS) rather than writing the same copy twice.
  if(hero){ hero.classList.add("tool-sidebar-hero"); sidebar.appendChild(hero); }

  // Flexible spacer: pushes whatever comes after (options + primary
  // action, below) down to the bottom of the sidebar on tall viewports,
  // instead of the button floating right under the instruction text.
  const spacer = document.createElement("div");
  spacer.className = "tool-sidebar-spacer";
  sidebar.appendChild(spacer);

  const footer = document.createElement("div");
  footer.className = "tool-sidebar-footer";
  const tip = document.createElement("div");
  tip.className = "tool-sidebar-tip";
  tip.innerHTML = `<span class="tip-icon" aria-hidden="true">🔒</span><span>${window.T ? T("workspace.privacyHintFiles") : "Everything happens right here in your browser — your files are never uploaded or stored anywhere."}</span>`;
  footer.appendChild(tip);
  sidebarEls.forEach(el=>footer.appendChild(el));
  sidebar.appendChild(footer);

  mainEls.forEach(el=>main.appendChild(el));
  wrap.appendChild(main);
  wrap.appendChild(sidebar);
  body.insertBefore(wrap, out || null);
  // .tool-workspace's 900px cap (right for a single centered column) is
  // too narrow for a 440px sidebar to sit comfortably beside real content
  // - widen only once a .tool-layout actually got built.
  body.classList.add("has-tool-layout");
  pinSidebarSafeHeight(sidebar);
}
// .tool-sidebar's CSS max-height (calc(100vh - 106px)) assumes the box
// starts flush at the viewport top - it doesn't, since .overlay never
// scrolls (overflow:hidden) so the sidebar sits permanently at its
// natural offset below the site header instead of ever actually
// reaching position:sticky's top:0. On a common 1280x720 desktop that
// offset alone (~127px) was enough for a content-filled sidebar to run
// its bottom edge (and the primary CTA inside it) past the viewport
// edge and into #quickDock's floating band - confirmed live, not
// hypothetical. Measuring the real offset here and subtracting it (once
// after layout, again on resize) is the actual fix; the CSS value stays
// as a pre-JS/no-JS fallback only.
function pinSidebarSafeHeight(sidebarEl){
  const DOCK_RESERVE = 74; // #quickDock's own 20px bottom offset + 38px icon height + ~16px breathing room
  function update(){
    const top = sidebarEl.getBoundingClientRect().top;
    if(top <= 0) return; // not laid out / off-screen yet, nothing sane to compute
    sidebarEl.style.maxHeight = `calc(100vh - ${Math.round(top)}px - ${DOCK_RESERVE}px)`;
  }
  update();
  // The call above runs synchronously inside layoutTwoColumn(), right as
  // panel.innerHTML is being assigned - before the browser necessarily
  // has this specific box in its final post-insert layout position, so
  // getBoundingClientRect() can catch it mid-flight and no-op via the
  // top<=0 guard above. One more pass on the next tick (after layout has
  // genuinely settled) is what actually lands the real value; setTimeout
  // rather than requestAnimationFrame specifically because rAF is
  // throttled to a stop on a backgrounded tab (a tool opened in a new
  // background tab would otherwise never get a correct value) - resize
  // keeps it correct after that regardless of tab visibility.
  setTimeout(update, 0);
  // layoutTwoColumn() (this function's only caller) runs on every
  // openPanel(), and panel.innerHTML replacement doesn't detach
  // window-level listeners the way it detaches DOM-node ones - without
  // self-removal this leaked one resize listener (holding `sidebarEl`,
  // and everything closed over with it) per tool open, same class of leak
  // as pdf-page-tools-2.js's cropKeyHandler.
  function onResize(){
    if(!sidebarEl.isConnected){ window.removeEventListener("resize", onResize); return; }
    update();
  }
  window.addEventListener("resize", onResize);
}
const PANEL_FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
function openPanel(html){
  panelLastFocus = document.activeElement;
  panel.innerHTML = html;
  // Single source of truth for a tool's primary heading. Every tool panel
  // has both a small .panel-head title bar (permanent chrome, shared with
  // the non-tool panels like About/Contact) and its own centered
  // <h2 class="tool-hero-title"> - for actual tools the hero title is the
  // real page heading (centered, in the content flow), so the redundant
  // bar is hidden rather than the other way around - one shared rule
  // instead of a per-tool "no title" hack. Non-tool panels (no
  // .tool-workspace) keep their .panel-head bar since it's their only
  // heading. (Left as h2, not promoted to h1: the homepage hero behind
  // this overlay already has its own h1 in the DOM at all times, so
  // adding a second h1 here would trade one duplicate-heading problem
  // for another rather than fix it.)
  const isToolPanel = panel.querySelector(".tool-workspace") && !panel.classList.contains("panel-fullscreen");
  if(isToolPanel){
    const panelHead = panel.querySelector(".panel-head");
    if(panelHead) panelHead.style.display = "none";
  }
  layoutTwoColumn();
  // .overlay.open has its own 220ms opacity fade-in (css/site.css) -
  // harmless for a same-page modal open (About/Contact/Quick Action,
  // or switching tools while a panel is already showing), where the
  // page underneath is legitimately supposed to be visible throughout.
  // But for the tool-preload page-load reveal specifically, that fade
  // is actively wrong: confirmed via frame-by-frame pixel inspection of
  // a throttled navigation that a partially-faded overlay lets the
  // still-visibility:hidden-until-now static SEO content underneath
  // bleed through as a real, visible double-exposure ghost (two
  // overlapping hero headings) for several frames. Skipping the
  // transition ONLY for this one reveal keeps it a genuine atomic
  // switch - no fade ever starts, so there's nothing to bleed through
  // during. Restored immediately after so any LATER same-page panel
  // open (a real, intentional interaction) still gets its normal fade.
  const isPageLoadReveal = document.documentElement.classList.contains("tool-preload");
  if(isPageLoadReveal) overlay.style.transition = "none";
  overlay.classList.add("open");
  document.documentElement.classList.add("panel-open");
  // The real reveal for the tool-preload flash fix (index.html's inline
  // <head> script + css/site.css's html.tool-preload rule) - the instant
  // the tool workspace is actually open, not a timer. No-op (harmless)
  // when this class was never added, e.g. the homepage's own Quick
  // Action/tool-card clicks. Also clears the matching inline
  // style.visibility the same head script sets (see its own comment) -
  // that inline property, not just the class, is what actually keeps
  // the page hidden pre-stylesheet-load, so it has to be cleared here too.
  document.documentElement.classList.remove("tool-preload");
  document.documentElement.style.visibility = "";
  if(isPageLoadReveal){
    void overlay.offsetWidth; // force the transition:none to actually apply before restoring it
    overlay.style.transition = "";
  }
  /* Every tool page keeps the site header visible above it (logo, nav,
     search, dark mode) — same pattern iLovePDF uses on its own tool
     pages — instead of covering the entire viewport and hiding all site
     branding/navigation, which read as a bare, disconnected utility
     screen rather than part of a real website. Force the header into its
     solid "scrolled" background since it now always sits above a panel,
     never the transparent hero. */
  siteHeader.classList.add("scrolled");
  overlay.style.top = siteHeader.getBoundingClientRect().height + "px";
  // Same focus-management intent the Quick Action modal already has
  // (qaLastFocus/Tab-trap above) — the tool panel is the app's far more
  // heavily used modal surface and previously had none of this. A plain
  // synchronous call works fine here (panel.innerHTML was already set
  // above, so the target is connected and focusable) and, unlike
  // requestAnimationFrame, doesn't depend on a compositor frame actually
  // being produced - a backgrounded/inactive tab can defer rAF
  // indefinitely, which would otherwise leave focus stuck on the trigger.
  (panel.querySelector(PANEL_FOCUSABLE) || panel).focus();
}
/* ---------------- Shared "page tail" for non-tool content panels ----
   About/Contact/Donate/Privacy/Terms used to end abruptly right after
   their own content - no SEO tool directory, no footer, unlike a real
   page. Rather than hand-copy that markup into five templates (five
   places to keep in sync forever), this clones the ONE real copy that
   already lives in index.html (the "Explore YOYOPDF Tools" section +
   the site footer, both already built and styled) and reuses it as-is.
   .content-page-tail itself only handles side-margin cancellation now
   (see its own CSS comment) - it used to also reserve bottom padding for
   #quickDock, but the dock is homepage-only now (js/app.js's
   isDockHiddenState()) and never shows inside any panel, so there's
   nothing left to reserve room for. */
function contentPageTailHTML(){
  const seo = document.querySelector(".seo-tool-directory");
  const footer = document.querySelector(".site-footer");
  if(!seo && !footer) return "";
  let html = (seo ? seo.outerHTML : "") + (footer ? footer.outerHTML : "");
  // Avoid a second #seo-tool-directory-title id fighting the homepage's
  // own copy (aria-labelledby's only consumer of that id) while this
  // clone is the one actually open.
  html = html.replace(/seo-tool-directory-title/g, "panelSeoToolDirectoryTitle");
  return `<div class="content-page-tail">${html}</div>`;
}
/* [data-open] buttons and real <a href> links inside the clone already
   work unchanged (delegated / native navigation respectively - the
   exact same reason the About page's existing "Contact Us ->" button
   already works with zero extra wiring). [data-filter] and [data-share]
   are NOT delegated, though - their only listeners were bound once, at
   page load, directly to index.html's original elements (see
   nav-menu.js/quick-actions.js), so a later clone needs its own. Call
   once per openPanel() that appends contentPageTailHTML(). */
function bindContentPageTail(root){
  root.querySelectorAll(".content-page-tail [data-filter]").forEach(el=>{
    el.addEventListener("click", ()=>{
      applyFilter(el.dataset.filter);
      closePanel();
      requestAnimationFrame(()=>{
        document.getElementById("tools")?.scrollIntoView({behavior: MOTION.reduced ? "auto" : "smooth", block:"start"});
      });
    });
  });
  root.querySelectorAll(".content-page-tail [data-share]").forEach(btn=>{
    btn.addEventListener("click", ()=>shareOn(btn.dataset.share));
  });
}
/**
 * @param {boolean} [skipRoute] - true when a tool-to-tool transition
 *   ("Continue to...", result screen "Start over") calls this right
 *   before openTool() opens the next one. For a cross-tool "Continue
 *   to..." this barely matters (openTool() is about to navigate away to
 *   that tool's own page, discarding this document entirely) - but
 *   "Start over" re-runs the SAME tool in place with no navigation at
 *   all, and without this flag the URL would flash to "/" via
 *   syncHomeRoute() for an instant before staying right where it was,
 *   leaving a spurious "/" entry in browser history for no reason.
 */
function closePanel(skipRoute){
  overlay.classList.remove("open");
  document.documentElement.classList.remove("panel-open");
  overlay.style.top = "";
  siteHeader.classList.toggle("scrolled", window.scrollY > 8);
  /* Strip the fullscreen variant (only ever added by TOOLS.edit) so the
     shared #panel/#overlay elements are back to their default state for
     every other tool the next time openPanel() runs. The editor's own
     workspace DOM is detached (not destroyed) just below, before the
     innerHTML wipe, so its state/listeners survive a close+reopen. */
  overlay.classList.remove("panel-fullscreen");
  panel.classList.remove("panel-fullscreen");
  if (window.__editorShellEl && window.__editorShellEl.parentNode === panel){
    editorHoldingArea.appendChild(window.__editorShellEl);
  }
  cancelAllToolOperations();
  runToolCleanups();
  __quickPreviewGeneration += 1;
  panel.innerHTML="";
  // The closed tool's result download / quick-preview / file-card thumbs
  // (if any) are no longer reachable from the DOM - release them now
  // rather than holding their Blobs in memory for the rest of the tab's
  // life. Editor image/signature-placement URLs are deliberately excluded
  // from this tracking (see the comment above downloadBlob()) and aren't
  // touched here.
  if(__activeResultUrl){ URL.revokeObjectURL(__activeResultUrl); __activeResultUrl = null; }
  if(__quickPreviewUrl){ URL.revokeObjectURL(__quickPreviewUrl); __quickPreviewUrl = null; }
  if(__fileCardPreviewUrls.length){ __fileCardPreviewUrls.forEach(u=>URL.revokeObjectURL(u)); __fileCardPreviewUrls = []; }
  panelLastFocus && panelLastFocus.focus && panelLastFocus.focus();
  panelLastFocus = null;
  if(!skipRoute && window.__currentToolId) syncHomeRoute();
  window.__currentToolId = null;
}
/* ROOT CAUSE of the "Home doesn't return to the top" bug: every tool now
   has its own real physical page (openTool()'s whole reason for being -
   see its comment above), which means the DOM "underneath" the overlay
   on, say, rotate-pdf.html is NOT the actual homepage - it's Rotate
   PDF's own generated hero + SEO content (build/generate-landing.js
   clones index.html per tool and swaps in that tool's own copy). Before
   this fix, goHome() always just closed the overlay and scrolled THIS
   document to 0,0 - technically correct in isolation, but "top of this
   document" is "top of Rotate PDF's own page" when called from
   rotate-pdf.html, which is exactly the "previous tool's section
   appears near the top" symptom: it's not stale scroll restoration,
   it's genuinely the wrong document being revealed. Home only ever
   needs the lightweight same-document close+scroll when already ON the
   real homepage (closePanel() there reveals the actual homepage
   content, unmodified) - from anywhere else it needs the same kind of
   real navigation openTool() already uses, landing on a freshly loaded
   index.html that starts at the top by construction (no scroll-position
   bug possible on a document that just loaded). One shared check
   (toolIdForPath) instead of a per-tool "am I home" flag, so this
   applies identically to every TOOL_ROUTES entry with zero new
   per-tool code. */
function goHome(){
  if(toolIdForPath(location.pathname)){
    location.href = '/';
    return;
  }
  closePanel();
  window.scrollTo({ top: 0, behavior: MOTION.reduced ? "auto" : "smooth" });
}
/**
 * The YOYOPDF logo/brand link's click handler - a real <a href="/">, so
 * middle-click/Ctrl-click/right-click "open in new tab" and no-JS all
 * still work normally. Only a plain left-click gets intercepted, to go
 * home the same client-side way every other in-app navigation does
 * (no full page reload) instead of the browser's default link navigation.
 * @returns {boolean} false to preventDefault when handled client-side.
 */
function handleLogoClick(e){
  if(e.button!==0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return true;
  e.preventDefault();
  goHome();
  return false;
}
// Phase 12: was onclick="return handleLogoClick(event)" inline on the
// header <a class="brand"> in index.html - the same CSP-'unsafe-inline'
// blocker as the .panel-close buttons above. handleLogoClick() already
// calls e.preventDefault() itself before returning false; that return
// value only mattered to the old inline-handler convention (which reads
// a false return as an implicit preventDefault+stopPropagation) - a
// plain addEventListener needs none of that, the explicit
// preventDefault() inside the function is already the real effect.
document.querySelector("header .brand")?.addEventListener("click", handleLogoClick);
overlay.addEventListener("click", e=>{ if(e.target===overlay) closePanel(); });
document.addEventListener("keydown", e=>{
  if(!overlay.classList.contains("open")) return;
  // TOOLS.edit's fullscreen editor already owns Escape end-to-end
  // (editor-objects.js cancels a pending placement; navigation-manager.js
  // closes the workspace via editor:requestClose -> closePanel(), with
  // its own stopPropagation() so a mobile overlay panel closes first,
  // not the whole editor). This listener sits on `document`, which sees
  // the bubbling keydown before `window` does, so without this guard
  // Escape would close the entire panel out from under the editor's own
  // handling instead of e.g. just canceling a pending text placement.
  if(e.key==="Escape" && panel.classList.contains("panel-fullscreen")) return;
  if(e.key==="Escape"){ closePanel(); return; }
  if(e.key==="Tab"){
    const focusable = Array.from(panel.querySelectorAll(PANEL_FOCUSABLE)).filter(el=>el.offsetParent!==null);
    if(!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length-1];
    if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
  }
});

document.addEventListener("click", e=>{
  const card = e.target.closest("[data-tool]");
  const opener = e.target.closest("[data-open]");
  const id = card ? card.dataset.tool : (opener ? opener.dataset.open : null);
  if(!id) return;
  if(card && card.classList.contains("card")){
    card.classList.remove("card-glow");
    void card.offsetWidth;
    card.classList.add("card-glow");
  }
  document.getElementById("mobileMenu")?.classList.remove("open");
  closeAllDropdowns();
  openTool(id);
});
