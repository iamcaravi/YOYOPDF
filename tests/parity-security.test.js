import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Parity wave C: Protect PDF AES-256 (R=6/V=5), Unlock AES fast path,
// permission bits, and the pdf-lib API contract the Fill Form dropdown
// fix relies on. js/core/pdf-crypto.js is a classic browser script,
// loaded into a vm sandbox exactly as tests/pdf-to-excel.test.js loads
// js/core/doc-export-builders.js. The sandbox gets the real WebCrypto
// (Node's globalThis.crypto) because the R=6 code uses crypto.subtle,
// and TextEncoder for the R=6 password encoding.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let sandbox;
beforeAll(() => {
  const source = readFileSync(resolve(ROOT, "js/core/pdf-crypto.js"), "utf8");
  sandbox = vm.createContext({
    console,
    crypto: globalThis.crypto,
    TextEncoder,
  });
  vm.runInContext(source, sandbox, { filename: "pdf-crypto.js" });
});

async function makeSamplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("Hello AES-256 world, editable text must survive.", {
    x: 72, y: 700, size: 18, font, color: rgb(0, 0, 0),
  });
  page.drawText("Second line 12345 and (parens).", { x: 72, y: 670, size: 12, font });
  doc.setTitle("Parity Title (with parens)");
  doc.setAuthor("Parity Author");
  return doc.save({ useObjectStreams: false });
}

async function pdfJsText(pdfBytes, password) {
  const params = { data: pdfBytes.slice(0) };
  if (password !== undefined) params.password = password;
  const pdoc = await pdfjsLib.getDocument(params).promise;
  try {
    const pg = await pdoc.getPage(1);
    const tc = await pg.getTextContent();
    const meta = await pdoc.getMetadata();
    return {
      numPages: pdoc.numPages,
      text: tc.items.map((it) => it.str).join(" "),
      title: meta?.info?.Title,
      author: meta?.info?.Author,
    };
  } finally {
    await pdoc.destroy();
  }
}

async function expectPasswordRejected(pdfBytes, password) {
  let rejected = false;
  try {
    const params = { data: pdfBytes.slice(0) };
    if (password !== undefined) params.password = password;
    const pdoc = await pdfjsLib.getDocument(params).promise;
    await pdoc.getPage(1);
    await pdoc.destroy();
  } catch (e) {
    rejected = e && e.name === "PasswordException";
  }
  expect(rejected).toBe(true);
}

describe("AES-256 protect (R=6/V=5)", () => {
  it("round-trips through pdf.js: user and owner passwords open, text and metadata survive", async () => {
    const raw = await makeSamplePdf();
    const enc = await sandbox.encryptPdfBytesAES256(raw, {
      userPassword: "userpw123",
      ownerPassword: "ownerpw456",
      permissions: {},
    });
    expect(ArrayBuffer.isView(enc)).toBe(true);
    expect(enc.length).toBeGreaterThan(raw.length);

    const asUser = await pdfJsText(enc, "userpw123");
    expect(asUser.numPages).toBe(1);
    expect(asUser.text).toContain("Hello AES-256 world");
    expect(asUser.text).toContain("Second line 12345");
    expect(asUser.title).toBe("Parity Title (with parens)");
    expect(asUser.author).toBe("Parity Author");

    const asOwner = await pdfJsText(enc, "ownerpw456");
    expect(asOwner.text).toContain("Hello AES-256 world");

    await expectPasswordRejected(enc, "wrongpw");
    await expectPasswordRejected(enc, undefined);
  });

  it("permissions-only file (empty user password) opens with no password and carries V=5/R=6", async () => {
    const raw = await makeSamplePdf();
    const enc = await sandbox.encryptPdfBytesAES256(raw, {
      userPassword: "",
      ownerPassword: "ownerpw456",
      permissions: { copy: false },
    });
    const opened = await pdfJsText(enc, undefined);
    expect(opened.text).toContain("Hello AES-256 world");

    const bin = sandbox.bytesToBinaryString(enc);
    const dict = sandbox.readExistingEncryptDict(bin);
    expect(dict).not.toBeNull();
    expect(dict.V).toBe(5);
    expect(dict.R).toBe(6);
    expect(dict.OE).not.toBeNull();
    expect(dict.UE).not.toBeNull();
    expect(dict.P).toBe(sandbox.computePermissionsInt({ copy: false }));
  });

  it("structural AES decrypt restores a password-free, text-intact PDF (user and owner passwords)", async () => {
    const raw = await makeSamplePdf();
    const enc = await sandbox.encryptPdfBytesAES256(raw, {
      userPassword: "userpw123",
      ownerPassword: "ownerpw456",
    });
    for (const pw of ["userpw123", "ownerpw456"]) {
      const fast = await sandbox.tryDecryptAesPdfBytes(enc, pw);
      expect(fast.notSimple).toBeUndefined();
      const opened = await pdfJsText(fast.bytes, undefined);
      expect(opened.text).toContain("Hello AES-256 world");
      expect(opened.title).toBe("Parity Title (with parens)");
      // The decrypted file carries no encrypt dictionary at all.
      expect(sandbox.readExistingEncryptDict(sandbox.bytesToBinaryString(fast.bytes))).toBeNull();
    }
    const wrong = await sandbox.tryDecryptAesPdfBytes(enc, "nope");
    expect(wrong).toEqual({ notSimple: true });
  });

  it("a non-ASCII password round-trips through this app's own encrypt/decrypt", async () => {
    const raw = await makeSamplePdf();
    const enc = await sandbox.encryptPdfBytesAES256(raw, { userPassword: "pässwörd✓" });
    const fast = await sandbox.tryDecryptAesPdfBytes(enc, "pässwörd✓");
    expect(fast.notSimple).toBeUndefined();
    const opened = await pdfJsText(fast.bytes, undefined);
    expect(opened.text).toContain("Hello AES-256 world");
  });

  it("legacy 40-bit RC4 path still round-trips (opt-in only)", async () => {
    const raw = await makeSamplePdf();
    const enc = sandbox.encryptPdfBytes(raw, {
      userPassword: "legacypw",
      ownerPassword: "legacypw",
      permissions: {},
    });
    const opened = await pdfJsText(enc, "legacypw");
    expect(opened.text).toContain("Hello AES-256 world");
    const dict = sandbox.readExistingEncryptDict(sandbox.bytesToBinaryString(enc));
    expect(dict.V).toBe(1);
    expect(dict.R).toBe(2);
    const fast = sandbox.tryDecryptSimplePdfBytes(enc, "legacypw");
    expect(ArrayBuffer.isView(fast.bytes)).toBe(true);
    const unlocked = await pdfJsText(fast.bytes, undefined);
    expect(unlocked.text).toContain("Hello AES-256 world");
  });
});

