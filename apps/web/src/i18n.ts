import type { Locale } from "@clawdesk/shared";
import { createI18n } from "vue-i18n";
import en from "./locales/en.json";
import ru from "./locales/ru.json";
import tg from "./locales/tg.json";

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
  fallbackLocale: "en",
  messages: { ru, en, tg },
});

export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // ignore
  }
}

export const supportedLocales = SUPPORTED;
