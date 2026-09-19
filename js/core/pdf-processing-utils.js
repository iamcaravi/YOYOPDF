/* ---------------- Helpers ---------------- */
/**
 * Sanitizes text before any page.drawText() call with a pdf-lib
 * StandardFont. Those fonts (Helvetica etc.) use WinAnsi encoding, which
 * can't represent many Unicode characters - currency symbols like ₹,
 * smart quotes, em dashes, emoji, non-Latin scripts. Calling
 * page.drawText() with such a character throws, and since that call
 * sits deep inside an async click handler, the error was previously
 * uncaught: the tool just froze on its last status message forever with
 * no explanation (found via real user-submitted documents containing
 * ₹). Replacing the common cases and stripping anything else outside
 * Latin-1 lets the conversion degrade instead of crash.
 * @param {string} s - text about to be drawn with a StandardFont.
 * @returns {string} WinAnsi-safe text.
 */
function winAnsiSafe(s){
  return String(s)
    .replace(/₹/g, "Rs.")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x00-\xFF]/g, "?");
}
/* Quality floors raised across the board (previously 0.35/0.6/0.85) - at
   quality 0.6 a scanned page's embedded image (where the "image" IS the
   page content, small text included) visibly artifacts, which is what
   "Recommended" being the default was doing to every scanned/photo PDF.
   maxDim raised to match: a Letter/A4 page scanned at even 200 DPI is
   ~1700-2200px on its long edge, so the old 1600 ceiling was already
   downscaling typical scans before quality even entered the picture.
   Readability now wins over squeezing out a few extra percent. */
/* Compress PDF V2: Recommended splits quality by image class. `quality`
   is what an ordinary photo gets; `documentQuality` (optional) is what an
   image the classifier below calls a scanned/typed page gets instead, so
   text stays crisp while photos - which tolerate it - are squeezed harder.
   A preset without documentQuality (High, Extreme, every Custom step)
   uses `quality` for everything, exactly as before. 0.82 -> 0.75 for photos
   is what makes mid-size q85 photo PDFs actually shrink: at 0.82 the
   re-encode is usually not smaller than the source and is thrown away. */
const COMPRESS_PRESETS = {
  high:      { quality: 0.92, maxDim: 3000, protectDocuments: true },
  recommended: { quality: 0.75, documentQuality: 0.82, maxDim: 2200, protectDocuments: true },
  max:       { quality: 0.55, maxDim: 1400, protectDocuments: false },
};
// A page scanned at ~200 DPI on Letter/A4 is roughly 1700-2200px on its
// long edge; 2800 gives real headroom above that so a "Recommended"
// compression never drops a genuine scanned page below normal reading
// resolution, even though its own maxDim (2200) would otherwise downscale
// it. Only used for images that *look* like a scanned page (see
// looksLikeDocumentPage below) - a real photo at 2200+ still downscales
// normally, since forcing every large image up to 2800 would defeat the
// point of the "Recommended" tier for photo-heavy PDFs.
const DOC_PAGE_MIN_LONG_EDGE = 2800;
/* Cheap, dependency-free heuristic for "this embedded image is probably a
   scanned document page, not a photo" - just the aspect ratio and
   absolute size, no pixel sampling/OCR. A4 is 1:1.414, Letter 1:1.294,
   Legal 1:1.647; the band below covers all three with margin. Deliberately
   conservative (a real photo shot in portrait A-series-ish proportions is
   a false positive here, which only means it gets treated a bit more
   gently than strictly necessary - never the reverse). */
function looksLikeDocumentPage(width, height){
  const longest = Math.max(width, height), shortest = Math.min(width, height);
  if(shortest < 900) return false; // too small to plausibly be a full-page scan
  const ratio = longest / shortest;
  return ratio > 1.2 && ratio < 1.75;
}
/* Compress PDF V2: pixel-based document-page classifier.
   looksLikeDocumentPage() above can only look at size and aspect ratio, and
   that cannot tell a 4:3 or 3:2 camera photo from a Letter/A4 page (A4 is
   1.41, Letter 1.29, 4:3 is 1.33) - every ordinary photo was being
   "protected" as a scanned page. It stays as the cheap PREFILTER; only
   images that pass it are then looked at. A scanned/typed page is one
   dominant, tight "paper" tone (paper colour plus scanner noise) with a
   little ink on it; a photo spreads across many tones. So the signal is
   taken from a 128px POINT-SAMPLED thumbnail of the already-decoded bitmap
   (no smoothing: averaging blends dense text into mid-grey and smears the
   paper tone - a dense text page measured paperShare 0.32 averaged vs
   0.77 point-sampled, on the labelled calibration set):
     paperShare - share of opaque pixels whose luma is inside the busiest
                  16-level luma window;
     peakLuma   - centre of that window (a flat DARK image - a night
                  photo - also has one tight mode, but paper is never dark).
   Errors are deliberately asymmetric: calling a photo a "document" only
   costs some compression on that photo, calling a page a "photo" blurs
   text. The threshold therefore leans towards "document" (see
   DOC_PAPER_SHARE_MIN's own note). Kept byte-identical in
   js/workers/pdf-compress-worker.js. */
const DOC_THUMB_LONG_EDGE = 128;
const DOC_PAPER_WINDOW = 16;
// Provisional 0.45 from the design phase; validated (and kept or changed)
// against the labelled fixture set - see the Phase 5 report.
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
    if(rgba[i+3] < 128) continue; // transparent pixels say nothing about the page
    hist[(0.299*rgba[i] + 0.587*rgba[i+1] + 0.114*rgba[i+2] + 0.5) | 0]++;
    n++;
  }
  if(!n) return {paperShare:0, peakLuma:0};
  let win = 0;
  for(let v=0; v<DOC_PAPER_WINDOW; v++) win += hist[v];
  let best = win, bestLo = 0;
  for(let lo=1; lo<=256-DOC_PAPER_WINDOW; lo++){
    win += hist[lo+DOC_PAPER_WINDOW-1] - hist[lo-1];
    if(win > best){ best = win; bestLo = lo; } // first (darkest) window wins ties - deterministic
  }
  return {paperShare: best/n, peakLuma: bestLo + DOC_PAPER_WINDOW/2};
}
function isDocumentPageFromSignals(signals){
  return signals.paperShare >= DOC_PAPER_SHARE_MIN && signals.peakLuma >= DOC_PEAK_LUMA_MIN;
}
/* `canvas` is any 2D-capable canvas (an HTMLCanvasElement on the main
   thread, an OffscreenCanvas in the worker). */
function documentSignalsFromBitmap(bitmap, canvas){
  const size = documentThumbSize(bitmap.width, bitmap.height);
  canvas.width = size.width; canvas.height = size.height;
  const ctx = canvas.getContext("2d", {willReadFrequently:true});
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  return documentSignalsFromPixels(ctx.getImageData(0, 0, size.width, size.height).data);
}
/* Resolves a PDF image ColorSpace entry to a component count (3=RGB,
   1=Gray) when - and only when - that can be determined with confidence;
   returns null for anything else (CMYK, Indexed, Separation/DeviceN, Lab,
   or an ICCBased/array form this can't resolve). Used only by the raw
   FlateDecode image path in recompressPdfImages(): unlike a JPEG (which
   is self-describing), raw pixel bytes have no built-in colour signal, so
   guessing wrong here would corrupt every pixel rather than just miss a
   compression opportunity - null means "leave this image alone". Handles
   both a direct Name (/DeviceRGB) and the array form PDFs commonly use
   for an embedded colour profile ([/ICCBased 5 0 R]), which is what most
   browser/Office "Print/Save as PDF" exporters attach to PNG-derived
   images - resolved via the profile stream's own /N (component count),
   not the profile data itself. */
function resolveImageComponents(colorSpaceObj, context, PDFName){
  if(!colorSpaceObj) return null;
  if(colorSpaceObj.asString){
    const name = colorSpaceObj.asString();
    if(/DeviceRGB|CalRGB/.test(name)) return 3;
    if(/DeviceGray|CalGray/.test(name)) return 1;
    return null; // CMYK/Indexed/Separation/Lab etc - not handled
  }
  const arr = colorSpaceObj.array;
  if(!Array.isArray(arr) || !arr.length) return null;
  const head = arr[0];
  if(head?.asString?.() !== "/ICCBased") return null; // Indexed/Separation/DeviceN/Lab etc - not handled
  const streamObj = arr[1] && context?.lookup ? context.lookup(arr[1]) : null;
  const n = streamObj?.dict?.lookup?.(PDFName.of("N"));
  const nVal = n?.asNumber?.();
  if(nVal===3) return 3;
  if(nVal===1) return 1;
  return null; // 4-component (CMYK) ICC profile, or unresolvable
}
/* Inflates a raw (headers-and-all) FlateDecode stream using the browser's
   native zlib implementation - no extra dependency needed alongside
   pdf-lib/pdf.js. FlateDecode in PDF is the zlib format (RFC 1950), which
   is exactly what the Streams API's "deflate" format name means (as
   opposed to "deflate-raw", RFC 1951 with no zlib wrapper). */
