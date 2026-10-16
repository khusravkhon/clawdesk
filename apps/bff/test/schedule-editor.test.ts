import { describe, expect, it } from "vitest";
import { CronExpr } from "@clawdesk/shared";
import { cronFromTime, parseCron } from "../../web/src/cron.js";

describe("schedule editor cron", () => {
  it("keeps the exact wall-clock time and selected weekdays", () => {
    expect(cronFromTime("14:47", "1,3,5")).toBe("47 14 * * 1,3,5");
    expect(cronFromTime("00:00", "0")).toBe("0 0 * * 0");
    expect(cronFromTime("23:59", "6,0")).toBe("59 23 * * 0,6");
    expect(cronFromTime("09:00", "*")).toBe("0 9 * * *");
  });

  it("does not turn an empty weekday selection into an everyday job", () => {
    expect(cronFromTime("09:00", "")).toBeNull();
    expect(cronFromTime(null, "1")).toBeNull();
    expect(cronFromTime("24:00", "1")).toBeNull();
    expect(cronFromTime("09:60", "1")).toBeNull();
    expect(parseCron("60 24 * * *")).toBeNull();
  });

  it("produces API-compatible expressions for all repeat presets", () => {
    for (const days of ["*", "1,2,3,4,5", "0,6", "1,3,5", "0", "0,1,2,3,4,5,6"]) {
      expect(CronExpr.safeParse(cronFromTime("06:31", days)).success).toBe(true);
    }
    expect(cronFromTime("06:31", "0,1,2,3,4,5,6")).toBe("31 6 * * *");
  });
});
