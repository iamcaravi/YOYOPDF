/* ---------------- PDF Standard Security Handler (Revision 2, 40-bit RC4) ----------------
   pdf-lib has no encryption support at all (confirmed via its own docs/issue
   tracker - writing an encrypted PDF isn't implemented), so Protect PDF and
   the "structure-preserving" fast path of Unlock PDF need a hand-rolled,
   from-spec implementation of ISO 32000-1 Section 7.6's original/simplest
   Standard Security Handler: 40-bit RC4, revision 2. This is deliberately
   the SIMPLEST variant in the spec (no 50x MD5 rehashing, no AES, no crypt
   filters) - see seo/tools-registry.json's own protect-pdf FAQ copy, which
   already commits to exactly this scope ("40-bit RC4... basic access
   control, not strong confidentiality").

   Both directions (encrypt for Protect, decrypt for Unlock's fast path) are
   really the SAME transform: RC4 is its own inverse, so encrypting and
   decrypting an object's strings/streams is one function
   (rc4TransformObjectBody) parameterized only by which file key was used to
   derive each object's key - never two parallel implementations to keep in
   sync.

   Scope/known limitations (by design, not oversight):
   - Only operates on a CLASSIC xref table + trailer PDF (not a PDF 1.5+
     cross-reference STREAM) - callers must pass bytes saved with
     `{useObjectStreams:false}` (encrypt) or fall back for files this parser
     doesn't recognize as that shape (decrypt). Every function here throws a
     plain Error on any unexpected structure rather than guessing.
   - Passwords are encoded as Latin-1/ISO-8859-1 bytes (one byte per code
     point, matching PDFDocEncoding for the common ASCII case) - non-Latin-1
     characters are lossy. Documented in the UI, not silently mishandled.
   - Only strings that appear as literal object dictionary content are
     re-encrypted; the overwhelming majority of real content (page content
     streams, fonts, images) lives in STREAM payloads, which this always
     encrypts/decrypts in full. A string this scanner's "genuine `stream`
     keyword" heuristic misses would at worst leave one metadata-ish string
     mismatched with the rest of the encryption scheme (e.g. a garbled
     CreationDate) - never a corrupted page or a security hole. */

/** Encodes a JS string as Latin-1 bytes (each char code truncated to 8 bits) - see file header re: password encoding scope. */
function pdfLatin1Bytes(str){
  const out = new Uint8Array(str.length);
  for(let i=0;i<str.length;i++) out[i] = str.charCodeAt(i) & 0xFF;
  return out;
}

/* ---- MD5 (RFC 1321) - operates on a byte array, returns a 16-byte digest ---- */
const MD5_K = [
  0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
  0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
  0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
  0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
  0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
  0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
  0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
  0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391,
];
const MD5_S = [
  7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
  5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
  4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
  6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21,
];
function md5RotL(x, c){ return (x<<c) | (x>>>(32-c)); }
function md5(bytes){
  const msgLen = bytes.length;
  const totalLenBits = msgLen * 8; // exact for any realistic PDF size (well under 2^53)
  const paddedLen = (Math.floor((msgLen + 8) / 64) + 1) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[msgLen] = 0x80;
  // 64-bit little-endian bit-length, written as two 32-bit LE halves (safe
  // since JS numbers are exact integers well past any real PDF's bit length).
  const lo = totalLenBits >>> 0;
  const hi = Math.floor(totalLenBits / 0x100000000) >>> 0;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen-8, lo, true);
  dv.setUint32(paddedLen-4, hi, true);

  let a0=0x67452301, b0=0xefcdab89, c0=0x98badcfe, d0=0x10325476;
  const M = new Uint32Array(16);
  for(let chunk=0; chunk<paddedLen; chunk+=64){
    for(let j=0;j<16;j++) M[j] = dv.getUint32(chunk + j*4, true);
    let A=a0,B=b0,C=c0,D=d0;
    for(let i=0;i<64;i++){
      let F, g;
      if(i<16){ F = (B & C) | (~B & D); g = i; }
      else if(i<32){ F = (D & B) | (~D & C); g = (5*i+1) % 16; }
      else if(i<48){ F = B ^ C ^ D; g = (3*i+5) % 16; }
      else { F = C ^ (B | (~D)); g = (7*i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + md5RotL(F, MD5_S[i])) | 0;
    }
    a0 = (a0+A)|0; b0=(b0+B)|0; c0=(c0+C)|0; d0=(d0+D)|0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0>>>0, true); odv.setUint32(4, b0>>>0, true);
  odv.setUint32(8, c0>>>0, true); odv.setUint32(12, d0>>>0, true);
  return out;
}

/* ---- RC4 - symmetric: the same function encrypts and decrypts ---- */
function rc4(keyBytes, dataBytes){
  const S = new Uint8Array(256);
  for(let i=0;i<256;i++) S[i]=i;
  let j=0;
  const klen = keyBytes.length;
  for(let i=0;i<256;i++){
    j = (j + S[i] + keyBytes[i % klen]) & 0xFF;
    const t=S[i]; S[i]=S[j]; S[j]=t;
  }
  const out = new Uint8Array(dataBytes.length);
  let i=0; j=0;
  for(let n=0;n<dataBytes.length;n++){
    i = (i+1) & 0xFF;
    j = (j+S[i]) & 0xFF;
    const t=S[i]; S[i]=S[j]; S[j]=t;
    out[n] = dataBytes[n] ^ S[(S[i]+S[j]) & 0xFF];
  }
  return out;
}

