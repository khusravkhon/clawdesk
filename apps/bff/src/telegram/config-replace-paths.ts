function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Exact array paths intentionally replaced or removed by a Telegram merge patch. */
export function telegramReplacePaths(current: unknown, patch: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  const collect = (value: unknown, path: string): void => {
    if (Array.isArray(value)) paths.add(path);
    else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) collect(child, `${path}.${key}`);
    }
  };
  const visit = (before: unknown, next: unknown, path: string): void => {
    if (Array.isArray(next)) {
      paths.add(path);
      return;
    }
    if (!isRecord(next)) {
      collect(before, path);
      return;
    }
    if (Array.isArray(before)) paths.add(path);
    for (const [key, value] of Object.entries(next)) {
      visit(isRecord(before) && Object.hasOwn(before, key) ? before[key] : undefined, value, path ? `${path}.${key}` : key);
    }
  };
  visit(current, patch, "");
  return [...paths];
}
