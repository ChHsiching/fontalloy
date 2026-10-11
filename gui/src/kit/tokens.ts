/**
 * FontAlloy kit — design tokens (Stage 1 of the design-fidelity repair).
 *
 * Every value here is EXTRACTED FROM THE VALIDATED PROTOTYPE
 * (gui/prototype/index.html, accepted by the owner 2026-10). The prototype
 * is the design contract; this module is its typed form. Do not invent
 * values — change them only with a new owner decision.
 *
 * The names deliberately follow the prototype's token vocabulary so a
 * side-by-side comparison maps one-to-one:
 * page/sf/sf2 surfaces, ink text tiers, ln borders, ac accent, dgr danger.
 */

/** One app palette — "teal on iron" in the dark case, off-white + teal in the light case. */
export interface AppPalette {
  /** Page (window) background. */
  page: string;
  /** Card / control surface. */
  sf: string;
  /** Recessed surface (hover fills, header fills, segment trays). */
  sf2: string;
  /** Primary text. */
  ink: string;
  /** Secondary text. */
  ink2: string;
  /** Tertiary text (hints, metadata). */
  ink3: string;
  /** Hairline border. */
  ln: string;
  /** Strong border. */
  ln2: string;
  /** De-emphasized glyph color (chevrons painted in SVG). */
  fb: string;
  /** Accent (teal: #0f766e light / #4ade9e dark). */
  ac: string;
  /** Accent hover mate. */
  acs: string;
  /** Accent tint fill (soft backgrounds). */
  acsoft: string;
  /** Text on accent. */
  acink: string;
  /** Danger (missing glyphs, destructive hover). */
  dgr: string;
  /** Danger tint fill. */
  dgrsoft: string;
  /** Elevation shadows, three steps. */
  sh1: string;
  sh2: string;
  sh3: string;
}

/** The validated LIGHT theme: off-white page, white cards, teal #0f766e. */
export const LIGHT_PALETTE: AppPalette = {
  page: "#f7f8fa",
  sf: "#ffffff",
  sf2: "#eef0f3",
  ink: "#131720",
  ink2: "#4a5262",
  ink3: "#5f6878",
  ln: "#dfe3e8",
  ln2: "#c0c7d0",
  fb: "#7a8290",
  ac: "#0f766e",
  acs: "#0d5f58",
  acsoft: "#e6f5f3",
  acink: "#ffffff",
  dgr: "#c53030",
  dgrsoft: "#fef0f0",
  sh1: "0 1px 2px rgba(16,20,26,.04)",
  sh2: "0 4px 14px rgba(16,20,26,.08)",
  sh3: "0 20px 50px rgba(16,20,26,.16)",
};

/** The validated DARK theme — the "teal on iron" signature: #0b0d0f / #14171a + #4ade9e. */
export const DARK_PALETTE: AppPalette = {
  page: "#0b0d0f",
  sf: "#14171a",
  sf2: "#1b1f23",
  ink: "#e4e8ec",
  ink2: "#9aa4b0",
  ink3: "#737f8c",
  ln: "#24282e",
  ln2: "#3e454e",
  fb: "#4a5460",
  ac: "#4ade9e",
  acs: "#34d399",
  acsoft: "#0c2822",
  acink: "#0b0d0f",
  dgr: "#f87171",
  dgrsoft: "#2a1414",
  sh1: "0 1px 2px rgba(0,0,0,.4)",
  sh2: "0 4px 16px rgba(0,0,0,.35)",
  sh3: "0 24px 60px rgba(0,0,0,.65)",
};

export const PALETTES = { light: LIGHT_PALETTE, dark: DARK_PALETTE } as const;

/** App theme names. The prototype ships BOTH; the kit always does. */
export type AppTheme = "light" | "dark";

/** Corner radii scale (px), as used across the prototype chrome. */
export const RADIUS = {
  /** App window. */
  window: 14,
  /** Cards, pickers, popovers, floating bars. */
  card: 12,
  /** Card header rounding (pairs with the card value). */
  cardHead: 11,
  /** Terminal / code wells, dropdown palettes. */
  well: 9,
  /** Inputs, cells, list rows, search fields. */
  field: 8,
  /** Buttons, chips, modebar inputs. */
  button: 7,
  /** Small buttons, rule rows, zoom buttons. */
  small: 6,
  /** Sub-chips, tags, pager buttons. */
  chip: 5,
} as const;

/**
 * Typography scale (px). Base is 13px system UI; CJK copy ships in the
 * same stack ("Microsoft YaHei" on Windows hosts).
 */
