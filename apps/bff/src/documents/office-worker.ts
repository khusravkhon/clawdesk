import { parentPort } from "node:worker_threads";
import { docxText, DocumentEncryptedError, DocumentUnreadableError, pptxText, xlsxText } from "./ooxml.js";

export type OfficeInput = { bytes: Uint8Array; format: "docx" | "xlsx" | "pptx"; maxChars: number };
export type OfficeResult =
  | { state: "read"; text: string; truncated: boolean; sheets?: number; slides?: number }
  | { state: "encrypted" | "unreadable" };

function readOffice({ bytes, format, maxChars }: OfficeInput): OfficeResult {
  try {
    const parsed = format === "docx" ? docxText(bytes) : format === "xlsx" ? xlsxText(bytes) : pptxText(bytes);
    return {
      state: "read", text: parsed.text.slice(0, maxChars), truncated: parsed.text.length > maxChars,
      ...("sheets" in parsed ? { sheets: parsed.sheets.length } : {}),
      ...("slides" in parsed ? { slides: parsed.slides } : {}),
    };
  } catch (error) {
    if (error instanceof DocumentEncryptedError) return { state: "encrypted" };
    if (error instanceof DocumentUnreadableError) return { state: "unreadable" };
    throw error;
  }
}

parentPort!.on("message", (input: OfficeInput) => parentPort!.postMessage(readOffice(input)));