/* ---- Standard Security Handler algorithms (ISO 32000-1 7.6.3, Revision 2) ---- */
const PDF_PAD = new Uint8Array([
  0x28,0xBF,0x4E,0x5E,0x4E,0x75,0x8A,0x41,0x64,0x00,0x4E,0x56,0xFF,0xFA,0x01,0x08,
  0x2E,0x2E,0x00,0xB6,0xD0,0x68,0x3E,0x80,0x2F,0x0C,0xA9,0xFE,0x64,0x53,0x69,0x7A,
]);
function padPassword(pwBytes){
  const out = new Uint8Array(32);
  const n = Math.min(pwBytes.length, 32);
  out.set(pwBytes.subarray(0, n));
  out.set(PDF_PAD.subarray(0, 32-n), n);
  return out;
}
/** Algorithm 3 (O value) - revision 2, no rehash. */
function computeO(ownerPwBytes, userPwBytes){
  const opw = padPassword(ownerPwBytes);
  const digest = md5(opw);
  const rc4Key = digest.subarray(0,5); // 40-bit
  const upw = padPassword(userPwBytes);
  return rc4(rc4Key, upw);
}
/** Algorithm 2 (encryption/file key) - revision 2, 5-byte (40-bit) key, no 50x rehash. */
function computeFileKey(userPwBytes, oBytes, permissionsInt, idBytes){
  const padded = padPassword(userPwBytes);
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, permissionsInt, true);
  const concat = new Uint8Array(padded.length + oBytes.length + 4 + idBytes.length);
  let off=0;
  concat.set(padded, off); off+=padded.length;
  concat.set(oBytes, off); off+=oBytes.length;
  concat.set(pBytes, off); off+=4;
  concat.set(idBytes, off);
  return md5(concat).subarray(0,5);
}
/** Algorithm 4 (U value) - revision 2: RC4 of the padding string itself with the file key. */
function computeU(fileKeyBytes){
  return rc4(fileKeyBytes, PDF_PAD);
}
/** Per-object key (7.6.2, algorithm 1 step a/b), key length min(fileKeyLen+5,16). */
function computeObjectKey(fileKeyBytes, objNum, genNum){
  const extra = new Uint8Array(5);
  extra[0]=objNum & 0xFF; extra[1]=(objNum>>8)&0xFF; extra[2]=(objNum>>16)&0xFF;
  extra[3]=genNum & 0xFF; extra[4]=(genNum>>8)&0xFF;
  const concat = new Uint8Array(fileKeyBytes.length + 5);
  concat.set(fileKeyBytes, 0); concat.set(extra, fileKeyBytes.length);
  const keyLen = Math.min(fileKeyBytes.length + 5, 16);
  return md5(concat).subarray(0, keyLen);
}
/** Permission bits (Table 22) - revision-2-compatible: bits 1-2 must be 0, bits 7-32 must be 1. */
function computePermissionsInt({print=true, modify=true, copy=true, annotate=true, fillForms=true, extractAccessibility=true, assemble=true, printHighRes=true}={}){
  let p = 0xFFFFFFFC; // all 1s except bit1/bit2
  if(!print) p &= ~(1<<2);    // bit position 3
  if(!modify) p &= ~(1<<3);   // bit position 4
  if(!copy) p &= ~(1<<4);     // bit position 5
  if(!annotate) p &= ~(1<<5); // bit position 6
  if(!fillForms) p &= ~(1<<8);            // bit position 9
  if(!extractAccessibility) p &= ~(1<<9); // bit position 10
  if(!assemble) p &= ~(1<<10);            // bit position 11
  if(!printHighRes) p &= ~(1<<11);        // bit position 12
  return p|0; // signed 32-bit, as written into the PDF integer
}

/* ---------------- Binary-safe string <-> bytes ----------------
   PDF structure (object numbers, keywords, dict syntax) is pure ASCII, but
   stream payloads and string values are arbitrary bytes - representing the
   whole file as a JS "binary string" (one JS char == one byte, Latin-1
   round-trip) lets regex/string tools do the structural parsing without
   ever corrupting the bytes it doesn't touch. Chunked to avoid a call-stack
   blowout from spreading a huge typed array into String.fromCharCode. */
function bytesToBinaryString(bytes){
  let s = "";
  const CHUNK = 0x8000;
  for(let i=0;i<bytes.length;i+=CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i+CHUNK));
  return s;
}
function binaryStringToBytes(str){
  const out = new Uint8Array(str.length);
  for(let i=0;i<str.length;i++) out[i] = str.charCodeAt(i) & 0xFF;
  return out;
}
function bytesToHexPdfString(bytes){
  let s = "<";
  for(let i=0;i<bytes.length;i++) s += bytes[i].toString(16).padStart(2,"0");
  return s + ">";
}
function hexPairsToBytes(hex){
  const clean = (hex||"").replace(/[^0-9A-Fa-f]/g, "");
  const out = new Uint8Array(Math.floor(clean.length/2));
  for(let i=0;i<out.length;i++) out[i] = parseInt(clean.substr(i*2,2), 16);
  return out;
}

/* ---------------- Minimal PDF token scanner (strings only) ----------------
   Deliberately not a full PDF-syntax parser: it only needs to find literal
   `(...)` and hex `<...>` STRING tokens inside a dictionary/array region and
   leave everything else (names, numbers, `<<`/`>>`, `[`/`]`, comments)
   byte-for-byte untouched - see file header for why that's sufficient here. */
function parseLiteralStringBin(text, start){
  let i = start+1, depth=1;
  const out=[];
  while(i<text.length && depth>0){
    const c = text.charCodeAt(i);
    if(c===0x5C){ // backslash
      const n = text.charCodeAt(i+1);
      if(n===0x6E){ out.push(0x0A); i+=2; }
      else if(n===0x72){ out.push(0x0D); i+=2; }
      else if(n===0x74){ out.push(0x09); i+=2; }
      else if(n===0x62){ out.push(0x08); i+=2; }
      else if(n===0x66){ out.push(0x0C); i+=2; }
      else if(n===0x28){ out.push(0x28); i+=2; }
      else if(n===0x29){ out.push(0x29); i+=2; }
      else if(n===0x5C){ out.push(0x5C); i+=2; }
      else if(n===0x0D){ i+=2; if(text.charCodeAt(i)===0x0A) i++; } // line continuation
      else if(n===0x0A){ i+=2; }
      else if(n>=0x30 && n<=0x37){
        let val=0, cnt=0, j=i+1;
        while(cnt<3 && text.charCodeAt(j)>=0x30 && text.charCodeAt(j)<=0x37){ val=val*8+(text.charCodeAt(j)-0x30); j++; cnt++; }
        out.push(val & 0xFF); i=j;
      } else { out.push(n); i+=2; } // unrecognized escape: backslash ignored, char literal
    } else if(c===0x28){ depth++; out.push(c); i++; }
    else if(c===0x29){ depth--; i++; if(depth>0) out.push(c); }
    else { out.push(c); i++; }
  }
  return { bytes: Uint8Array.from(out), end: i };
}
function isHexDigitCode(c){ return (c>=0x30&&c<=0x39)||(c>=0x41&&c<=0x46)||(c>=0x61&&c<=0x66); }
function parseHexStringBin(text, start){
  let i = start+1;
  const hexChars = [];
  while(i<text.length && text.charCodeAt(i)!==0x3E){ // '>'
    const c = text.charCodeAt(i);
    if(isHexDigitCode(c)) hexChars.push(text[i]);
    i++;
  }
  i++; // consume '>'
  if(hexChars.length % 2 === 1) hexChars.push("0");
  const out = new Uint8Array(hexChars.length/2);
  for(let k=0;k<out.length;k++) out[k] = parseInt(hexChars[2*k]+hexChars[2*k+1], 16);
  return { bytes: out, end: i };
}
/** Replaces every string token in `text` with RC4(objKey, decodedBytes) re-encoded as a hex string. RC4 is its own inverse, so this is used for both encrypt and decrypt. */
function rc4TransformPdfObjectText(text, objKey){
  let out = "";
  let i = 0;
  while(i < text.length){
    const c = text.charCodeAt(i);
    if(c===0x25){ // '%' comment to end of line
      let j=i;
      while(j<text.length && text.charCodeAt(j)!==0x0A && text.charCodeAt(j)!==0x0D) j++;
      out += text.slice(i,j); i=j;
    } else if(c===0x28){ // '('
      const {bytes, end} = parseLiteralStringBin(text, i);
      out += bytesToHexPdfString(rc4(objKey, bytes));
      i = end;
    } else if(c===0x3C){ // '<'
      if(text.charCodeAt(i+1)===0x3C){ out += "<<"; i+=2; }
      else {
        const {bytes, end} = parseHexStringBin(text, i);
        out += bytesToHexPdfString(rc4(objKey, bytes));
        i = end;
      }
    } else { out += text[i]; i++; }
  }
  return out;
}

