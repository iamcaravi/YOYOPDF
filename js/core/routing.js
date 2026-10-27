/* ---------------- Shared upload/session manager ----------------
   Single source of truth for "what file(s) the user is currently working
   with". The Hero uploader, the Quick Action modal, the nav/search/mega-menu
   tool links, and the homepage tool cards all funnel through openTool()
   below rather than passing File objects to each other directly — that's
   the only place a File ever gets bridged into a tool. No tool's own code
   is touched or duplicated; this just drives the exact same #fi input each
   tool already listens on (or, for the Edit PDF workspace, the editor's own
   public EditorCanvas.loadFile() API — see TOOLS.edit below).
   Shape is intentionally generic (currentFiles is always an array) so it
   can later support multi-file workflows, a "recent uploads" list, or
   workflow-chaining (tool A's output becoming tool B's input) without a
   rewrite — just extend .set()/.metadata, callers don't change. */
const AppSession = {
  currentFile: null,
  currentFiles: [],
  metadata: {},
  source: null,
  timestamp: null,
  set(files, source){
    const list = Array.isArray(files) ? files.filter(Boolean) : (files ? [files] : []);
    this.currentFiles = list;
    this.currentFile = list[0] || null;
    this.source = source || null;
    this.timestamp = Date.now();
    this.metadata = { count: list.length, names: list.map(f=>f.name) };
  },
  clear(){
    this.currentFile = null; this.currentFiles = []; this.metadata = {}; this.source = null; this.timestamp = null;
  },
};

/* ---------------- Client-side tool routing ----------------
   Real dedicated URLs per tool (/merge-pdf, /split-pdf, ...) instead of
   /?tool=merge, with matching document.title/meta description/canonical,
   browser Back/Forward support, and direct-URL/refresh support (the
   static SEO pages already serve these same paths at build time for
   crawlers; this is what makes the *interactive app* itself answer to
   the same path once JS has loaded, and '_redirects' at the repo root
   already tells the production host to serve index.html for any path
   it doesn't recognize, which is what makes this work on a real refresh). */
