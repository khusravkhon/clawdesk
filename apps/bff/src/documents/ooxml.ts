import { unzipSync } from "fflate";
import { attribute, localName, scanXml, XmlRefusedError } from "./xml-text.js";

// Word, Excel and PowerPoint files are ZIP containers of XML parts. Only the parts that hold
// readable text are unpacked, each under its own size cap, so a small file cannot expand into a
// large one (a "zip bomb"). Nothing is executed and no part is resolved by reference.

/** How much XML one part may expand to before the file counts as too large to read. */
const MAX_PART_BYTES = 24 * 1024 * 1024;
/** Decompressed bytes of all parts of one document together. */
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_SHEETS = 20;
const MAX_SHEET_ROWS = 2000;
const MAX_SLIDES = 200;

export class DocumentUnreadableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DocumentUnreadableError";
  }
}

/** Encrypted Office files are ZIPs with an OLE container inside, or not ZIPs at all. */
export class DocumentEncryptedError extends Error {
  constructor() {
    super("the document is protected with a password");
    this.name = "DocumentEncryptedError";
  }
}

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const isOle = (bytes: Uint8Array) => OLE_SIGNATURE.every((byte, i) => bytes[i] === byte);
const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b;

const decoder = new TextDecoder("utf-8");

/** Unpacks the wanted parts only; `wanted` decides by part name, and each part stays bounded. */
function parts(bytes: Uint8Array, wanted: (name: string) => boolean): Map<string, string> {
  if (isOle(bytes)) throw new DocumentEncryptedError();
  if (!isZip(bytes)) throw new DocumentUnreadableError("not an Office file");
  let budget = MAX_DOCUMENT_BYTES;
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(bytes, {
      filter: (file) => {
        if (!wanted(file.name)) return false;
        if (file.originalSize > MAX_PART_BYTES) throw new DocumentUnreadableError("a part of the document is too large to read");
        budget -= file.originalSize;
        if (budget < 0) throw new DocumentUnreadableError("the document expands to more than this panel reads");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof DocumentUnreadableError || error instanceof DocumentEncryptedError) throw error;
    throw new DocumentUnreadableError("the document could not be unpacked");
  }
  // An OOXML container with an encrypted payload keeps its parts in EncryptedPackage instead.
  if (!Object.keys(unpacked).length && hasEncryptedPackage(bytes)) throw new DocumentEncryptedError();
  return new Map(Object.entries(unpacked).map(([name, data]) => [name, decoder.decode(data)]));
}

function hasEncryptedPackage(bytes: Uint8Array): boolean {
  try {
    return Object.keys(unzipSync(bytes, { filter: (file) => file.name === "EncryptedPackage" })).length > 0;
  } catch {
    return false;
  }
}

const collapse = (text: string) => text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/** Paragraph text of a .docx, in document order; tables read row by row, cells separated by tabs. */
export function docxText(bytes: Uint8Array): { text: string; paragraphs: number } {
  const xml = parts(bytes, (name) => name === "word/document.xml").get("word/document.xml");
  if (xml === undefined) throw new DocumentUnreadableError("the document has no main part");
  const out: string[] = [];
  let line = "";
  let paragraphs = 0;
  scan(xml, (event) => {
    if (event.kind === "text") {
      line += event.text;
      return;
    }
    const name = localName(event.name);
    if (event.kind === "open" && (name === "tab" || name === "br")) line += name === "tab" ? "\t" : "\n";
    if (event.kind === "close" && (name === "p" || name === "tr")) {
      out.push(line);
      line = "";
      paragraphs += 1;
    }
    if (event.kind === "close" && name === "tc") line += "\t";
  });
  if (line.trim()) {
    out.push(line);
    paragraphs += 1;
  }
  return { text: collapse(out.join("\n")), paragraphs };
}

type Sheet = { name: string; rows: string[] };

/** Cells of a .xlsx by sheet, as `A1: value` lines, so an answer can point at the cell it used. */
export function xlsxText(bytes: Uint8Array): { text: string; sheets: { name: string; rows: number }[] } {
  const wanted = (name: string) =>
    name === "xl/workbook.xml" || name === "xl/sharedStrings.xml" || name === "xl/_rels/workbook.xml.rels" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
  const files = parts(bytes, wanted);
  const shared = sharedStrings(files.get("xl/sharedStrings.xml"));
  const names = sheetNames(files.get("xl/workbook.xml"), files.get("xl/_rels/workbook.xml.rels"));
  const sheets: Sheet[] = [];
  const sheetParts = [...files.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort(byTrailingNumber);
  for (const part of sheetParts.slice(0, MAX_SHEETS)) {
    const rows = sheetRows(files.get(part)!, shared);
    sheets.push({ name: names.get(part) ?? part.replace("xl/worksheets/", "").replace(".xml", ""), rows });
  }
  const text = sheets
    .filter((sheet) => sheet.rows.length)
    .map((sheet) => [`## ${sheet.name}`, ...sheet.rows].join("\n"))
    .join("\n\n");
  return { text: collapse(text), sheets: sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.length })) };
}

