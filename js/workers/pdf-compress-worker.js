/* ==========================================================================
   js/workers/pdf-compress-worker.js
   ---------------------------------------------------------------------------
   Phase 4 (PDF Engine & Worker Performance): runs Compress PDF's image
   recompression pipeline off the main thread. This is the single heaviest
   CPU-bound operation in the app - it decodes every embedded raster image
   in a PDF, re-encodes each one via canvas, and re-serializes the whole
   document with pdf-lib's doc.save() - and previously ran synchronously on
   the main thread, freezing the UI (no scrolling, no paint, no responding
   to Cancel) for the whole duration on any image-heavy or multi-MB PDF.

   A classic (non-module) worker, matching every other script in this app -
   see js/core/pdf-processing-utils.js and vite.config.js's own comment on
   why this project stays plain global-scope scripts rather than ES modules.
   importScripts() loads an exact-version local pdf-lib build so worker startup
   does not depend on a third-party CDN or its cross-origin policy. The main
   thread keeps its Phase 8 SRI-protected script loading unchanged.

   Public message protocol (see getCompressWorker() in
   pdf-processing-utils.js for the main-thread side):
     -> { id, type:"recompress", pdfBytes:Uint8Array, preset }
     -> { id, type:"compressToTarget", pdfBytes:Uint8Array, targetBytes }
     <- { id, kind:"progress", step, total, size? }
     <- { id, kind:"result", bytes:Uint8Array, imagesRecompressed, stats, achieved?, alreadyUnderTarget? }
     <- { id, kind:"error", message }
   pdfBytes/result bytes are always transferred (not copied) - callers must
   treat their own reference as consumed once posted.

   Cancellation is deliberately NOT a message in this protocol: pdf-lib's
   doc.save() and the image loop below are synchronous stretches with no
   cooperative yield point to check a "please stop" flag against. The
   main-thread client cancels by calling Worker.terminate() directly,
   which kills this whole isolate instantly regardless of what it's doing -
   simpler and more immediate than plumbing an AbortSignal through pdf-lib
   internals that were never built to expect one.
   ========================================================================== */
importScripts("../../assets/vendor/pdf-lib/1.17.1/pdf-lib.min.js");

const { PDFDocument, ParseSpeeds, PDFName, PDFRawStream, PDFNumber, PDFRef } = self.PDFLib;

/** Worker-side twin of js/app.js's loadPdfSafe() - same fast parse mode and
 *  timeout guard, duplicated here only because this file cannot reach
 *  across to a window-scoped function; keep any behavioral change to
 *  loadPdfSafe mirrored here. */
const MAX_WORKER_PDF_BYTES = 200 * 1024 * 1024;
const MAX_WORKER_PDF_PAGES = 1500;

