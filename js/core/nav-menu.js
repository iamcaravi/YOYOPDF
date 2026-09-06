/* ---------------- Tool registry ----------------
   Category set/labels/colors/icons are unchanged - only the ORDER of
   categories, and the order of tools within each category, changed.
   Merge PDF, Split PDF, Organize PDF and Rotate PDF are the most
   commonly used PDF-organization actions, so the "edit" category (the
   one holding those four, plus every other page-organization/editing
   tool) now leads, and those four are the first four entries within it
   - they're still fully listed, fully functional, same names/URLs/
   metadata/colors/icons, just reordered so a visitor scanning "All PDF
   Tools" (this same array flattened, both in the mega-menu columns and
   in the #toolCategories homepage grid - see below) hits them first. */
const CATEGORIES = [
  { id:"edit", title:"Edit", tools:[
    ["merge","Merge PDF"],["split","Split PDF"],["organize","Organize PDF"],["rotate","Rotate PDF"],
    ["reorder","Reorder Pages"],["deletepages","Delete Pages"],["extractpages","Extract Pages"],["addblank","Add Blank Page"],
    ["edit","Edit PDF"],["headerfooter","Add Header & Footer"],["pagenumbers","Add Page Numbers"],
    ["crop","Crop PDF"],["invertpdf","Invert PDF Colors"],["watermark","Add Watermark"],
  ]},
  { id:"security", title:"Security", tools:[
    ["protect","Protect PDF"],["unlock","Unlock PDF"],["sign","Sign PDF"],["flatten","Flatten PDF"],
    ["fillform","Fill PDF Form"],
  ]},
  { id:"optimize", title:"Optimize", tools:[
    ["compress","Compress PDF"],["imgcompress","Image Compressor"],["repair","Repair PDF"],
  ]},
  { id:"convert", title:"Convert", tools:[
    ["jpg2pdf","JPG to PDF"],["pdf2jpg","PDF to JPG"],["pdf2word","PDF to Word"],["word2pdf","Word to PDF"],
    ["pdf2excel","PDF to Excel"],["excel2pdf","Excel to PDF"],["pdf2pptx","PDF to PowerPoint"],["mergeexcel","Merge Excel"],
  ]},
  { id:"images", title:"Images", tools:[
    ["imgconvert","Convert Image Format"],["imgresize","Resize Image"],["imgcrop","Crop Image"],
    ["imgwatermark","Add Watermark to Image"],["imginvert","Invert Image Colors"],
  ]},
];

/* Curated "Popular" shortcuts — references existing tool ids only, no duplicated tool data */
const POPULAR_IDS = ["pdf2word","pdf2excel","excel2pdf","jpg2pdf","compress","split","merge"];

const CATEGORY_META = {
  popular:  { color:"#FFD60A" },
  convert:  { color:"#00E5FF" },
  edit:     { color:"#FF7A1A" },
  optimize: { color:"#9CFF00" },
  security: { color:"#A855F7" },
  images:   { color:"#FF3EC9" },
  ai:       { color:"#FFD60A" },
};

/* Small emoji glyphs for mega-menu / mobile-accordion category headers (purely decorative, no new tool data) */
const CATEGORY_ICON_EMOJI = {
  convert:"🔄", edit:"✏️", optimize:"⚡", security:"🔒", images:"🖼️", ai:"✨",
};

/* Single source of truth for the "coming soon" AI tools — reused by the tools grid AND the mega menu / mobile accordion */
const AI_TOOLS = [
  { name:"AI Chat with PDF", icon:"✨", desc:"Ask questions and get answers straight from your document." },
  { name:"AI Summarize",     icon:"📝", desc:"Get a quick summary of long documents in seconds." },
];

const DESCRIPTIONS = {
  merge:"Combine multiple PDFs into one file, in the order you choose.",
  split:"Break a PDF into separate pages or custom page ranges.",
  compress:"Shrink file size down to an exact KB target you set.",
  pdf2jpg:"Turn every page of a PDF into a JPG image.",
  jpg2pdf:"Combine one or more images into a single PDF.",
  pdf2word:"Pull the text out of a PDF into an editable Word file.",
  word2pdf:"Convert a Word document's text into a clean PDF.",
  pdf2excel:"Extract PDF content into rows and columns in Excel.",
  excel2pdf:"Turn every worksheet into one paginated table PDF.",
  mergeexcel:"Combine multiple Excel workbooks into one, keeping each sheet's layout and formatting.",
  organize:"Preview every page and drag together a new page order.",
  rotate:"Rotate every page 90°, 180° or 270° in one click.",
  crop:"Trim margins from every page of a PDF.",
  deletepages:"Remove specific pages from a PDF.",
  extractpages:"Pull out only the pages you need into a new PDF.",
  addblank:"Insert a blank page anywhere in your document.",
  reorder:"Rearrange pages into any order you like.",
  pagenumbers:"Stamp page numbers onto every page.",
  watermark:"Overlay custom watermark text across every page.",
  headerfooter:"Add a running header and footer to every page.",
  invertpdf:"Flip every page to a negative / dark-mode style palette.",
  flatten:"Lock form fields permanently into the page content.",
  sign:"Draw a signature and place it anywhere on the page.",
  fillform:"Fill out fillable form fields and save the result.",
  imgcompress:"Shrink an image down to an exact KB target.",
  imgresize:"Resize an image to exact width and height.",
  imgcrop:"Crop an image to a precise pixel region.",
  imgconvert:"Convert an image between PNG, JPG and WebP.",
  imgwatermark:"Overlay custom watermark text on an image.",
  imginvert:"Flip an image's colors to a negative palette.",
  edit:"Add text, images and shapes to a PDF directly in your browser.",
  protect:"Add a password so only people who know it can open this PDF.",
  unlock:"Remove a password from a PDF you already know the password to.",
  repair:"Recover a PDF that won't open properly or has a broken structure.",
  pdf2pptx:"Turn every page of a PDF into its own PowerPoint slide.",
};
const ICONS = {
  pdf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v5h5"/></svg>`,
  img:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-4 4-3-3-5 5"/></svg>`,
};