/* SEO_TOOL_ROUTES_START */
const TOOL_ROUTES = {"merge":{"path":"/merge-pdf","title":"Merge PDF Files Free Online — Combine PDFs | YOYOPDF","description":"Combine multiple PDF files into one document in your browser. Drag to reorder, free, with no document upload and practical browser safety limits."},"split":{"path":"/split-pdf","title":"Split PDF Files Free Online — Extract Pages | YOYOPDF","description":"Split a PDF into separate files by page range or extract every page individually. Free, browser-based, no file uploads."},"rotate":{"path":"/rotate-pdf","title":"Rotate PDF Pages Free Online — Fix Orientation | YOYOPDF","description":"Rotate individual pages or the entire PDF 90, 180 or 270 degrees. Free, fast, and processed entirely in your browser."},"deletepages":{"path":"/delete-pages","title":"Delete Pages from PDF Free Online | YOYOPDF","description":"Remove unwanted pages from a PDF in a few clicks. Preview every page first. Free, browser-based, no uploads."},"extractpages":{"path":"/extract-pages","title":"Extract Pages from PDF Free Online | YOYOPDF","description":"Pull specific pages out of a PDF into a new document. Visual page picker, free, and processed locally in your browser."},"organize":{"path":"/organize-pdf","title":"Organize & Reorder PDF Pages Free Online | YOYOPDF","description":"Drag and drop to reorder, rotate, or remove PDF pages in one visual workspace. Free, browser-based, no file uploads."},"crop":{"path":"/crop-pdf","title":"Crop PDF Pages Free Online — Trim Margins | YOYOPDF","description":"Crop margins or unwanted areas from PDF pages with a visual crop box. Apply to one page or the whole document, free."},"watermark":{"path":"/watermark-pdf","title":"Add Watermark to PDF Free Online | YOYOPDF","description":"Add a text watermark to your PDF with live preview — control position, opacity, size and rotation. Free, no uploads."},"pagenumbers":{"path":"/page-numbers","title":"Add Page Numbers to PDF Free Online | YOYOPDF","description":"Insert page numbers into a PDF with control over position, starting number and format. Free, live preview, no uploads."},"protect":{"path":"/protect-pdf","title":"Password Protect PDF Free Online | YOYOPDF","description":"Add a password to a PDF to restrict opening or editing. Free, browser-based encryption — see the tool for encryption details."},"compress":{"path":"/compress-pdf","title":"Compress PDF to Target Size Free Online | YOYOPDF","description":"Shrink a PDF's file size down to an exact KB target you set. Free, fast, entirely in-browser compression."},"edit":{"path":"/edit-pdf","title":"Edit PDF Online Free — Add Text, Images & Shapes | YOYOPDF","description":"Edit PDF documents directly in your browser — add text, images, shapes, and annotations. Free, no upload, no sign-up."},"pdf2word":{"path":"/pdf-to-word","title":"PDF to Word Converter Free Online | YOYOPDF","description":"Convert PDF into an editable Word document, free and browser-based. No upload, no sign-up."},"word2pdf":{"path":"/word-to-pdf","title":"Word to PDF Converter Free Online | YOYOPDF","description":"Convert a .docx file into a PDF, free and browser-based. No upload, no sign-up, no watermark."},"pdf2jpg":{"path":"/pdf-to-jpg","title":"PDF to JPG Converter Free Online | YOYOPDF","description":"Convert every page of a PDF into a JPG image, free and browser-based. Download all pages as a ZIP."},"jpg2pdf":{"path":"/jpg-to-pdf","title":"JPG to PDF Converter Free Online | YOYOPDF","description":"Combine one or more images into a single PDF file, free and browser-based. No upload, no sign-up."},"pdf2excel":{"path":"/pdf-to-excel","title":"PDF to Excel Converter Free Online | YOYOPDF","description":"Extract text from a PDF into rows and columns in a spreadsheet, free and browser-based. No upload, no sign-up."},"excel2pdf":{"path":"/excel-to-pdf","title":"Excel to PDF Converter Free Online | YOYOPDF","description":"Convert every worksheet into one paginated table PDF, free and browser-based. No upload, no sign-up."},"mergeexcel":{"path":"/merge-excel","title":"Merge Excel Files Free Online — Combine Workbooks | YOYOPDF","description":"Combine multiple Excel workbooks into one while keeping each worksheet's layout and formatting intact. Free, browser-based, no upload."},"sign":{"path":"/sign-pdf","title":"Sign PDF Online Free — Add Your Signature | YOYOPDF","description":"Draw a signature and place it anywhere on a PDF page, free and browser-based. No upload, no account."},"reorder":{"path":"/reorder-pages","title":"Reorder PDF Pages Free Online | YOYOPDF","description":"Rearrange the pages of a PDF into any order you like, free and browser-based. Drag to reorder."},"addblank":{"path":"/add-blank-page","title":"Add Blank Page to PDF Free Online | YOYOPDF","description":"Insert a blank page anywhere in a PDF document, free and browser-based."},"headerfooter":{"path":"/header-footer","title":"Add Header and Footer to PDF Free Online | YOYOPDF","description":"Add a running header and footer to every page of a PDF, free and browser-based."},"invertpdf":{"path":"/invert-pdf-colors","title":"Invert PDF Colors Free Online — Dark Mode PDF | YOYOPDF","description":"Flip every page of a PDF to a negative / dark-mode style palette, free and browser-based."},"flatten":{"path":"/flatten-pdf","title":"Flatten PDF Form Fields Free Online | YOYOPDF","description":"Lock PDF form fields permanently into the page content, free and browser-based."},"fillform":{"path":"/fill-pdf-form","title":"Fill PDF Form Online Free | YOYOPDF","description":"Fill out fillable form fields in a PDF and save the result, free and browser-based."},"imgcompress":{"path":"/image-compressor","title":"Image Compressor Free Online — Shrink to Exact KB | YOYOPDF","description":"Shrink an image down to an exact KB target, free and browser-based."},"imgresize":{"path":"/resize-image","title":"Resize Image Free Online — Exact Width & Height | YOYOPDF","description":"Resize an image to exact width and height, free and browser-based."},"imgcrop":{"path":"/crop-image","title":"Crop Image Free Online | YOYOPDF","description":"Crop an image to a precise pixel region, free and browser-based."},"imgconvert":{"path":"/convert-image-format","title":"Convert Image Format Free Online — PNG, JPG, WebP | YOYOPDF","description":"Convert an image between PNG, JPG, and WebP formats, free and browser-based."},"imgwatermark":{"path":"/watermark-image","title":"Add Watermark to Image Free Online | YOYOPDF","description":"Overlay custom watermark text on an image, free and browser-based."},"imginvert":{"path":"/invert-image-colors","title":"Invert Image Colors Free Online | YOYOPDF","description":"Flip an image's colors to a negative palette, free and browser-based."},"unlock":{"path":"/unlock-pdf","title":"Unlock PDF — Remove PDF Password Free Online | YOYOPDF","description":"Remove a password from a PDF you already know the password to. Free, browser-based, no uploads."},"repair":{"path":"/repair-pdf","title":"Repair PDF Free Online | YOYOPDF","description":"Recover a PDF that won't open properly or has a broken internal structure. Free, browser-based, no uploads."},"pdf2pptx":{"path":"/pdf-to-powerpoint","title":"PDF to PowerPoint Converter Free Online | YOYOPDF","description":"Turn every page of a PDF into its own PowerPoint slide, free and browser-based. No upload, no sign-up."},"extractimages":{"path":"/extract-images","title":"Extract Images from PDF Free Online — Save Embedded Pictures | YOYOPDF","description":"Pull every embedded image out of a PDF as PNG files, free and browser-based. No upload, no sign-up, duplicates removed automatically."},"pdfcounter":{"path":"/pdf-counter","title":"PDF Counter Free Online — Count Pages, Words, Characters & Images | YOYOPDF","description":"Count a PDF's pages, words, characters and embedded images, with a per-page breakdown and estimated reading time. Free, browser-based, no upload."},"extracttext":{"path":"/extract-text","title":"Extract Text from PDF Free Online — PDF to Text | YOYOPDF","description":"Copy the text out of a PDF into a plain .txt file, page by page, free and browser-based. No upload, no sign-up."},"pdfmetadata":{"path":"/edit-pdf-metadata","title":"Edit PDF Metadata Free Online — Change Title, Author & More | YOYOPDF","description":"View and edit a PDF's title, author, subject, keywords and dates, or remove all metadata, free in your browser. No upload, no sign-up."},"pdf2md":{"path":"/pdf-to-markdown","title":"PDF to Markdown Converter Free Online | YOYOPDF","description":"Convert a PDF into Markdown with headings, tables and lists preserved, free and browser-based. No upload, no AI, no sign-up."},"resizepages":{"path":"/resize-page-size","title":"Resize PDF Page Size Free Online — A4, Letter, Legal | YOYOPDF","description":"Change every PDF page to A4, US Letter, Legal or a custom size, free in your browser. Text and vectors scale losslessly — no upload, no sign-up."},"comparepdf":{"path":"/compare-pdf","title":"Compare Two PDFs Free Online — Find Text Differences | YOYOPDF","description":"Compare two PDFs side by side and highlight added and removed words on every page, free in your browser. No upload, no sign-up."},"scantopdf":{"path":"/scan-to-pdf","title":"Scan to PDF Free Online — Camera & Photos to PDF | YOYOPDF","description":"Photograph pages with your camera or upload photos and build a PDF, free in your browser. No upload, no OCR, no sign-up."},"imgrotate":{"path":"/rotate-image","title":"Rotate Image Free Online — Rotate JPG, PNG, WebP | YOYOPDF","description":"Rotate images 90, 180 or 270 degrees, or any custom angle, free in your browser. Batch up to 30 images — no upload, no sign-up."}};
/* SEO_TOOL_ROUTES_END */
const PATH_TO_TOOLID = {};
for(const id in TOOL_ROUTES) PATH_TO_TOOLID[TOOL_ROUTES[id].path] = id;
/* Resolves a location.pathname to a tool id, two ways:
   1. Exact match against TOOL_ROUTES' clean paths (e.g. "/crop-pdf") -
      what production serves via _redirects, and what my own
      dev-server.py's clean-URL rewrite produces.
   2. Basename match (e.g. "crop-pdf" from ".../eazypdf/crop-pdf.html")
      - required because this app can be served from ANY root: VS Code
      Live Server's default root is the open workspace folder, which for
      this project is one level ABOVE eazypdf/, so the real served path
      is "/eazypdf/crop-pdf.html", not "/crop-pdf.html" - an exact-match
      lookup against the bare "/crop-pdf" key would silently never fire,
      which is exactly why the tool previously failed to auto-open under
      Live Server. Matching on the basename alone makes this correct
      regardless of how deep the project sits under the server root, or
      if the whole eazypdf/ folder is moved somewhere else entirely. */
