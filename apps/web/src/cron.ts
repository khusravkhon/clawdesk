// The schedule shapes the panel edits: "M H * * DOW" — a time of day and a set of weekdays.
// Weekdays follow cron: 0 = Sunday … 6 = Saturday. The UI lists them Monday first.

export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAYS = [1, 2, 3, 4, 5];

export type SimpleSchedule = { hour: number; minute: number; days: number[] };

export function parseCron(expr: string | null): SimpleSchedule | null {
  const m = expr?.match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6](?:,[0-6])*)$/);
  if (!m) return null;
  if (Number(m[1]) > 59 || Number(m[2]) > 23) return null;
  const days = m[3] === "*" ? [] : [...new Set(m[3]!.split(",").map(Number))].sort();
  return { minute: Number(m[1]), hour: Number(m[2]), days: days.length === 7 ? [] : days };
}

/** Empty `days` means every day. */
export function toCron(s: SimpleSchedule): string {
  const days = [...new Set(s.days)].sort();
  return `${s.minute} ${s.hour} * * ${days.length === 0 || days.length === 7 ? "*" : days.join(",")}`;
}

export function cronFromTime(time: string | null, days: string): string | null {
  const match = time?.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const parsed = parseCron(`${Number(match[2])} ${Number(match[1])} * * ${days}`);
  return parsed ? toCron(parsed) : null;
}

type Translate = (key: string, values?: Record<string, unknown>) => string;

export function describeSchedule(t: Translate, expr: string | null, everyMs: number | null, locale: string): string {
  const s = parseCron(expr);
  if (!s) {
    if (everyMs) return t("schedules.every", { n: Math.round(everyMs / 60_000) });
    return expr ?? "—";
  }
  const time = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
  if (!s.days.length) return t("schedules.daily", { time });
  if (s.days.join(",") === WEEKDAYS.join(",")) return t("schedules.weekdays", { time });
  const names = WEEK_ORDER.filter((d) => s.days.includes(d)).map((d) => weekdayShort(d, locale));
  return t("schedules.onDays", { days: names.join(", "), time });
}

/** Short weekday name; 2024-01-07 was a Sunday. */
export function weekdayShort(day: number, locale: string): string {
  const tags = locale === "tg" ? ["tg", "ru"] : [locale];
  const name = new Intl.DateTimeFormat(tags, { weekday: "short", timeZone: "UTC" }).format(Date.UTC(2024, 0, 7 + day));
  return name.charAt(0).toLocaleUpperCase(tags[0]) + name.slice(1);
}
