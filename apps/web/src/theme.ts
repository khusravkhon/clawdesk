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
  // The owner's choice (12.11.2026): the dark glass look greets a new browser; light is one click away.
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
  // Glass: surfaces are translucent over the green backdrop; what floats above the page stays solid.
  dark: {
    bg: "#07100b",
    surface: "rgba(255, 255, 255, 0.06)",
    surfaceSolid: "#121b16",
    surface2: "rgba(255, 255, 255, 0.07)",
    surfaceHover: "rgba(255, 255, 255, 0.12)",
    border: "rgba(255, 255, 255, 0.1)",
    text: "#f1f7f3",
    text2: "#a8b8ae",
    muted: "#71837a",
    ink: "#86efac",
    inkHover: "#a7f3c4",
    inkText: "#05140b",
    pillActive: "#86efac",
    pillActiveText: "#05140b",
    pillActiveIcon: "#05140b",
    accent: "#86efac",
    accentHover: "#a7f3c4",
    accentPressed: "#6ee7a0",
    accentBright: "#4ade80",
    accentSoft: "rgba(74, 222, 128, 0.16)",
    grid: "rgba(255, 255, 255, 0.06)",
    axis: "rgba(255, 255, 255, 0.14)",
  },
  light: {
    bg: "#f1f2f4",
    surface: "#ffffff",
    surfaceSolid: "#ffffff",
    surface2: "#f4f5f7",
    surfaceHover: "#eceef1",
    border: "rgba(17, 24, 39, 0.07)",
    text: "#0c0d10",
    text2: "#565b66",
    muted: "#9499a3",
    ink: "#0c0d10",
    inkHover: "#26282e",
    inkText: "#ffffff",
    pillActive: "#ffffff",
    pillActiveText: "#0c0d10",
    pillActiveIcon: "#22c55e",
    accent: "#15803d",
    accentHover: "#166f37",
    accentPressed: "#14602f",
    accentBright: "#22c55e",
    accentSoft: "rgba(34, 197, 94, 0.13)",
    grid: "#eceef1",
    axis: "#d9dce1",
  },
} as const;

export const colors = computed(() => palette[themeMode.value]);

export const naiveTheme = computed(() => (themeMode.value === "dark" ? darkTheme : null));

export const themeOverrides = computed<GlobalThemeOverrides>(() => {
  const c = palette[themeMode.value];
  const focusRing = `0 0 0 3px ${c.accentSoft}`;
  return {
    common: {
      fontFamily: FONT,
      fontSize: "14px",
      borderRadius: "12px",
      borderRadiusSmall: "9px",
      primaryColor: c.accent,
      primaryColorHover: c.accentHover,
      primaryColorPressed: c.accentPressed,
      primaryColorSuppl: c.accentBright,
      bodyColor: c.bg,
      cardColor: c.surface,
      modalColor: c.surfaceSolid,
      popoverColor: c.surfaceSolid,
      tableColor: c.surface,
      inputColor: c.surface2,
      borderColor: c.border,
      dividerColor: c.border,
      textColorBase: c.text,
      textColor1: c.text,
      textColor2: c.text,
      textColor3: c.text2,
      cubicBezierEaseInOut: "cubic-bezier(0.16, 1, 0.3, 1)",
    },
    Card: {
      borderColor: c.border,
      borderRadius: "20px",
      titleFontSizeMedium: "16px",
      titleFontWeight: "600",
      paddingMedium: "20px 22px",
    },
    // Transparent: the page's backdrop (plain in light, green glass in dark) shows through the frame.
    Layout: { color: "transparent", siderColor: "transparent", headerColor: "transparent", siderBorderColor: "transparent" },
    Menu: {
      itemHeight: "40px",
      borderRadius: "12px",
      itemTextColor: c.text2,
      itemIconColor: c.muted,
      itemTextColorHover: c.text,
      itemIconColorHover: c.text,
      itemColorHover: c.surfaceHover,
      itemColorActive: c.pillActive,
      itemColorActiveHover: c.pillActive,
      itemTextColorActive: c.pillActiveText,
      itemTextColorActiveHover: c.pillActiveText,
      itemIconColorActive: c.pillActiveIcon,
      itemIconColorActiveHover: c.pillActiveIcon,
      itemIconColorCollapsed: c.text2,
    },
    // The main action is ink, not the accent: green stays the sign of "alive / on / done".
    Button: {
      fontWeight: "500",
      borderRadiusMedium: "12px",
      borderRadiusSmall: "10px",
      borderRadiusTiny: "8px",
      borderRadiusLarge: "14px",
      colorPrimary: c.ink,
      colorHoverPrimary: c.inkHover,
      colorPressedPrimary: c.ink,
      colorFocusPrimary: c.inkHover,
      colorDisabledPrimary: c.ink,
      textColorPrimary: c.inkText,
      textColorHoverPrimary: c.inkText,
      textColorPressedPrimary: c.inkText,
      textColorFocusPrimary: c.inkText,
      textColorDisabledPrimary: c.inkText,
      borderPrimary: `1px solid ${c.ink}`,
      borderHoverPrimary: `1px solid ${c.inkHover}`,
      borderPressedPrimary: `1px solid ${c.ink}`,
      borderFocusPrimary: `1px solid ${c.inkHover}`,
      borderDisabledPrimary: `1px solid ${c.ink}`,
      rippleColorPrimary: c.accentBright,
    },
    Input: {
      borderRadius: "12px",
      color: c.surface2,
      colorFocus: c.surface,
      border: "1px solid transparent",
      borderHover: `1px solid ${c.border}`,
      borderFocus: `1px solid ${c.accentBright}`,
      boxShadowFocus: focusRing,
      caretColor: c.accentBright,
    },
    InternalSelection: {
      borderRadius: "12px",
      color: c.surface2,
      colorActive: c.surface,
      border: "1px solid transparent",
      borderHover: `1px solid ${c.border}`,
      borderActive: `1px solid ${c.accentBright}`,
      borderFocus: `1px solid ${c.accentBright}`,
      boxShadowActive: focusRing,
      boxShadowFocus: focusRing,
    },
    Switch: { railColorActive: c.accentBright },
    Checkbox: { colorChecked: c.accentBright, borderChecked: `1px solid ${c.accentBright}`, borderFocus: `1px solid ${c.accentBright}`, boxShadowFocus: focusRing, borderRadius: "5px" },
    Radio: { dotColorActive: c.accentBright, boxShadowActive: `inset 0 0 0 1px ${c.accentBright}`, boxShadowFocus: `inset 0 0 0 1px ${c.accentBright}, ${focusRing}`, boxShadowHover: `inset 0 0 0 1px ${c.accentBright}` },
    Slider: { fillColor: c.accentBright, fillColorHover: c.accentBright },
    Progress: { fillColor: c.accentBright },
    Tag: { borderRadius: "999px" },
    Alert: { borderRadius: "16px" },
    Dialog: { borderRadius: "20px" },
    Popover: { borderRadius: "14px" },
    Dropdown: { borderRadius: "14px" },
    Tabs: { tabBorderRadius: "10px" },
    Skeleton: { color: c.surface2, colorEnd: c.surfaceHover },
    List: { color: "transparent", borderColor: c.border },
  };
});
