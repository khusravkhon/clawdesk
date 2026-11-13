import { describe, expect, it } from "vitest";
import { cronFromTime, describeSchedule, parseCron, toCron } from "../src/cron";

const t = (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}`;

describe("cron", () => {
  it("reads the shape the panel edits and refuses anything else", () => {
    expect(parseCron("30 8 * * 1,2,3")).toEqual({ minute: 30, hour: 8, days: [1, 2, 3] });
    expect(parseCron("0 9 * * *")).toEqual({ minute: 0, hour: 9, days: [] });
    expect(parseCron("0 9 * * 0,1,2,3,4,5,6")?.days).toEqual([]);
    expect(parseCron("0 24 * * *")).toBeNull();
    expect(parseCron("60 1 * * *")).toBeNull();
    expect(parseCron("*/5 * * * *")).toBeNull();
    expect(parseCron(null)).toBeNull();
  });

  it("writes days sorted and without repeats; all seven days are every day", () => {
    expect(toCron({ minute: 5, hour: 7, days: [3, 1, 3] })).toBe("5 7 * * 1,3");
    expect(toCron({ minute: 5, hour: 7, days: [0, 1, 2, 3, 4, 5, 6] })).toBe("5 7 * * *");
    for (const expr of ["0 9 * * *", "15 18 * * 0,6"]) expect(toCron(parseCron(expr)!)).toBe(expr);
  });

  it("turns a time field into cron, refusing bad times", () => {
    expect(cronFromTime("08:05", "1,2,3,4,5")).toBe("5 8 * * 1,2,3,4,5");
    expect(cronFromTime("24:00", "*")).toBeNull();
    expect(cronFromTime("8:05", "*")).toBeNull();
    expect(cronFromTime(null, "*")).toBeNull();
  });

  it("describes daily, weekday and interval schedules", () => {
    expect(describeSchedule(t, "0 9 * * *", null, "en")).toBe('schedules.daily{"time":"09:00"}');
    expect(describeSchedule(t, "30 7 * * 1,2,3,4,5", null, "en")).toBe('schedules.weekdays{"time":"07:30"}');
    expect(describeSchedule(t, null, 1_800_000, "en")).toBe('schedules.every{"n":30}');
    expect(describeSchedule(t, "0 0 1 * *", null, "en")).toBe("0 0 1 * *");
  });
});