/* ---------------- Object discovery + whole-body transform ---------------- */
/** Finds every top-level indirect object in a classic (non-xref-stream) PDF body. Anchored to real line starts with a strict "N G obj" shape to minimize the (already tiny) chance of matching stray bytes inside a binary stream payload. */
function findIndirectObjects(bin){
  const objRe = /(?:^|[\r\n])(\d+) (\d+) obj\b/gm;
  const objects = [];
  let m;
  while((m = objRe.exec(bin))){
    const num = parseInt(m[1],10), gen = parseInt(m[2],10);
    const headerStart = m.index + (m[0][0]==="\r"||m[0][0]==="\n" ? 1 : 0);
    const bodyStart = objRe.lastIndex;
    const endobjIdx = bin.indexOf("endobj", bodyStart);
    if(endobjIdx === -1) continue;
    objects.push({num, gen, headerStart, bodyStart, bodyEnd: endobjIdx, endobjEnd: endobjIdx+6});
  }
  return objects;
}
function findPlainIntObjects(bin, objects){
  const map = new Map();
  for(const o of objects){
    const bodyText = bin.slice(o.bodyStart, o.bodyEnd).trim();
    if(/^\d+$/.test(bodyText)) map.set(o.num+"_"+o.gen, parseInt(bodyText,10));
  }
  return map;
}
/** Splits one object's body into header/stream (if any), RC4-transforms strings in the header and the raw stream payload with the same per-object key, and returns the rewritten body text. Symmetric: works for both encrypt and decrypt. */
function rc4TransformObjectBody(body, objKey, plainIntObjects){
  let streamKwIdx = -1, eol = "";
  const re = /stream(\r\n|\n)/g;
  let mm;
  while((mm = re.exec(body))){
    const before = mm.index>0 ? body.charCodeAt(mm.index-1) : 0x0A;
    if(before===0x0A||before===0x0D||before===0x20||before===0x09||before===0x3E){
      streamKwIdx = mm.index; eol = mm[1]; break;
    }
  }
  if(streamKwIdx === -1) return rc4TransformPdfObjectText(body, objKey);

  const header = body.slice(0, streamKwIdx);
  const payloadStart = streamKwIdx + 6 + eol.length;
  let length = null;
  const indirectM = /\/Length\s+(\d+)\s+(\d+)\s+R\b/.exec(header);
  if(indirectM){
    const v = plainIntObjects.get(indirectM[1]+"_"+indirectM[2]);
    if(v!=null) length = v;
  }
  if(length == null){
    const directM = /\/Length\s+(\d+)\b/.exec(header);
    if(directM) length = parseInt(directM[1],10);
  }
  const endstreamIdx = body.indexOf("endstream", payloadStart);
  let payloadEnd;
  if(length!=null && payloadStart+length <= body.length){
    payloadEnd = payloadStart + length;
  } else if(endstreamIdx !== -1){
    payloadEnd = endstreamIdx;
    if(payloadEnd>0 && body.charCodeAt(payloadEnd-1)===0x0A){ payloadEnd--; if(payloadEnd>0 && body.charCodeAt(payloadEnd-1)===0x0D) payloadEnd--; }
  } else {
    throw new Error("Could not determine a stream's length while processing this PDF's structure");
  }
  const payload = body.slice(payloadStart, payloadEnd);
  const tail = body.slice(payloadEnd);
  const newHeader = rc4TransformPdfObjectText(header, objKey);
  const newPayload = bytesToBinaryString(rc4(objKey, binaryStringToBytes(payload)));
  return newHeader + "stream" + eol + newPayload + tail;
}

