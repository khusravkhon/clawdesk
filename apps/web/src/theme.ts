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
    bg: "#090a0f",
    surface: "#12141e",
    surface2: "#191c2a",
    border: "rgba(255, 255, 255, 0.08)",
    text: "#f4f4f7",
    text2: "#9ea0ab",
    muted: "#676977",
    accent: "#7c70f0",
    accentHover: "#8f85f3",
    accentPressed: "#6a5ee0",
    grid: "#1d202e",
    axis: "#2b2f44",
  },
  light: {
    bg: "#f7f8fa",
    surface: "#ffffff",
    surface2: "#f0f2f5",
    border: "rgba(15, 23, 42, 0.08)",
    text: "#0f172a",
    text2: "#475569",
    muted: "#94a3b8",
    accent: "#5b4fd9",
    accentHover: "#6c61e0",
    accentPressed: "#4b3fc7",
    grid: "#e8ebf0",
    axis: "#d4d8e0",
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
      borderRadius: "14px",
      titleFontSizeMedium: "16px",
      titleFontWeight: "600",
      paddingMedium: "20px 22px",
    },
    Layout: { color: c.bg, siderColor: c.bg, headerColor: c.bg, siderBorderColor: c.border },
    Menu: {
      itemHeight: "38px",
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
    Button: {
      fontWeight: "500",
      borderRadiusMedium: "8px",
      borderRadiusSmall: "6px",
    },
    Tag: {
      borderRadius: "6px",
    },
    List: { color: "transparent", borderColor: c.border },
  };
});
