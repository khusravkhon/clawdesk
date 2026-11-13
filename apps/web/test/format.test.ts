import { describe, expect, it } from "vitest";
import { formatBytes, formatCost, formatRelative, intlLocale } from "../src/format";

describe("format", () => {
  it("Tajik falls back to Russian number data", () => {
    expect(intlLocale("tg")).toEqual(["tg", "ru"]);
    expect(intlLocale("en")).toEqual(["en"]);
  });

  it("shows tiny costs as under a cent instead of $0.00", () => {
    expect(formatCost(0.004, "en")).toBe("< $0.01");
    expect(formatCost(0, "en")).toBe("$0.00");
    expect(formatCost(12.5, "en")).toBe("$12.50");
  });

  it("picks the unit for sizes", () => {
    expect(formatBytes(512, "en")).toMatch(/^512 ?byte/);
    expect(formatBytes(1536, "en")).toBe("1.5 kB");
    expect(formatBytes(5 * 1024 ** 3, "en")).toBe("5 GB");
  });

  it("says how long ago in the right unit", () => {
    const now = Date.UTC(2026, 10, 13, 12);
    expect(formatRelative(now - 30_000, "en", now)).toBe("30 seconds ago");
    expect(formatRelative(now - 5 * 60_000, "en", now)).toBe("5 minutes ago");
    expect(formatRelative(now + 2 * 3_600_000, "en", now)).toBe("in 2 hours");
    expect(formatRelative(now - 86_400_000, "en", now)).toBe("yesterday");
  });
});