/** Locates the ORIGINAL trailer dict text (classic `trailer<<...>>` form only - see file header scope note) and pulls out /Root, /Info, and /ID so a rebuild can carry them forward. Throws if this doesn't look like a classic-trailer PDF. */
function readOriginalTrailer(bin){
  const idx = bin.lastIndexOf("trailer");
  if(idx === -1) throw new Error("This PDF doesn't use a classic cross-reference table, which this feature requires");
  const openIdx = bin.indexOf("<<", idx);
  if(openIdx === -1) throw new Error("Could not read this PDF's trailer dictionary");
  // Balanced-bracket scan (not a lazy regex) - the trailer can itself
  // contain a NESTED `<<...>>` dict (e.g. an inline /Encrypt dict, exactly
  // what this module's own encryptPdfBytes() writes), which a naive
  // `<<([\s\S]*?)>>` would truncate at the first, inner `>>` instead of the
  // outer trailer's real close. A hex string's content can never itself
  // contain literal "<<"/">>" (only hex digits/whitespace are legal between
  // its single-angle-bracket delimiters), so counting these two-char
  // tokens is safe here.
  let depth=0, i=openIdx, closeIdx=-1;
  while(i<bin.length-1){
    if(bin[i]==="<" && bin[i+1]==="<"){ depth++; i+=2; continue; }
    if(bin[i]===">" && bin[i+1]===">"){ depth--; i+=2; if(depth===0){ closeIdx=i-2; break; } continue; }
    i++;
  }
  if(closeIdx===-1) throw new Error("Could not read this PDF's trailer dictionary");
  const dict = bin.slice(openIdx+2, closeIdx);
  const rootM = /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(dict);
  if(!rootM) throw new Error("Could not find this PDF's document catalog reference");
  const infoM = /\/Info\s+(\d+)\s+(\d+)\s+R\b/.exec(dict);
  const idM = /\/ID\s*\[\s*<([0-9A-Fa-f]*)>/.exec(dict);
  return {
    rootRef: `${rootM[1]} ${rootM[2]} R`,
    infoRef: infoM ? `${infoM[1]} ${infoM[2]} R` : null,
    idHex: idM ? idM[1] : null,
    dictText: dict,
  };
}

/** Finds and resolves this PDF's existing /Encrypt dictionary (direct or indirect) for the Unlock fast path. Returns null if there's no encryption, or if the structure isn't one this module recognizes. */
function readExistingEncryptDict(bin){
  let trailer;
  try{ trailer = readOriginalTrailer(bin); } catch(e){ return null; }
  const encM = /\/Encrypt\s+(?:(\d+)\s+(\d+)\s+R|(<<))/.exec(trailer.dictText);
  if(!encM) return null;
  let dictText;
  if(encM[3]){
    // Direct dict - it can itself contain a NESTED <<...>> dict (the /CF
    // crypt-filter dict an R=6 file writes), so a lazy `<<...>>` regex
    // would truncate at the inner dict's close. Balanced-scan instead,
    // the same way readOriginalTrailer reads the trailer itself.
    const start = encM.index + encM[0].length - 2;
    const src = trailer.dictText;
    let depth=0, i=start, closeIdx=-1;
    while(i<src.length-1){
      if(src[i]==="<" && src[i+1]==="<"){ depth++; i+=2; continue; }
      if(src[i]===">" && src[i+1]===">"){ depth--; i+=2; if(depth===0){ closeIdx=i-2; break; } continue; }
      i++;
    }
    if(closeIdx===-1) return null;
    dictText = trailer.dictText.slice(start+2, closeIdx);
  } else {
    const objs = findIndirectObjects(bin);
    const target = objs.find(o=>o.num===parseInt(encM[1],10) && o.gen===parseInt(encM[2],10));
    if(!target) return null;
    dictText = bin.slice(target.bodyStart, target.bodyEnd);
  }
  const filterM = /\/Filter\s*\/(\w+)/.exec(dictText);
  const vM = /\/V\s+(\d+)/.exec(dictText);
  const rM = /\/R\s+(\d+)/.exec(dictText);
  const pM = /\/P\s+(-?\d+)/.exec(dictText);
  const oM = /\/O\s*(\([\s\S]*?[^\\]\)|<[0-9A-Fa-f\s]*>)/.exec(dictText);
  const uM = /\/U\s*(\([\s\S]*?[^\\]\)|<[0-9A-Fa-f\s]*>)/.exec(dictText);
  const oeM = /\/OE\s*(\([\s\S]*?[^\\]\)|<[0-9A-Fa-f\s]*>)/.exec(dictText);
  const ueM = /\/UE\s*(\([\s\S]*?[^\\]\)|<[0-9A-Fa-f\s]*>)/.exec(dictText);
  if(!filterM || filterM[1]!=="Standard" || !vM || !rM || !pM || !oM || !uM) return null;
  function decodeStringToken(tok){
    if(tok[0]==="<") return parseHexStringBin(tok, 0).bytes;
    return parseLiteralStringBin(tok, 0).bytes;
  }
  return {
    V: parseInt(vM[1],10), R: parseInt(rM[1],10), P: parseInt(pM[1],10),
    O: decodeStringToken(oM[1]), U: decodeStringToken(uM[1]),
    OE: oeM ? decodeStringToken(oeM[1]) : null,
    UE: ueM ? decodeStringToken(ueM[1]) : null,
    // R=5/R=6 key derivation never uses the file ID; R=2 does. An
    // ID-less file is therefore still readable here, and the R=2 path
    // below rejects it explicitly instead of crashing on undefined.
    idBytes: trailer.idHex ? hexPairsToBytes(trailer.idHex) : null,
    trailer,
  };
}

/** Shared rebuild: re-serializes `pdfBytes` with every object's strings/streams transformed via RC4 under a per-object key derived from `fileKey`, then regenerates a fresh classic xref table + trailer (object byte offsets necessarily change since hex-re-encoded strings rarely keep the original literal string's exact length). `trailerFields` is the literal dict content (without the surrounding `<< >>`) to write into the new trailer - caller decides whether that includes /Encrypt (protect) or omits it (unlock). */
function rebuildPdfWithTransform(pdfBytes, fileKey, trailerFields){
  const bin = bytesToBinaryString(pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes));
  const objects = findIndirectObjects(bin);
  if(!objects.length) throw new Error("No PDF objects found - this file may not be a valid PDF");
  const plainIntObjects = findPlainIntObjects(bin, objects);
  objects.sort((a,b)=>a.headerStart-b.headerStart);

  const headerText = bin.slice(0, objects[0].headerStart);
  let out = headerText;
  const offsetByNum = new Map();
  let maxNum = 0;
  for(const o of objects){
    if(o.num > maxNum) maxNum = o.num;
    offsetByNum.set(o.num, out.length);
    const objKey = computeObjectKey(fileKey, o.num, o.gen);
    const body = bin.slice(o.bodyStart, o.bodyEnd);
    const newBody = rc4TransformObjectBody(body, objKey, plainIntObjects);
    out += `${o.num} ${o.gen} obj\n${newBody}\nendobj\n`;
  }
  const xrefOffset = out.length;
  const count = maxNum + 1;
  let xref = `xref\n0 ${count}\n`;
  xref += "0000000000 65535 f \n";
  for(let n=1;n<count;n++){
    if(offsetByNum.has(n)) xref += String(offsetByNum.get(n)).padStart(10,"0") + " 00000 n \n";
    else xref += "0000000000 65535 f \n";
  }
  out += xref;
  out += `trailer\n<< /Size ${count} ${trailerFields} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return binaryStringToBytes(out);
}

/**
 * Encrypts a PDF with the Standard Security Handler (40-bit RC4, revision 2).
 * `pdfBytes` MUST come from `PDFDocument.save({useObjectStreams:false})` -
 * see file header for why. Caller is responsible for the runtime self-check
 * (re-opening the result with pdf.js + the same password) since that needs
 * pdfjsLib, which this pure module deliberately doesn't depend on.
 * @param {Uint8Array} pdfBytes
 * @param {{userPassword:string, ownerPassword?:string, permissions?:object}} opts
 * @returns {Uint8Array}
 */
function encryptPdfBytes(pdfBytes, {userPassword, ownerPassword, permissions}={}){
  // An EMPTY user password is valid (a permissions-only file: it opens
  // without a password but carries restrictions); only a missing
  // password argument is an error. Callers validate that at least one
  // of the user/owner passwords is set.
  if(userPassword === undefined || userPassword === null) throw new Error("A password is required");
  const userPwBytes = pdfLatin1Bytes(userPassword);
  const ownerPwBytes = pdfLatin1Bytes(ownerPassword || userPassword);
  const idBytes = crypto.getRandomValues(new Uint8Array(16));
  const P = computePermissionsInt(permissions);
  const O = computeO(ownerPwBytes, userPwBytes);
  const fileKey = computeFileKey(userPwBytes, O, P, idBytes);
  const U = computeU(fileKey);
  const idHex = bytesToHexPdfString(idBytes);
  const origTrailer = readOriginalTrailer(bytesToBinaryString(pdfBytes));
  const trailerFields = `/Root ${origTrailer.rootRef}`
    + (origTrailer.infoRef ? ` /Info ${origTrailer.infoRef}` : "")
    + ` /Encrypt << /Filter /Standard /V 1 /R 2 /O ${bytesToHexPdfString(O)} /U ${bytesToHexPdfString(U)} /P ${P} >>`
    + ` /ID [${idHex} ${idHex}]`;
  return rebuildPdfWithTransform(pdfBytes, fileKey, trailerFields);
}

/**
 * Structure-preserving decrypt fast path for Unlock PDF - ONLY handles the
 * exact scheme encryptPdfBytes() produces (Standard handler, V1/R2, 40-bit
 * RC4). Returns `{notSimple:true}` for anything else (AES, 128-bit RC4,
 * revision 3+, a non-classic-xref file, or any parse hiccup) so the caller
 * falls back to the pdf.js render-based flatten path, which covers every
 * encryption variant pdf.js itself supports. The password itself is assumed
 * already verified by the caller (pdf.js's own getDocument({password})) -
 * this only re-confirms it via the same U-value check the PDF spec itself
 * uses, which doubles as a sanity check on this module's own O/U parsing.
 * @param {Uint8Array} pdfBytes
 * @param {string} password
 * @returns {{bytes:Uint8Array}|{notSimple:true}}
 */
function tryDecryptSimplePdfBytes(pdfBytes, password){
  try{
    const bin = bytesToBinaryString(pdfBytes);
    const enc = readExistingEncryptDict(bin);
    if(!enc || enc.V!==1 || enc.R!==2 || !enc.idBytes) return {notSimple:true};
    const pwBytes = pdfLatin1Bytes(password || "");
    let fileKey = computeFileKey(pwBytes, enc.O, enc.P, enc.idBytes);
    if(bytesToHexPdfString(computeU(fileKey)) !== bytesToHexPdfString(enc.U)){
      // Supplied password didn't work as the USER password - try it as the
      // OWNER password (Algorithm 7: recover the user password from O, then
      // derive the file key from that).
      const opw = padPassword(pwBytes);
      const rc4Key = md5(opw).subarray(0,5);
      const recoveredUserPw = rc4(rc4Key, enc.O);
      fileKey = computeFileKey(recoveredUserPw, enc.O, enc.P, enc.idBytes);
      if(bytesToHexPdfString(computeU(fileKey)) !== bytesToHexPdfString(enc.U)) return {notSimple:true};
    }
    const trailerFields = `/Root ${enc.trailer.rootRef}` + (enc.trailer.infoRef ? ` /Info ${enc.trailer.infoRef}` : "")
      + ` /ID [${bytesToHexPdfString(enc.idBytes)} ${bytesToHexPdfString(enc.idBytes)}]`;
    return { bytes: rebuildPdfWithTransform(pdfBytes, fileKey, trailerFields) };
  }catch(e){
    return {notSimple:true};
  }
}

/* ---------------- Standard Security Handler, Revisions 5/6 (AES-256, V=5) ----------------
   ISO 32000-2 Section 7.6.4.3. Protect PDF's DEFAULT since the parity
   fixes (the R=2/40-bit RC4 path above is kept only as an explicit
   "Legacy compatibility" opt-in): AES-256, Security Handler revision 6
   (revision 5 uses the same entry layout with a plain SHA-256 hash
   instead of the iterative one, and is accepted on the decrypt path).

   Every algorithmic choice below was verified empirically against
   pdf.js 3.11.174 (the same build this app ships): a file produced by
   encryptPdfBytesAES256() opens in pdf.js with the user password AND
   with the owner password, rejects wrong/empty passwords, preserves
   text and metadata byte-for-byte through decryption, and a
   permissions-only file (empty user password) opens with no password
   at all. Two details that are easy to get wrong, confirmed by reading
   pdf.js's own CipherTransformFactory/PDF20 source in node_modules:
   (1) the owner-password hash and the OE key take the FULL 48-byte U
   entry as their "user key" input, not just its 32-byte hash portion;
   (2) AESV3 encrypts strings AND streams directly with the 32-byte
   file key (AES-256-CBC, random 16-byte IV prepended, PKCS#7 padding)
   - there are NO per-object keys and no "sAlT" salt for V=5, unlike
   the V<=4 handlers. (pdf.js's AESV3 branch is literally
   `new AES256Cipher(key)` with the file key.)

   Scope/known limitations (by design):
   - WebCrypto only (crypto.subtle): AES-CBC and SHA-256/384/512 are
     used directly. In a non-secure context subtle is unavailable and
     these functions throw a descriptive error so the caller can offer
     the legacy path instead of silently producing a weak file. Key
     import happens once per file, not once per object.
   - Password bytes are the UTF-8 encoding truncated to 127 bytes
     (SASLprep normalization is skipped: ASCII passwords - the
     overwhelmingly common case - are unaffected, and a password
     round-trips through this app's own encrypt/decrypt since both
     sides use the same encoding).
   - Like the R=2 path, only classic xref-table PDFs are handled;
     callers must pass bytes saved with `{useObjectStreams:false}`.
   - WebCrypto's AES-CBC always applies PKCS#7 padding, but Algorithm
     2.B, UE/OE and Perms need RAW (unpadded) CBC. Their inputs are
     always block-aligned, so encryption truncates the one extra
     padding block WebCrypto appends, and decryption appends one
     synthetic block that decrypts to a valid padding block (see
     r6DecryptRawBlock) so WebCrypto's padding strip returns exactly
     the raw plaintext. Object strings/streams DO use padding (per
     the AESV3 spec) and go through the plain WebCrypto calls. */

function r6GetSubtle(){
  const subtle = (typeof globalThis !== "undefined" ? globalThis.crypto : undefined)?.subtle
    || (typeof crypto !== "undefined" ? crypto.subtle : undefined);
  if(!subtle) throw new Error("AES-256 encryption needs WebCrypto (a secure HTTPS/local context). Use the legacy compatibility option instead.");
  return subtle;
}
function r6Concat(...arrs){
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for(const a of arrs){ out.set(a, off); off += a.length; }
  return out;
}
function r6BytesEqual(a, b){
  if(!a || !b || a.length !== b.length) return false;
  for(let i=0;i<a.length;i++) if(a[i] !== b[i]) return false;
  return true;
}
function r6RandomBytes(n){
  const c = (typeof globalThis !== "undefined" && globalThis.crypto) || (typeof crypto !== "undefined" ? crypto : null);
  if(!c || !c.getRandomValues) throw new Error("No secure random source is available.");
  return c.getRandomValues(new Uint8Array(n));
}
function r6PasswordBytes(str){
  // UTF-8, truncated to 127 bytes (ISO 32000-2 7.6.4.3.2).
  return new TextEncoder().encode(str || "").subarray(0, 127);
}
async function r6Digest(algo, data){
  return new Uint8Array(await r6GetSubtle().digest(algo, data));
}
async function r6ImportKey(rawBytes, usages){
  return r6GetSubtle().importKey("raw", rawBytes, {name:"AES-CBC"}, false, usages);
}
async function r6EncryptRaw(key, iv, data){
  // Raw CBC: data is block-aligned; drop the padding block WebCrypto appends.
  const out = new Uint8Array(await r6GetSubtle().encrypt({name:"AES-CBC", iv}, key, data));
  return out.subarray(0, data.length);
}
async function r6DecryptRaw(key, iv, data){
  // Raw CBC decrypt via WebCrypto, which always strips PKCS#7 padding:
  // append one synthetic block that decrypts to a full padding block
  // (16 bytes of 0x10), so the strip removes exactly that block and
  // returns the raw plaintext. Only valid for block-aligned input
  // (UE/OE are always exactly 32 bytes).
  if(data.length === 0 || data.length % 16 !== 0) throw new Error("Raw AES decryption needs block-aligned input.");
  const padBlock = new Uint8Array(16).fill(16);
  const lastBlock = data.subarray(data.length - 16);
  const xPlain = new Uint8Array(16);
  for(let i=0;i<16;i++) xPlain[i] = padBlock[i] ^ lastBlock[i];
  const xCipher = await r6EncryptRaw(key, new Uint8Array(16), xPlain);
  const padded = r6Concat(data, xCipher);
  const out = new Uint8Array(await r6GetSubtle().decrypt({name:"AES-CBC", iv}, key, padded));
  if(out.length !== data.length) throw new Error("Raw AES decryption produced an unexpected length.");
  return out;
}
/** Algorithm 2.B (R=6 iterative hash); with iterative=false it is the plain SHA-256 hash R=5 uses. */
async function r6IterativeHash(passwordBytes, saltBytes, userKeyBytes, iterative){
  let k = await r6Digest("SHA-256", r6Concat(passwordBytes, saltBytes, userKeyBytes));
  if(!iterative) return k.subarray(0, 32);
  const subtle = r6GetSubtle();
  let e = new Uint8Array([0]);
  let round = 0;
  while(round < 64 || e[e.length-1] > round - 32){
    if(round > 4096) throw new Error("Password hashing did not converge.");
    const combined = r6Concat(passwordBytes, k, userKeyBytes);
    const k1 = new Uint8Array(combined.length * 64);
    for(let j=0;j<64;j++) k1.set(combined, j * combined.length);
    const aesKey = await subtle.importKey("raw", k.subarray(0, 16), {name:"AES-CBC"}, false, ["encrypt"]);
    const enc = new Uint8Array(await subtle.encrypt({name:"AES-CBC", iv: k.subarray(16, 32)}, aesKey, k1));
    // k1 is always a multiple of 16 bytes (64 repetitions), so the raw
    // ciphertext is the output minus the one appended padding block.
    e = enc.subarray(0, k1.length);
    // The remainder is the SUM of the first 16 bytes mod 3 (which equals
    // the big-endian-integer mod 3, since 256 == 1 mod 3) - pdf.js does
    // the sum form; both agree.
    let remainder = 0;
    for(let i=0;i<16;i++) remainder = (remainder + e[i]) % 3;
    k = remainder === 0 ? await r6Digest("SHA-256", e) : remainder === 1 ? await r6Digest("SHA-384", e) : await r6Digest("SHA-512", e);
    round++;
  }
  return k.subarray(0, 32);
}
/** Verifies `password` against a parsed V=5 encrypt dict and recovers the file key. Returns null when the password matches neither the user nor the owner entry - never throws for a wrong password. */
async function r6RecoverFileKey(passwordStr, enc){
  const iterative = enc.R >= 6;
  const pw = r6PasswordBytes(passwordStr);
  if(!enc.U || enc.U.length !== 48 || !enc.O || enc.O.length !== 48 || !enc.UE || enc.UE.length !== 32 || !enc.OE || enc.OE.length !== 32) return null;
  const uHash = enc.U.subarray(0, 32), uValSalt = enc.U.subarray(32, 40), uKeySalt = enc.U.subarray(40, 48);
  const uCheck = await r6IterativeHash(pw, uValSalt, new Uint8Array(0), iterative);
  if(r6BytesEqual(uCheck, uHash)){
    const ueKey = await r6ImportKey(await r6IterativeHash(pw, uKeySalt, new Uint8Array(0), iterative), ["encrypt", "decrypt"]);
    return {fileKey: await r6DecryptRaw(ueKey, new Uint8Array(16), enc.UE), viaOwner:false};
  }
  const oHash = enc.O.subarray(0, 32), oValSalt = enc.O.subarray(32, 40), oKeySalt = enc.O.subarray(40, 48);
  // Owner hash and OE key use the FULL 48-byte U entry as user key (pdf.js PDF20).
  const oCheck = await r6IterativeHash(pw, oValSalt, enc.U, iterative);
  if(r6BytesEqual(oCheck, oHash)){
    const oeKey = await r6ImportKey(await r6IterativeHash(pw, oKeySalt, enc.U, iterative), ["encrypt", "decrypt"]);
    return {fileKey: await r6DecryptRaw(oeKey, new Uint8Array(16), enc.OE), viaOwner:true};
  }
  return null;
}
/** AESV3 object encryption: file key, random IV prepended, PKCS#7 padding. */
async function aesV3EncryptBytes(fileKey, plainBytes){
  const iv = r6RandomBytes(16);
  const ct = new Uint8Array(await r6GetSubtle().encrypt({name:"AES-CBC", iv}, fileKey, plainBytes));
  return r6Concat(iv, ct);
}
/** AESV3 object decryption: first 16 bytes are the IV. Throws on bad padding/length. */
async function aesV3DecryptBytes(fileKey, data){
  if(data.length < 32 || (data.length - 16) % 16 !== 0) throw new Error("Invalid AESV3 ciphertext length.");
  const iv = data.subarray(0, 16);
  const ct = data.subarray(16);
  return new Uint8Array(await r6GetSubtle().decrypt({name:"AES-CBC", iv}, fileKey, ct));
}
/** Replaces every string token in `text` with the AESV3 encryption (hex string) or decryption (hex string) of its bytes. */
async function aesV3TransformObjectText(text, fileKey, decrypt){
  let out = "";
  let i = 0;
  while(i < text.length){
    const c = text.charCodeAt(i);
    if(c===0x25){ // '%' comment to end of line
      let j=i;
      while(j<text.length && text.charCodeAt(j)!==0x0A && text.charCodeAt(j)!==0x0D) j++;
      out += text.slice(i,j); i=j;
    } else if(c===0x28){ // '('
      const {bytes, end} = parseLiteralStringBin(text, i);
      const transformed = decrypt ? await aesV3DecryptBytes(fileKey, bytes) : await aesV3EncryptBytes(fileKey, bytes);
      out += bytesToHexPdfString(transformed);
      i = end;
    } else if(c===0x3C){ // '<'
      if(text.charCodeAt(i+1)===0x3C){ out += "<<"; i+=2; }
      else {
        const {bytes, end} = parseHexStringBin(text, i);
        const transformed = decrypt ? await aesV3DecryptBytes(fileKey, bytes) : await aesV3EncryptBytes(fileKey, bytes);
        out += bytesToHexPdfString(transformed);
        i = end;
      }
    } else { out += text[i]; i++; }
  }
  return out;
}
/** Shared AESV3 rebuild: re-serializes `pdfBytes` with every object's strings/streams encrypted (decrypt=false) or decrypted (decrypt=true) under `fileKey`, regenerating a fresh classic xref table + trailer. `trailerFields` is the literal dict content the caller wants in the new trailer (with /Encrypt for protect, without it for unlock). Handles direct and indirect /Length, since AES changes stream lengths (unlike RC4). */
async function rebuildPdfWithAesV3Transform(pdfBytes, fileKey, trailerFields, decrypt){
  const bin = bytesToBinaryString(pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes));
  const objects = findIndirectObjects(bin);
  if(!objects.length) throw new Error("No PDF objects found - this file may not be a valid PDF");
  const plainIntObjects = findPlainIntObjects(bin, objects);
  objects.sort((a,b)=>a.headerStart-b.headerStart);
  const lengthUpdates = new Map();
  const newBodies = new Map();
  for(const o of objects){
    const body = bin.slice(o.bodyStart, o.bodyEnd);
    let streamKwIdx = -1, eol = "";
    const re = /stream(\r\n|\n)/g;
    let mm;
    while((mm = re.exec(body))){
      const before = mm.index>0 ? body.charCodeAt(mm.index-1) : 0x0A;
      if(before===0x0A||before===0x0D||before===0x20||before===0x09||before===0x3E){
        streamKwIdx = mm.index; eol = mm[1]; break;
      }
    }
    if(streamKwIdx === -1){
      newBodies.set(o.num+"_"+o.gen, await aesV3TransformObjectText(body, fileKey, decrypt));
      continue;
    }
    const header = body.slice(0, streamKwIdx);
    const payloadStart = streamKwIdx + 6 + eol.length;
    let length = null, lengthRef = null;
    const indirectM = /\/Length\s+(\d+)\s+(\d+)\s+R\b/.exec(header);
    if(indirectM){
      lengthRef = indirectM[1]+"_"+indirectM[2];
      const v = plainIntObjects.get(lengthRef);
      if(v!=null) length = v;
    }
    if(length == null){
      const directM = /\/Length\s+(\d+)\b/.exec(header);
      if(directM) length = parseInt(directM[1],10);
    }
    const endstreamIdx = body.indexOf("endstream", payloadStart);
    let payloadEnd;
    if(length!=null && payloadStart+length <= body.length){
      payloadEnd = payloadStart + length;
    } else if(endstreamIdx !== -1){
      payloadEnd = endstreamIdx;
      if(payloadEnd>0 && body.charCodeAt(payloadEnd-1)===0x0A){ payloadEnd--; if(payloadEnd>0 && body.charCodeAt(payloadEnd-1)===0x0D) payloadEnd--; }
    } else {
      throw new Error("Could not determine a stream's length while processing this PDF's structure");
    }
    const payloadBytes = binaryStringToBytes(body.slice(payloadStart, payloadEnd));
    const newPayload = decrypt ? await aesV3DecryptBytes(fileKey, payloadBytes) : await aesV3EncryptBytes(fileKey, payloadBytes);
    const tail = body.slice(payloadEnd);
    let newHeader = await aesV3TransformObjectText(header, fileKey, decrypt);
    if(lengthRef){
      lengthUpdates.set(lengthRef, newPayload.length);
    } else {
      newHeader = newHeader.replace(/\/Length\s+\d+\b/, "/Length " + newPayload.length);
    }
    newBodies.set(o.num+"_"+o.gen, newHeader + "stream" + eol + bytesToBinaryString(newPayload) + tail);
  }
  const headerText = bin.slice(0, objects[0].headerStart);
  let out = headerText;
  const offsetByNum = new Map();
  let maxNum = 0;
  for(const o of objects){
    if(o.num > maxNum) maxNum = o.num;
    offsetByNum.set(o.num, out.length);
    const key = o.num+"_"+o.gen;
    const bodyText = lengthUpdates.has(key) ? String(lengthUpdates.get(key)) : newBodies.get(key);
    out += `${o.num} ${o.gen} obj\n${bodyText}\nendobj\n`;
  }
  const xrefOffset = out.length;
  const count = maxNum + 1;
  let xref = `xref\n0 ${count}\n`;
  xref += "0000000000 65535 f \n";
  for(let n=1;n<count;n++){
    if(offsetByNum.has(n)) xref += String(offsetByNum.get(n)).padStart(10,"0") + " 00000 n \n";
    else xref += "0000000000 65535 f \n";
  }
  out += xref;
  out += `trailer\n<< /Size ${count} ${trailerFields} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return binaryStringToBytes(out);
}