async function inflateFlateBytes(bytes){
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
/* Reverses PDF's PNG-style predictor (Predictor 10-15: the actual
   per-row filter type - None/Sub/Up/Average/Paeth - is always encoded as
   a leading byte on each row, independent of which of 10-15 was declared
   in DecodeParms) on inflated raw image bytes. Standard PNG defiltering
   algorithm; bpp below is bytes-per-pixel (3 for 8-bit RGB, 1 for 8-bit
   Gray), matching the only bit depth this function's caller supports.
   @param {Uint8Array} data - inflated bytes: (1 + rowBytes) per row.
   @param {number} height
   @param {number} components - unused directly, kept for call-site clarity
   @param {number} rowBytes - bytes per unfiltered row (width*components)
   @returns {Uint8Array} rowBytes*height bytes, filter type bytes removed.
*/
function unfilterPngRows(data, width, height, components, rowBytes){
  const bpp = components; // 8 bits/component, so bytes-per-pixel === components
  const out = new Uint8Array(rowBytes*height);
  let prevRow = new Uint8Array(rowBytes);
  let pos = 0;
  for(let y=0; y<height; y++){
    if(pos >= data.length) return null; // truncated - let the caller bail out
    const filterType = data[pos++];
    const outRow = out.subarray(y*rowBytes, y*rowBytes+rowBytes);
    for(let i=0; i<rowBytes; i++){
      const raw = data[pos+i] ?? 0;
      const a = i>=bpp ? outRow[i-bpp] : 0;
      const b = prevRow[i];
      const c = i>=bpp ? prevRow[i-bpp] : 0;
      let val;
      switch(filterType){
        case 0: val = raw; break; // None
        case 1: val = (raw + a) & 0xff; break; // Sub
        case 2: val = (raw + b) & 0xff; break; // Up
        case 3: val = (raw + ((a+b)>>1)) & 0xff; break; // Average
        case 4: { // Paeth
          const p = a+b-c;
          const pa = Math.abs(p-a), pb = Math.abs(p-b), pc = Math.abs(p-c);
          val = (raw + (pa<=pb && pa<=pc ? a : (pb<=pc ? b : c))) & 0xff;
          break;
        }
        default: return null; // unrecognized filter type - don't guess
      }
      outRow[i] = val;
    }
    pos += rowBytes;
    prevRow = outRow;
  }
  return out;
}
/* Recompresses the embedded raster images inside a PDF, in place, at the
   same object reference - page content streams (text, vector paths, fonts)
   are never touched, so text stays exactly as sharp as the original
   regardless of preset. Two source formats are handled:
     - DCTDecode (already-JPEG) images: decoded and re-encoded at the
       preset's quality/maxDim.
     - FlateDecode (raw/lossless) images: this is the common case that was
       previously invisible to this function entirely - PNG-derived images
       (screenshots, "Print to PDF" output, Office/browser PDF export,
       pdf-lib-embedded PNGs) store their pixels as plain zlib-compressed
       RGB/Gray bytes, optionally with a PNG predictor filter per row.
       Flate on photographic pixel data rarely beats JPEG by more than a
       small margin, which is exactly why PDFs built this way "compress"
       to nearly the same size today - the images were never being
       recompressed at all, just losslessly re-flated. This path inflates
       those raw bytes, undoes the PNG predictor if present, and feeds the
       result through the exact same scale/encode/no-gain-skip pipeline as
       the JPEG path below, converting it to a real JPEG.
   Both paths require a colour space this function can confidently resolve
   to RGB or Gray (DeviceRGB/DeviceGray/CalRGB/CalGray, or an ICCBased
   space whose stream declares N=3 or N=1) and no soft mask - CMYK,
   Indexed, Separation/DeviceN, and anything with an alpha channel is left
   completely untouched rather than risking wrong colors or lost
   transparency. Real-world "PDF is too big" cases are almost always
   driven by embedded photos/scans in one of these two forms, so this
   covers the common case without the risk of a broader rewrite. */
// How often (in encoded images, not PDF objects) the main-thread fallback
// yields to the event loop during its per-image encode loop - see the
// yield's own comment further down for why. Benchmarked on a real
// image-heavy PDF against every 1/2/4 images before landing on this
// value (Phase 2 investigation/implementation notes).
const FALLBACK_YIELD_EVERY_N_IMAGES = 1;
/** Thrown (name "CompressionCancelled") when a cancellation signal fires
 *  at one of the fallback's cooperative yield points - the same error
 *  name cancelCompressWorker() already uses for the Worker path, so the
 *  existing click-handler catch block in TOOLS.compress (pdf-page-tools-1.js)
 *  handles both paths identically with no changes needed there. A no-op
 *  when `signal` is undefined (e.g. any caller that hasn't opted into
 *  cancellation), so this is safe to call unconditionally. */
function throwIfCompressionCancelled(signal){
  if(signal?.aborted){
    const err = new Error("Compression cancelled");
    err.name = "CompressionCancelled";
    throw err;
  }
}
/* PDF /Decode is an array of [min max] pairs, one per colour component; the
   identity mapping is [0 1] repeated. Anything else (e.g. [1 0] to invert)
   changes how the stored samples are displayed - and the canvas re-encode
   below reads the pixels WITHOUT applying /Decode and then drops the key,
   so such an image would come out visibly inverted/remapped. Skipped. */
function isIdentityDecode(decode){
  if(!decode) return true;
  const arr = decode.asArray ? decode.asArray() : null;
  if(!arr || !arr.length || arr.length % 2) return false;
  for(let i=0; i<arr.length; i+=2){
    if(arr[i]?.asNumber?.() !== 0 || arr[i+1]?.asNumber?.() !== 1) return false;
  }
  return true;
}
/* What the engine reports about the images it looked at, so the UI can tell
   "no images at all" from "images we can't safely touch" from "already as
   small as re-encoding can make them". `found` excludes soft-mask images
   (they are not pictures the user knows about); `eligible` = passed every
   guard and was actually decoded; eligible = replaced + noGain +
   decodeFailed. Mirrored in js/workers/pdf-compress-worker.js. */
function newCompressStats(){
  return {
    found:0, eligible:0, replaced:0, noGain:0, decodeFailed:0, maskImages:0, documentPages:0,
    skipped:{unsupportedFilter:0, alpha:0, masked:0, decode:0, colorSpace:0, unsupportedParams:0, error:0}
  };
}
function compressStatsSkippedTotal(stats){
  const sk = (stats && stats.skipped) || {};
  return Object.keys(sk).reduce((n, k)=>n + (sk[k]||0), 0);
}
/* Compress PDF V2: turns "what the engine returned" into exactly one
   user-facing outcome, so the result screen can say WHY a file did or did
   not get smaller instead of showing a generic success. Pure (no DOM, no
   i18n lookup - it returns a message key + variables) so every branch is
   unit-testable. The 4% floor is passed in by the caller and is NOT applied
   to Custom (target-size) runs, exactly as before.

   input:
     originalSize, candidateSize - bytes of the PDF and of the engine output
     stats     - newCompressStats() shape from the engine (may be missing)
     floorPct  - minimum % saving worth keeping the re-encoded file for
     custom    - null, or {alreadyUnderTarget, achieved, targetBytes}
     verifyFailed - the compressed file failed the reload/page-count check
   output: {kind, changed, key, vars, tipKey?, tipVars?}
     changed=false means the ORIGINAL bytes are what the user gets. */
function describeCompressOutcome(input){
  const {originalSize, candidateSize, floorPct, custom, verifyFailed} = input;
  const stats = input.stats || newCompressStats();
  const savedPct = originalSize > 0 ? (1 - candidateSize/originalSize) * 100 : 0;
  const unchanged = (kind, key, vars)=>({kind, changed:false, key, vars: vars || {}});
  if(verifyFailed) return unchanged("verifyFailed", "toolCompress.outVerifyFailed");
  if(custom && custom.alreadyUnderTarget){
    return unchanged("alreadyUnderTarget", "toolCompress.doneAlreadyUnderTarget", {size: fmtSize(originalSize)});
  }
  const smaller = candidateSize < originalSize;
  const meaningful = smaller && (!!custom || savedPct >= floorPct);
  if(!meaningful){
    // Re-encoded some images and got a real (but sub-floor) saving.
    if(smaller && stats.replaced > 0){
      return unchanged("belowFloor", "toolCompress.outBelowFloor", {
        pct: (Math.round(savedPct*10)/10).toString(), floor: String(floorPct), from: fmtSize(originalSize), to: fmtSize(candidateSize)
      });
    }
    if(stats.found === 0) return unchanged("noImages", "toolCompress.outNoImages");
    if(stats.eligible === 0) return unchanged("noneEligible", "toolCompress.outNoneEligible", {n: stats.found});
    return unchanged("noGain", "toolCompress.outNoGain", {n: stats.eligible});
  }
  const vars = {from: fmtSize(originalSize), to: fmtSize(candidateSize), pct: Math.round(savedPct)};
  if(custom && !custom.achieved){
    return {kind:"targetMissed", changed:true, key:"toolCompress.doneTargetMissed", vars:{size: fmtSize(candidateSize), target: fmtSize(custom.targetBytes)}};
  }
  const skipped = compressStatsSkippedTotal(stats);
  if(stats.replaced > 0){
    const out = {kind:"reduced", changed:true, key:"toolCompress.outReduced", vars};
    if(skipped > 0){ out.tipKey = "toolCompress.outSkippedTip"; out.tipVars = {n: skipped, total: stats.found}; }
    return out;
  }
  return {kind:"structure", changed:true, key:"toolCompress.outStructure", vars};
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
async function recompressPdfImagesMainThread(pdfBytes, presetName, onImageProgress, signal){
  throwIfCompressionCancelled(signal);
  // Custom mode (below) needs arbitrary {quality, maxDim} pairs that don't
  // correspond to any named preset - accepting an object here directly,
  // alongside the existing named-preset strings every other caller still
  // uses unchanged, avoids inventing a parallel copy of this whole function.
  const preset = typeof presetName === "object" && presetName
    ? presetName
    : (COMPRESS_PRESETS[presetName] || COMPRESS_PRESETS.recommended);
  // Main-thread-only override: loadPdfSafe()'s app-wide default is
  // ParseSpeeds.Fastest (zero cooperative yields during parse - see its
  // own comment in js/app.js for why that's the right call everywhere
  // else). On THIS path specifically, the parse runs on the UI thread
  // with nothing else to keep it responsive, so it's worth trading some
  // of that speed for periodic yields instead - Medium (500
  // objects/tick) rather than Slow (100), since this fixture set showed
  // Slow costing ~1.7x the parse time for not much extra yield density
  // on documents in the size range this fallback actually sees. Passed
  // as extraOpts (loadPdfSafe already supports overriding parseSpeed
  // per call) - the shared default other tools use is untouched.
  const doc = await loadPdfSafe(pdfBytes, {parseSpeed: ParseSpeeds.Medium});
  throwIfCompressionCancelled(signal);
  const { PDFName, PDFRawStream, PDFNumber, PDFRef } = PDFLib;
  let touched = 0;
  let encodedCount = 0;
  const stats = newCompressStats();
  let thumbCanvas = null; // reused by the document classifier
  // Soft-mask / explicit-mask images are alpha data belonging to another
  // image, not pictures in their own right: never recompress them (a lossy
  // re-encode of a mask corrupts the transparency) and don't count them as
  // images the user has.
  const allObjects = Array.from(doc.context.enumerateIndirectObjects());
  const maskRefs = new Set();
  for(const [,obj] of allObjects){
    if(!(obj instanceof PDFRawStream)) continue;
    for(const key of ["SMask", "Mask"]){
      const target = obj.dict.get(PDFName.of(key));
      if(target instanceof PDFRef) maskRefs.add(target.toString());
    }
  }
  // Materialized once so onImageProgress can report "image N of M" instead
  // of a silent multi-second loop on image-heavy PDFs, which previously
  // looked identical to a hung tab on large files.
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
      // Exact match only (not "includes") - a combined filter chain like
      // "/ASCII85Decode,/FlateDecode" needs a decode step this function
      // doesn't implement, so it's left untouched rather than guessed at.
      const isRawFlate = filterName === "/FlateDecode";
      if(!isJpeg && !isRawFlate){ stats.skipped.unsupportedFilter++; continue; } // neither format this function knows how to re-encode
      if(dict.lookup(PDFName.of("SMask"))){ stats.skipped.alpha++; continue; } // has transparency - skip, JPEG can't keep it
      // A colour-key /Mask marks specific sample values transparent; a lossy
      // re-encode no longer produces those exact values, so the transparency
      // would silently break.
      if(dict.lookup(PDFName.of("Mask"))){ stats.skipped.masked++; continue; }
      if(!isIdentityDecode(dict.lookup(PDFName.of("Decode")))){ stats.skipped.decode++; continue; }

      let bitmap = null;
      if(isJpeg){
        const colorSpace = dict.lookup(PDFName.of("ColorSpace"));
        const csName = colorSpace && colorSpace.asString ? colorSpace.asString() : "";
        if(csName && !/DeviceRGB|DeviceGray|CalRGB|CalGray/.test(csName)){ stats.skipped.colorSpace++; continue; } // skip CMYK/Indexed etc.
        stats.eligible++;
        const blob = new Blob([jpegWithoutExif(obj.contents)], {type:"image/jpeg"});
        // createImageBitmap() has been observed elsewhere in this app to
        // hang indefinitely (never resolving or rejecting) rather than
        // erroring on some inputs - without a timeout here, one bad image
        // would silently block every remaining image in the PDF forever,
        // since this runs in a sequential loop. Same "skip on failure"
        // philosophy as CMYK/SMask above - a timed-out image is left
        // untouched.
        // The EXIF segment was stripped above (see jpegWithoutExif) so the
        // browser cannot auto-rotate the pixels.
        bitmap = await Promise.race([
          createImageBitmap(blob),
          new Promise((_, reject) => setTimeout(() => reject(new Error("decode timed out")), 8000))
        ]).catch(()=>null);
      } else {
        // Raw/lossless image: unlike JPEG, the pixel bytes carry no
        // built-in colour-space signal, so this path requires a
        // confidently-resolved component count (3=RGB, 1=Gray) rather
        // than the JPEG path's "assume RGB unless proven otherwise" -
        // guessing wrong here would corrupt every pixel, not just miss a
        // compression opportunity.
        const width = dict.lookup(PDFName.of("Width"))?.asNumber?.();
        const height = dict.lookup(PDFName.of("Height"))?.asNumber?.();
        const bpc = dict.lookup(PDFName.of("BitsPerComponent"))?.asNumber?.();
        const components = resolveImageComponents(dict.lookup(PDFName.of("ColorSpace")), doc.context, PDFName);
        if(!components){ stats.skipped.colorSpace++; continue; }
        // 8 bits/component only - 1/2/4-bit raw images (rare, and usually
        // already tiny after Flate) and 16-bit are out of scope here.
        // Width*height capped well under typical browser/canvas limits so
        // a pathological Width/Height pair can't force an enormous
        // in-memory pixel buffer before any of the real image bytes have
        // even been inflated.
        if(!width || !height || bpc!==8 || width*height>30_000_000){ stats.skipped.unsupportedParams++; continue; }
        const predictor = dict.lookup(PDFName.of("DecodeParms"))?.lookup?.(PDFName.of("Predictor"))?.asNumber?.() ?? 1;
        if(predictor!==1 && (predictor<10 || predictor>15)){ stats.skipped.unsupportedParams++; continue; } // TIFF predictor / unknown - not implemented, skip
        stats.eligible++;
        const inflated = await Promise.race([
          inflateFlateBytes(obj.contents),
          new Promise((_, reject) => setTimeout(() => reject(new Error("inflate timed out")), 8000))
        ]).catch(()=>null);
        if(!inflated){ stats.decodeFailed++; continue; }
        const rowBytes = width*components;
        const raw = predictor===1 ? inflated : unfilterPngRows(inflated, width, height, components, rowBytes);
        if(!raw || raw.length < rowBytes*height){ stats.decodeFailed++; continue; } // truncated/corrupt - leave untouched
        const rgba = new Uint8ClampedArray(width*height*4);
        if(components===3){
          for(let p=0, s=0; p<width*height; p++, s+=3){
            rgba[p*4]=raw[s]; rgba[p*4+1]=raw[s+1]; rgba[p*4+2]=raw[s+2]; rgba[p*4+3]=255;
          }
        } else { // components===1, DeviceGray/CalGray
          for(let p=0; p<width*height; p++){
            const g = raw[p]; rgba[p*4]=g; rgba[p*4+1]=g; rgba[p*4+2]=g; rgba[p*4+3]=255;
          }
        }
        bitmap = await createImageBitmap(new ImageData(rgba, width, height)).catch(()=>null);
      }
      if(!bitmap){ stats.decodeFailed++; continue; } // not decodable (or timed out) - skip rather than guess

      let {width, height} = bitmap;
      const longest = Math.max(width, height);
      // Scanned-page-shaped images get a higher effective ceiling (and, on
      // Recommended, a higher quality) so a real document page never gets
      // downscaled below normal reading resolution or over-compressed just
      // because "Recommended" was selected - see DOC_PAGE_MIN_LONG_EDGE and
      // the pixel classifier above. Only images that pass the cheap
      // size/aspect prefilter are ever looked at.
      let isDocument = false;
      if(preset.protectDocuments && looksLikeDocumentPage(width, height)){
        if(!thumbCanvas) thumbCanvas = document.createElement("canvas");
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
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
      const newDataUrl = canvas.toDataURL("image/jpeg", quality);
      const newBytes = Uint8Array.from(atob(newDataUrl.split(",")[1]), c=>c.charCodeAt(0));
      // canvas.toDataURL() above is a synchronous, CPU-heavy JPEG encode -
      // the one part of this loop with no built-in async yield point
      // (unlike createImageBitmap/inflateFlateBytes above, which are real
      // awaited decodes). Yielding here every FALLBACK_YIELD_EVERY_N_IMAGES
      // encoded images (not every object visited - most objects in a PDF
      // aren't images at all) gives the main thread a chance to repaint
      // and handle input between encode bursts; benchmarked against every
      // 1/2/4 images on a real image-heavy PDF before picking this value
      // (see the Phase 2 investigation/implementation notes).
      encodedCount++;
      if(encodedCount % FALLBACK_YIELD_EVERY_N_IMAGES === 0){
        await new Promise(resolve => setTimeout(resolve, 0));
        throwIfCompressionCancelled(signal);
      }
      if(newBytes.length >= obj.contents.length){ stats.noGain++; continue; } // no gain - keep original for this image

      const newDict = doc.context.obj({});
      dict.keys().forEach(k=>newDict.set(k, dict.get(k))); // start from a copy of the original dict
      newDict.set(PDFName.of("Width"), PDFNumber.of(width));
      newDict.set(PDFName.of("Height"), PDFNumber.of(height));
      newDict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
      newDict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
      newDict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
      newDict.set(PDFName.of("Length"), PDFNumber.of(newBytes.length));
      // The source dict's DecodeParms (PNG predictor settings) and Decode
      // (component remap, e.g. an inverted-grayscale mask) no longer apply
      // once the stream is real DCTDecode/DeviceRGB JPEG data - carrying
      // either over would misinterpret the new bytes. (Decode can only be
      // identity here - non-identity images were skipped above.)
      newDict.delete(PDFName.of("DecodeParms"));
      newDict.delete(PDFName.of("Decode"));
      doc.context.assign(ref, PDFRawStream.of(newDict, newBytes));
      touched++;
      stats.replaced = touched;
    }catch(e){
      // Cancellation (thrown by throwIfCompressionCancelled at the yield
      // point above) must propagate out of the loop, not be swallowed as
      // "this one image failed to compress" like every other error here -
      // it isn't a per-image failure, the whole operation is stopping.
      if(e && e.name === "CompressionCancelled") throw e;
      /* leave this one object exactly as it was on any other failure */
      stats.skipped.error++;
    }
  }
  const outBytes = await doc.save();
  return { bytes: outBytes, imagesRecompressed: touched, stats };
}
/**
 * Custom "target size" compression: binary-searches a single aggressiveness
 * knob (0 = the existing "high" preset's quality/maxDim, 1 = harder than
 * "max") and re-runs recompressPdfImages() at each step, since that's the
 * only compression lever this engine actually has (it only ever touches
 * embedded JPEGs, same as every preset) - this is not a separate
 * compression algorithm, just the existing one driven toward a target
 * instead of a fixed preset. Bounded to MAX_ITERATIONS real compression
 * passes so a stubborn PDF can't spin forever.
 * @param {ArrayBuffer|Uint8Array} pdfBytes
 * @param {number} targetBytes - requested output size ceiling, in bytes.
 * @param {(step:number, total:number, currentSize:number)=>void} [onProgress]
 * @returns {Promise<{bytes:Uint8Array, achieved:boolean, imagesRecompressed:number}>}
 *   achieved is false when even the most aggressive pass this engine can do
 *   still landed above targetBytes - bytes is still the smallest result
 *   found, just not a guarantee of hitting the target.
 */
async function compressToTargetMainThread(pdfBytes, targetBytes, onProgress, signal){
  const originalSize = pdfBytes.byteLength ?? pdfBytes.length;
  if(originalSize <= targetBytes){
    return { bytes: new Uint8Array(pdfBytes), achieved:true, imagesRecompressed:0, alreadyUnderTarget:true, stats:newCompressStats() };
  }
  const MAX_ITERATIONS = 6;
  // t=0 -> same ceiling as the "high" (least-aggressive) preset
  // t=1 -> a floor kept above the point where text-in-scans stops being
  // readable, even though the user explicitly asked for a target size -
  // "as close as possible without destroying image quality" per the UI's
  // own copy, not truly unbounded.
  const presetAt = t => ({
    quality: COMPRESS_PRESETS.high.quality - t*(COMPRESS_PRESETS.high.quality-0.3),
    maxDim: Math.round(COMPRESS_PRESETS.high.maxDim - t*(COMPRESS_PRESETS.high.maxDim-700)),
  });
  let lo=0, hi=1, best=null, bestUnder=null;
  for(let i=0;i<MAX_ITERATIONS;i++){
    const t = (lo+hi)/2;
    // Cancellation raised inside recompressPdfImagesMainThread's own
    // yield points propagates straight out of this await and out of this
    // loop - no separate check needed here for that. This one covers the
    // gap between iterations too (e.g. cancel arriving right as one
    // iteration finishes and before the next one's parse starts).
    throwIfCompressionCancelled(signal);
    const result = await recompressPdfImagesMainThread(pdfBytes, presetAt(t), null, signal);
    if(onProgress) onProgress(i+1, MAX_ITERATIONS, result.bytes.length);
    if(!best || result.bytes.length < best.bytes.length) best = result;
    if(result.bytes.length <= targetBytes){ bestUnder = result; hi = t; }
    else { lo = t; }
  }
  const chosen = bestUnder || best;
  return { bytes: chosen.bytes, achieved: chosen.bytes.length <= targetBytes, imagesRecompressed: chosen.imagesRecompressed, stats: chosen.stats };
}

/* ---------------- Worker-backed compression (Phase 4) ----------------
   recompressPdfImagesMainThread()/compressToTargetMainThread() above are
   the original, fully-synchronous-per-image implementations - they still
   exist unchanged and are now the fallback path. The image
   decode/re-encode loop and pdf-lib's own doc.save() are both long
   uninterruptible synchronous stretches; on a large or image-heavy PDF
   that froze the tab (no scrolling, no repaint, Cancel impossible) for
   the whole operation. js/workers/pdf-compress-worker.js runs the exact
   same algorithm off the main thread instead - see that file's header for
   the message protocol and why cancellation there is a hard
   Worker.terminate() rather than a cooperative flag.

   recompressPdfImages()/compressToTarget() below are what the rest of the
   app actually calls (same names/signatures the main-thread versions used
   to have) - they route to the worker when supported and fall back to the
   main-thread path both when the browser lacks Worker/OffscreenCanvas and
   if the worker itself fails to start (e.g. blocked by CSP, offline first
   load before the CDN script is cached). A genuine compression failure
   (corrupt PDF, etc.) surfaces as a real error either way, since it would
   just fail identically on a retry. */
let __compressWorker = null;
let __compressJobSeq = 0;
const __compressJobs = new Map(); // id -> {resolve, reject, onProgress}

function compressWorkerSupported(){
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined";
}

function getCompressWorker(){
  if(__compressWorker) return __compressWorker;
  let w;
  try{
    w = new Worker("js/workers/pdf-compress-worker.js");
  }catch(e){
    const err = new Error("Could not start the PDF compression worker");
    err.name = "CompressWorkerUnavailable";
    throw err;
  }
  w.onmessage = (e)=>{
    const data = e.data || {};
    const job = __compressJobs.get(data.id);
    if(!job) return;
    if(data.kind === "progress"){
      if(job.onProgress) job.onProgress(data.step, data.total, data.size);
    } else if(data.kind === "result"){
      __compressJobs.delete(data.id);
      job.resolve(data);
    } else if(data.kind === "error"){
      __compressJobs.delete(data.id);
      job.reject(new Error(data.message || "Compression failed"));
    }
  };
  w.onerror = (ev)=>{
    // A worker-level failure (script 404, importScripts blocked, syntax
    // error) rather than a job-level rejection - reject whatever's in
    // flight and drop this worker so the next call starts a fresh one,
    // tagged so the callers below know to fall back to the main thread
    // instead of surfacing this as a real compression error.
    const err = new Error(ev?.message || "PDF compression worker failed to start");
    err.name = "CompressWorkerUnavailable";
    __compressJobs.forEach(job=>job.reject(err));
    __compressJobs.clear();
    __compressWorker = null;
  };
  __compressWorker = w;
  return w;
}

/**
 * Immediately kills the active compression worker, rejecting whatever job
 * is in flight - the only way to interrupt pdf-lib's synchronous doc.save()
 * mid-run, since it has no cooperative cancellation point to check a flag
 * against. Safe to call with no job running (no-op). A fresh worker is
 * created lazily on the next compress call.
 */
function cancelCompressWorker(){
  if(!__compressWorker) return;
  __compressWorker.terminate();
  __compressWorker = null;
  const err = new Error("Compression cancelled");
  err.name = "CompressionCancelled";
  __compressJobs.forEach(job=>job.reject(err));
  __compressJobs.clear();
}

function runCompressJob(type, payload, onProgress){
  const worker = getCompressWorker(); // may throw CompressWorkerUnavailable
  return new Promise((resolve, reject)=>{
    const id = ++__compressJobSeq;
    __compressJobs.set(id, {resolve, reject, onProgress});
    // pdfBytes is transferred, not copied - every call site below passes
    // its own fresh .slice() so the caller's original reference (still
    // needed afterward, e.g. for byteLength comparisons) is never the one
    // handed off and detached here.
    worker.postMessage({ id, type, ...payload }, [payload.pdfBytes.buffer]);
  });
}

// `signal` (an AbortSignal, optional) only ever reaches the *MainThread
// fallback calls below - the Worker branch's cancellation is, and
// remains, exclusively cancelCompressWorker()'s Worker.terminate(); a
// signal handed to this function has no effect at all on the Worker path.
async function recompressPdfImages(pdfBytes, presetName, onImageProgress, signal){
  if(!compressWorkerSupported()) return recompressPdfImagesMainThread(pdfBytes, presetName, onImageProgress, signal);
  try{
    const bytesCopy = (pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes)).slice();
    const data = await runCompressJob("recompress", { pdfBytes: bytesCopy, preset: presetName }, onImageProgress);
    return { bytes: data.bytes, imagesRecompressed: data.imagesRecompressed, stats: data.stats };
  }catch(err){
    if(err && err.name === "CompressWorkerUnavailable") return recompressPdfImagesMainThread(pdfBytes, presetName, onImageProgress, signal);
    throw err;
  }
}