async function loadPdfSafe(bytes, extraOpts = {}, timeoutMs = 20000) {
  if((bytes?.byteLength ?? bytes?.length ?? 0) > MAX_WORKER_PDF_BYTES){
    throw new Error("This PDF exceeds the 200 MB in-browser processing limit.");
  }

  let timeoutId;
  try{
    const doc = await Promise.race([
      PDFDocument.load(bytes, { parseSpeed: ParseSpeeds.Fastest, ...extraOpts }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("This PDF took too long to open - it may be unusually large or complex")),
          timeoutMs
        );
      })
    ]);
    const pageCount = doc.getPageCount();
    if(pageCount < 1) throw new Error("This PDF has no readable pages.");
    if(pageCount > MAX_WORKER_PDF_PAGES) throw new Error("This PDF exceeds the 1500-page in-browser processing limit.");
    return doc;
  }finally{
    if(timeoutId) clearTimeout(timeoutId);
  }
}
// Identical to js/core/pdf-processing-utils.js's COMPRESS_PRESETS/
// DOC_PAGE_MIN_LONG_EDGE - see that file for the full reasoning behind
// these numbers. Duplicated rather than shared because a classic worker
// and the main-thread page script are two separate global scopes with no
// module system connecting them in this project.
const COMPRESS_PRESETS = {
  high:      { quality: 0.92, maxDim: 3000, protectDocuments: true },
  recommended: { quality: 0.75, documentQuality: 0.82, maxDim: 2200, protectDocuments: true },
  max:       { quality: 0.55, maxDim: 1400, protectDocuments: false },
};
const DOC_PAGE_MIN_LONG_EDGE = 2800;
// Compress PDF V2 pixel classifier - byte-for-byte the same constants and
// functions as js/core/pdf-processing-utils.js (see the long note there for
// what paperShare/peakLuma are and how the 0.45 threshold was validated).
const DOC_THUMB_LONG_EDGE = 128;
const DOC_PAPER_WINDOW = 16;
const DOC_PAPER_SHARE_MIN = 0.45;
const DOC_PEAK_LUMA_MIN = 100;
function documentThumbSize(width, height){
  const scale = Math.min(1, DOC_THUMB_LONG_EDGE / Math.max(width, height));
  return {width: Math.max(1, Math.round(width*scale)), height: Math.max(1, Math.round(height*scale))};
}
function documentSignalsFromPixels(rgba){
  const hist = new Uint32Array(256);
  let n = 0;
  for(let i=0; i<rgba.length; i+=4){
    if(rgba[i+3] < 128) continue;
    hist[(0.299*rgba[i] + 0.587*rgba[i+1] + 0.114*rgba[i+2] + 0.5) | 0]++;
    n++;
  }
  if(!n) return {paperShare:0, peakLuma:0};
  let win = 0;
  for(let v=0; v<DOC_PAPER_WINDOW; v++) win += hist[v];
  let best = win, bestLo = 0;
  for(let lo=1; lo<=256-DOC_PAPER_WINDOW; lo++){
    win += hist[lo+DOC_PAPER_WINDOW-1] - hist[lo-1];
    if(win > best){ best = win; bestLo = lo; }
  }
  return {paperShare: best/n, peakLuma: bestLo + DOC_PAPER_WINDOW/2};
}
function isDocumentPageFromSignals(signals){
  return signals.paperShare >= DOC_PAPER_SHARE_MIN && signals.peakLuma >= DOC_PEAK_LUMA_MIN;
}
function documentSignalsFromBitmap(bitmap, canvas){
  const size = documentThumbSize(bitmap.width, bitmap.height);
  canvas.width = size.width; canvas.height = size.height;
  const ctx = canvas.getContext("2d", {willReadFrequently:true});
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  return documentSignalsFromPixels(ctx.getImageData(0, 0, size.width, size.height).data);
}
function isIdentityDecode(decode){
  if(!decode) return true;
  const arr = decode.asArray ? decode.asArray() : null;
  if(!arr || !arr.length || arr.length % 2) return false;
  for(let i=0; i<arr.length; i+=2){
    if(arr[i]?.asNumber?.() !== 0 || arr[i+1]?.asNumber?.() !== 1) return false;
  }
  return true;
}
function newCompressStats(){
  return {
    found:0, eligible:0, replaced:0, noGain:0, decodeFailed:0, maskImages:0, documentPages:0,
    fromIndexed:0, fromCmyk:0, alphaComposited:0,
    skipped:{unsupportedFilter:0, alpha:0, masked:0, decode:0, colorSpace:0, unsupportedParams:0, error:0}
  };
}

function looksLikeDocumentPage(width, height){
  const longest = Math.max(width, height), shortest = Math.min(width, height);
  if(shortest < 900) return false;
  const ratio = longest / shortest;
  return ratio > 1.2 && ratio < 1.75;
}

function resolveImageComponents(colorSpaceObj, context, PDFNameRef){
  if(!colorSpaceObj) return null;
  if(colorSpaceObj.asString){
    const name = colorSpaceObj.asString();
    if(/DeviceRGB|CalRGB/.test(name)) return 3;
    if(/DeviceGray|CalGray/.test(name)) return 1;
    return null;
  }
  const arr = colorSpaceObj.array;
  if(!Array.isArray(arr) || !arr.length) return null;
  const head = arr[0];
  if(head?.asString?.() !== "/ICCBased") return null;
  const streamObj = arr[1] && context?.lookup ? context.lookup(arr[1]) : null;
  const n = streamObj?.dict?.lookup?.(PDFNameRef.of("N"));
  const nVal = n?.asNumber?.();
  if(nVal===3) return 3;
  if(nVal===1) return 1;
  return null;
}

