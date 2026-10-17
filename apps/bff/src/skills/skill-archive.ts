import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

// Own skills travel to OpenClaw as a zip archive with SKILL.md at its root (skills.upload.* +
// skills.install source "upload"). A skill written in the panel is such an archive with one file.
// Pure functions, unit-tested.

const MAX_FILES = 500;
const MAX_UNPACKED_BYTES = 20 * 1024 * 1024;

export class SkillArchiveError extends Error {
  constructor(
    readonly code: "no_skill_md" | "archive_too_large" | "bad_archive" | "bad_skill_md",
    message: string,
  ) {
    super(message);
    this.name = "SkillArchiveError";
  }
}

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", ғ: "gh", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", ӣ: "i", й: "y", к: "k", қ: "q",
  л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ӯ: "u", ф: "f", х: "kh", ҳ: "h", ц: "ts", ч: "ch",
  ҷ: "j", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Folder name for a skill from its human name: latin letters, digits and dashes only. */
export function slugify(name: string): string {
  const latin = [...name.toLowerCase()].map((ch) => CYRILLIC[ch] ?? ch).join("");
  const slug = latin.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return slug || "skill";
}

export type SkillMd = { name: string | null; description: string | null; body: string };

/** Reads the frontmatter fields OpenClaw uses (name, description) and the text below it. */
export function parseSkillMd(text: string): SkillMd {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { name: null, description: null, body: text.trim() };
  const field = (key: string): string | null => {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(match[1]!)?.[1]?.trim();
    if (!line) return null;
    if (line.startsWith('"')) {
      try {
        return String(JSON.parse(line));
      } catch {
        return line.slice(1, -1);
      }
    }
    return line.replace(/^'(.*)'$/, "$1");
  };
  return { name: field("name"), description: field("description"), body: match[2]!.trim() };
}

/** SKILL.md for a skill written in the panel; the title keeps the owner's own name. */
export function ownSkillMd(skill: { slug: string; name: string; description: string; instructions: string }): string {
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  return `---\nname: ${skill.slug}\ndescription: ${JSON.stringify(oneLine(skill.description))}\n---\n\n# ${oneLine(skill.name)}\n\n${skill.instructions.trim()}\n`;
}

export function zipSkillMd(content: string): Buffer {
  return Buffer.from(zipSync({ "SKILL.md": strToU8(content) }, { level: 6 }));
}

/** Checks an uploaded zip has a SKILL.md (at the root or in its only folder) and reads it. */
export function readSkillArchive(zip: Uint8Array): SkillMd {
  let files: Record<string, Uint8Array>;
  let total = 0;
  let count = 0;
  try {
    files = unzipSync(zip, {
      filter: (file) => {
        count += 1;
        total += file.originalSize;
        if (count > MAX_FILES || total > MAX_UNPACKED_BYTES) throw new SkillArchiveError("archive_too_large", "the archive is too large");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof SkillArchiveError) throw error;
    throw new SkillArchiveError("bad_archive", "this is not a zip archive");
  }
  const names = Object.keys(files).filter((n) => !n.endsWith("/") && !n.startsWith("__MACOSX/"));
  const roots = new Set(names.map((n) => (n.includes("/") ? n.slice(0, n.indexOf("/")) : "")));
  const prefix = roots.size === 1 && !roots.has("") ? `${[...roots][0]}/` : "";
  const skillMd = files[`${prefix}SKILL.md`];
  if (!skillMd) throw new SkillArchiveError("no_skill_md", "the archive has no SKILL.md");
  return parseSkillMd(strFromU8(skillMd));
}