/**
 * Encrypts a PDF with the Standard Security Handler, revision 6 (AES-256,
 * V=5). `pdfBytes` MUST come from `PDFDocument.save({useObjectStreams:false})`.
 * `userPassword` may be "" for a permissions-only file (opens without a
 * password but carries restrictions); `ownerPassword` defaults to the user
 * password when omitted. Caller is responsible for the runtime self-check
 * (re-opening the result with pdf.js + the password).
 * @param {Uint8Array} pdfBytes
 * @param {{userPassword?:string, ownerPassword?:string, permissions?:object}} opts
 * @returns {Promise<Uint8Array>}
 */
async function encryptPdfBytesAES256(pdfBytes, {userPassword="", ownerPassword, permissions}={}){
  r6GetSubtle(); // throws a descriptive error early when WebCrypto is unavailable
  const upw = r6PasswordBytes(userPassword);
  const opw = r6PasswordBytes(ownerPassword === undefined || ownerPassword === null ? userPassword : ownerPassword);
  const P = computePermissionsInt(permissions);
  const fileKeyRaw = r6RandomBytes(32);
  const fileKey = await r6ImportKey(fileKeyRaw, ["encrypt", "decrypt"]);
  const uValSalt = r6RandomBytes(8), uKeySalt = r6RandomBytes(8);
  const uHash = await r6IterativeHash(upw, uValSalt, new Uint8Array(0), true);
  const U = r6Concat(uHash, uValSalt, uKeySalt);
  const oValSalt = r6RandomBytes(8), oKeySalt = r6RandomBytes(8);
  const oHash = await r6IterativeHash(opw, oValSalt, U, true);
  const O = r6Concat(oHash, oValSalt, oKeySalt);
  const ueKey = await r6ImportKey(await r6IterativeHash(upw, uKeySalt, new Uint8Array(0), true), ["encrypt"]);
  const UE = await r6EncryptRaw(ueKey, new Uint8Array(16), fileKeyRaw);
  const oeKey = await r6ImportKey(await r6IterativeHash(opw, oKeySalt, U, true), ["encrypt"]);
  const OE = await r6EncryptRaw(oeKey, new Uint8Array(16), fileKeyRaw);
  // Perms: 16 bytes (P LE, 0xFFFFFFFF, 'T' for EncryptMetadata, 'adb',
  // 4 random bytes) encrypted as a single AES block (CBC, zero IV == ECB).
  const permsPlain = r6Concat(
    (()=>{ const b=new Uint8Array(4); new DataView(b.buffer).setInt32(0, P, true); return b; })(),
    new Uint8Array([0xFF,0xFF,0xFF,0xFF,0x54,0x61,0x64,0x62]),
    r6RandomBytes(4)
  );
  const Perms = await r6EncryptRaw(fileKey, new Uint8Array(16), permsPlain);
  const origTrailer = readOriginalTrailer(bytesToBinaryString(pdfBytes));
  const idHex = origTrailer.idHex || [...r6RandomBytes(16)].map(b=>b.toString(16).padStart(2,"0")).join("");
  const trailerFields = `/Root ${origTrailer.rootRef}`
    + (origTrailer.infoRef ? ` /Info ${origTrailer.infoRef}` : "")
    + ` /Encrypt << /Filter /Standard /V 5 /R 6 /Length 256`
    + ` /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >>`
    + ` /StrF /StdCF /StmF /StdCF`
    + ` /O ${bytesToHexPdfString(O)} /U ${bytesToHexPdfString(U)}`
    + ` /OE ${bytesToHexPdfString(OE)} /UE ${bytesToHexPdfString(UE)}`
    + ` /Perms ${bytesToHexPdfString(Perms)} /P ${P} /EncryptMetadata true >>`
    + ` /ID [${bytesToHexPdfString(hexPairsToBytes(idHex))} ${bytesToHexPdfString(hexPairsToBytes(idHex))}]`;
  return rebuildPdfWithAesV3Transform(pdfBytes, fileKey, trailerFields, false);
}