function toolIdForPath(pathname){
  const clean = pathname.replace(/\.html$/i, "") || "/";
  return PATH_TO_TOOLID[clean] || PATH_TO_TOOLID["/" + clean.split("/").pop()];
}
const HOME_TITLE = document.title;
const HOME_DESCRIPTION = document.querySelector('meta[name="description"]').content;
const HOME_CANONICAL = 'https://yoyopdf.com/';
function setPageMeta(title, description, canonicalPath){
  document.title = title;
  const descTag = document.querySelector('meta[name="description"]');
  if(descTag) descTag.content = description;
  let canonicalTag = document.querySelector('link[rel="canonical"]');
  if(canonicalTag) canonicalTag.href = 'https://yoyopdf.com' + (canonicalPath==='/' ? '/' : canonicalPath);
}
/* Carries File objects across a REAL page navigation (see openTool()
   below) - sessionStorage/localStorage can only hold strings, and every
   tool-to-tool navigation now loads that tool's own physical .html page
   (a full document reload) rather than staying on the same document, so
   passing a file forward needs something that survives that reload.
   IndexedDB is the only browser-native store that can hold a File/Blob.
   Single-slot, single-use: stash() overwrites whatever was there, and
   consume() deletes the entry the instant it's read - a stale or
   duplicate bridge can never fire twice or leak into a later, unrelated
   navigation. Best-effort throughout: if IndexedDB is unavailable
   (private browsing in some browsers, etc.) the target tool just opens
   empty, same as any other fresh visit - never a hard failure. */
