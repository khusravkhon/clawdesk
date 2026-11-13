import { describe, expect, it } from "vitest";
import en from "../src/locales/en.json";
import ru from "../src/locales/ru.json";
import tg from "../src/locales/tg.json";

// Languages load one at a time and nothing falls back to another one, so every key must exist in all three.
const keys = (tree: object, prefix = ""): string[] =>
  Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`]));

describe("translations", () => {
  it("ru, en and tg have exactly the same keys", () => {
    const base = keys(ru).sort();
    expect(keys(en).sort()).toEqual(base);
    expect(keys(tg).sort()).toEqual(base);
  });

  it("a text left empty on purpose is empty in every language", () => {
    const value = (tree: object, key: string) => key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
    const emptyIn = (tree: object) => keys(tree).filter((key) => value(tree, key) === "");
    expect(emptyIn(en)).toEqual(emptyIn(ru));
    expect(emptyIn(tg)).toEqual(emptyIn(ru));
  });
});