/**
 * Structure-preserving decrypt for V=5 (AES-256, revisions 5/6) files -
 * the AES counterpart of tryDecryptSimplePdfBytes(). Verifies the
 * password against U/O itself (the same check pdf.js performs), recovers
 * the file key from UE/OE, and decrypts every string/stream in place, so
 * the result keeps fully vector/text pages. Returns `{notSimple:true}`
 * for anything else (other V/R values, missing OE/UE, bad padding, a
 * non-classic-xref file, or any parse hiccup) so the caller falls back
 * to the render-based flatten path. The password is assumed already
 * verified by the caller (pdf.js's own getDocument({password})) - the
 * re-verification here doubles as a sanity check on the parsing.
 * @param {Uint8Array} pdfBytes
 * @param {string} password
 * @returns {Promise<{bytes:Uint8Array}|{notSimple:true}>}
 */
async function tryDecryptAesPdfBytes(pdfBytes, password){
  try{
    const bin = bytesToBinaryString(pdfBytes);
    const enc = readExistingEncryptDict(bin);
    if(!enc || enc.V!==5 || (enc.R!==5 && enc.R!==6)) return {notSimple:true};
    const recovered = await r6RecoverFileKey(password || "", enc);
    if(!recovered) return {notSimple:true};
    const fileKey = await r6ImportKey(recovered.fileKey, ["encrypt", "decrypt"]);
    const idHex = enc.trailer.idHex || [...r6RandomBytes(16)].map(b=>b.toString(16).padStart(2,"0")).join("");
    const trailerFields = `/Root ${enc.trailer.rootRef}` + (enc.trailer.infoRef ? ` /Info ${enc.trailer.infoRef}` : "")
      + ` /ID [${bytesToHexPdfString(hexPairsToBytes(idHex))} ${bytesToHexPdfString(hexPairsToBytes(idHex))}]`;
    return { bytes: await rebuildPdfWithAesV3Transform(pdfBytes, fileKey, trailerFields, true) };
  }catch(e){
    return {notSimple:true};
  }
}
