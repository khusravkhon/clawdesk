// A deliberately small XML scanner for Office parts (word/document.xml and friends).
// It reads elements and text only: no DTDs, no entity declarations, no external references,
// no namespace resolution. A part that declares a DOCTYPE is refused rather than resolved, so a
// crafted .docx cannot make the panel fetch anything or expand an entity bomb.

export type XmlEvent =
  | { kind: "open"; name: string; attrs: string; selfClosing: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

export class XmlRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "XmlRefusedError";
  }
}

const NAMED = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", String.fromCharCode(34)],
  ["apos", "'"],
]);

/** Only the five predefined entities and numeric references; an unknown entity stays literal. */
export function decodeXmlText(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (!body.startsWith("#")) return NAMED.get(body) ?? match;
    const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    // Surrogates and out-of-range code points are dropped, not guessed.
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
    return String.fromCodePoint(code);
  });
}

/** The local name of an element: Office parts are read by local name, never by prefix binding. */
export const localName = (name: string): string => {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
};

/** One attribute of an opening tag by local name, read only where a format needs it. */
export function attribute(attrs: string, attr: string): string | null {
  const pattern = new RegExp("(?:^|\\s)(?:[A-Za-z0-9_.-]+:)?" + attr + "\\s*=\\s*(\"[^\"]*\"|'[^']*')");
  const match = pattern.exec(attrs);
  return match ? decodeXmlText(match[1]!.slice(1, -1)) : null;
}

/**
 * Walks the markup once and hands every element and text run to `onEvent`. Markup the Office
 * formats do not need (comments, processing instructions) is skipped, CDATA is taken as text,
 * and a DOCTYPE is refused.
 */
export function scanXml(xml: string, onEvent: (event: XmlEvent) => void): void {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      const tail = xml.slice(i);
      if (tail) onEvent({ kind: "text", text: decodeXmlText(tail) });
      return;
    }
    if (lt > i) {
      onEvent({ kind: "text", text: decodeXmlText(xml.slice(i, lt)) });
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) return;
      onEvent({ kind: "text", text: xml.slice(lt + 9, end) });
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!DOCTYPE", lt) || xml.startsWith("<!ENTITY", lt)) {
      throw new XmlRefusedError("the document declares a DOCTYPE or an entity");
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end === -1) return;
      i = end + 1;
      continue;
    }
    const gt = xml.indexOf(">", lt + 1);
    if (gt === -1) return;
    const inner = xml.slice(lt + 1, gt);
    if (inner.startsWith("/")) {
      onEvent({ kind: "close", name: inner.slice(1).trim() });
    } else {
      const selfClosing = inner.endsWith("/");
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const space = body.search(/\s/);
      const name = (space === -1 ? body : body.slice(0, space)).trim();
      if (name) onEvent({ kind: "open", name, attrs: space === -1 ? "" : body.slice(space), selfClosing });
    }
    i = gt + 1;
  }
}