export const FONT = {
  stack: 'system-ui,"Segoe UI","Microsoft YaHei",sans-serif',
  monoBase: "Consolas,ui-monospace,monospace",
  monoCjk: "'Microsoft YaHei',sans-serif",
  /** Numbers that must align in columns — statusbar, counts, codepoints. */
  numeric: "tabular-nums",
  sizes: {
    display: 15,
    pickerName: 13.5,
    body: 13,
    emphasized: 12.5,
    control: 12,
    caption: 11.5,
    label: 11,
    micro: 10,
  },
} as const;

/** Motion curves — Apple-style critically damped springs (prototype r30). */
export const MOTION = {
  spring: "cubic-bezier(.25,.1,.25,1)",
  springOut: "cubic-bezier(.22,1,.36,1)",
} as const;

/** Page size of the character grid — uniform 1024 cells per page. */
export const GRID_PAGE_SIZE = 1024;

/* ------------------------------------------------------------------ */
/* Scene themes — carried 1:1 from the prototype's theme system.       */
/* ------------------------------------------------------------------ */

/**
 * One terminal palette. Keyed by the CSS custom properties the terminal
 * chrome consumes (tokens.css declares them per data-t):
 * tb background, tw text, tp prompt, tc cyan, td dim, ty yellow,
 * th purple, tr red.
 */
export interface TerminalThemeVars {
  "--tb": string;
  "--tw": string;
  "--tp": string;
  "--tc": string;
  "--td": string;
  "--ty": string;
  "--th": string;
  "--tr": string;
}

export interface SceneTheme {
  /** Value stored on the card; "" means follow the app theme. */
  id: string;
  /** UI label, Chinese verbatim from the prototype. */
  label: string;
  /** Palette for the app-theme=light case ("" themes only). */
  light?: TerminalThemeVars;
  /** Palette for the app-theme=dark case ("" themes only). */
  dark?: TerminalThemeVars;
  /** Palette for a locked theme (non-"" ids). */
  vars?: TerminalThemeVars;
}

