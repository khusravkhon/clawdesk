import type { LocalizedText } from "@clawdesk/shared";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

/** Picks the current UI language from template texts, falling back to Russian. */
export function useLocalized() {
  const { locale } = useI18n();
  const lang = computed(() => locale.value as keyof LocalizedText);
  return (text: LocalizedText): string => text[lang.value] ?? text.ru;
}