async function compressToTarget(pdfBytes, targetBytes, onProgress, signal){
  const originalSize = pdfBytes.byteLength ?? pdfBytes.length;
  if(originalSize <= targetBytes){
    return { bytes: new Uint8Array(pdfBytes), achieved:true, imagesRecompressed:0, alreadyUnderTarget:true, stats:newCompressStats() };
  }
  if(!compressWorkerSupported()) return compressToTargetMainThread(pdfBytes, targetBytes, onProgress, signal);
  try{
    const bytesCopy = (pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes)).slice();
    const data = await runCompressJob("compressToTarget", { pdfBytes: bytesCopy, targetBytes }, onProgress);
    return { bytes: data.bytes, achieved: data.achieved, imagesRecompressed: data.imagesRecompressed, alreadyUnderTarget: !!data.alreadyUnderTarget, stats: data.stats };
  }catch(err){
    if(err && err.name === "CompressWorkerUnavailable") return compressToTargetMainThread(pdfBytes, targetBytes, onProgress, signal);
    throw err;
  }
}
function fmtSize(bytes){
  if(bytes < 1024) return bytes+" B";
  if(bytes < 1024*1024) return (bytes/1024).toFixed(1)+" KB";
  return (bytes/1024/1024).toFixed(2)+" MB";
}
/* Object URLs created for the current result download / quick-preview
   strip / file-card thumbnails - tracked here so each is revoked exactly
   once (superseded by a newer one, or the tool workspace closing) instead
   of never. A Blob URL keeps its Blob's bytes alive in memory for as long
   as it stays registered, regardless of whether the DOM node that used it
   is still on the page - removing the <a>/<img> alone doesn't release it.
   window.loadImage() (used by the single-image tools further below, and
   by js/editor/editor-toolbar.js's picked-image/signature placement) is
   deliberately NOT tracked here: editor-toolbar.js keeps that URL alive
   on purpose for as long as the placed image object exists (it becomes
   the object's data.src, re-read on every render and by export), so a
   blanket revoke-on-load would break Edit PDF's "add image"/signature
   feature. See that file's own pendingImageUrl lifecycle for how it's
   handled instead. */