/* Resolves an [/Indexed base hival lookup] colour space for the Flate
   image path: the palette (lookup) bytes plus the base space's component
   count (3=RGB, 1=Gray). Returns null for anything else (Separation,
   Lab, ICCBased bases, non-8-bit lookups are rejected by the caller).
   The lookup may be a literal/hex string or a stream behind a reference;
   anything unresolvable returns null so the image is left untouched.
   Mirrored in js/core/pdf-processing-utils.js - keep the two in step. */
function resolveIndexedColorSpace(colorSpaceObj, context, PDFName){
  try{
    const arr = colorSpaceObj?.array;
    if(!Array.isArray(arr) || !arr.length) return null;
    if(arr[0]?.asString?.() !== "/Indexed") return null;
    const base = arr[1];
    let baseComponents = null;
    const baseName = base?.asString?.();
    if(/DeviceRGB|CalRGB/.test(baseName || "")) baseComponents = 3;
    else if(/DeviceGray|CalGray/.test(baseName || "")) baseComponents = 1;
    else {
      // ICCBased base: [/ICCBased streamRef] - resolve N from the profile stream.
      const baseArr = base?.array;
      if(Array.isArray(baseArr) && baseArr[0]?.asString?.() === "/ICCBased"){
        const streamObj = baseArr[1] && context?.lookup ? context.lookup(baseArr[1]) : null;
        const n = streamObj?.dict?.lookup?.(PDFName.of("N"))?.asNumber?.();
        if(n===3) baseComponents = 3;
        else if(n===1) baseComponents = 1;
      }
    }
    if(!baseComponents) return null;
    const hival = arr[2]?.asNumber?.();
    if(!Number.isInteger(hival) || hival<0 || hival>255) return null;
    let lookupObj = arr[3];
    if(lookupObj && context?.lookup && typeof lookupObj !== "string") {
      // A reference resolves to the stream/string it points at; a direct
      // object is used as-is. lookup() on a non-ref returns the object.
      try{ lookupObj = context.lookup(lookupObj); }catch(e){ /* fall through with the direct object */ }
    }
    let lookup = null;
    if(lookupObj?.asBytes) lookup = lookupObj.asBytes();
    else if(lookupObj?.contents) lookup = lookupObj.contents;
    if(!lookup || lookup.length < (hival+1)*baseComponents) return null;
    return {baseComponents, hival, lookup: lookup.slice(0, (hival+1)*baseComponents)};
  }catch(e){ return null; }
}
/* True only for a DIRECT /DeviceCMYK colour space (name or 1-element
   array form). ICCBased CMYK profiles are deliberately NOT matched: their
   transform is profile-defined, and a naive CMYK->RGB conversion would
   shift colours. Direct DeviceCMYK with an identity /Decode uses the
   standard simple transform (see cmykPixelsToRgba), which is safe. */
function isDeviceCmykColorSpace(colorSpaceObj){
  if(!colorSpaceObj) return false;
  if(colorSpaceObj.asString) return colorSpaceObj.asString() === "/DeviceCMYK";
  const arr = colorSpaceObj.array;
  return Array.isArray(arr) && arr.length>0 && arr[0]?.asString?.() === "/DeviceCMYK";
}
/* Expands 8-bit palette-index bytes to RGBA using a palette lookup:
   raw holds one index byte per pixel; lookup holds (hival+1) palette
   entries of baseComponents bytes each. An index past the palette is
   clamped to the last entry rather than corrupting the row - the caller
   already validated the lookup length, so this is belt-and-braces. Pure. */
function indexedPixelsToRgba(raw, width, height, lookup, baseComponents){
  const rgba = new Uint8ClampedArray(width*height*4);
  const entries = Math.floor(lookup.length / baseComponents);
  for(let p=0; p<width*height; p++){
    const idx = Math.min(raw[p] || 0, entries-1);
    const off = idx*baseComponents;
    if(baseComponents===3){
      rgba[p*4]=lookup[off]; rgba[p*4+1]=lookup[off+1]; rgba[p*4+2]=lookup[off+2];
    } else {
      const g = lookup[off]; rgba[p*4]=g; rgba[p*4+1]=g; rgba[p*4+2]=g;
    }
    rgba[p*4+3]=255;
  }
  return rgba;
}
/* Expands 8-bit DeviceCMYK bytes to RGBA with the standard simple
   transform R=(1-C)(1-K), G=(1-M)(1-K), B=(1-Y)(1-K). Only valid for
   direct DeviceCMYK data under an identity /Decode - the caller enforces
   both before calling. Pure. */