const byTrailingNumber = (a: string, b: string) => (Number.parseInt(a.replace(/\D+/g, ""), 10) || 0) - (Number.parseInt(b.replace(/\D+/g, ""), 10) || 0);

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  let current: string | null = null;
  scan(xml, (event) => {
    const name = event.kind === "text" ? "" : localName(event.name);
    if (event.kind === "open" && name === "si") current = "";
    else if (event.kind === "close" && name === "si") {
      out.push(current ?? "");
      current = null;
    } else if (event.kind === "text" && current !== null) current += event.text;
  });
  return out;
}

/** Sheet names as the workbook orders them, mapped onto the part each relationship points at. */
function sheetNames(workbook: string | undefined, rels: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!workbook) return out;
  const targets = new Map<string, string>();
  if (rels) {
    scan(rels, (event) => {
      if (event.kind !== "open" || localName(event.name) !== "Relationship") return;
      const id = attribute(event.attrs, "Id");
      const target = attribute(event.attrs, "Target");
      if (id && target) targets.set(id, `xl/${target.replace(/^\/?xl\//, "").replace(/^\.\//, "")}`);
    });
  }
  scan(workbook, (event) => {
    if (event.kind !== "open" || localName(event.name) !== "sheet") return;
    const name = attribute(event.attrs, "name");
    const id = attribute(event.attrs, "id");
    const part = id ? targets.get(id) : null;
    if (name && part) out.set(part, name);
  });
  return out;
}

function sheetRows(xml: string, shared: string[]): string[] {
  const rows: string[] = [];
  let cells: string[] = [];
  let reference: string | null = null;
  let type: string | null = null;
  let value = "";
  let inValue = false;
  scan(xml, (event) => {
    if (event.kind === "text") {
      if (inValue) value += event.text;
      return;
    }
    const name = localName(event.name);
    if (event.kind === "open" && name === "c") {
      reference = attribute(event.attrs, "r");
      type = attribute(event.attrs, "t");
      value = "";
    }
    if (event.kind === "open" && (name === "v" || name === "t")) inValue = true;
    if (event.kind === "close" && (name === "v" || name === "t")) inValue = false;
    if (event.kind === "close" && name === "c") {
      // t="s" means the value is an index into the shared strings table.
      const text = type === "s" ? (shared[Number.parseInt(value, 10)] ?? "") : value;
      if (text.trim() && cells.length < 512) cells.push(`${reference ?? ""}: ${text.trim()}`);
      reference = null;
      type = null;
      value = "";
    }
    if (event.kind === "close" && name === "row") {
      if (cells.length && rows.length < MAX_SHEET_ROWS) rows.push(cells.join(" | "));
      cells = [];
    }
  });
  return rows;
}

/** Slide text of a .pptx, slide by slide, in slide order. */
export function pptxText(bytes: Uint8Array): { text: string; slides: number } {
  const files = parts(bytes, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const slides = [...files.keys()].sort(byTrailingNumber).slice(0, MAX_SLIDES);
  const out: string[] = [];
  slides.forEach((part, index) => {
    const lines: string[] = [];
    let line = "";
    scan(files.get(part)!, (event) => {
      if (event.kind === "text") {
        line += event.text;
        return;
      }
      const name = localName(event.name);
      if (event.kind === "close" && (name === "p" || name === "t")) {
        if (line.trim()) lines.push(line.trim());
        line = "";
      }
    });
    if (line.trim()) lines.push(line.trim());
    if (lines.length) out.push([`## Слайд ${index + 1}`, ...lines].join("\n"));
  });
  return { text: collapse(out.join("\n\n")), slides: slides.length };
}

/** A refused part (DOCTYPE, entity) makes the whole document unreadable, never half-read. */
function scan(xml: string, onEvent: Parameters<typeof scanXml>[1]): void {
  try {
    scanXml(xml, onEvent);
  } catch (error) {
    if (error instanceof XmlRefusedError) throw new DocumentUnreadableError(error.message);
    throw error;
  }
}