let __activeResultUrl = null;
let __quickPreviewUrl = null;
let __quickPreviewGeneration = 0;
let __fileCardPreviewUrls = [];
/**
 * Wraps a result Blob as an object URL ready for a `<a download>` link.
 * Revokes the previous result's URL first, if any - a tool that
 * regenerates its output (re-running with new settings without closing
 * the panel) would otherwise leak one URL per run.
 * @param {Blob} blob - the file bytes to offer for download.
 * @param {string} filename - suggested download filename.
 * @returns {{url: string, filename: string}}
 */
function downloadBlob(blob, filename){
  if(__activeResultUrl) URL.revokeObjectURL(__activeResultUrl);
  const url = URL.createObjectURL(blob);
  __activeResultUrl = url;
  return {url, filename};
}
/**
 * Builds "<original-name-without-extension>_<suffix>.<ext>" instead of a
 * generic static name, so a result stays traceable to what the user
 * uploaded (document.pdf -> document_compressed.pdf). Falls back to
 * "document" if the input has no usable name (e.g. a merge/zip output
 * with no single source file).
 * @param {File|null} file - the original uploaded file, if any.
 * @param {string} suffix - tool-specific suffix, e.g. "compressed".
 * @param {string} ext - output extension, without the leading dot.
 * @returns {string}
 */
