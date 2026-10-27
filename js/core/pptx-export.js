/* ---------------- Minimal .pptx (OOXML presentation) builder ----------------
   Two builders share one hand-written OOXML package (content types,
   package rels, one slide master/layout/theme shared by every slide):

   1. buildPptxFromPageImages - the original approach: pdf.js rasterizes
      each page and this packages those page images as one full-bleed
      picture per slide. Still used for scanned/textless pages, where
      there is no extractable text to re-author.
   2. buildEditablePptx (below) - the default for text PDFs: the same
      document model PDF to Word/Excel use (extractPageBlocks /
      extractPageVisuals) is re-authored into real DrawingML shapes -
      editable textboxes, editable tables and real pictures at their
      source positions - so the text IS editable in PowerPoint. This
      sidesteps having to reverse-engineer raw PDF content streams: it
      reuses the geometry/style detection Word/Excel already trust,
      which no reliable client-side library otherwise provides.
   Structurally, both hand-write the smallest set of OOXML parts a real
   presentation needs rather than pulling in a whole
   presentation-authoring dependency. Every part below is boilerplate
   that's otherwise identical across every real .pptx - see each
   function for what it represents. */

function pptxEsc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function pptxContentTypesXml(slideOverridesXml, extraDefaultsXml){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
${extraDefaultsXml || ""}
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${slideOverridesXml}
</Types>`;
}
function pptxPackageRelsXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}
function pptxCoreXml(title){
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${pptxEsc(title)}</dc:title>
<dc:creator>YOYOPDF</dc:creator>
<cp:lastModifiedBy>YOYOPDF</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}
function pptxAppXml(slideCount){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>YOYOPDF</Application>
<Slides>${slideCount}</Slides>
<TitlesOfParts><vt:vector size="0" baseType="lpstr"/></TitlesOfParts>
</Properties>`;
}
function pptxPresentationXml(slideW, slideH, sldIdEntriesXml){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster1"/></p:sldMasterIdLst>
<p:sldIdLst>${sldIdEntriesXml}</p:sldIdLst>
<p:sldSz cx="${slideW}" cy="${slideH}"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}
function pptxPresentationRelsXml(slideRelEntriesXml){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slideRelEntriesXml}
</Relationships>`;
}
function pptxSlideMasterXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>
</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout1"/></p:sldLayoutIdLst>
</p:sldMaster>`;
}
function pptxSlideMasterRelsXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}
function pptxSlideLayoutXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank">
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}
function pptxSlideLayoutRelsXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}
/** Standard 12-color/2-font/3-style "Office Theme" shape - nothing in our
 * own slide content references it (every slide is one absolute-positioned
 * picture, no placeholders/theme-colored shapes), so it only needs to be
 * structurally complete, not visually tuned. */
function pptxThemeXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="YOYOPDF Theme">
<a:themeElements>
<a:clrScheme name="YOYOPDF">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1F497D"/></a:dk2>
<a:lt2><a:srgbClr val="EEECE1"/></a:lt2>
<a:accent1><a:srgbClr val="4F81BD"/></a:accent1>
<a:accent2><a:srgbClr val="C0504D"/></a:accent2>
<a:accent3><a:srgbClr val="9BBB59"/></a:accent3>
<a:accent4><a:srgbClr val="8064A2"/></a:accent4>
<a:accent5><a:srgbClr val="4BACC6"/></a:accent5>
<a:accent6><a:srgbClr val="F79646"/></a:accent6>
<a:hlink><a:srgbClr val="0000FF"/></a:hlink>
<a:folHlink><a:srgbClr val="800080"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="YOYOPDF">
<a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="YOYOPDF">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst>
<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
<a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
<a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
</a:lnStyleLst>
<a:effectStyleLst>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
</a:effectStyleLst>
<a:bgFillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>`;
}
function pptxSlideXml(x, y, cx, cy){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:pic>
<p:nvPicPr><p:cNvPr id="2" name="Page image"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
</p:pic>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}
function pptxSlideRelsXml(imageFileName){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${imageFileName}"/>
</Relationships>`;
}