function cmykPixelsToRgba(raw, width, height){
  const rgba = new Uint8ClampedArray(width*height*4);
  for(let p=0, s=0; p<width*height; p++, s+=4){
    const k = raw[s+3]/255;
    rgba[p*4]   = Math.round(255*(1-raw[s]/255)*(1-k));
    rgba[p*4+1] = Math.round(255*(1-raw[s+1]/255)*(1-k));
    rgba[p*4+2] = Math.round(255*(1-raw[s+2]/255)*(1-k));
    rgba[p*4+3] = 255;
  }
  return rgba;
}
/* Overwrites the alpha channel of RGBA pixel data with decoded soft-mask
   bytes (one byte per pixel). Pure. */
function applySmaskToRgba(rgba, alphaBytes){
  const n = Math.min(alphaBytes.length, rgba.length/4);
  for(let p=0; p<n; p++) rgba[p*4+3] = alphaBytes[p];
  return rgba;
}
/* Decodes an image's /SMask soft mask to one alpha byte per pixel, or
   null when the mask cannot be decoded safely (in which case the caller
   leaves the image untouched). Only 8-bit grayscale FlateDecode masks at
   exactly the base image's dimensions are attempted: JPEG masks need a
   canvas decode whose result depends on the viewer's colour handling,
   ImageMask (1-bit) and mismatched-size masks need resampling - all
   out of scope rather than guessed. The mask's own /Decode must be
   identity (a remapped mask would invert transparency). Mirrored in
   js/core/pdf-processing-utils.js - keep the two in step. */
async function decodeSmaskAlpha(smaskObj, context, PDFName, width, height){
  try{
    let maskObj = smaskObj;
    if(maskObj && context?.lookup){
      try{ maskObj = context.lookup(maskObj); }catch(e){ /* direct object */ }
    }
    if(!maskObj || typeof maskObj !== "object") return null;
    const dict = maskObj.dict;
    if(!dict) return null;
    const w = dict.lookup(PDFName.of("Width"))?.asNumber?.();
    const h = dict.lookup(PDFName.of("Height"))?.asNumber?.();
    if(w!==width || h!==height) return null;
    const bpc = dict.lookup(PDFName.of("BitsPerComponent"))?.asNumber?.();
    if(bpc!==8) return null;
    const filter = dict.lookup(PDFName.of("Filter"));
    const filterName = filter?.asString?.() || "";
    if(filterName !== "/FlateDecode") return null;
    if(!isIdentityDecode(dict.lookup(PDFName.of("Decode")))) return null;
    const predictor = dict.lookup(PDFName.of("DecodeParms"))?.lookup?.(PDFName.of("Predictor"))?.asNumber?.() ?? 1;
    if(predictor!==1 && (predictor<10 || predictor>15)) return null;
    const inflated = await inflateFlateBytes(maskObj.contents);
    if(!inflated) return null;
    const raw = predictor===1 ? inflated : unfilterPngRows(inflated, width, height, 1, width);
    if(!raw || raw.length < width*height) return null;
    return raw.slice(0, width*height);
  }catch(e){ return null; }
}