/* Dedicated, tool-specific icons — single source of truth reused everywhere a tool
   icon is rendered (grid cards, "All PDF Tools" mega menu, "Convert PDF" menu,
   mobile accordion, and search results). Never falls back to a generic document
   icon when a real one is defined here.
   Sub-elements that css/site.css's "Tool-card icon animations" section
   animates on card hover/press carry a class (i-a/i-b/i-pg/i-content/etc) -
   purely a CSS animation hook, no effect on the static icon's appearance or
   layout. Every icon still communicates its tool with zero animation. */
const TOOL_ICONS = {
  merge:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><g class="i-a"><rect x="2" y="5" width="9" height="13" rx="1.4"/><path d="M5 9h3M5 12h3M5 15h2"/></g><g class="i-b"><rect x="13" y="5" width="9" height="13" rx="1.4"/><path d="M16 9h3M16 12h3M16 15h2"/></g></svg>`,
  split:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><g class="i-a"><path d="M11 3H8a1 1 0 00-1 1v16a1 1 0 001 1h3z"/><path d="M9 8h1M9 12h1M9 16h1"/></g><g class="i-b"><path d="M13 3h3a1 1 0 011 1v16a1 1 0 01-1 1h-3z"/><path d="M14 8h1M14 12h1M14 16h1"/></g></svg>`,
  organize:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect class="i-tl" x="3" y="3" width="7" height="7" rx="1.2"/><rect class="i-tr" x="14" y="3" width="7" height="7" rx="1.2"/><rect class="i-bl" x="3" y="14" width="7" height="7" rx="1.2"/><rect class="i-br" x="14" y="14" width="7" height="7" rx="1.2"/></svg>`,
  rotate:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect class="i-pg" x="7" y="6" width="10" height="12" rx="1.4"/><path class="i-arrow" d="M3 12a9 9 0 1 1 3.2 6.9"/><path class="i-arrow" d="M3 21v-6h6"/></svg>`,
  crop:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path class="i-tl" d="M6 2v14a2 2 0 002 2h14"/><path class="i-br" d="M18 22V8a2 2 0 00-2-2H2"/></svg>`,
  deletepages:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><g class="i-lid"><path d="M4 7h16"/><path d="M9 7V4h6v3"/></g><g class="i-body"><path d="M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13"/><path d="M10 11v6M14 11v6"/></g></svg>`,
  extractpages:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><g class="i-arrow"><path d="M12 17V9"/><path d="M9 12l3-3 3 3"/></g></svg>`,
  addblank:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v5h5"/><g class="i-plus"><path d="M12 11v6M9 14h6"/></g></svg>`,
  reorder:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><g class="i-a"><rect x="4" y="4" width="12" height="6" rx="1.2"/></g><g class="i-b"><rect x="6" y="9" width="12" height="6" rx="1.2"/></g><g class="i-c"><rect x="4" y="14" width="12" height="6" rx="1.2"/></g></svg>`,
  pagenumbers:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><g class="i-num"><path d="M9 15h1.5M9 15v4M9 17h1.5M13 15l1 4M14 15l1 4M13 19l1-4"/></g></svg>`,
  watermark:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v5h5"/><path class="i-drop" d="M12 9.5s3 3.1 3 5.4a3 3 0 01-6 0c0-2.3 3-5.4 3-5.4z" opacity="0.55"/></svg>`,
  headerfooter:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="1.5"/><path class="i-top" d="M3 7h18"/><path class="i-bot" d="M3 17h18"/></svg>`,
  invertpdf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path class="i-half" d="M12 3a9 9 0 010 18z" fill="currentColor" stroke="none"/></svg>`,
  compress:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path class="i-tl" d="M9 3v4a1 1 0 01-1 1H4"/><path class="i-tr" d="M20 8h-4a1 1 0 01-1-1V3"/><path class="i-br" d="M15 21v-4a1 1 0 011-1h4"/><path class="i-bl" d="M4 16h4a1 1 0 011 1v4"/></svg>`,
  flatten:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><g class="i-a"><rect x="5" y="3" width="13" height="7" rx="1.3"/></g><g class="i-b"><rect x="5" y="8.5" width="13" height="7" rx="1.3"/></g><g class="i-c"><rect x="5" y="14" width="13" height="7" rx="1.3"/></g></svg>`,
  sign:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path class="i-sig" d="M3 17c2-1 3-3 3.5-5C7.5 8 9 6 10.5 8c1 1.4-.5 4-2 5.5 2 1 4-1 5.5-2.7C15.5 9 17.5 8 18 10s-1 3-1 3"/><path class="i-pen" d="M14 20l6-6-2-2-6 6z"/></svg>`,
  fillform:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8 8h8M8 12h5"/><path class="i-check" pathLength="1" d="M8 16.5l1.5 1.5L13 14"/></svg>`,
  edit:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v5h5"/><path class="i-pencil" d="M8.5 15.2l5-5 1.8 1.8-5 5H8.5v-1.8z"/></svg>`,
  pdf2word:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path class="i-content" d="M8 13l1.4 6L11 15l1.6 4L14 13"/></svg>`,
  word2pdf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path class="i-content" d="M8 13l1.4 6L11 15l1.6 4L14 13"/></svg>`,
  pdf2excel:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path class="i-content" d="M8.5 13l6 6M14.5 13l-6 6"/></svg>`,
  excel2pdf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path class="i-content" d="M8.5 13l6 6M14.5 13l-6 6"/></svg>`,
  mergeexcel:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path class="i-content" d="M8 12h8M8 16h5"/></svg>`,
  pdf2jpg:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="14" height="11" rx="1.5"/><circle cx="7" cy="9" r="1.1"/><path class="i-content" d="M3 14l4-3.5 3 2.5 3.5-3L17 13"/></svg>`,
  jpg2pdf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="14" height="11" rx="1.5"/><circle cx="7" cy="9" r="1.1"/><path class="i-content" d="M3 14l4-3.5 3 2.5 3.5-3L17 13"/></svg>`,
  imgresize:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="12" height="12" rx="1.5"/><path class="i-arrow" d="M14 21l7-7M17 21h4v-4"/></svg>`,
  imgcrop:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path class="i-tl" d="M6 2v14a2 2 0 002 2h14"/><path class="i-br" d="M18 22V8a2 2 0 00-2-2H2"/></svg>`,
  imgconvert:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path class="i-content" d="M21 16l-5-5-4 4-3-3-5 5"/></svg>`,
  imgwatermark:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path class="i-drop" d="M12 8.5s3 3 3 5.3a3 3 0 01-6 0c0-2.3 3-5.3 3-5.3z" opacity="0.6"/></svg>`,
  imginvert:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path class="i-half" d="M12 4a8 8 0 010 16z" fill="currentColor" stroke="none"/></svg>`,
  imgcompress:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><g class="i-tl"><path d="M9 10V8h2" stroke-linecap="round"/><path d="M9 8l3 3"/></g><g class="i-br"><path d="M15 14v2h-2" stroke-linecap="round"/><path d="M15 16l-3-3"/></g></svg>`,
  protect:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="10" rx="1.5"/><path class="i-shackle" d="M8 11V7a4 4 0 018 0v4"/></svg>`,
  unlock:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="10" rx="1.5"/><path class="i-shackle" d="M8 11V7a4 4 0 017.6-1.8"/></svg>`,
  repair:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path class="i-wrench" d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2-2 2.6-2.6z"/><path class="i-spark" d="M18.5 3l.5 1.4L20.4 5l-1.4.5-.5 1.4-.5-1.4L16.6 5l1.4-.6z" fill="currentColor" stroke="none" opacity="0"/></svg>`,
  pdf2pptx:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path class="i-content" d="M9 17V9h2.5a2 2 0 010 4H9"/></svg>`,
};
function iconFor(id){
  if(TOOL_ICONS[id]) return TOOL_ICONS[id];
  if(id.includes("img")) return ICONS.img;
  return ICONS.pdf;
}

/* Distinctive badge icons for format-conversion tools, similar to iLovePDF's stacked file+badge look */
const TOOL_BADGES = {
  pdf2word:  {label:"W",   color:"#2E5FD9"},
  word2pdf:  {label:"W",   color:"#2E5FD9"},
  pdf2excel: {label:"X",   color:"#1E8E3E"},
  excel2pdf: {label:"X",   color:"#1E8E3E"},
  mergeexcel:{label:"X",   color:"#1E8E3E"},
  pdf2jpg:   {label:"JPG", color:"#F59E0B"},
  jpg2pdf:   {label:"JPG", color:"#F59E0B"},
  imgconvert:{label:"IMG", color:"#F764B0"},
  sign:      {label:"✒",   color:"#0E8C74"},
  fillform:  {label:"✒",   color:"#0E8C74"},
  pdf2pptx:  {label:"PPT", color:"#D24625"},
};
/* Bright category swatches (neon lime/yellow) need a dark glyph instead of the
   CSS default white stroke, or the icon disappears into its own background -
   plain WCAG relative-luminance check against a hex color. */
function inkForBg(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if(!m) return "#fff";
  const n = parseInt(m[1], 16);
  const [r,g,b] = [(n>>16)&255, (n>>8)&255, n&255].map(c=>{
    c/=255; return c<=0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
  });
  const luminance = 0.2126*r + 0.7152*g + 0.0722*b;
  return luminance > 0.5 ? "#0A0A0A" : "#fff";
}
/* i18n helpers: prefer the current language's translation, fall back to
   the English name already in CATEGORIES/cat.title if I18N isn't loaded
   yet or a key is missing - so this file works identically whether or
   not js/core/i18n.js ran first. */
function toolName(id, fallback){ return window.I18N ? I18N.t("tools."+id) : fallback; }
function catName(cat){ return window.I18N ? I18N.t("categories."+cat.id) : cat.title; }
function renderIcon(id, categoryColor){
  const b = TOOL_BADGES[id];
  if(b){
    const fs = b.label.length>1 ? "8.5px" : "14px";
    return `<div class="icon-stack">
      <div class="icon-base">${iconFor(id)}</div>
      <div class="icon-corner" style="background:${b.color};font-size:${fs};color:${inkForBg(b.color)}">${b.label}</div>
    </div>`;
  }
  return `<div class="icon" style="background:${categoryColor};color:${inkForBg(categoryColor)}">${iconFor(id)}</div>`;
}

/* ---------------- Render tool cards (single master list, one card per tool) ---------------- */
function cardHTML(id, name, color, catId, isPopular){
  const cats = [catId, isPopular ? "popular" : ""].filter(Boolean).join(" ");
  return `
    <div class="card" data-tool="${id}" data-cat="${cats}">
      ${renderIcon(id, color)}
      <div class="name" data-i18n="tools.${id}">${name}</div>
      <div class="desc" data-i18n="toolDesc.${id}">${DESCRIPTIONS[id]||""}</div>
    </div>`;
}
const toolCategoriesEl = document.getElementById("toolCategories");
const POPULAR_SET = new Set(POPULAR_IDS);

/* Homepage tool-card grid order: the most commonly used PDF-organization
   tools first (Merge, Split, Organize, Rotate), then the rest of the
   page-organization tools, then Edit, Security, Optimize, Convert and
   Image tools, in that category order. Explicitly lists every tool id
   from CATEGORIES so the grid order matches this exact sequence; any
   tool id from CATEGORIES not listed here (there shouldn't be one)
   would simply sort after all of these, in its original CATEGORIES
   order (stable sort below) - so every tool still renders exactly
   once, nothing is dropped. */
const HOME_GRID_ORDER = [
  "merge","split","organize","rotate","reorder","deletepages","extractpages","addblank",
  "edit","headerfooter","pagenumbers","crop","fillform","invertpdf","watermark",
  "protect","unlock","sign","flatten",
  "compress","imgcompress","repair",
  "jpg2pdf","pdf2jpg","pdf2word","word2pdf","pdf2excel","excel2pdf","pdf2pptx","mergeexcel",
  "imgconvert","imgresize","imgcrop","imgwatermark","imginvert",
];
const homeOrderIndex = new Map(HOME_GRID_ORDER.map((id,i)=>[id,i]));

/* Single source of truth: each tool from CATEGORIES is rendered exactly once, tagged with its
   real category (and "popular" too, if applicable) so filtering never has to duplicate a card.
   Names carry a data-i18n tag (see cardHTML) so I18N.applyAll() can relabel them on language
   change without rebuilding the whole grid (which would drop scroll-reveal/hover-fx state). */
let gridHtml = "";
const flatTools = [];
CATEGORIES.forEach(cat=>{
  const meta = CATEGORY_META[cat.id] || {color:"linear-gradient(135deg,#FF7A18,#E8291B)"};
  cat.tools.forEach(([id,name])=>{
    flatTools.push({ id, name, color:meta.color, catId:cat.id });
  });
});
flatTools
  .slice()
  .sort((a,b)=>(homeOrderIndex.has(a.id)?homeOrderIndex.get(a.id):Infinity) - (homeOrderIndex.has(b.id)?homeOrderIndex.get(b.id):Infinity))
  .forEach(t=>{
    gridHtml += cardHTML(t.id, toolName(t.id, t.name), t.color, t.catId, POPULAR_SET.has(t.id));
  });

/* AI — future category placeholder, no live tools yet. Rendered from the shared AI_TOOLS list. */
gridHtml += AI_TOOLS.map(t=>`
  <div class="card ai-card" data-cat="ai">
    <div class="icon" style="background:${CATEGORY_META.ai.color}">${t.icon}</div>
    <div class="name">${t.name} <span class="coming-soon-badge">Soon</span></div>
    <div class="desc">${t.desc}</div>
    <div class="open-link">Coming soon</div>
  </div>`).join("");

toolCategoriesEl.innerHTML = `<div class="grid" id="toolsGrid">${gridHtml}</div>`;

/* ---------------- Hero atomic orbit tool shortcuts ----------------
   Real functional shortcuts orbiting the hero upload card like
   electrons around a nucleus - NOT decorative icons. Each button
   carries data-tool="<id>" (the exact same attribute + id values
   CATEGORIES/cardHTML above already use for the "Popular PDF Tools"
   cards) and nothing else: the existing global [data-tool] click
   delegation in js/core/panel.js already calls openTool(id) for any
   element with this attribute, so these buttons need zero new
   click-handling code and automatically get the same real
   cross-document navigation, preload/glitch-fix, and active-state sync
   every other tool entry point already has. iconFor()/category-color
   data are reused as-is from the registry above - no second icon/color
   system. Only 4 tools by design (Merge, Compress, Rotate, Organize).

   TRUE CONTINUOUS ELLIPTICAL ORBITS (replaces an earlier corner-anchor
   + straight-connector-line design, rejected on visual grounds - it
   read as "four buttons near a card", not an atomic orbit). 3 tilted
   ellipses share .hero-art's center with the upload card: orbit A
   (tilt -20deg) carries TWO tools at opposite phase, orbits B (+20deg)
   and C (+5deg) carry one each - see the full geometry derivation in
   css/site.css. Each orbit exists as TWO separate layers sharing the
   same rotation/radii (decorative ring+particles behind the card,
   interactive buttons in front of it) because a CSS `transform`
   establishes a new stacking context for its descendants - z-index
   values on a ring vs. a button INSIDE the same rotated carrier can't
   be interleaved with an external sibling (the device) between them;
   splitting into two parallel carrier trees, each independently
   stacked relative to the device, is what actually lets the orbit
   LINE pass behind the card while the ICON stays in front of it. */
const HERO_ORBIT_TOOLS = [
  {id:"merge",      cls:"hot-merge",      carrier:"oc-a"},
  {id:"compress",   cls:"hot-compress",   carrier:"oc-a"},
  {id:"split",      cls:"hot-split",      carrier:"oc-a"},
  {id:"mergeexcel", cls:"hot-mergeexcel", carrier:"oc-a"},
  {id:"rotate",     cls:"hot-rotate",     carrier:"oc-b"},
  {id:"sign",       cls:"hot-sign",       carrier:"oc-b"},
  {id:"organize",   cls:"hot-organize",   carrier:"oc-c"},
  {id:"invertpdf",  cls:"hot-invertpdf",  carrier:"oc-c"},
];
// Local, dependency-free copy of pdf-processing-utils.js's escapeAttr():
// buildHeroOrbitTools() now runs synchronously as soon as this (very
// early, 3rd-loaded) script executes rather than waiting for
// DOMContentLoaded, and pdf-processing-utils.js - loaded much later in
// SCRIPT_ORDER - isn't defined yet at that point.
function heroOrbitEscapeAttr(s){ return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function buildHeroOrbitTools(){
  const heroArt = document.querySelector(".hero-art");
  if(!heroArt) return; // hero markup isn't present on every generated page
  const idToCat = {};
  CATEGORIES.forEach(cat=>{ cat.tools.forEach(([id,name])=>{ idToCat[id] = {name, color:(CATEGORY_META[cat.id]||{}).color}; }); });
  // Decorative layer (z-index BELOW the device - see css) - one ring +
  // 5 drifting particles per orbit (15 total), always rendered
  // regardless of which tools exist, since it's purely visual.
  const ringsWrap = document.createElement("div");
  ringsWrap.className = "hero-orbit-rings";
  ringsWrap.innerHTML = ["a","b","c"].map(k=>`
    <div class="hero-orbit-carrier oc-${k}" aria-hidden="true">
      <div class="hero-orbit-ring"></div>
      <span class="hero-orbit-particle hop-${k}-1"></span>
      <span class="hero-orbit-particle hop-${k}-2"></span>
      <span class="hero-orbit-particle hop-${k}-3"></span>
      <span class="hero-orbit-particle hop-${k}-4"></span>
      <span class="hero-orbit-particle hop-${k}-5"></span>
    </div>
  `).join("");
  // Interactive layer (z-index ABOVE the device) - real [data-tool]
  // buttons, grouped into the SAME 3 carriers by rotation/radii (see
  // .oc-a/.oc-b/.oc-c in css) so each button's offset-path ellipse
  // agrees exactly with its decorative twin.
  const carriers = {a:[], b:[], c:[]};
  HERO_ORBIT_TOOLS.forEach(({id, cls, carrier})=>{
    const meta = idToCat[id];
    if(!meta) return; // only ever render a tool that actually exists in the registry
    const color = meta.color || "#9CFF00";
    // --hot-color is data only (per-tool color, used by dark theme's
    // colorful icons); CSS drives the actual background/color from it,
    // so light theme's CSS can override to a single uniform blue without
    // fighting an inline style (see [data-theme="light"] .hot-icon).
    const key = carrier.slice(-1); // "oc-a" -> "a"
    const localizedName = toolName(id, meta.name);
    carriers[key].push(`<button type="button" class="hero-orbit-tool ${cls}" data-tool="${id}" aria-label="Open ${heroOrbitEscapeAttr(localizedName)}">
      <span class="hot-icon" style="--hot-color:${color}">${iconFor(id)}</span>
      <span class="hot-tooltip" data-i18n="tools.${id}" aria-hidden="true">${localizedName}</span>
    </button>`);
  });
  const orbitsHTML = Object.keys(carriers).map(k=>
    carriers[k].length ? `<div class="hero-orbit-carrier oc-${k}">${carriers[k].join("")}</div>` : ""
  ).join("");
  if(!orbitsHTML) return; // no tool exists on this page - skip both layers
  heroArt.appendChild(ringsWrap);
  const orbitsWrap = document.createElement("div");
  orbitsWrap.className = "hero-orbits";
  orbitsWrap.innerHTML = orbitsHTML;
  heroArt.appendChild(orbitsWrap);
}
// Runs immediately, not on DOMContentLoaded: this is a `defer` script, so
// the DOM (including .hero-art) is already fully parsed by the time it
// executes - waiting for DOMContentLoaded instead would delay this until
// every OTHER deferred script has also finished (on the homepage, that's
// the full ~20-file runtime, tool implementations included), leaving a
// visible gap where the hero paints without its orbit rings/buttons and
// then they pop in a moment later. Since the tool metadata this needs
// (name/color/icon via CATEGORIES/CATEGORY_META/iconFor/toolName) all
// lives in this same file rather than in the not-yet-loaded tool
// implementation files, there's nothing left to wait for.
buildHeroOrbitTools();

/* ---------------- Mega Menu ("All PDF Tools") — desktop hover panel + mobile accordion.
   Both are generated dynamically from CATEGORIES / AI_TOOLS, so any future tool added to the
   registry automatically appears here with zero extra markup. ---------------- */
function megaColumnHTML(cat){
  const meta = CATEGORY_META[cat.id] || {color:"linear-gradient(135deg,#FF7A18,#E8291B)"};
  const emoji = CATEGORY_ICON_EMOJI[cat.id] || "📄";
  return `
    <div class="mega-col">
      <div class="mega-col-head">
        <span class="mega-col-icon" style="background:${meta.color}">${emoji}</span>
        <h4>${catName(cat)}</h4>
      </div>
      <div class="mega-col-list">
        ${cat.tools.map(([id,name])=>`<button type="button" data-open="${id}"><span class="mega-tool-icon">${iconFor(id)}</span>${toolName(id,name)}</button>`).join("")}
      </div>
    </div>`;
}
function megaAiColumnHTML(){
  const emoji = CATEGORY_ICON_EMOJI.ai;
  return `
    <div class="mega-col">
      <div class="mega-col-head">
        <span class="mega-col-icon" style="background:${CATEGORY_META.ai.color}">${emoji}</span>
        <h4>AI Tools <span class="coming-soon-badge">Soon</span></h4>
      </div>
      <div class="mega-col-list">
        ${AI_TOOLS.map(t=>`<button type="button" disabled title="Coming soon"><span class="mega-tool-icon">${t.icon}</span>${t.name}</button>`).join("")}
      </div>
    </div>`;
}
const megaMenuEl = document.getElementById("megaMenu");
const convertMenuEl = document.getElementById("convertMenu");
function renderMegaAndConvertMenus(){
  if(megaMenuEl){
    megaMenuEl.innerHTML = `<div class="mega-grid">${CATEGORIES.map(megaColumnHTML).join("")}${megaAiColumnHTML()}</div>`;
  }
  /* "Convert PDF" menu — sourced from the same CATEGORIES.convert list as the mega
     menu, so adding a conversion tool there automatically shows up here too. */
  if(convertMenuEl){
    const convertCat = CATEGORIES.find(c=>c.id==="convert");
    if(convertCat){
      convertMenuEl.innerHTML = convertCat.tools.map(([id,name])=>
        `<button type="button" role="menuitem" data-open="${id}"><span class="mega-tool-icon">${iconFor(id)}</span>${toolName(id,name)}</button>`
      ).join("");
    }
  }
}
renderMegaAndConvertMenus();

function mobileMegaCatHTML(cat){
  const meta = CATEGORY_META[cat.id] || {color:"linear-gradient(135deg,#FF7A18,#E8291B)"};
  const emoji = CATEGORY_ICON_EMOJI[cat.id] || "📄";
  return `
    <div class="mm-cat" data-mm-cat="${cat.id}">
      <button type="button" class="mm-cat-head">
        <span class="mm-cat-icon" style="background:${meta.color}">${emoji}</span>
        <span class="mm-cat-title">${catName(cat)}</span>
        <svg class="mm-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="mm-cat-body">
        <div class="mm-cat-body-inner">
          ${cat.tools.map(([id,name])=>`<button type="button" class="mm-tool" data-open="${id}"><span class="mm-tool-icon">${iconFor(id)}</span>${toolName(id,name)}</button>`).join("")}
        </div>
      </div>
    </div>`;
}
function mobileMegaAiHTML(){
  return `
    <div class="mm-cat" data-mm-cat="ai">
      <button type="button" class="mm-cat-head">
        <span class="mm-cat-icon" style="background:${CATEGORY_META.ai.color}">${CATEGORY_ICON_EMOJI.ai}</span>
        <span class="mm-cat-title">AI Tools <span class="coming-soon-badge">Soon</span></span>
        <svg class="mm-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="mm-cat-body">
        <div class="mm-cat-body-inner">
          ${AI_TOOLS.map(t=>`<button type="button" class="mm-tool" disabled>${t.icon} ${t.name}</button>`).join("")}
        </div>
      </div>
    </div>`;
}
const mobileMegaEl = document.getElementById("mobileMega");
function renderMobileMega(){
  if(mobileMegaEl){
    mobileMegaEl.innerHTML = `<div class="mm-inner">${CATEGORIES.map(mobileMegaCatHTML).join("")}${mobileMegaAiHTML()}</div>`;
  }
}
renderMobileMega();

/* Re-render every JS-built menu that embeds tool/category names as
   literal text (mega menu, convert menu, mobile mega) when the language
   changes. The homepage tool grid doesn't need this - its card names
   carry data-i18n and are relabeled by I18N.applyAll() itself. Rebuilding
   these three is safe because every click they handle is delegated
   ([data-open] is caught globally in panel.js), so there are no
   per-button listeners here to lose on innerHTML replacement. */
document.addEventListener("yoyopdf:langchange", ()=>{
  renderMegaAndConvertMenus();
  renderMobileMega();
});

/* Top-level "All PDF Tools" accordion toggle (mobile) */
document.getElementById("mobileAllToolsToggle")?.addEventListener("click", (e)=>{
  e.stopPropagation();
  const btn = e.currentTarget;
  const panel = document.getElementById("mobileMega");
  if(!panel) return;
  const isOpen = panel.classList.toggle("open");
  btn.classList.toggle("expanded", isOpen);
  btn.setAttribute("aria-expanded", String(isOpen));
});

/* Per-category accordion toggles inside the mobile "All PDF Tools" panel */
document.getElementById("mobileMega")?.addEventListener("click", (e)=>{
  const head = e.target.closest(".mm-cat-head");
  if(!head) return;
  head.parentElement.classList.toggle("mm-open");
});

/* ---------------- Live tool search (desktop navbar + mobile menu) ----------------
   Reuses the existing CATEGORIES / DESCRIPTIONS / CATEGORY_META / renderIcon data —
   no separate tool list is created, so the registry stays the single source of truth. */
const CATEGORY_LABELS = {};
document.querySelectorAll("[data-filter]").forEach(btn=>{
  if(btn.dataset.filter && btn.dataset.filter!=="all" && !CATEGORY_LABELS[btn.dataset.filter]){
    CATEGORY_LABELS[btn.dataset.filter] = btn.textContent.trim();
  }
});
const SEARCH_INDEX = [];
CATEGORIES.forEach(cat=>{
  const meta = CATEGORY_META[cat.id] || {color:"linear-gradient(135deg,#FF7A18,#E8291B)"};
  cat.tools.forEach(([id,name])=>{
    SEARCH_INDEX.push({ id, name, cat: cat.id, catLabel: CATEGORY_LABELS[cat.id] || cat.title, desc: DESCRIPTIONS[id]||"", color: meta.color });
  });
});
function searchTools(q){
  q = q.trim().toLowerCase();
  if(!q) return [];
  return SEARCH_INDEX.filter(t =>
    t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q)
  ).slice(0, 8);
}
function resultRowHTML(t){
  return `<button type="button" data-search-tool="${t.id}">
    <span class="sr-icon" style="background:${t.color};color:#fff">${iconFor(t.id)}</span>
    <span class="sr-text"><span class="sr-name">${t.name}</span><span class="sr-cat">${t.catLabel}</span></span>
  </button>`;
}
function wireSearchBox(inputId, resultsId, {dropdownStyle}={}){
  const input = document.getElementById(inputId);
  const results = document.getElementById(resultsId);
  if(!input || !results) return;
  function render(){
    const matches = searchTools(input.value);
    if(!input.value.trim()){
      results.innerHTML = "";
      if(dropdownStyle) results.classList.remove("open");
      return;
    }
    results.innerHTML = matches.length
      ? matches.map(resultRowHTML).join("")
      : `<div class="sr-empty">No tools match “${escapeAttr(input.value.trim())}”</div>`;
    if(dropdownStyle) results.classList.add("open");
    results.querySelectorAll("[data-search-tool]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        TOOLS[btn.dataset.searchTool] && TOOLS[btn.dataset.searchTool]();
        input.value = "";
        results.innerHTML = "";
        if(dropdownStyle) results.classList.remove("open");
        document.getElementById("mobileMenu")?.classList.remove("open");
      });
    });
  }
  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("keydown", e=>{
    if(e.key==="Enter"){
      const first = searchTools(input.value)[0];
      if(first){ TOOLS[first.id] && TOOLS[first.id](); input.value=""; results.innerHTML=""; if(dropdownStyle) results.classList.remove("open"); }
    } else if(e.key==="Escape"){
      input.value=""; results.innerHTML=""; if(dropdownStyle) results.classList.remove("open"); input.blur();
    }
  });
  if(dropdownStyle){
    input.addEventListener("click", e=>e.stopPropagation());
    results.addEventListener("click", e=>e.stopPropagation());
  }
}
wireSearchBox("navSearchInput", "navSearchResults", {dropdownStyle:true});
wireSearchBox("mobileSearchInput", "mobileSearchResults", {});
document.addEventListener("click", ()=>{
  document.getElementById("navSearchResults")?.classList.remove("open");
});

/* ---------------- Category-tab / dropdown / mobile-menu filtering ----------------
   One master grid (#toolsGrid) is the only source of truth: filtering just
   fades individual cards in or out based on their data-cat tag(s). */
function applyFilter(f){
  document.querySelectorAll(".cat-tab").forEach(t=>t.classList.toggle("active", t.dataset.filter===f));

  const grid = document.getElementById("toolsGrid");
  if(!grid) return;

  // Category buttons must stay responsive even mid-animation: cancel any
  // in-flight timers/frames from a previous switch and instantly resolve
  // whatever card was mid fade-out/fade-in, so we always start this switch
  // from a clean, unambiguous baseline (no cards left stuck transparent).
  if(grid._filterTimers){ grid._filterTimers.forEach(clearTimeout); }
  if(grid._filterRafs){ grid._filterRafs.forEach(cancelAnimationFrame); }
  grid._filterTimers = [];
  grid._filterRafs = [];

  const cards = Array.from(grid.querySelectorAll(".card"));
  cards.forEach(card=>{
    if(card.classList.contains("card-hidden")){ card.style.display = "none"; card.classList.remove("card-hidden"); }
    card.classList.remove("card-entering");
  });

  const shouldShow = card=>{
    const cats = (card.dataset.cat||"").split(" ").filter(Boolean);
    return (f==="all") || cats.includes(f);
  };
  const toHide = cards.filter(card=> !shouldShow(card) && card.style.display !== "none");
  const toShow = cards.filter(card=> shouldShow(card) && card.style.display === "none");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(reduceMotion){
    cards.forEach(card=>{ card.style.display = shouldShow(card) ? "" : "none"; });
    grid.style.height = "";
    return;
  }

  if(!toHide.length && !toShow.length) return;

  // Lock the grid at its current on-screen height so removing/adding cards
  // never causes an instant jump — it animates to the new height instead.
  const H1 = grid.getBoundingClientRect().height;
  grid.style.height = H1 + "px";

  // Step 1 — fade out + slide up the cards that are leaving (180ms).
  toHide.forEach(card=> card.classList.add("card-hidden"));

  const afterFadeOut = setTimeout(()=>{
    toHide.forEach(card=>{ card.style.display = "none"; card.classList.remove("card-hidden"); });

    // Reveal the entering cards (still transparent) so the grid's natural
    // height reflects the final visible set, then measure it.
    toShow.forEach(card=>{ card.style.display = ""; card.classList.add("card-entering"); });
    grid.style.height = "auto";
    const H2 = grid.getBoundingClientRect().height;
    grid.style.height = H1 + "px";
    void grid.offsetHeight; // force reflow so the height change below actually transitions

    const raf1 = requestAnimationFrame(()=>{
      grid.style.height = H2 + "px";
      // Step 2 — fade in + slide up the entering cards (180ms), in step with the height animation.
      const raf2 = requestAnimationFrame(()=>{
        toShow.forEach(card=> card.classList.remove("card-entering"));
      });
      grid._filterRafs.push(raf2);
    });
    grid._filterRafs.push(raf1);

    // Release the fixed height once everything has settled so the grid can
    // respond naturally to window resizes / future content changes.
    const afterSettle = setTimeout(()=>{ grid.style.height = ""; }, 260);
    grid._filterTimers.push(afterSettle);
  }, 180);
  grid._filterTimers.push(afterFadeOut);
}
document.querySelectorAll("[data-filter]").forEach(el=>{
  el.addEventListener("click", ()=>{
    applyFilter(el.dataset.filter);
    if(el.closest(".nav-dd-menu") || el.closest(".mobile-menu") || el.closest(".footer-col") || el.hasAttribute("data-scroll-tools")){
      document.getElementById("tools").scrollIntoView({behavior:"smooth", block:"start"});
    }
    document.getElementById("mobileMenu")?.classList.remove("open");
  });
});

/* ---------------- Hero CTAs: "All PDF Tools" scrolls + resets filter ----
   "Edit PDF" (#heroChoosePdfBtn) no longer has its own click handler here -
   it now carries data-open="edit" (see index.html), so the existing
   global [data-open] click delegation (panel.js) opens the Edit PDF tool
   the exact same way every other data-open button/card on the site
   already does, instead of this button's previous one-off job of
   triggering the hero's own file picker (#heroFileInput) - that input is
   still fully wired to the right-side dropzone/"Choose File" mock UI
   (see js/core/hero-upload.js), unaffected by this. ---------------- */
document.getElementById("heroAllToolsBtn")?.addEventListener("click", ()=>{
  applyFilter("all");
  document.getElementById("tools").scrollIntoView({behavior:"smooth", block:"start"});
});