/**
 * Builds a .pptx Blob from one raster image per slide.
 * @param {{blob:Blob, widthPx:number, heightPx:number}[]} pages - in slide order.
 * @param {string} [title]
 * @returns {Promise<Blob>}
 */
async function buildPptxFromPageImages(pages, title){
  if(!pages.length) throw new Error("No pages to convert");
  await ensureJSZip();
  const EMU_PER_PX = 9525; // 914400 EMU/inch / 96 px/inch
  const slideW = Math.max(1, Math.round(pages[0].widthPx * EMU_PER_PX));
  const slideH = Math.max(1, Math.round(pages[0].heightPx * EMU_PER_PX));
  const slideAspect = slideW / slideH;

  const zip = new JSZip();
  const slideOverrides = [];
  const sldIdEntries = [];
  const presRelEntries = [];
  for(let i=0;i<pages.length;i++){
    const n = i+1;
    const {widthPx, heightPx, blob} = pages[i];
    const pxAspect = widthPx / heightPx;
    let cx, cy;
    if(pxAspect > slideAspect){ cx = slideW; cy = Math.round(slideW/pxAspect); }
    else { cy = slideH; cx = Math.round(slideH*pxAspect); }
    const x = Math.round((slideW-cx)/2), y = Math.round((slideH-cy)/2);
    zip.file(`ppt/media/image${n}.jpeg`, blob);
    zip.file(`ppt/slides/slide${n}.xml`, pptxSlideXml(x, y, cx, cy));
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, pptxSlideRelsXml(`image${n}.jpeg`));
    slideOverrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    sldIdEntries.push(`<p:sldId id="${256+i}" r:id="rIdSlide${n}"/>`);
    presRelEntries.push(`<Relationship Id="rIdSlide${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`);
  }
  zip.file("[Content_Types].xml", pptxContentTypesXml(slideOverrides.join("\n")));
  zip.file("_rels/.rels", pptxPackageRelsXml());
  zip.file("docProps/core.xml", pptxCoreXml(title || "Presentation"));
  zip.file("docProps/app.xml", pptxAppXml(pages.length));
  zip.file("ppt/presentation.xml", pptxPresentationXml(slideW, slideH, sldIdEntries.join("")));
  zip.file("ppt/_rels/presentation.xml.rels", pptxPresentationRelsXml(presRelEntries.join("\n")));
  zip.file("ppt/slideMasters/slideMaster1.xml", pptxSlideMasterXml());
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", pptxSlideMasterRelsXml());
  zip.file("ppt/slideLayouts/slideLayout1.xml", pptxSlideLayoutXml());
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", pptxSlideLayoutRelsXml());
  zip.file("ppt/theme/theme1.xml", pptxThemeXml());
  return zip.generateAsync({type:"blob", mimeType:"application/vnd.openxmlformats-officedocument.presentationml.presentation"});
}

/* ---------------- Editable .pptx builder ----------------
   Same hand-written OOXML package as buildPptxFromPageImages above, but
   the slides are built from the SAME document model PDF to Word/Excel
   already use (extractPageBlocks / extractPageVisuals in
   js/core/doc-export-builders.js) instead of one raster per page: every
   paragraph becomes a real editable textbox (position, size, bold,
   italic, underline, colour and alignment preserved), every detected
   table becomes a real editable DrawingML table, and every embedded
   image (logo, QR code, photo) becomes a real picture at its source
   position. A page with no extractable text (a scanned page) is the
   only case that still becomes a full-slide picture - the caller
   supplies it as a single full-page image block, exactly like PDF to
   Word's screenshot fallback, so a scanned deck never silently loses a
   page. No server, no AI, no new dependency: JSZip only, as before. */

const PPTX_EMU_PER_PT = 12700; // 914400 EMU/inch / 72 pt/inch

