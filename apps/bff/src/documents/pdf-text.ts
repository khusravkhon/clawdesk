import { DocumentEncryptedError, DocumentUnreadableError } from "./ooxml.js";

// PDF text with page numbers, so an answer can say which page it came from. Scripting and system
// fonts stay off: a PDF is read as data here, never run. A scan has no text layer, which is
// reported as such instead of being passed off as an empty document.

/** Pages read from one PDF; a longer document is read up to here and reported as partial. */
export const MAX_PDF_PAGES = 100;

type PdfModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Promise<PdfModule> | null = null;
/** pdfjs is large; it is loaded the first time a PDF arrives, not at panel startup. */
const load = (): Promise<PdfModule> => (pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs"));

export type PdfText = { text: string; pages: number; readPages: number };

export async function pdfText(bytes: Uint8Array): Promise<PdfText> {
  const { getDocument, PasswordException } = await load();
  // The data is copied: pdfjs transfers the buffer it is given, and the caller still needs it.
  // 6.x evaluates no scripts of its own; fonts and fetching stay off so nothing is loaded.
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, useWorkerFetch: false, disableFontFace: true });
  let doc: Awaited<typeof task.promise> | null = null;
  try {
    doc = await task.promise;
    const readPages = Math.min(doc.numPages, MAX_PDF_PAGES);
    const pages: string[] = [];
    for (let number = 1; number <= readPages; number++) {
      const page = await doc.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
          .join("")
          .replace(/[ \t]+/g, " ")
          .trim();
        if (text) pages.push(`[стр. ${number}] ${text}`);
      } finally {
        page.cleanup();
      }
    }
    return { text: pages.join("\n\n"), pages: doc.numPages, readPages };
  } catch (error) {
    if (error instanceof PasswordException) throw new DocumentEncryptedError();
    throw new DocumentUnreadableError("the PDF could not be read");
  } finally {
    await task.destroy().catch(() => {});
  }
}
