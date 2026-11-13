import type { Locale } from "@clawdesk/shared";
import { createI18n } from "vue-i18n";

const STORAGE_KEY = "clawdesk.locale";
const SUPPORTED: Locale[] = ["ru", "en", "tg"];

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (SUPPORTED as string[]).includes(saved)) return saved as Locale;
  } catch {
    // storage unavailable (private mode); fall through to browser language
  }
  const browser = navigator.language.slice(0, 2);
  return (SUPPORTED as string[]).includes(browser) ? (browser as Locale) : "ru";
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale(),
  // Every language has the same keys (checked), so no fallback is needed and none is loaded.
  fallbackLocale: false,
  messages: {},
});

// One language per file, fetched when chosen: the first load carries one language instead of three.
const LOADERS: Record<Locale, () => Promise<{ default: Record<string, unknown> }>> = {
  ru: () => import("./locales/ru.json"),
  en: () => import("./locales/en.json"),
  tg: () => import("./locales/tg.json"),
};

async function loadMessages(locale: Locale): Promise<void> {
  if (i18n.global.availableLocales.includes(locale)) return;
  const messages = await LOADERS[locale]();
  i18n.global.setLocaleMessage(locale, messages.default as never);
}

/** Resolves once the starting language is loaded; main.ts waits for it before the first screen. */
export const i18nReady: Promise<void> = loadMessages(i18n.global.locale.value as Locale).then(() => {
  document.documentElement.lang = i18n.global.locale.value;
});

export async function setLocale(locale: Locale): Promise<void> {
  try {
    await loadMessages(locale);
  } catch {
    return; // the file did not arrive (connection lost): stay on the current language
  }
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // ignore
  }
}

export const supportedLocales = SUPPORTED;