function pptxColorHex(color){
  if(Array.isArray(color) && color.length >= 3){
    const c = color.slice(0,3).map(v=>Math.max(0, Math.min(255, Math.round(v))));
    return c.map(v=>v.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  if(typeof color === "string"){
    const m = color.replace(/^#/, "").match(/^[0-9A-Fa-f]{6}$/);
    if(m) return m[0].toUpperCase();
  }
  return "000000";
}
function pptxCleanText(s){
  // XML 1.0 forbids most control characters even when escaped; a PDF
  // text item can legitimately contain them, and one such byte would
  // make PowerPoint reject the whole slide.
  return String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}
function pptxRunXml(run, fallbackSizePt){
  const text = pptxCleanText(run && run.text);
  if(!text) return "";
  const sizePt = Math.max(8, Math.min(44, Number(run.size) || fallbackSizePt || 12));
  const typeface = pptxEsc((run && run.fontFamily) || "Calibri");
  const fill = `<a:solidFill><a:srgbClr val="${pptxColorHex(run && run.color)}"/></a:solidFill>`;
  return `<a:r><a:rPr lang="en-US" sz="${Math.round(sizePt*100)}"${run && run.bold ? " b=\"1\"" : ""}${run && run.italic ? " i=\"1\"" : ""}${run && run.underline ? " u=\"sng\"" : ""}>${fill}<a:latin typeface="${typeface}"/><a:ea typeface="${typeface}"/><a:cs typeface="${typeface}"/></a:rPr><a:t>${pptxEsc(text)}</a:t></a:r>`;
}
function pptxAlignVal(align){
  if(align === "center") return "ctr";
  if(align === "right" || align === "end") return "r";
  if(align === "justify") return "just";
  return "l";
}
function pptxParagraphsXml(runs, align, opts){
  const listItem = !!(opts && opts.listItem);
  const fallbackSizePt = (opts && opts.fallbackSizePt) || 12;
  // isBreak runs are hard line breaks inside one source paragraph: keep
  // them as separate <a:p> elements with the same alignment so the break
  // survives editing (a <a:br/> would also work, but separate
  // paragraphs are what PowerPoint itself writes for pasted line
  // breaks and they round-trip cleanly).
  const groups = [[]];
  (runs || []).forEach(run=>{
    if(run && run.isBreak){ groups.push([]); return; }
    groups[groups.length-1].push(run);
  });
  const paras = groups.map(group=>{
    const runXml = group.map(r=>pptxRunXml(r, fallbackSizePt)).join("");
    const pPrAttrs = ` algn="${pptxAlignVal(align)}"`;
    const bullet = listItem ? `<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>` : "";
    const defRPr = `<a:defRPr lang="en-US" sz="${Math.round(fallbackSizePt*100)}"/>`;
    if(!runXml) return `<a:p><a:pPr${pPrAttrs}>${bullet}${defRPr}</a:pPr></a:p>`;
    return `<a:p><a:pPr${pPrAttrs}>${bullet}${defRPr}</a:pPr>${runXml}</a:p>`;
  }).filter((p, idx, arr)=> p.includes("<a:r>") || arr.length === 1);
  return paras.join("");
}
function pptxTextShapeXml(id, name, x, y, cx, cy, paragraphsXml){
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${pptxEsc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" anchor="t" anchorCtr="0" vert="horz" lIns="45720" tIns="22860" rIns="45720" bIns="22860"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${paragraphsXml}</p:txBody></p:sp>`;
}
function pptxPictureShapeXml(id, name, x, y, cx, cy, rId){
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${pptxEsc(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}
function pptxTableCellXml(cell, defaultSizePt, scale){
  const runs = (cell.runs && cell.runs.length) ? cell.runs : [{text: cell.text || "", bold: cell.r0 === 0, size: defaultSizePt}];
  const parasXml = pptxParagraphsXml(runs, cell.align || "left", {fallbackSizePt: defaultSizePt});
  const shade = cell.shadeHex ? `<a:solidFill><a:srgbClr val="${pptxColorHex(cell.shadeHex)}"/></a:solidFill>` : "";
  const border = (cell.bordered === false) ? "" : `<a:ln w="9525"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill><a:prstDash val="solid"/></a:ln>`;
  const ln = (tag)=> border ? `<a:${tag}>${border}</a:${tag}>` : "";
  const attrs = [];
  if(cell.colSpan > 1) attrs.push(`gridSpan="${cell.colSpan}"`);
  if(cell.rowSpan > 1) attrs.push(`rowSpan="${cell.rowSpan}"`);
  if(cell.hMerge) attrs.push(`hMerge="1"`);
  if(cell.vMerge) attrs.push(`vMerge="1"`);
  const anchor = cell.vAlign === "bottom" ? "b" : (cell.vAlign === "center" ? "ctr" : "t");
  const marL = Math.round(Math.max(0, Math.min(20, cell.padLeftPt || 4)) * PPTX_EMU_PER_PT * (scale || 1));
  return `<a:tc${attrs.length ? " " + attrs.join(" ") : ""}><a:txBody><a:bodyPr wrap="square" anchor="${anchor}" lIns="${marL}" tIns="22860" rIns="45720" bIns="22860"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${parasXml}</a:txBody><a:tcPr>${ln("lnL")}${ln("lnR")}${ln("lnT")}${ln("lnB")}${shade}</a:tcPr></a:tc>`;
}
function pptxTableShapeXml(id, name, x, y, colWidthsEmu, rowHeightsEmu, rowsXml){
  const grid = colWidthsEmu.map(w=>`<a:gridCol w="${w}"/>`).join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${pptxEsc(name)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>`
    + `<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${colWidthsEmu.reduce((a,b)=>a+b,0)}" cy="${rowHeightsEmu.reduce((a,b)=>a+b,0)}"/></p:xfrm>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid>${grid}</a:tblGrid>${rowsXml}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}
function pptxSlideRelsXmlEditable(imageFileNames){
  const entries = [`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`];
  imageFileNames.forEach((name, i)=>{
    entries.push(`<Relationship Id="rId${i+2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${name}"/>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n${entries.join("\n")}\n</Relationships>`;
}
function pptxEditableSlideXml(shapesXml){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${shapesXml}
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

/* Converts one page's document-model blocks into slide shapes. `media`
   collects {fileName, pngBase64} entries for every picture placed, in
   shape order; the caller assigns rIds (rId2 onwards, rId1 is the
   slide layout) and writes the media parts. Returns the shapes XML.
   Coordinates: PDF points, y-up, converted to EMU with the slide sized
   to the page itself (1pt = 12700 EMU), so font sizes and positions
   stay true to the source page. */
function pptxShapesForPage(blocks, pageWidthPt, pageHeightPt, media, ctx, fit){
  // `fit` scales an outlier-sized page into the deck's modal slide
  // size (see pptxDeckPageSize): every position and extent is mapped
  // through it, including font sizes, so nothing overflows or clips.
  // With no fit the mapping is the identity (1pt = 12700 EMU), exactly
  // as before - font sizes and positions stay true to the source page.
  const fitScale = (fit && Number(fit.scale) > 0) ? Number(fit.scale) : 1;
  const fitOffX = (fit && Number(fit.offsetXPt)) || 0;
  const fitOffY = (fit && Number(fit.offsetYPt)) || 0;
  const shapes = [];
  const toX = pt=>Math.max(0, Math.round((fitOffX + pt * fitScale) * PPTX_EMU_PER_PT));
  const toY = yFromTopPt=>Math.max(0, Math.round((fitOffY + yFromTopPt * fitScale) * PPTX_EMU_PER_PT));
  const ext = pt=>Math.max(1, Math.round(pt * fitScale * PPTX_EMU_PER_PT));
  function addPicture(block, xPt, yTopPt, wPt, hPt, name){
    if(!block || !block.pngBase64) return;
    const fileName = `image${ctx.mediaCount+1}.png`;
    ctx.mediaCount++;
    media.push({fileName, pngBase64: block.pngBase64});
    const rId = `rId${ctx.mediaCount+1}`;
    shapes.push(pptxPictureShapeXml(ctx.nextId++, name, toX(xPt), toY(yTopPt), ext(wPt), ext(hPt), rId));
  }
  function paragraphShape(p, xPt, yTopPt, wPt, fallbackSizePt){
    const text = (p.runs || []).map(r=>r.text || "").join("");
    if(!text.trim()) return;
    const scaledRuns = (p.runs || []).map(r=>Object.assign({}, r, r.size != null ? {size: Number(r.size) * fitScale} : {}));
    const sizePt = (Math.max(...(p.runs || []).map(r=>Number(r.size) || 0), 0) || fallbackSizePt || 12) * fitScale;
    // Estimate wrapped lines from the paragraph's real horizontal
    // extent so a multi-line paragraph gets a tall enough box; the
    // shape's spAutoFit grows it further in PowerPoint if needed.
    const avgCharPt = Math.max(3, sizePt * 0.5);
    const estCharsPerLine = Math.max(10, Math.floor(wPt / avgCharPt));
    const estLines = Math.max(1, Math.ceil(text.length / estCharsPerLine));
    const hPt = Math.max(sizePt * 1.35, estLines * sizePt * 1.25 + 4);
    shapes.push(pptxTextShapeXml(ctx.nextId++, "TextBox", toX(xPt), toY(yTopPt), ext(wPt), Math.round(hPt*PPTX_EMU_PER_PT),
      pptxParagraphsXml(scaledRuns, p.align, {listItem: p.listItem, fallbackSizePt: sizePt})));
  }
  function gridTableShape(tbl){
    const colBounds = tbl.colBounds, rowBounds = tbl.rowBounds;
    if(!colBounds || !rowBounds || !tbl.nCols || !tbl.nRows) return;
    const xPt = colBounds[0], yTopPt = pageHeightPt - rowBounds[0];
    const colWidthsEmu = (tbl.colWidthsPt && tbl.colWidthsPt.length === tbl.nCols)
      ? tbl.colWidthsPt.map(w=>ext(w))
      : Array.from({length: tbl.nCols}, (_, i)=>ext(colBounds[i+1]-colBounds[i]));
    const rowHeightsEmu = Array.from({length: tbl.nRows}, (_, r)=>Math.max(ext(18), ext(rowBounds[r]-rowBounds[r+1])));
    // Build a coverage map so spanned cells emit exactly one master
    // <a:tc> and hMerge/vMerge placeholders for the cells they cover -
    // a DrawingML table row must contain exactly nCols <a:tc> elements.
    const covered = Array.from({length: tbl.nRows}, ()=>Array(tbl.nCols).fill(null));
    (tbl.cells || []).forEach(cell=>{
      const rs = Math.max(1, cell.rowSpan || 1), cs = Math.max(1, cell.colSpan || 1);
      for(let r=cell.r0; r<Math.min(tbl.nRows, cell.r0+rs); r++)
        for(let c=cell.c0; c<Math.min(tbl.nCols, cell.c0+cs); c++)
          covered[r][c] = (r === cell.r0 && c === cell.c0) ? cell : {hMerge: r === cell.r0, vMerge: r !== cell.r0, text:""};
    });
    const rowsXml = [];
    for(let r=0; r<tbl.nRows; r++){
      const cellsXml = [];
      for(let c=0; c<tbl.nCols; c++){
        const cell = covered[r][c] || {text:"", r0:r, c0:c};
        const sizePt = (((cell.runs && cell.runs.length) ? Math.max(...cell.runs.map(x=>Number(x.size)||0), 0) || 11 : 11)) * fitScale;
        const scaledCell = Object.assign({}, cell, (cell.runs && cell.runs.length) ? {runs: cell.runs.map(x=>Object.assign({}, x, x.size != null ? {size: Number(x.size) * fitScale} : {}))} : {});
        cellsXml.push(pptxTableCellXml(Object.assign({bordered: tbl.bordered !== false}, scaledCell), sizePt, fitScale));
      }
      rowsXml.push(`<a:tr h="${rowHeightsEmu[r]}">${cellsXml.join("")}</a:tr>`);
    }
    shapes.push(pptxTableShapeXml(ctx.nextId++, "Table", toX(xPt), toY(yTopPt), colWidthsEmu, rowHeightsEmu, rowsXml.join("")));
    // Images embedded inside table cells cannot live inside a
    // DrawingML <a:tc>; float them over their cell instead, at the
    // cell's real geometry, so a product photo in a table still lands
    // in the right place instead of vanishing.
    (tbl.cells || []).forEach(cell=>{
      (cell.images || []).forEach(im=>{
        const cx0 = colBounds[cell.c0], cx1 = colBounds[Math.min(tbl.nCols, cell.c0 + Math.max(1, cell.colSpan || 1))];
        const ryTop = pageHeightPt - rowBounds[cell.r0], ryBot = pageHeightPt - rowBounds[Math.min(tbl.nRows, cell.r0 + Math.max(1, cell.rowSpan || 1))];
        const wPt = Math.min(im.widthPt || (cx1-cx0), cx1-cx0), hPt = Math.min(im.heightPt || (ryBot-ryTop), ryBot-ryTop);
        addPicture(im, cx0 + Math.max(0, (cx1-cx0-wPt)/2), ryTop + Math.max(0, (ryBot-ryTop-hPt)/2), wPt, hPt, "Table image");
      });
    });
  }
  function gapTableShape(tbl){
    const rows = tbl.rows || [];
    if(!rows.length) return;
    const nCols = Math.max(...rows.map(r=>r.length));
    const marginPt = 36;
    const wPt = pageWidthPt - marginPt*2;
    const colW = wPt / nCols;
    const rowH = 18 * fitScale;
    const yTopPt = pageHeightPt - (tbl._y || pageHeightPt) - 14;
    const colWidthsEmu = Array.from({length: nCols}, ()=>ext(colW));
    const rowHeightsEmu = rows.map(()=>Math.round(rowH*PPTX_EMU_PER_PT));
    const rowsXml = rows.map((row, ri)=>{
      let cellsXml = "";
      let col = 0;
      row.forEach(cell=>{
        const span = Math.max(1, Math.min(cell.span || 1, nCols - col));
        const text = cell.text || "";
        const runs = [{text, bold: ri === 0, size: 11 * fitScale}];
        cellsXml += pptxTableCellXml({text, runs, r0: ri, c0: col, colSpan: span, rowSpan: 1, bordered: true}, 11 * fitScale, fitScale);
        col += span;
      });
      while(col < nCols){ cellsXml += pptxTableCellXml({text:"", runs:[{text:"", size:11 * fitScale}], r0:ri, c0:col, colSpan:1, rowSpan:1, bordered:true}, 11 * fitScale, fitScale); col++; }
      return `<a:tr h="${rowHeightsEmu[ri]}">${cellsXml}</a:tr>`;
    }).join("");
    shapes.push(pptxTableShapeXml(ctx.nextId++, "Table", toX(marginPt), toY(yTopPt), colWidthsEmu, rowHeightsEmu, rowsXml));
  }
  (blocks || []).forEach(block=>{
    if(!block) return;
    if(block.type === "paragraph"){
      const xPt = (block.xLeft != null) ? block.xLeft : 36;
      const wPt = Math.max(40, ((block.xRight != null ? block.xRight : pageWidthPt - 36) - xPt));
      const sizePt = Math.max(...(block.runs || []).map(r=>Number(r.size) || 0), 0) || 12;
      const yTopPt = pageHeightPt - (block._y || 0) - sizePt;
      paragraphShape(block, xPt, yTopPt, wPt, sizePt);
    } else if(block.type === "gridtable"){
      gridTableShape(block);
    } else if(block.type === "table"){
      gapTableShape(block);
    } else if(block.type === "columns"){
      const midPt = pageWidthPt / 2;
      (block.left || []).forEach(p=>{
        const sizePt = Math.max(...(p.runs || []).map(r=>Number(r.size) || 0), 0) || 12;
        paragraphShape(p, p.xLeft != null ? p.xLeft : 36, pageHeightPt - (p._y || 0) - sizePt, Math.max(40, (p.xRight != null ? p.xRight : midPt - 12) - (p.xLeft != null ? p.xLeft : 36)), sizePt);
      });
      (block.right || []).forEach(p=>{
        const sizePt = Math.max(...(p.runs || []).map(r=>Number(r.size) || 0), 0) || 12;
        paragraphShape(p, p.xLeft != null ? p.xLeft : midPt + 12, pageHeightPt - (p._y || 0) - sizePt, Math.max(40, (p.xRight != null ? p.xRight : pageWidthPt - 36) - (p.xLeft != null ? p.xLeft : midPt + 12)), sizePt);
      });
    } else if(block.type === "image"){
      const wPt = block.widthPt || block.width || pageWidthPt;
      const hPt = block.heightPt || block.height || pageHeightPt;
      const xPt = block.placement === "anchored" && block.xPt != null ? block.xPt : Math.max(0, (pageWidthPt - wPt) / 2);
      const yTopPt = block.yFromTopPt != null ? block.yFromTopPt : Math.max(0, pageHeightPt - (block._y || pageHeightPt) - hPt);
      // A full-page image block is the scanned-page fallback: cover
      // the whole slide exactly, like the old image-only deck did.
      if(wPt >= pageWidthPt * 0.95 && hPt >= pageHeightPt * 0.95){
        addPicture(block, 0, 0, pageWidthPt, pageHeightPt, "Page image");
      } else {
        addPicture(block, xPt, yTopPt, Math.min(wPt, pageWidthPt - xPt), Math.min(hPt, pageHeightPt - yTopPt), "Image");
      }
    } else if(block.type === "separator"){
      const yTopPt = pageHeightPt - (block._y || 0);
      const xPt = block.xLeft != null ? block.xLeft : 36;
      const wPt = Math.max(20, (block.xRight != null ? block.xRight : pageWidthPt - 36) - xPt);
      shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${ctx.nextId++}" name="Separator"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${toX(xPt)}" y="${toY(yTopPt)}"/><a:ext cx="${ext(wPt)}" cy="${Math.round(12700*fitScale)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="999999"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`);
    }
    // "pagebreak" / "pagelayout" blocks never reach here: each PDF
    // page is already its own slide in the caller.
  });
  return shapes.join("\n");
}

/**
 * Builds an editable .pptx Blob from the document model.
 * @param {{pageWidthPt:number, pageHeightPt:number, blocks:object[]}[]} pages
 *   One entry per PDF page; blocks are the extractPageBlocks document
 *   model (paragraph / table / gridtable / columns / image /
 *   separator). Image blocks carry pngBase64 (as buildMixedDocx
 *   consumes them). A page whose blocks are a single full-page image
 *   block becomes a picture slide, like the old image-only builder.
 * @param {string} [title]
 * @returns {Promise<Blob>}
 */
/* A PPTX has ONE slide size for the whole deck, so a mixed-size PDF
   cannot keep every page's size. The deck uses the modal (most common)
   page size; outlier pages are letterboxed into it (see the `fit`
   argument of pptxShapesForPage) instead of overflowing/clipping.
   Returns the slide size in points plus how many pages were scaled,
   so the caller can say so in its status message. Ties go to the
   first page's size. */
function pptxDeckPageSize(pages){
  const counts = new Map();
  (pages || []).forEach(p=>{
    const key = `${Math.round(p.pageWidthPt || 612)}x${Math.round(p.pageHeightPt || 792)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  let bestKey = null, bestCount = 0;
  counts.forEach((c, k)=>{ if(c > bestCount){ bestCount = c; bestKey = k; } });
  const parts = (bestKey || "612x792").split("x");
  const slideWidthPt = Number(parts[0]) || 612, slideHeightPt = Number(parts[1]) || 792;
  const scaledCount = (pages || []).filter(p=>Math.round(p.pageWidthPt || 612) !== slideWidthPt || Math.round(p.pageHeightPt || 792) !== slideHeightPt).length;
  return {slideWidthPt, slideHeightPt, scaledCount};
}
async function buildEditablePptx(pages, title){
  if(!pages || !pages.length) throw new Error("No pages to convert");
  await ensureJSZip();
  const deckSize = pptxDeckPageSize(pages);
  const slideW = Math.max(1, Math.round(deckSize.slideWidthPt * PPTX_EMU_PER_PT));
  const slideH = Math.max(1, Math.round(deckSize.slideHeightPt * PPTX_EMU_PER_PT));
  const zip = new JSZip();
  const slideOverrides = [];
  const sldIdEntries = [];
  const presRelEntries = [];
  let hasPng = false;
  for(let i=0;i<pages.length;i++){
    const n = i+1;
    const page = pages[i];
    const pageWidthPt = page.pageWidthPt || deckSize.slideWidthPt;
    const pageHeightPt = page.pageHeightPt || deckSize.slideHeightPt;
    const media = [];
    const ctx = {nextId: 2, mediaCount: 0};
    // Letterbox this page into the modal slide size, centred.
    const fitScale = Math.min(deckSize.slideWidthPt / pageWidthPt, deckSize.slideHeightPt / pageHeightPt);
    const fit = {scale: fitScale, offsetXPt: (deckSize.slideWidthPt - pageWidthPt * fitScale) / 2, offsetYPt: (deckSize.slideHeightPt - pageHeightPt * fitScale) / 2};
    const shapesXml = pptxShapesForPage(page.blocks || [], pageWidthPt, pageHeightPt, media, ctx, fit);
    if(media.length) hasPng = true;
    media.forEach(m=> zip.file(`ppt/media/${m.fileName}`, m.pngBase64, {base64:true}));
    zip.file(`ppt/slides/slide${n}.xml`, pptxEditableSlideXml(shapesXml));
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, pptxSlideRelsXmlEditable(media.map(m=>m.fileName)));
    slideOverrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    sldIdEntries.push(`<p:sldId id="${256+i}" r:id="rIdSlide${n}"/>`);
    presRelEntries.push(`<Relationship Id="rIdSlide${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`);
  }
  const extraDefaults = hasPng ? `<Default Extension="png" ContentType="image/png"/>` : "";
  zip.file("[Content_Types].xml", pptxContentTypesXml(slideOverrides.join("\n"), extraDefaults));
  zip.file("_rels/.rels", pptxPackageRelsXml());
  zip.file("docProps/core.xml", pptxCoreXml(title || "Presentation"));
  zip.file("docProps/app.xml", pptxAppXml(pages.length));
  zip.file("ppt/presentation.xml", pptxPresentationXml(slideW, slideH, sldIdEntries.join("")));
  zip.file("ppt/_rels/presentation.xml.rels", pptxPresentationRelsXml(presRelEntries.join("\n")));
  zip.file("ppt/slideMasters/slideMaster1.xml", pptxSlideMasterXml());
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", pptxSlideMasterRelsXml());
  zip.file("ppt/slideLayouts/slideLayout1.xml", pptxSlideLayoutXml());
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", pptxSlideLayoutRelsXml());
  zip.file("ppt/theme/theme1.xml", pptxThemeXml());
  return zip.generateAsync({type:"blob", mimeType:"application/vnd.openxmlformats-officedocument.presentationml.presentation"});
}