// Every tool-specific suffix suffixedName() ever appends, so a file that's
// been round-tripped through several tools (download -> re-upload into the
// next one) gets its OWN previous suffixes stripped before a new one is
// added, instead of compounding into
// "name_compressed_pages_removed_merged_compressed.pdf". Sorted longest
// first so a multi-word suffix like "pages_removed" is tried whole before
// any shorter one that could otherwise match a fragment of it.
const KNOWN_FILENAME_SUFFIXES = [
  "split_parts","pages_removed","header_footer","metadata_updated","with_blank",
  "split","compressed","rotated","extracted","reordered","numbered","watermarked",
  "cropped","inverted","organized","flattened","repaired","pages","converted",
  "resized","signed","filled","images","merged",
].sort((a,b)=>b.length-a.length);
function suffixedName(file, suffix, ext){
  const raw = (file && file.name) ? file.name : "document";
  let base = raw.replace(/\.[^./\\]+$/, "") || "document";
  let stripped = true;
  while(stripped){
    stripped = false;
    for(const suf of KNOWN_FILENAME_SUFFIXES){
      if(base.length > suf.length+1 && base.endsWith("_"+suf)){
        base = base.slice(0, -(suf.length+1));
        stripped = true;
        break;
      }
    }
  }
  base = base || "document";
  // Caps the final filename's length so a long original name plus a new
  // suffix can never make the download button's label wrap/overflow.
  const MAX_BASE = 60;
  if(base.length > MAX_BASE) base = base.slice(0, MAX_BASE).replace(/_+$/, "");
  return `${base}_${suffix}.${ext}`;
}
/**
 * Resolves the output raster format for an image tool from its input
 * File's MIME type: PNG stays PNG (to preserve transparency), everything
 * else becomes JPEG. Shared by every image tool that re-encodes via
 * canvas.toBlob() (Resize/Crop/Watermark/Invert), which previously each
 * duplicated this same two-branch ternary independently.
 *
 * PNG and WebP round-trip to themselves (both keep alpha, both are
 * canvas.toBlob()-encodable in every current browser). GIF has no
 * canvas-encodable equivalent at all - toBlob() simply doesn't support
 * "image/gif" - so it falls back to PNG rather than JPEG specifically so
 * a transparent/animated-frame GIF doesn't get silently flattened onto a
 * black background the way the old two-branch version did. Everything
 * else (JPEG and any other opaque format) becomes JPEG, as before.
 * @param {File} file - the original uploaded image file.
 * @returns {{mime: "image/png"|"image/webp"|"image/jpeg", ext: "png"|"webp"|"jpg"}}
 */
function imgOutputFormat(file){
  const type = file.type;
  if(type === "image/png") return {mime:"image/png", ext:"png"};
  if(type === "image/webp") return {mime:"image/webp", ext:"webp"};
  if(type === "image/gif") return {mime:"image/png", ext:"png"};
  return {mime:"image/jpeg", ext:"jpg"};
}
/**
 * Browser-side resource budgets. These are guardrails against accidental
 * tab exhaustion, not upload quotas: files never leave the device.
 */
const YOYO_RESOURCE_LIMITS = Object.freeze({
  maxBatchFiles: 40,
  maxBatchBytes: 400 * 1024 * 1024,
  maxPdfBytes: 200 * 1024 * 1024,
  maxImageBytes: 50 * 1024 * 1024,
  maxOfficeBytes: 100 * 1024 * 1024,
  maxOtherBytes: 100 * 1024 * 1024,
  maxPdfPages: 1500,
  maxImagePixels: 64 * 1000 * 1000,
  maxImageDimension: 16384,
});
if(typeof window !== "undefined"){
  window.YOYO_RUNTIME = Object.freeze({ limits: YOYO_RESOURCE_LIMITS });
}

class ResourceValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ResourceValidationError";
    this.code = code;
  }
}

function fileExtension(file) {
  const match = String(file?.name || "").toLowerCase().match(/\.([^.\\/]+)$/);
  return match ? "." + match[1] : "";
}

function fileResourceKind(file) {
  const ext = fileExtension(file);
  const type = String(file?.type || "").toLowerCase();
  if (ext === ".pdf" || type === "application/pdf") return "pdf";
  if (type.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"].includes(ext)) return "image";
  if ([".docx", ".xlsx", ".xls", ".pptx", ".csv"].includes(ext) ||
      /officedocument|msword|ms-excel|text\/csv/.test(type)) return "office";
  return "other";
}

function matchesFileAccept(file, accept) {
  const tokens = String(accept || "").split(",").map(token => token.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  const type = String(file?.type || "").toLowerCase();
  const ext = fileExtension(file);
  const kind = fileResourceKind(file);
  return tokens.some(token => {
    if (token.startsWith(".")) return ext === token;
    if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1)) || (token === "image/*" && kind === "image");
    if (type === token) return true;
    return token === "application/pdf" && kind === "pdf";
  });
}

function resourceLimitFor(file) {
  const kind = fileResourceKind(file);
  if (kind === "pdf") return YOYO_RESOURCE_LIMITS.maxPdfBytes;
  if (kind === "image") return YOYO_RESOURCE_LIMITS.maxImageBytes;
  if (kind === "office") return YOYO_RESOURCE_LIMITS.maxOfficeBytes;
  return YOYO_RESOURCE_LIMITS.maxOtherBytes;
}

/**
 * Performs the synchronous part of selection validation. Kept separate from
 * signature checks so it is cheap to unit test and reusable by non-dropzone
 * inputs such as the editor toolbar.
 * @param {File[]|FileList} selected
 * @param {{accept?: string, multiple?: boolean}} options
 * @returns {File[]}
 */
function validateFileSelectionMetadata(selected, options = {}) {
  const files = Array.from(selected || []);
  if (!files.length) return files;
  if (!options.multiple && files.length > 1) {
    throw new ResourceValidationError("Please choose one file at a time.", "too-many-files");
  }
  if (files.length > YOYO_RESOURCE_LIMITS.maxBatchFiles) {
    throw new ResourceValidationError(
      `Choose no more than ${YOYO_RESOURCE_LIMITS.maxBatchFiles} files at once.`,
      "too-many-files"
    );
  }

  let total = 0;
  for (const file of files) {
    const displayName = String(file?.name || "this file");
    if (!matchesFileAccept(file, options.accept)) {
      throw new ResourceValidationError(`“${displayName}” is not a supported file type for this tool.`, "unsupported-type");
    }
    if (!Number.isFinite(file?.size) || file.size <= 0) {
      throw new ResourceValidationError(`“${displayName}” is empty and cannot be processed.`, "empty-file");
    }
    const limit = resourceLimitFor(file);
    if (file.size > limit) {
      throw new ResourceValidationError(
        `“${displayName}” is too large for safe in-browser processing (maximum ${fmtSize(limit)}).`,
        "file-too-large"
      );
    }
    total += file.size;
  }

  if (total > YOYO_RESOURCE_LIMITS.maxBatchBytes) {
    throw new ResourceValidationError(
      `This selection is too large for safe in-browser processing (maximum ${fmtSize(YOYO_RESOURCE_LIMITS.maxBatchBytes)} total).`,
      "batch-too-large"
    );
  }
  return files;
}

