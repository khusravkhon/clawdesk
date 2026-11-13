import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ownSkillMd, parseSkillMd, readSkillArchive, slugify, type SkillArchiveError, zipSkillMd } from "../src/skills/skill-archive.js";

describe("skill archives", () => {
  it("makes folder names from Russian and Tajik names", () => {
    expect(slugify("Отчёт по расходам")).toBe("otchyot-po-raskhodam");
    expect(slugify("Ҳисоботи ҳафтаина")).toBe("hisoboti-haftaina");
    expect(slugify("Budget v2!")).toBe("budget-v2");
    expect(slugify("!!!")).toBe("skill");
    expect(slugify("а".repeat(100)).length).toBeLessThanOrEqual(48);
  });

  it("writes a SKILL.md OpenClaw reads", () => {
    const md = ownSkillMd({ slug: "otchyot", name: "Отчёт", description: 'Сводка "за неделю"\nпо пятницам', instructions: "1. Собери траты.\n2. Пришли итог." });
    expect(parseSkillMd(md)).toEqual({ name: "otchyot", description: 'Сводка "за неделю" по пятницам', body: "# Отчёт\n\n1. Собери траты.\n2. Пришли итог." });
    expect(Object.keys(unzipSync(zipSkillMd(md)))).toEqual(["SKILL.md"]);
  });

  it("reads SKILL.md at the root or inside the only folder of an upload", () => {
    const md = strToU8("---\nname: budget\ndescription: 'Tracks spend'\n---\nDo it.");
    expect(readSkillArchive(zipSync({ "SKILL.md": md }))).toMatchObject({ name: "budget", description: "Tracks spend" });
    expect(readSkillArchive(zipSync({ "budget/SKILL.md": md, "budget/scripts/run.sh": strToU8("echo") }))).toMatchObject({ name: "budget" });
  });

  it("refuses archives without SKILL.md, broken files and zip bombs", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as SkillArchiveError).code;
      }
      return null;
    };
    expect(code(() => readSkillArchive(zipSync({ "README.md": strToU8("x") })))).toBe("no_skill_md");
    expect(code(() => readSkillArchive(zipSync({ "a/SKILL.md": strToU8("x"), "b/x": strToU8("y") })))).toBe("no_skill_md");
    expect(code(() => readSkillArchive(strToU8("not a zip")))).toBe("bad_archive");
    expect(code(() => readSkillArchive(zipSync({ "SKILL.md": new Uint8Array(21 * 1024 * 1024) })))).toBe("archive_too_large");
  });
});
