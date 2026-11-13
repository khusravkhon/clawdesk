import { describe, expect, it } from "vitest";
import { checkAttachment, rejectedAttachment, toBase64 } from "../src/chat-attachments";

const limits = { maxFiles: 2, maxFileBytes: 1000, maxImageBytes: 500, maxTotalBytes: 1200 };

describe("chat attachments", () => {
  it("accepts a supported file that fits", () => {
    expect(checkAttachment({ size: 400, type: "application/pdf" }, [], limits)).toEqual({ ok: true, mimeType: "application/pdf" });
  });

  it("refuses an unknown type but lets the next file through", () => {
    expect(checkAttachment({ size: 1, type: "application/x-msdownload" }, [], limits)).toEqual({ ok: false, problem: { key: "unsupported" }, stop: false });
  });

  it("holds images to their own, smaller limit", () => {
    expect(checkAttachment({ size: 600, type: "image/png" }, [], limits)).toEqual({ ok: false, problem: { key: "tooLarge", limit: 500 }, stop: false });
    expect(checkAttachment({ size: 600, type: "application/pdf" }, [], limits).ok).toBe(true);
  });

  it("stops at the file count and at the total size", () => {
    expect(checkAttachment({ size: 1, type: "application/pdf" }, [{ sizeBytes: 1 }, { sizeBytes: 1 }], limits)).toEqual({ ok: false, problem: { key: "tooMany", count: 2 }, stop: true });
    expect(checkAttachment({ size: 900, type: "application/pdf" }, [{ sizeBytes: 400 }], limits)).toEqual({ ok: false, problem: { key: "tooMuch", limit: 1200 }, stop: true });
  });

  it("before the limits are known checks the type only", () => {
    expect(checkAttachment({ size: 10 ** 9, type: "application/pdf" }, [], null).ok).toBe(true);
  });

  it("maps the server's reason codes", () => {
    expect(rejectedAttachment({ code: "image_too_large", limit: 5 })).toEqual({ key: "tooLarge", limit: 5 });
    expect(rejectedAttachment({ code: "too_many_files", limit: 4 })).toEqual({ key: "tooMany", count: 4 });
    expect(rejectedAttachment({ code: "something_new" })).toEqual({ key: "rejected" });
    expect(rejectedAttachment(undefined)).toBeNull();
  });

  it("encodes large files without overflowing the argument list", async () => {
    const data = new Uint8Array(100_000).map((_, i) => i % 256);
    const encoded = await toBase64(new Blob([data]));
    expect(Buffer.from(encoded, "base64").equals(Buffer.from(data))).toBe(true);
  });
});