function bytesStartWith(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

async function validateFileSignature(file) {
  const kind = fileResourceKind(file);
  const bytes = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const displayName = String(file.name || "This file");

  if (kind === "pdf") {
    const hasPdfHeader = bytes.some((value, index) =>
      value === 0x25 && bytes[index + 1] === 0x50 && bytes[index + 2] === 0x44 &&
      bytes[index + 3] === 0x46 && bytes[index + 4] === 0x2d
    );
    if (!hasPdfHeader) {
      throw new ResourceValidationError(`“${displayName}” does not contain a valid PDF header.`, "invalid-signature");
    }
  }

  if (kind === "office" && fileExtension(file) !== ".csv") {
    const isZip = bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
      bytesStartWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
      bytesStartWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
    if (!isZip) {
      throw new ResourceValidationError(`“${displayName}” is not a valid Office document package.`, "invalid-signature");
    }
  }

  if (kind === "image") {
    const ext = fileExtension(file);
    const png = bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpeg = bytesStartWith(bytes, [0xff, 0xd8, 0xff]);
    const gif = bytesStartWith(bytes, [0x47, 0x49, 0x46, 0x38]);
    const webp = bytesStartWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    const expectedKnownRaster = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
    if (expectedKnownRaster && !png && !jpeg && !gif && !webp) {
      throw new ResourceValidationError(`“${displayName}” does not match its image extension.`, "invalid-signature");
    }
  }
}

/**
 * Validates type, byte budgets, and inexpensive file signatures before any
 * parser or preview worker sees user-controlled bytes.
 */
async function validateFileSelection(selected, options = {}) {
  const files = validateFileSelectionMetadata(selected, options);
  for (const file of files) await validateFileSignature(file);
  return files;
}

/**
 * Opens a PDF.js document with the same byte/page budgets as pdf-lib callers.
 * Destroys the loading task/document on timeout or validation failure.
 * @param {ArrayBuffer|Uint8Array|object} source
 * @param {number} timeoutMs
 */
async function loadPdfJsSafe(source, timeoutMs = 30000) {
  const params = source && typeof source === "object" && "data" in source ? source : { data: source };
  const byteLength = params.data?.byteLength ?? params.data?.length ?? 0;
  if (byteLength > YOYO_RESOURCE_LIMITS.maxPdfBytes) {
    throw new ResourceValidationError(
      `This PDF exceeds the ${fmtSize(YOYO_RESOURCE_LIMITS.maxPdfBytes)} in-browser processing limit.`,
      "file-too-large"
    );
  }

  const task = pdfjsLib.getDocument(params);
  let timeoutId;
  try {
    const doc = await Promise.race([
      task.promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("This PDF took too long to render.")), timeoutMs);
      }),
    ]);
    if (!doc.numPages) {
      await doc.destroy();
      throw new ResourceValidationError("This PDF has no readable pages.", "invalid-pdf");
    }
    if (doc.numPages > YOYO_RESOURCE_LIMITS.maxPdfPages) {
      await doc.destroy();
      throw new ResourceValidationError(
        `This PDF has too many pages for safe in-browser processing (maximum ${YOYO_RESOURCE_LIMITS.maxPdfPages}).`,
        "too-many-pages"
      );
    }
    return trackPdfJsDocument(doc);
  } catch (error) {
    try { await task.destroy(); } catch (_) {}
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
class StaleOperationError extends Error {
  constructor() {
    super("This operation was superseded by a newer action.");
    this.name = "StaleOperationError";
  }
}

const __activeToolOperations = new Set();

/**
 * Creates the single operation lifecycle used by tool actions: duplicate-click
 * suppression, button restoration, AbortSignal propagation, stale-result
 * checks, and optional timeout. Tool-specific processing remains in the tool.
 * @param {HTMLButtonElement|null} defaultButton
 * @param {{busyLabel?: string, timeoutMs?: number}} defaults
 */
function createOperationController(defaultButton, defaults = {}) {
  let generation = 0;
  let busy = false;
  let abortController = null;
  let activeButton = null;
  let buttonSnapshot = null;

  function restoreButton() {
    if (!activeButton || !buttonSnapshot) return;
    activeButton.disabled = buttonSnapshot.disabled;
    activeButton.textContent = buttonSnapshot.textContent;
    activeButton.removeAttribute("aria-busy");
    delete activeButton.dataset.operationState;
    activeButton = null;
    buttonSnapshot = null;
  }

  function cancel() {
    generation += 1;
    abortController?.abort();
    abortController = null;
    busy = false;
    restoreButton();
    __activeToolOperations.delete(api);
  }

  const api = {
    get busy() { return busy; },
    cancel,
    isCurrent(token) { return busy && token === generation && !abortController?.signal.aborted; },
    async run(task, options = {}) {
      if (busy) return undefined;
      const token = ++generation;
      const button = options.button || defaultButton || null;
      const busyLabel = options.busyLabel ?? defaults.busyLabel;
      const timeoutMs = options.timeoutMs ?? defaults.timeoutMs ?? 120000;
      const runAbortController = new AbortController();
      const operationCleanups = [];
      busy = true;
      abortController = runAbortController;
      activeButton = button;
      if (button) {
        buttonSnapshot = { disabled: button.disabled, textContent: button.textContent };
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        button.dataset.operationState = "running";
        if (busyLabel) button.textContent = busyLabel;
      }
      __activeToolOperations.add(api);

      let timeoutId = null;
      try {
        const context = {
          signal: runAbortController.signal,
          token,
          isCurrent: () => api.isCurrent(token),
          throwIfStale: () => {
            if (!api.isCurrent(token)) throw new StaleOperationError();
          },
          registerCleanup(cleanup) {
            if(typeof cleanup === "function") operationCleanups.push(cleanup);
          },
          track(resource, cleanup) {
            if(!resource) return resource;
            const release = cleanup || (value => value?.destroy?.());
            operationCleanups.push(() => release(resource));
            return resource;
          },
        };
        const work = Promise.resolve().then(() => task(context));
        const aborted = new Promise((_, reject) => {
          runAbortController.signal.addEventListener("abort", () => {
            const error = new Error("This operation was cancelled.");
            error.name = "AbortError";
            reject(error);
          }, {once:true});
        });
        const races = [work, aborted];
        if(timeoutMs > 0){
          races.push(new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error("This operation took too long and was stopped."));
              runAbortController.abort();
            }, timeoutMs);
          }));
        }
        const result = await Promise.race(races);
        context.throwIfStale();
        return result;
      } catch (error) {
        if (error instanceof StaleOperationError || error?.name === "AbortError") return undefined;
        throw error;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        for(const cleanup of operationCleanups.reverse()){
          try{ await cleanup(); }catch(error){ console.warn("Operation cleanup failed:", error); }
        }
        if (token === generation) {
          busy = false;
          abortController = null;
          restoreButton();
        }
        __activeToolOperations.delete(api);
      }
    },
  };
  return api;
}

const __toolCleanupCallbacks = new Set();

function registerToolCleanup(cleanup) {
  if(typeof cleanup !== "function") return () => {};
  __toolCleanupCallbacks.add(cleanup);
  return () => __toolCleanupCallbacks.delete(cleanup);
}

function runToolCleanups() {
  const callbacks = [...__toolCleanupCallbacks];
  __toolCleanupCallbacks.clear();
  callbacks.forEach(cleanup => {
    try{ Promise.resolve(cleanup()).catch(error => console.warn("Tool cleanup failed:", error)); }
    catch(error){ console.warn("Tool cleanup failed:", error); }
  });
}

function trackPdfJsDocument(doc) {
  const destroyDocument = doc.destroy.bind(doc);
  let destroyed = false;
  let unregister = () => {};
  doc.destroy = () => {
    if(destroyed) return Promise.resolve();
    destroyed = true;
    unregister();
    return destroyDocument();
  };
  unregister = registerToolCleanup(() => doc.destroy());
  return doc;
}
function cancelAllToolOperations() {
  [...__activeToolOperations].forEach(controller => controller.cancel());
}
/**
 * Adapts an existing click handler to the shared operation controller without
 * moving tool-specific processing out of its module.
 */
function withToolOperation(button, handler, options = {}) {
  const controller = createOperationController(button, options);
  return function controlledToolOperation(event) {
    return controller.run(
      context => handler.call(this, event, context),
      options
    ).catch(error => {
      console.error("Tool operation failed:", error);
      toast(error?.message || "This operation could not be completed.");
    });
  };
}

function fileInputHTML(accept, multiple, label){
  // Same widget renders two different roles: the big empty-state CTA
  // ("Select PDF file") and its own drop target - so the small caption
  // underneath states the second role ("or drop PDF file here") instead
  // of repeating unrelated copy, derived from the one label callers
  // already pass rather than a second parameter every call site would
  // have to keep in sync.
  const t = window.I18N ? I18N.t : (k)=>k;
  // Previously derived the hint's noun by regex-stripping the English
  // word "Select " off the label ("Select PDF files" -> "PDF files") -
  // once callers started passing a TRANSLATED label (see i18n.js Phase
  // 2), that regex no longer matched anything (translated strings don't
  // start with the English word "Select"), so the *entire* translated
  // label leaked into the hint verbatim ("or drop [Select PDF files]
  // here" - confirmed live in Hindi). The hint no longer depends on the
  // label's wording at all now - "or drop here" reads correctly in every
  // language regardless of what noun (if any) the caller's label uses.
  const visibleLabel = label || t("workspace.dropDefaultLabel");
  return `<div class="dropzone" id="dz" role="button" tabindex="0" aria-labelledby="dzLabel dzHint" aria-controls="fi">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 16V4M12 4l-4 4M12 4l4 4"/><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/></svg>
    <div><strong id="dzLabel">${escapeAttr(visibleLabel)}</strong></div>
    <div class="hint" id="dzHint">${escapeAttr(t("workspace.dropHintPrefix"))} ${escapeAttr(t("workspace.dropHintSuffix"))} · 🔒 ${escapeAttr(t("workspace.staysOnDevice"))}</div>
    <input type="file" id="fi" class="hidden" accept="${escapeAttr(accept)}" aria-labelledby="dzLabel" ${multiple?"multiple":""}>
  </div><div class="filelist" id="flist"></div><div class="thumbs" id="quickPreview"></div>`;
}
async function autoQuickPreview(fs){
  const previewToken = ++__quickPreviewGeneration;
  const qp = document.getElementById("quickPreview");
  if(!qp) return;
  if(__quickPreviewUrl){ URL.revokeObjectURL(__quickPreviewUrl); __quickPreviewUrl = null; }
  qp.innerHTML = "";
  // Tools with their own page-grid already render interactive thumbnails.
  if(document.getElementById("pageGrid") || fs.length!==1) return;

  const f = fs[0];
  let pdoc = null;
  try{
    if(f.type==="application/pdf" || f.name.toLowerCase().endsWith(".pdf")){
      const bytes = await f.arrayBuffer();
      if(previewToken !== __quickPreviewGeneration) return;
      pdoc = await loadPdfJsSafe({data:bytes.slice(0)});
      if(previewToken !== __quickPreviewGeneration) return;

      const maxShow = Math.min(pdoc.numPages, 6);
      for(let i=1;i<=maxShow;i++){
        const {canvas} = await pdfThumb(bytes.slice(0), i, 100);
        if(previewToken !== __quickPreviewGeneration) return;
        if(canvas) qp.appendChild(canvas);
      }
      if(pdoc.numPages>maxShow && previewToken === __quickPreviewGeneration){
        const more = document.createElement("div");
        more.style.cssText="display:flex;align-items:center;color:var(--ink-soft);font-size:.8rem;padding:0 8px;white-space:nowrap;";
        more.textContent = `+${pdoc.numPages-maxShow} more page${pdoc.numPages-maxShow>1?'s':''}`;
        qp.appendChild(more);
      }
    } else if(f.type.startsWith("image/")){
      const url = URL.createObjectURL(f);
      if(previewToken !== __quickPreviewGeneration){ URL.revokeObjectURL(url); return; }
      __quickPreviewUrl = url;
      const img = document.createElement("img");
      img.src=url;
      qp.appendChild(img);
    }
  }catch(e){
    // Preview is best-effort; the selected file remains available to the tool.
  }finally{
    if(pdoc){ try{ await pdoc.destroy(); }catch(e){} }
  }
}
/**
 * Wires the current panel's dropzone/file-input pair (the "#dz"/"#fi"
 * elements fileInputHTML() renders) to a single callback, covering both
 * click-to-browse and drag-and-drop, plus the shared quick-preview strip.
 * @param {(files: File[]) => void} onFiles - called with the picked/
 *   dropped files, once per pick/drop.
 */
