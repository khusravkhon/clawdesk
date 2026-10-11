import { darkTheme, type GlobalThemeOverrides } from "naive-ui";
import { computed, ref, watchEffect } from "vue";

// One place for the panel's look: Naive UI overrides and chart colors per mode.
// CSS tokens with the same values live in styles.css under [data-theme].

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "clawdesk.theme";

function initialMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // storage blocked: fall through to the default
  }
  return "dark";
}

export const themeMode = ref<ThemeMode>(initialMode());

watchEffect(() => {
  document.documentElement.dataset.theme = themeMode.value;
  try {
    localStorage.setItem(STORAGE_KEY, themeMode.value);
  } catch {
    // not persisted; still applied for this visit
  }
});

export function toggleTheme(): void {
  themeMode.value = themeMode.value === "dark" ? "light" : "dark";
}

const FONT = '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", sans-serif';

const palette = {
  dark: {
    bg: "#0e0e11",
    surface: "#16161a",
    surface2: "#1c1c21",
    border: "rgba(255, 255, 255, 0.07)",
    text: "#ededef",
    text2: "#a0a0ab",
    muted: "#6b6b76",
    accent: "#7c70f0",
    accentHover: "#8f85f3",
    accentPressed: "#6a5ee0",
    grid: "#24242a",
    axis: "#34343c",
  },
  light: {
    bg: "#f6f6f8",
    surface: "#ffffff",
    surface2: "#f1f1f4",
    border: "rgba(15, 15, 20, 0.08)",
    text: "#16161a",
    text2: "#5c5c66",
    muted: "#8a8a94",
    accent: "#5b4fd9",
    accentHover: "#6c61e0",
    accentPressed: "#4b3fc7",
    grid: "#ececf0",
    axis: "#d6d6dc",
  },
} as const;

export const colors = computed(() => palette[themeMode.value]);

export const naiveTheme = computed(() => (themeMode.value === "dark" ? darkTheme : null));

export const themeOverrides = computed<GlobalThemeOverrides>(() => {
  const c = palette[themeMode.value];
  return {
    common: {
      fontFamily: FONT,
      fontSize: "14px",
      borderRadius: "8px",
      borderRadiusSmall: "6px",
      primaryColor: c.accent,
      primaryColorHover: c.accentHover,
      primaryColorPressed: c.accentPressed,
      primaryColorSuppl: c.accent,
      bodyColor: c.bg,
      cardColor: c.surface,
      modalColor: c.surface,
      popoverColor: c.surface2,
      tableColor: c.surface,
      inputColor: c.surface2,
      borderColor: c.border,
      dividerColor: c.border,
      textColorBase: c.text,
      textColor1: c.text,
      textColor2: c.text,
      textColor3: c.text2,
    },
    Card: {
      borderColor: c.border,
      borderRadius: "12px",
      titleFontSizeMedium: "15px",
      titleFontWeight: "600",
      paddingMedium: "18px 20px 20px",
    },
    Layout: { color: c.bg, siderColor: c.bg, headerColor: c.bg, siderBorderColor: c.border },
    Menu: {
      itemHeight: "36px",
      borderRadius: "8px",
      itemTextColor: c.text2,
      itemIconColor: c.muted,
      itemTextColorHover: c.text,
      itemIconColorHover: c.text,
      itemColorHover: c.surface2,
      itemColorActive: c.surface2,
      itemColorActiveHover: c.surface2,
      itemTextColorActive: c.text,
      itemTextColorActiveHover: c.text,
      itemIconColorActive: c.accent,
      itemIconColorActiveHover: c.accent,
      itemIconColorCollapsed: c.text2,
    },
    Button: { fontWeight: "500" },
    List: { color: "transparent", borderColor: c.border },
  };
});