describe("permission bits", () => {
  it("all-allowed is -4 and each opt-out clears exactly its bit", () => {
    expect(sandbox.computePermissionsInt({})).toBe(-4);
    const base = sandbox.computePermissionsInt({});
    expect(sandbox.computePermissionsInt({ print: false })).toBe(base & ~(1 << 2));
    expect(sandbox.computePermissionsInt({ modify: false })).toBe(base & ~(1 << 3));
    expect(sandbox.computePermissionsInt({ copy: false })).toBe(base & ~(1 << 4));
    expect(sandbox.computePermissionsInt({ annotate: false })).toBe(base & ~(1 << 5));
    expect(sandbox.computePermissionsInt({ fillForms: false })).toBe(base & ~(1 << 8));
    expect(sandbox.computePermissionsInt({ extractAccessibility: false })).toBe(base & ~(1 << 9));
    expect(sandbox.computePermissionsInt({ assemble: false })).toBe(base & ~(1 << 10));
    expect(sandbox.computePermissionsInt({ printHighRes: false })).toBe(base & ~(1 << 11));
  });
});

describe("Fill Form field-type API contract (pdf-lib)", () => {
  // The dropdown fix classifies PDFDropdown explicitly instead of
  // falling through to "text" (where getTextField() throws inside a
  // swallowed catch and the value is silently lost). These tests pin
  // the pdf-lib APIs that classification and export rely on.
  it("dropdown options round-trip through select(), and getTextField() on a dropdown throws (the old bug)", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const dd = form.createDropdown("ChoiceField");
    dd.addOptions(["Red", "Green", "Blue"]);
    dd.addToPage(page, { x: 72, y: 700, width: 200, height: 24 });
    const tf = form.createTextField("NotesField");
    tf.enableMultiline();
    tf.addToPage(page, { x: 72, y: 650, width: 200, height: 48 });
    const bytes = await doc.save();

    const reloaded = await PDFDocument.load(bytes);
    const reForm = reloaded.getForm();
    const fields = reForm.getFields();
    const kinds = fields.map((f) => f.constructor.name);
    expect(kinds).toContain("PDFDropdown");
    expect(kinds).toContain("PDFTextField");

    const dropdown = reForm.getDropdown("ChoiceField");
    expect(dropdown.getOptions()).toEqual(["Red", "Green", "Blue"]);
    dropdown.select("Green");
    expect(() => reForm.getTextField("ChoiceField")).toThrow();

    const textField = reForm.getTextField("NotesField");
    expect(textField.isMultiline()).toBe(true);

    const saved = await reloaded.save();
    const final = await PDFDocument.load(saved);
    expect(final.getForm().getDropdown("ChoiceField").getSelected()).toEqual(["Green"]);
  });

  it("checkbox and radio groups keep their existing APIs", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const cb = form.createCheckBox("AgreeField");
    cb.addToPage(page, { x: 72, y: 700, width: 16, height: 16 });
    const rg = form.createRadioGroup("PickField");
    rg.addOptionToPage("A", page, { x: 72, y: 650, width: 16, height: 16 });
    rg.addOptionToPage("B", page, { x: 100, y: 650, width: 16, height: 16 });
    const bytes = await doc.save();
    const reloaded = await PDFDocument.load(bytes);
    const reForm = reloaded.getForm();
    reForm.getCheckBox("AgreeField").check();
    reForm.getRadioGroup("PickField").select("B");
    const saved = await reloaded.save();
    const final = await PDFDocument.load(saved);
    expect(final.getForm().getCheckBox("AgreeField").isChecked()).toBe(true);
    expect(final.getForm().getRadioGroup("PickField").getSelected()).toBe("B");
  });
});
