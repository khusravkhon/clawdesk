/** ISO local minute in an IANA zone, independent of the machine's zone and locale. */
export function zonedMinute(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return part("year") + "-" + part("month") + "-" + part("day") + "T" + part("hour") + ":" + part("minute");
}

/** Choose the first occurrence of a repeated clock minute. A skipped minute has no instant. */
export function wallMinuteToInstant(value: string, timeZone: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const wall = Date.parse(value + ":00Z");
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== value) return null;
  const day = 86_400_000;
  const candidates = [wall - day, wall, wall + day].map((at) => {
    const offset = Date.parse(zonedMinute(at, timeZone) + ":00Z") - at;
    return wall - offset;
  }).filter((at) => zonedMinute(at, timeZone) === value);
  return candidates.length ? Math.min(...candidates) : null;
}

export function nextWeeklyMinute(after: number, timeZone: string, days: readonly number[], clock: string): number {
  const firstDay = Date.parse(zonedMinute(after, timeZone).slice(0, 10) + "T00:00:00Z");
  // A skipped DST date or clock minute may postpone an occurrence by one week.
  for (let offset = 0; offset < 15; offset++) {
    const day = new Date(firstDay + offset * 86_400_000);
    if (!days.includes(day.getUTCDay())) continue;
    const at = wallMinuteToInstant(day.toISOString().slice(0, 10) + "T" + clock, timeZone);
    if (at !== null && at > after) return at;
  }
  throw new Error("cannot calculate next weekly reminder");
}