/** 跟随主题 + the 13 named terminal themes — 14 options in total. */
export const TERMINAL_THEMES: readonly SceneTheme[] = [
  {
    id: "",
    label: "跟随主题",
    light: {
      "--tb": "#f6f8fa", "--tw": "#1f2328", "--tp": "#1a7f37", "--tc": "#0550ae",
      "--td": "#59636e", "--ty": "#9a6700", "--th": "#8250df", "--tr": "#cf222e",
    },
    dark: {
      "--tb": "#0d1117", "--tw": "#e6edf3", "--tp": "#7ee787", "--tc": "#79c0ff",
      "--td": "#8b949e", "--ty": "#e3b341", "--th": "#d2a8ff", "--tr": "#ffa198",
    },
  },
  {
    id: "github-light",
    label: "GitHub Light",
    vars: {
      "--tb": "#f6f8fa", "--tw": "#1f2328", "--tp": "#1a7f37", "--tc": "#0550ae",
      "--td": "#59636e", "--ty": "#9a6700", "--th": "#8250df", "--tr": "#cf222e",
    },
  },
  {
    id: "github-dark",
    label: "GitHub Dark",
    vars: {
      "--tb": "#0d1117", "--tw": "#e6edf3", "--tp": "#7ee787", "--tc": "#79c0ff",
      "--td": "#8b949e", "--ty": "#e3b341", "--th": "#d2a8ff", "--tr": "#ffa198",
    },
  },
  {
    id: "one-light",
    label: "One Light",
    vars: {
      "--tb": "#fafafa", "--tw": "#383a42", "--tp": "#50a14f", "--tc": "#4078f2",
      "--td": "#a0a1a7", "--ty": "#c18401", "--th": "#a626a4", "--tr": "#e45649",
    },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    vars: {
      "--tb": "#fdf6e3", "--tw": "#586e75", "--tp": "#859900", "--tc": "#268bd2",
      "--td": "#93a1a1", "--ty": "#b58900", "--th": "#6c71c4", "--tr": "#dc322f",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    vars: {
      "--tb": "#282a36", "--tw": "#f8f8f2", "--tp": "#50fa7b", "--tc": "#8be9fd",
      "--td": "#6272a4", "--ty": "#f1fa8c", "--th": "#ff79c6", "--tr": "#ff5555",
    },
  },
  {
    id: "tokyonight",
    label: "Tokyo Night",
    vars: {
      "--tb": "#1a1b26", "--tw": "#c0caf5", "--tp": "#9ece6a", "--tc": "#7dcfff",
      "--td": "#565f89", "--ty": "#e0af68", "--th": "#bb9af7", "--tr": "#f7768e",
    },
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    vars: {
      "--tb": "#282828", "--tw": "#ebdbb2", "--tp": "#b8bb26", "--tc": "#83a598",
      "--td": "#928374", "--ty": "#fabd2f", "--th": "#d3869b", "--tr": "#fb4934",
    },
  },
  {
    id: "nord",
    label: "Nord",
    vars: {
      "--tb": "#2e3440", "--tw": "#eceff4", "--tp": "#a3be8c", "--tc": "#88c0d0",
      "--td": "#616e88", "--ty": "#ebcb8b", "--th": "#b48ead", "--tr": "#bf616a",
    },
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    vars: {
      "--tb": "#1e1e2e", "--tw": "#cdd6f4", "--tp": "#a6e3a1", "--tc": "#89dceb",
      "--td": "#6c7086", "--ty": "#f9e2af", "--th": "#f5c2e7", "--tr": "#f38ba8",
    },
  },
  {
    id: "onedark",
    label: "One Dark",
    vars: {
      "--tb": "#282c34", "--tw": "#abb2bf", "--tp": "#98c379", "--tc": "#61afef",
      "--td": "#5c6370", "--ty": "#e5c07b", "--th": "#c678dd", "--tr": "#e06c75",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    vars: {
      "--tb": "#002b36", "--tw": "#93a1a1", "--tp": "#859900", "--tc": "#2aa198",
      "--td": "#586e75", "--ty": "#b58900", "--th": "#6c71c4", "--tr": "#dc322f",
    },
  },
  {
    id: "everforest",
    label: "Everforest",
    vars: {
      "--tb": "#2d353b", "--tw": "#d3c6aa", "--tp": "#83c092", "--tc": "#7fbbb3",
      "--td": "#859289", "--ty": "#dbbc7f", "--th": "#d699b6", "--tr": "#e67e80",
    },
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    vars: {
      "--tb": "#191724", "--tw": "#e0def4", "--tp": "#31748f", "--tc": "#9ccfd8",
      "--td": "#6e6a86", "--ty": "#ebbcba", "--th": "#c4a7e7", "--tr": "#eb6f92",
    },
  },
];

/**
 * One editor (code) theme: background + syntax token colors.
 * Locked themes set their own text color (#c9d1d9 family in the
 * prototype); the follow-theme case inherits the app palette.
 */
export interface EditorTheme {
  id: string;
  label: string;
  /** Locked-theme background. */
  bg?: string;
  /** Locked-theme base text. */
  text?: string;
  k: string;
  s: string;
  n: string;
  t: string;
  cm: string;
}

/** 跟随主题 + the 9 named editor themes — 10 options in total. */
export const EDITOR_THEMES: readonly EditorTheme[] = [
  // Follow-theme: token colors come from the app palette (tokens.css
  // .kit-code rules); light/dark values carried from the prototype base.
  { id: "", label: "跟随主题", k: "#7c3aad", s: "#3f7433", n: "#92510a", t: "#1e5a8a", cm: "" },
  { id: "vs-dark", label: "VS Dark", bg: "#1e1e1e", text: "#c9d1d9", k: "#c586c0", s: "#ce9178", n: "#b5cea8", t: "#4ec9b0", cm: "#6a9955" },
  { id: "monokai", label: "Monokai", bg: "#272822", text: "#c9d1d9", k: "#f92672", s: "#e6db74", n: "#ae81ff", t: "#66d9ef", cm: "#75715e" },
  { id: "nord", label: "Nord", bg: "#2e3440", text: "#c9d1d9", k: "#81a1c1", s: "#a3be8c", n: "#b48ead", t: "#88c0d0", cm: "#616e88" },
  { id: "dracula", label: "Dracula", bg: "#282a36", text: "#c9d1d9", k: "#ff79c6", s: "#f1fa8c", n: "#bd93f9", t: "#8be9fd", cm: "#6272a4" },
  { id: "tokyonight", label: "Tokyo Night", bg: "#1a1b26", text: "#c9d1d9", k: "#bb9af7", s: "#9ece6a", n: "#ff9e64", t: "#7aa2f7", cm: "#565f89" },
  { id: "gruvbox", label: "Gruvbox", bg: "#282828", text: "#c9d1d9", k: "#fb4934", s: "#b8bb26", n: "#d3869b", t: "#83a598", cm: "#928374" },
  { id: "catppuccin", label: "Catppuccin", bg: "#1e1e2e", text: "#c9d1d9", k: "#cba6f7", s: "#a6e3a1", n: "#fab387", t: "#89b4fa", cm: "#6c7086" },
  { id: "onedark", label: "One Dark", bg: "#282c34", text: "#c9d1d9", k: "#c678dd", s: "#98c379", n: "#d19a66", t: "#61afef", cm: "#5c6370" },
  { id: "solarized-dark", label: "Solarized", bg: "#002b36", text: "#c9d1d9", k: "#859900", s: "#2aa198", n: "#d33682", t: "#268bd2", cm: "#586e75" },
];
