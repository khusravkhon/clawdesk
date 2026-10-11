// Number and time formatting for the panel, in the current UI language.

/** Intl tags for UI locales; Tajik falls back to Russian where the browser lacks data. */
export function intlLocale(locale: string): string[] {
  return locale === "tg" ? ["tg", "ru"] : [locale];
}

export function formatCompact(value: number, locale: string): string {
  return new Intl.NumberFormat(intlLocale(locale), { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatCost(value: number, locale: string): string {
  if (value > 0 && value < 0.01) return "< $0.01";
  return new Intl.NumberFormat(intlLocale(locale), { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

export function formatInt(value: number, locale: string): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(value);
}

export function formatRelative(ms: number, locale: string, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" });
  const diff = (ms - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86_400), "day");
}

/** Short day label for chart axes, e.g. "11 окт." */
export function formatDay(date: string, locale: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short", timeZone: "UTC" }).format(Date.UTC(y!, m! - 1, d!));
}