async function inflateFlateBytes(bytes){
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function unfilterPngRows(data, width, height, components, rowBytes){
  const bpp = components;
  const out = new Uint8Array(rowBytes*height);
  let prevRow = new Uint8Array(rowBytes);
  let pos = 0;
  for(let y=0; y<height; y++){
    if(pos >= data.length) return null;
    const filterType = data[pos++];
    const outRow = out.subarray(y*rowBytes, y*rowBytes+rowBytes);
    for(let i=0; i<rowBytes; i++){
      const raw = data[pos+i] ?? 0;
      const a = i>=bpp ? outRow[i-bpp] : 0;
      const b = prevRow[i];
      const c = i>=bpp ? prevRow[i-bpp] : 0;
      let val;
      switch(filterType){
        case 0: val = raw; break;
        case 1: val = (raw + a) & 0xff; break;
        case 2: val = (raw + b) & 0xff; break;
        case 3: val = (raw + ((a+b)>>1)) & 0xff; break;
        case 4: {
          const p = a+b-c;
          const pa = Math.abs(p-a), pb = Math.abs(p-b), pc = Math.abs(p-c);
          val = (raw + (pa<=pb && pa<=pc ? a : (pb<=pc ? b : c))) & 0xff;
          break;
        }
        default: return null;
      }
      outRow[i] = val;
    }
    pos += rowBytes;
    prevRow = outRow;
  }
  return out;
}

/* Camera JPEGs can carry an EXIF Orientation tag. PDF viewers ignore EXIF,
   but createImageBitmap()/<img> apply it, so decoding such an image and
   re-encoding the pixels would rotate it relative to the /Width /Height and
   placement the PDF declares (verified: a 3000x2000 EXIF-6 JPEG came back
   1467x2200). imageOrientation:"none" does NOT prevent this - in current
   browsers "none" is a legacy alias of the default "from-image". The only
   reliable, cross-browser fix is to hand the decoder bytes without the EXIF
   APP1 segment, so the raw stored pixel grid is what gets decoded. Only the
   Exif APP1 segment is removed (never touched: ICC, XMP, quantisation or
   entropy data - the image itself is re-encoded anyway). Returns the SAME
   array when there is nothing to strip or the bytes are not a JPEG. Mirrored
   in js/workers/pdf-compress-worker.js. */
function jpegWithoutExif(bytes){
  if(!bytes || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes;
  const chunks = [bytes.subarray(0, 2)];
  let start = 2, i = 2, removed = false;
  while(i + 4 <= bytes.length){
    if(bytes[i] !== 0xFF) break;
    const marker = bytes[i+1];
    if(marker === 0xD9 || marker === 0xDA) break; // EOI / SOS: entropy-coded data follows
    if(marker === 0xFF){ i++; continue; }         // fill byte
    if(marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)){ i += 2; continue; } // standalone markers
    const len = (bytes[i+2] << 8) | bytes[i+3];
    if(len < 2 || i + 2 + len > bytes.length) break;
    const isExif = marker === 0xE1 && bytes[i+4] === 0x45 && bytes[i+5] === 0x78 && bytes[i+6] === 0x69 &&
      bytes[i+7] === 0x66 && bytes[i+8] === 0 && bytes[i+9] === 0; // "Exif\0\0"
    if(isExif){ chunks.push(bytes.subarray(start, i)); start = i + 2 + len; removed = true; }
    i += 2 + len;
  }
  if(!removed) return bytes;
  chunks.push(bytes.subarray(start));
  const out = new Uint8Array(chunks.reduce((n, c)=>n + c.length, 0));
  let o = 0;
  for(const c of chunks){ out.set(c, o); o += c.length; }
  return out;
}
/** Worker-side twin of pdf-processing-utils.js's recompressPdfImages() -
 *  same algorithm; only the canvas backend differs (OffscreenCanvas here,
 *  since this scope has no `document`) and progress is reported via
 *  postMessage instead of a direct callback so the main thread can update
 *  its status UI while this keeps running off-thread. Every guard,
 *  classifier and stat below is deliberately identical to that file's
 *  recompressPdfImagesMainThread() - keep the two in step. */
async function recompressPdfImages(pdfBytes, presetName, onImageProgress){
  const preset = typeof presetName === "object" && presetName
    ? presetName
    : (COMPRESS_PRESETS[presetName] || COMPRESS_PRESETS.recommended);
  const doc = await loadPdfSafe(pdfBytes);
  let touched = 0;
  const stats = newCompressStats();
  let thumbCanvas = null;
  const allObjects = Array.from(doc.context.enumerateIndirectObjects());
  const maskRefs = new Set();
  for(const [,obj] of allObjects){
    if(!(obj instanceof PDFRawStream)) continue;
    for(const key of ["SMask", "Mask"]){
      const target = obj.dict.get(PDFName.of(key));
      if(target instanceof PDFRef) maskRefs.add(target.toString());
    }
  }
  const imageObjects = allObjects.filter(([ref, obj])=>{
    if(!(obj instanceof PDFRawStream)) return false;
    const subtype = obj.dict.lookup(PDFName.of("Subtype"));
    return !!subtype && subtype.asString?.() === "/Image" && !maskRefs.has(ref.toString());
  });
  let imageIndex = 0;
  for(const [ref, obj] of allObjects){
    try{
      if(!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      const subtype = dict.lookup(PDFName.of("Subtype"));
      if(!subtype || subtype.asString?.() !== "/Image") continue;
      if(maskRefs.has(ref.toString())){ stats.maskImages++; continue; }
      imageIndex++;
      stats.found++;
      if(onImageProgress) onImageProgress(imageIndex, imageObjects.length);
      const filter = dict.lookup(PDFName.of("Filter"));
      const filterName = filter && filter.asString ? filter.asString() : (Array.isArray(filter?.array) ? filter.array.map(f=>f.asString?.()).join(",") : "");
      const isJpeg = filterName === "/DCTDecode";
      const isRawFlate = filterName === "/FlateDecode";
      if(!isJpeg && !isRawFlate){ stats.skipped.unsupportedFilter++; continue; }
      // A soft mask (/SMask) is transparency data for THIS image: JPEG
      // cannot carry it, so the image used to be skipped outright. It is
      // now composited onto white when the mask decodes cleanly (see
      // decodeSmaskAlpha + the composite steps in each branch below) and
      // the /SMask entry is dropped from the replacement dict - the
      // composited JPEG already has the transparency baked in, so keeping
      // the mask would apply it twice. Undecodable masks still skip.
      const smaskObj = dict.lookup(PDFName.of("SMask"));
      const hasSmask = !!smaskObj;
      let compositedAlpha = false; // set once a mask is actually baked in
      let replacedKind = null; // "indexed" | "cmyk" | null, for stats
      if(dict.lookup(PDFName.of("Mask"))){ stats.skipped.masked++; continue; }
      if(!isIdentityDecode(dict.lookup(PDFName.of("Decode")))){ stats.skipped.decode++; continue; }

      let bitmap = null;
      if(isJpeg){
        const colorSpace = dict.lookup(PDFName.of("ColorSpace"));
        const csName = colorSpace && colorSpace.asString ? colorSpace.asString() : "";
        if(csName && !/DeviceRGB|DeviceGray|CalRGB|CalGray/.test(csName)){ stats.skipped.colorSpace++; continue; }
        stats.eligible++;
        const blob = new Blob([jpegWithoutExif(obj.contents)], {type:"image/jpeg"});
        // EXIF stripped above (see jpegWithoutExif) so the decoder cannot
        // auto-rotate - same as the main-thread twin.
        bitmap = await Promise.race([
          createImageBitmap(blob),
          new Promise((_, reject) => setTimeout(() => reject(new Error("decode timed out")), 8000))
        ]).catch(()=>null);
        if(bitmap && hasSmask){
          // Composite the soft mask onto white: fill white, draw the
          // image, then destination-in with a mask canvas whose alpha
          // channel is the mask (RGB is irrelevant for destination-in).
          // The result is an opaque bitmap - the JPEG below needs no
          // further alpha handling, and the replacement dict drops /SMask.
          const mw = dict.lookup(PDFName.of("Width"))?.asNumber?.();
          const mh = dict.lookup(PDFName.of("Height"))?.asNumber?.();
          const alpha = (mw && mh) ? await decodeSmaskAlpha(smaskObj, doc.context, PDFName, mw, mh) : null;
          if(!alpha){ stats.skipped.alpha++; continue; }
          try{
            const maskRgba = new Uint8ClampedArray(mw*mh*4);
            for(let p=0; p<mw*mh; p++) maskRgba[p*4+3] = alpha[p];
            const maskBitmap = await createImageBitmap(new ImageData(maskRgba, mw, mh));
            const compCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const cctx = compCanvas.getContext("2d");
            cctx.fillStyle = "#fff"; cctx.fillRect(0, 0, compCanvas.width, compCanvas.height);
            cctx.drawImage(bitmap, 0, 0);
            cctx.globalCompositeOperation = "destination-in";
            cctx.drawImage(maskBitmap, 0, 0, compCanvas.width, compCanvas.height);
            cctx.globalCompositeOperation = "source-over";
            const prev = bitmap;
            bitmap = await createImageBitmap(compCanvas);
            prev.close?.();
            compositedAlpha = true;
          }catch(e){ stats.skipped.alpha++; continue; }
        }
      } else {
        const width = dict.lookup(PDFName.of("Width"))?.asNumber?.();
        const height = dict.lookup(PDFName.of("Height"))?.asNumber?.();
        const bpc = dict.lookup(PDFName.of("BitsPerComponent"))?.asNumber?.();
        const components = resolveImageComponents(dict.lookup(PDFName.of("ColorSpace")), doc.context, PDFName);
        let pixelKind = components===3 ? "rgb" : (components===1 ? "gray" : null);
        let indexedInfo = null;
        if(!pixelKind){
          indexedInfo = resolveIndexedColorSpace(dict.lookup(PDFName.of("ColorSpace")), doc.context, PDFName);
          if(indexedInfo) pixelKind = "indexed";
          else if(isDeviceCmykColorSpace(dict.lookup(PDFName.of("ColorSpace")))) pixelKind = "cmyk";
        }
        if(!pixelKind){ stats.skipped.colorSpace++; continue; }
        if(!width || !height || bpc!==8 || width*height>30_000_000){ stats.skipped.unsupportedParams++; continue; }
        const predictor = dict.lookup(PDFName.of("DecodeParms"))?.lookup?.(PDFName.of("Predictor"))?.asNumber?.() ?? 1;
        if(predictor!==1 && (predictor<10 || predictor>15)){ stats.skipped.unsupportedParams++; continue; }
        stats.eligible++;
        const inflated = await Promise.race([
          inflateFlateBytes(obj.contents),
          new Promise((_, reject) => setTimeout(() => reject(new Error("inflate timed out")), 8000))
        ]).catch(()=>null);
        if(!inflated){ stats.decodeFailed++; continue; }
        const rowComponents = pixelKind==="rgb" ? 3 : pixelKind==="cmyk" ? 4 : 1;
        const rowBytes = width*rowComponents;
        const raw = predictor===1 ? inflated : unfilterPngRows(inflated, width, height, rowComponents, rowBytes);
        if(!raw || raw.length < rowBytes*height){ stats.decodeFailed++; continue; }
        let rgba;
        if(pixelKind==="rgb"){
          rgba = new Uint8ClampedArray(width*height*4);
          for(let p=0, s=0; p<width*height; p++, s+=3){
            rgba[p*4]=raw[s]; rgba[p*4+1]=raw[s+1]; rgba[p*4+2]=raw[s+2]; rgba[p*4+3]=255;
          }
        } else if(pixelKind==="gray"){
          rgba = new Uint8ClampedArray(width*height*4);
          for(let p=0; p<width*height; p++){
            const g = raw[p]; rgba[p*4]=g; rgba[p*4+1]=g; rgba[p*4+2]=g; rgba[p*4+3]=255;
          }
        } else if(pixelKind==="indexed"){
          rgba = indexedPixelsToRgba(raw, width, height, indexedInfo.lookup, indexedInfo.baseComponents);
          replacedKind = "indexed";
        } else { // cmyk
          rgba = cmykPixelsToRgba(raw, width, height);
          replacedKind = "cmyk";
        }
        if(hasSmask){
          const alpha = await decodeSmaskAlpha(smaskObj, doc.context, PDFName, width, height);
          if(!alpha){ stats.skipped.alpha++; continue; }
          applySmaskToRgba(rgba, alpha);
          compositedAlpha = true;
        }
        bitmap = await createImageBitmap(new ImageData(rgba, width, height)).catch(()=>null);
      }
      if(!bitmap){ stats.decodeFailed++; continue; }

      let {width, height} = bitmap;
      const longest = Math.max(width, height);
      let isDocument = false;
      if(preset.protectDocuments && looksLikeDocumentPage(width, height)){
        if(!thumbCanvas) thumbCanvas = new OffscreenCanvas(1, 1);
        isDocument = isDocumentPageFromSignals(documentSignalsFromBitmap(bitmap, thumbCanvas));
      }
      if(isDocument) stats.documentPages++;
      const effectiveMaxDim = isDocument
        ? Math.max(preset.maxDim, DOC_PAGE_MIN_LONG_EDGE)
        : preset.maxDim;
      const quality = (isDocument && preset.documentQuality) ? preset.documentQuality : preset.quality;
      if(longest > effectiveMaxDim){
        const scale = effectiveMaxDim / longest;
        width = Math.round(width*scale); height = Math.round(height*scale);
      }
      const canvas = new OffscreenCanvas(width, height);
      const encodeCtx = canvas.getContext("2d");
      // White first: bitmaps carrying real alpha (soft-mask compositing
      // above) must composite onto white, not onto the transparent-black
      // a bare canvas would hand the JPEG encoder. Previously every
      // bitmap reaching this point was fully opaque, so this changes
      // nothing for them.
      encodeCtx.fillStyle = "#fff";
      encodeCtx.fillRect(0, 0, width, height);
      encodeCtx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();
      const newBlob = await canvas.convertToBlob({type:"image/jpeg", quality});
      const newBytes = new Uint8Array(await newBlob.arrayBuffer());
      if(newBytes.length >= obj.contents.length){ stats.noGain++; continue; }

      const newDict = doc.context.obj({});
      dict.keys().forEach(k=>newDict.set(k, dict.get(k)));
      newDict.set(PDFName.of("Width"), PDFNumber.of(width));
      newDict.set(PDFName.of("Height"), PDFNumber.of(height));
      newDict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
      newDict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
      newDict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
      newDict.set(PDFName.of("Length"), PDFNumber.of(newBytes.length));
      newDict.delete(PDFName.of("DecodeParms"));
      newDict.delete(PDFName.of("Decode"));
      if(compositedAlpha) newDict.delete(PDFName.of("SMask"));
      doc.context.assign(ref, PDFRawStream.of(newDict, newBytes));
      touched++;
      stats.replaced = touched;
      if(compositedAlpha) stats.alphaComposited = (stats.alphaComposited || 0) + 1;
      if(replacedKind==="indexed") stats.fromIndexed = (stats.fromIndexed || 0) + 1;
      if(replacedKind==="cmyk") stats.fromCmyk = (stats.fromCmyk || 0) + 1;
    }catch(e){ /* leave this one object exactly as it was on any failure */ stats.skipped.error++; }
  }
  const outBytes = await doc.save();
  return { bytes: outBytes, imagesRecompressed: touched, stats };
}

/** Worker-side twin of pdf-processing-utils.js's compressToTarget() -
 *  identical binary-search logic, calling this file's own
 *  recompressPdfImages() at each step. */
async function compressToTarget(pdfBytes, targetBytes, onProgress){
  const originalSize = pdfBytes.byteLength ?? pdfBytes.length;
  if(originalSize <= targetBytes){
    return { bytes: new Uint8Array(pdfBytes), achieved:true, imagesRecompressed:0, alreadyUnderTarget:true, stats:newCompressStats() };
  }
  const MAX_ITERATIONS = 6;
  const presetAt = t => ({
    quality: COMPRESS_PRESETS.high.quality - t*(COMPRESS_PRESETS.high.quality-0.3),
    maxDim: Math.round(COMPRESS_PRESETS.high.maxDim - t*(COMPRESS_PRESETS.high.maxDim-700)),
  });
  let lo=0, hi=1, best=null, bestUnder=null;
  for(let i=0;i<MAX_ITERATIONS;i++){
    const t = (lo+hi)/2;
    const result = await recompressPdfImages(pdfBytes, presetAt(t));
    if(onProgress) onProgress(i+1, MAX_ITERATIONS, result.bytes.length);
    if(!best || result.bytes.length < best.bytes.length) best = result;
    if(result.bytes.length <= targetBytes){ bestUnder = result; hi = t; }
    else { lo = t; }
  }
  const chosen = bestUnder || best;
  return { bytes: chosen.bytes, achieved: chosen.bytes.length <= targetBytes, imagesRecompressed: chosen.imagesRecompressed, stats: chosen.stats };
}

self.onmessage = async (e) => {
  const { id, type, pdfBytes, preset, targetBytes } = e.data || {};
  try{
    if(type === "recompress"){
      const result = await recompressPdfImages(pdfBytes, preset, (step, total) => {
        self.postMessage({ id, kind:"progress", step, total });
      });
      self.postMessage({ id, kind:"result", bytes: result.bytes, imagesRecompressed: result.imagesRecompressed, stats: result.stats }, [result.bytes.buffer]);
    } else if(type === "compressToTarget"){
      const result = await compressToTarget(pdfBytes, targetBytes, (step, total, size) => {
        self.postMessage({ id, kind:"progress", step, total, size });
      });
      self.postMessage({ id, kind:"result", bytes: result.bytes, achieved: result.achieved, imagesRecompressed: result.imagesRecompressed, alreadyUnderTarget: !!result.alreadyUnderTarget, stats: result.stats }, [result.bytes.buffer]);
    } else {
      self.postMessage({ id, kind:"error", message: "Unknown job type: " + type });
    }
  }catch(err){
    self.postMessage({ id, kind:"error", message: (err && err.message) ? err.message : String(err) });
  }
};