function wireDropzone(onFiles){
  const dz = document.getElementById("dz");
  const fi = document.getElementById("fi");
  let selectionGeneration = 0;

  async function handle(selected){
    const token = ++selectionGeneration;
    let files;
    const t = window.I18N ? I18N.t : (k)=>k;
    try {
      files = await validateFileSelection(selected, { accept: fi.accept, multiple: fi.multiple });
    } catch (error) {
      if(token === selectionGeneration) toast(error?.message || t("workspace.thisFileCannotBeProcessed"));
      return;
    }
    if(token !== selectionGeneration || !files.length) return;

    // A validated replacement supersedes any in-flight action from the old
    // selection. Cooperative tools receive an AbortSignal; all tools are
    // protected from a stale controller result restoring obsolete UI.
    cancelAllToolOperations();
    try {
      const result = onFiles(files);
      Promise.resolve(result).catch(error => toast(error?.message || t("workspace.thisFileCouldNotBeOpened")));
    } catch (error) {
      toast(error?.message || t("workspace.thisFileCouldNotBeOpened"));
      return;
    }
    autoQuickPreview(files);
  }

  dz.addEventListener("click", event=>{ if(event.target !== fi) fi.click(); });
  dz.addEventListener("keydown", event=>{
    if(event.key === "Enter" || event.key === " "){
      event.preventDefault();
      fi.click();
    }
  });
  fi.addEventListener("change", ()=>{
    const files = [...fi.files];
    fi.value = "";
    handle(files);
  });
  ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault(); dz.classList.add("drag");}));
  ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault(); dz.classList.remove("drag");}));
  dz.addEventListener("drop", e=>{ handle([...(e.dataTransfer?.files || [])]); });
}
/**
 * Renders the selected-files list as real thumbnail cards (actual PDF
 * page 1 + page count, or the image itself) instead of a plain filename
 * row — matches iLovePDF's file-card look. Placeholder cards render
 * instantly; real thumbnails fill in progressively (sequential, not
 * concurrent, since rendering many PDFs' first pages at once can starve
 * pdf.js's worker).
 * @param {File[]} files - files to render as cards.
 * @param {(index: number) => void} onRemove - called with a file's index
 *   when its card's remove button is clicked.
 */