const FileBridge = {
  DB_NAME: "yoyopdf-bridge", STORE: "files", KEY: "pending",
  _open(){
    return new Promise((resolve, reject)=>{
      if(!window.indexedDB){ reject(new Error("no indexedDB")); return; }
      const req = indexedDB.open(this.DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this.STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async stash(files){
    try{
      const db = await this._open();
      await new Promise((resolve, reject)=>{
        const tx = db.transaction(this.STORE, "readwrite");
        tx.objectStore(this.STORE).put(files, this.KEY);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close();
    }catch(e){ /* best-effort - see comment above */ }
  },
  async consume(){
    try{
      const db = await this._open();
      const files = await new Promise((resolve, reject)=>{
        const tx = db.transaction(this.STORE, "readwrite");
        const store = tx.objectStore(this.STORE);
        const getReq = store.get(this.KEY);
        getReq.onsuccess = () => { store.delete(this.KEY); resolve(getReq.result || null); };
        getReq.onerror = () => reject(getReq.error);
      });
      db.close();
      return files;
    }catch(e){ return null; }
  },
  /* Drops any pending entry WITHOUT reading it. stash() is only ever
     paired with a consume() on the very next page load, so an entry that
     is still sitting here on any OTHER load means that bridge navigation
     never completed (tab closed mid-hop, navigation abandoned, the
     ?bridge=1 query lost) - i.e. a File the user never asked to carry
     forward, left in persistent storage indefinitely. That matters most
     under file://, where every local document shares one origin and this
     store outlives the tab, so a single abandoned bridge could keep a
     stale File reachable on later visits. Called on every tool load that
     is NOT an explicit bridge consume (see the init block at the bottom
     of this file), which is what guarantees "direct open == brand-new
     first visit, no carry-over, ever". */
  async clear(){
    try{
      const db = await this._open();
      await new Promise((resolve, reject)=>{
        const tx = db.transaction(this.STORE, "readwrite");
        tx.objectStore(this.STORE).delete(this.KEY);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close();
    }catch(e){ /* best-effort - see comment above */ }
  }
};
function syncHomeRoute(replace){
  setPageMeta(HOME_TITLE, HOME_DESCRIPTION, '/');
  const method = replace ? 'replaceState' : 'pushState';
  history[method]({}, '', '/');
}
window.addEventListener('popstate', ()=>{
  const id = toolIdForPath(location.pathname);
  if(id && TOOLS[id]){
    window.__currentToolId = id;
    TOOLS[id]();
    setPageMeta(TOOL_ROUTES[id].title, TOOL_ROUTES[id].description, TOOL_ROUTES[id].path);
  } else {
    closePanel();
    setPageMeta(HOME_TITLE, HOME_DESCRIPTION, '/');
  }
});
/* Guards against the bfcache case: returning to this tab via Back/Forward
   can restore the exact in-memory DOM/JS state the tab had when it was
   left (a loaded workspace, mid-crop selection, etc.) WITHOUT re-running
   any script - none of the reset-on-load logic above runs for that case,
   since nothing actually reloaded. event.persisted is true only for a
   bfcache restore (false for a normal load, where this is a no-op since
   every TOOLS[id]() call already starts from a clean closure). Re-running
   whatever tool is currently marked open forces the same clean
   landing-first state a real fresh load would have produced. */
window.addEventListener('pageshow', (e)=>{
  if(!e.persisted) return;
  // Same hard reset the initial-load path does - a bfcache restore hands
  // back the exact heap this tab had when it was left (including a
  // populated AppSession), and no init code re-runs to clear it.
  AppSession.clear();
  const id = window.__currentToolId;
  if(id && TOOLS[id] && overlay.classList.contains('open')) TOOLS[id]();
});

/* Opens a tool. For any tool with a real physical page (everything in
   TOOL_ROUTES), this is a REAL navigation to that tool's own .html file
   - not a same-document panel swap with the address bar cosmetically
   rewritten via history.pushState. That distinction is the whole point:
   a pushState-only "navigation" leaves the ORIGINAL document (e.g.
   index.html) running underneath a URL that looks like a different page,
   so opening that exact URL fresh (new tab, bookmark, reload) under any
   server that doesn't specifically rewrite it back to index.html (Live
   Server has no such rewrite; my own dev-server.py and production's
   _redirects do) shows nothing coherent - or, worse, whatever the
   in-memory document happened to be showing at pushState time. A real
   navigation to the tool's own file has no such dependency: it's a
   plain relative link to a file sitting right next to this one, so it
   resolves identically under Live Server, dev-server.py, production, or
   file://, and lands on that file's own fresh script execution (clean
   landing state) every single time, exactly like typing the URL cold.
   Tools with no physical page (About/Donate/Contact - not in
   TOOL_ROUTES) keep the original same-document panel-open behavior,
   since there's no separate file to navigate to.
   @param {boolean} [bridgeFile] - true ONLY for the two actual "continue
     with this file" actions in the app: a Quick Action modal card (the
     modal only exists because the user just handed over a file via the
     homepage hero dropzone) and a result screen's "Continue to..." card
     (the user just finished processing this exact file and picked the
     next tool for it). Every other caller must leave this false/omitted -
     a fresh nav click is not the same thing as an explicit "carry my
     file to the next tool" action. */
function openTool(toolId, bridgeFile){
  const route = TOOL_ROUTES[toolId];
  const alreadyOnThisToolsPage = route && toolIdForPath(location.pathname) === toolId;
  if(route && !alreadyOnThisToolsPage){
    // A real navigation to the tool's own page never needs TOOLS[toolId]
    // to already be defined on THIS page - only a subset of tool scripts
    // loads per page (see build/runtime-manifest.js's per-profile script
    // bundles), so e.g. clicking "Sign PDF" from rotate-pdf.html would
    // wrongly no-op here if this required TOOLS.sign locally. The target
    // page loads its own scripts fresh, exactly like typing the URL cold.
    const targetFile = route.path.slice(1) + ".html"; // e.g. "/crop-pdf" -> "crop-pdf.html"
    if(bridgeFile && AppSession.currentFiles.length){
      const files = AppSession.currentFiles;
      AppSession.clear();
      FileBridge.stash(files).then(()=>{ location.href = targetFile + "?bridge=1"; });
    } else {
      location.href = targetFile;
    }
    return;
  }
  if(!TOOLS[toolId]) return;
  // Either a page-less tool (About/Donate/Contact) or already sitting on
  // this exact tool's own page (e.g. re-clicking the same nav item, or
  // "Start over") - no navigation needed, just re-run its init in place.
  // TOOLS[id]() always starts from a brand-new closure, so this is the
  // same clean reset a real reload would produce, just instant.
  window.__currentToolId = toolId;
  TOOLS[toolId]();
  if(!bridgeFile || !AppSession.currentFiles.length) return;
  const files = AppSession.currentFiles;
  AppSession.clear();
  requestAnimationFrame(()=>{
    const fi = document.getElementById("fi");
    if(!fi) return;
    const dt = new DataTransfer();
    files.forEach(f=>dt.items.add(f));
    fi.files = dt.files;
    fi.dispatchEvent(new Event("change"));
  });
}