function renderFileList(files, onRemove){
  const flist = document.getElementById("flist");
  // Every call fully replaces #flist's contents (including any image
  // thumbnails from the previous call, each its own object URL below) -
  // revoke those now rather than leaking one per add/remove/replace cycle.
  if(__fileCardPreviewUrls.length){ __fileCardPreviewUrls.forEach(u=>URL.revokeObjectURL(u)); __fileCardPreviewUrls = []; }
  flist.classList.add("file-grid");
  document.querySelector(".panel-body")?.classList.toggle("has-file", files.length>0);
  const tRfl = window.I18N ? I18N.t : (k)=>k;
  flist.innerHTML = files.map((f,i)=>{
    const kind = isPdfFile(f) ? "PDF" : (f.type && f.type.startsWith("image/")) ? "IMG" : (f.name.split(".").pop()||"FILE").toUpperCase().slice(0,4);
    return `<div class="file-card" data-i="${i}">
      <button type="button" class="file-card-remove" data-i="${i}" aria-label="${escapeAttr(tRfl("workspace.removeFile"))} ${escapeAttr(f.name)}">✕</button>
      <div class="file-card-thumb" id="fcThumb${i}"><span class="file-card-kind">${kind}</span></div>
      <div class="file-card-name" title="${escapeAttr(f.name)}">${escapeAttr(f.name)}</div>
      <div class="file-card-meta">
        <span class="file-card-size mono">${fmtSize(f.size)}</span>
        <span class="file-card-pages mono" id="fcPages${i}"></span>
      </div>
    </div>`;
  }).join("");
  /* Centralized removal cleanup: many callers only reset their own tool
     state in onRemove (null the file var, hide a toolbar) without ever
     re-rendering #flist, leaving a stale file-card on screen even though
     the tool's internal state is empty. Removing the card and re-syncing
     .has-file HERE, before calling the tool's own onRemove, means every
     caller gets a correctly-cleared file list for free - no per-tool
     cleanup required. Multi-file tools whose onRemove re-renders the
     whole list anyway (Merge's refresh()) just get an instant, harmless
     no-op re-render on top of this. */
  flist.querySelectorAll(".file-card-remove").forEach(b=>b.addEventListener("click", e=>{
    e.stopPropagation();
    const i = +b.dataset.i;
    const card = b.closest(".file-card");
    // Fade+shrink the card out first, THEN actually remove it and notify
    // the caller - a plain instant .remove() (the old behavior) made
    // whatever grid row below it snap up with no transition, which reads
    // as an abrupt pop on a multi-file grid. motionExit no-ops straight
    // to removal under reduced motion.
    motionExit(card, ()=>{
      card?.remove();
      document.querySelector(".panel-body")?.classList.toggle("has-file", flist.children.length>0);
      // autoQuickPreview()'s strip is a separate sibling element populated
      // independently of #flist - clear it too, otherwise a removed file's
      // preview image/thumbnails linger even though the file list is empty.
      if(flist.children.length===0){
        const qp = document.getElementById("quickPreview");
        if(qp) qp.innerHTML = "";
      }
      onRemove(i);
    });
  }));
  motionEnter(flist.querySelectorAll(".file-card"), {duration:MOTION.fast, stagger:MOTION.stagger.small, fromY:10});
  (async ()=>{
    for(let i=0;i<files.length;i++){
      const f = files[i];
      const slot = document.getElementById("fcThumb"+i);
      if(!slot) return; // list was re-rendered (add/remove) before this finished
      try{
        if(isPdfFile(f)){
          const bytes = await f.arrayBuffer();
          const {canvas, numPages} = await pdfThumb(bytes, 1, 220);
          // pdfThumb() returns {canvas:null, numPages:0} on its own internal
          // timeout (see its own doc comment) rather than throwing - must
          // guard here, since appendChild(null) throws and would otherwise
          // also skip the page-count line below via the shared try/catch.
          if(canvas && document.getElementById("fcThumb"+i)===slot){ slot.innerHTML=""; slot.appendChild(canvas); }
          const pagesEl = document.getElementById("fcPages"+i);
          if(pagesEl && numPages>0) pagesEl.textContent = `${numPages} ${numPages===1 ? tRfl("workspace.page") : tRfl("workspace.pages")}`;
        } else if(f.type && f.type.startsWith("image/")){
          const img = document.createElement("img");
          const url = URL.createObjectURL(f);
          __fileCardPreviewUrls.push(url);
          img.src = url;
          slot.innerHTML=""; slot.appendChild(img);
        }
      }catch(e){ /* leave the kind-badge placeholder on any render failure */ }
    }
  })();
}
function escapeAttr(s){ return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

// statusEl()/setStatus()/resultBox() moved here from js/core/pdf-canvas-
// widgets.js (Phase 11): every tool, including the image-only tools that
// intentionally don't load pdf-canvas-widgets.js, calls all three on its
// processing path - they were the last PDF-canvas-widgets.js dependency
// image-tools.js had, so image routes threw "statusEl is not defined" the
// moment a conversion started. None of the three touch that file's actual
// canvas widgets (crop handles, page grid drag); they belong with the
// other cross-tool helpers here, which every route already loads.
/**
 * Initial processing-state markup for a tool's #out container: the shared
 * compact horizontal progress bar (see .pdf-progress in index.html),
 * inline in the tool's own workspace - no modal, no overlay, no large
 * centered animation. One component used by every tool via this same
 * pair of functions, so redesigning the loader only ever happens here,
 * never per-tool.
 * Pair with setStatus() to update the same status text/progress as work
 * proceeds, and finish with setStatus(msg, true) to mark it done.
 * @param {string} msg - initial status message.
 * @returns {string} HTML to assign into `#out`.
 */
function statusEl(msg){
  const t = window.I18N ? I18N.t : (k)=>k;
  return `<div class="pdf-progress" id="pdfLoader" role="status" aria-live="polite">
    <div class="pdf-progress-head">
      <span class="pdf-progress-title" id="statusLine">${escapeAttr(msg)}</span>
      <span class="pdf-progress-dots" aria-hidden="true"><span></span><span></span><span></span></span>
    </div>
    <div class="pdf-progress-sub" id="pdfLoaderSub">${escapeAttr(t("workspace.pleaseWait"))}</div>
    <div class="pdf-progress-track"><div class="pdf-progress-fill indeterminate" id="pdfLoaderFill"></div></div>
    <div class="pdf-progress-pct" id="pdfLoaderPct" hidden></div>
  </div>`;
}
/**
 * Updates the status text/progress statusEl() rendered, in place - the
 * standard progress-reporting call every tool's async handler makes
 * repeatedly while working. Only ever real progress: the fill bar and
 * percentage text only appear when the caller passes an actual number -
 * otherwise the bar stays in its indeterminate sweep instead of inventing
 * a percentage.
 * @param {string} msg - current status message.
 * @param {boolean} [done] - true to render the final done state.
 * @param {number} [percent] - 0-100, real progress only.
 */
function setStatus(msg, done, percent){
  const s = document.getElementById("statusLine");
  if(!s) return;
  const loader = document.getElementById("pdfLoader");
  if(done){
    // Every caller's very next line is out.appendChild(resultBox(...)) -
    // the progress bar must be GONE by then, not left sitting above the
    // result at 100%/green. Previously it only got an .is-done class
    // (still rendered, just static), so success looked like "processing
    // bar frozen at Done, then a second result card appended below it"
    // instead of a clean state swap.
    if(loader) loader.remove();
    return;
  }
  s.textContent = msg;
  const fill = document.getElementById("pdfLoaderFill");
  const pct = document.getElementById("pdfLoaderPct");
  const hasPercent = percent!=null && !isNaN(percent);
  const clamped = hasPercent ? Math.max(0, Math.min(100, Math.round(percent))) : null;
  if(fill){
    if(hasPercent){ fill.classList.remove("indeterminate"); fill.style.width = clamped + "%"; }
    else { fill.classList.add("indeterminate"); fill.style.width = ""; }
  }
  if(pct){
    pct.hidden = !hasPercent;
    if(hasPercent) pct.textContent = clamped + "%";
  }
}
/**
 * Full success screen, matching iLovePDF's post-process page: the input
 * form (dropzone/fields/button) is hidden — not just left visible above
 * the result — and replaced by a prominent download + a "Continue to..."
 * grid of other tools, built from the same QUICK_ACTIONS/QA_LABELS/
 * CATEGORY_META/renderIcon data already used by the Quick Action modal,
 * so it needs no per-tool wiring and covers all 39 tools automatically.
 * @param {object} opts
 * @param {string} opts.sizeText - displayed result size, e.g. "1.2 MB".
 * @param {boolean} opts.sizeGood - true renders the size badge as
 *   "good" (green), false as "bad" (e.g. larger than the original).
 * @param {Node} [opts.previewNode] - optional thumbnail/canvas to show.
 * @param {string} opts.url - object URL from downloadBlob().
 * @param {string} opts.filename - suggested download filename.
 * @param {{id: string, label: string, question: string}} [opts.nextTool]
 *   - optional suggested-next-step call to action shown above the
 *   generic "Continue to..." grid.
 * @returns {HTMLElement} the result box, ready to append into `#out`.
 */
function resultBox({sizeText, sizeGood, previewNode, url, filename}){
  const t = window.I18N ? I18N.t : (k)=>k;
  const body = document.querySelector(".panel-body");
  const out = document.getElementById("out");
  if(body){
    [...body.children].forEach(el=>{ if(el!==out) el.classList.add("hidden"); });
    body.classList.add("has-file");
  }

  const continueIds = QUICK_ACTIONS.map(q=>q.id).filter(id=>id!==window.__currentToolId && TOOLS[id]).slice(0,6);
  const continueHtml = continueIds.map(id=>{
    const qa = QUICK_ACTIONS.find(q=>q.id===id);
    const color = (CATEGORY_META[qa && qa.cat] && CATEGORY_META[qa.cat].color) || "#112B5C";
    return `<button type="button" class="continue-card" data-continue-tool="${id}">
      ${renderIcon(id, color)}
      <span class="continue-name">${window.I18N ? I18N.t("tools."+id) : (QA_LABELS[id] || id)}</span>
    </button>`;
  }).join("");

  const box = document.createElement("div");
  box.className="result-box result-success";
  box.innerHTML = `
    <div class="result-head">
      <button type="button" class="result-back" aria-label="${escapeAttr(t("workspace.startOver"))}">←</button>
      <h3>✅ ${escapeAttr(t("workspace.allDone"))}</h3>
    </div>
    <div>${escapeAttr(t("workspace.resultSize"))} <span class="size-badge ${sizeGood?'good':'bad'} mono">${sizeText}</span></div>`;
  if(previewNode){ const wrap=document.createElement("div"); wrap.className="thumbs"; wrap.appendChild(previewNode); box.appendChild(wrap); }
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.className="dl-link dl-link-primary"; a.textContent = "⬇ " + t("workspace.download") + " " + filename;
  box.appendChild(a);
  const shareRow = document.createElement("div");
  shareRow.className = "result-share";
  const shareOnWhatsapp = escapeAttr(`${t("workspace.shareOn")} WhatsApp`);
  const shareOnFacebook = escapeAttr(`${t("workspace.shareOn")} Facebook`);
  const shareOnX = escapeAttr(`${t("workspace.shareOn")} X`);
  shareRow.innerHTML = `
    <span class="result-share-label">❤️ ${escapeAttr(t("workspace.enjoyedShare"))}</span>
    <span class="result-share-btns">
      <button type="button" class="share-btn sm whatsapp" data-share="whatsapp" title="${shareOnWhatsapp}" aria-label="${shareOnWhatsapp}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.29-1.39a9.9 9.9 0 0 0 4.75 1.21h.01c5.46 0 9.9-4.45 9.9-9.91C21.96 6.45 17.5 2 12.04 2zm0 18.02h-.01a8.13 8.13 0 0 1-4.14-1.13l-.3-.18-3.08.81.82-3-.2-.31a8.1 8.1 0 0 1-1.25-4.3c0-4.48 3.65-8.12 8.14-8.12 2.17 0 4.21.85 5.75 2.38a8.06 8.06 0 0 1 2.38 5.75c0 4.48-3.65 8.1-8.11 8.1zm4.45-6.07c-.24-.12-1.44-.71-1.66-.79-.22-.08-.39-.12-.55.12-.16.24-.63.79-.78.95-.14.16-.29.18-.53.06-.24-.12-1.02-.38-1.94-1.2-.72-.64-1.2-1.43-1.35-1.67-.14-.24-.02-.37.11-.49.11-.11.24-.29.36-.43.12-.15.16-.25.24-.41.08-.16.04-.31-.02-.43-.06-.12-.55-1.32-.75-1.81-.2-.48-.4-.41-.55-.42h-.47c-.16 0-.43.06-.65.31-.22.24-.86.84-.86 2.05s.88 2.38 1 2.54c.12.16 1.73 2.64 4.2 3.7.59.25 1.05.4 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.44-.59 1.64-1.16.2-.57.2-1.06.14-1.16-.06-.1-.22-.16-.46-.28z"/></svg>
      </button>
      <button type="button" class="share-btn sm facebook" data-share="facebook" title="${shareOnFacebook}" aria-label="${shareOnFacebook}">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5 3.66 9.15 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.44 2.91h-2.34V22c4.78-.79 8.44-4.94 8.44-9.94z"/></svg>
      </button>
      <button type="button" class="share-btn sm x" data-share="x" title="${shareOnX}" aria-label="${shareOnX}">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M18.9 2H22l-7.6 8.7L23.3 22h-6.9l-5.4-7.1L4.7 22H1.6l8.1-9.3L1 2h7l4.9 6.5L18.9 2zm-1.2 18h1.9L7.4 4H5.4l12.3 16z"/></svg>
      </button>
    </span>`;
  box.appendChild(shareRow);
  // Phase 12: was onclick="shareOn('...')" inline in the HTML string above
  // (blocked script-src 'unsafe-inline' from ever being removed from the
  // CSP) — same addEventListener wiring the sibling .result-back/
  // [data-continue-tool] buttons two lines below already use.
  shareRow.querySelectorAll("[data-share]").forEach(btn=>{
    btn.addEventListener("click", ()=>shareOn(btn.dataset.share));
  });
  // Tool rating: appears only here, after the result/download is ready -
  // never above the workspace, never interrupting the actual PDF task.
  // mountToolRating() (js/core/ratings.js) is entirely best-effort: it
  // never throws and the rating service being slow/unreachable can never
  // block or hide the download link above it.
  if(window.__currentToolId && typeof mountToolRating === "function"){
    const ratingMount = document.createElement("div");
    ratingMount.className = "result-rating";
    mountToolRating(ratingMount, window.__currentToolId);
    box.appendChild(ratingMount);
  }
  if(continueHtml){
    const section = document.createElement("div");
    section.className = "continue-section";
    section.innerHTML = `<div class="continue-label">${escapeAttr(t("workspace.continueTo"))}</div><div class="continue-grid">${continueHtml}</div>`;
    box.appendChild(section);
  }
  box.querySelector(".result-back").addEventListener("click", ()=>{ const id=window.__currentToolId; closePanel(true); openTool(id); });
  box.querySelectorAll("[data-continue-tool]").forEach(btn=>{
    btn.addEventListener("click", ()=>{ closePanel(true); openTool(btn.dataset.continueTool, true); });
  });
  return box;
}
