// The `@layer ravi.pieces` stylesheet: widget pieces, fields and the runtime
// layouts (lists, boards, tables, galleries, menus, dialogs, status lines).
// Colors, fonts, radii and spacing come only from theme variables (MCP Apps
// names and `--ravi-*`, CONTRACT 3.1), each with a fallback equal to the
// default light theme so pieces render before or without a theme (a test
// checks the fallbacks against `defaultCompiledTheme()`). Page CSS outside the
// layer always wins.

const FALLBACKS: Record<string, string> = {
  "--color-background-primary": "#fbfcfd",
  "--color-background-secondary": "#f3f5f8",
  "--color-background-tertiary": "#e8ecf1",
  "--color-background-info": "#dde9fb",
  "--color-background-success": "#dcf3e3",
  "--color-background-warning": "#fdf3c7",
  "--color-background-danger": "#fbdcdc",
  "--color-text-primary": "#17202a",
  "--color-text-secondary": "#5f6f80",
  "--color-text-tertiary": "#627181",
  "--color-text-inverse": "#fbfcfd",
  "--color-text-info": "#1d4f8f",
  "--color-text-success": "#1d6537",
  "--color-text-warning": "#7a4a00",
  "--color-text-danger": "#a1262b",
  "--color-background-inverse": "#17202a",
  "--color-border-primary": "#838f9c",
  "--color-border-secondary": "#dfe4ea",
  "--color-ring-primary": "#14635a",
  "--ravi-color-accent": "#14635a",
  "--ravi-color-on-accent": "#ffffff",
  "--ravi-option-gray-bg": "#eceff3",
  "--ravi-option-gray-text": "#3f4955",
  "--ravi-option-brown-bg": "#efe3d7",
  "--ravi-option-brown-text": "#6b4428",
  "--ravi-option-orange-bg": "#fde7d3",
  "--ravi-option-orange-text": "#8a4210",
  "--ravi-option-yellow-bg": "#fdf3c7",
  "--ravi-option-yellow-text": "#72520a",
  "--ravi-option-green-bg": "#dcf3e3",
  "--ravi-option-green-text": "#1d6537",
  "--ravi-option-blue-bg": "#dde9fb",
  "--ravi-option-blue-text": "#1d4f8f",
  "--ravi-option-purple-bg": "#ebe2fb",
  "--ravi-option-purple-text": "#5b3497",
  "--ravi-option-pink-bg": "#fbe2ef",
  "--ravi-option-pink-text": "#8c2557",
  "--ravi-option-red-bg": "#fbdcdc",
  "--ravi-option-red-text": "#a1262b",
  "--font-sans":
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
  "--font-mono": 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-xs-size": "0.75rem",
  "--font-text-sm-size": "0.875rem",
  "--font-text-md-size": "1rem",
  "--font-text-lg-size": "1.125rem",
  "--font-heading-sm-size": "1rem",
  "--font-heading-md-size": "1.25rem",
  "--font-heading-lg-size": "1.5rem",
  "--font-heading-xl-size": "1.875rem",
  "--border-radius-xs": "2px",
  "--border-radius-sm": "4px",
  "--border-radius-md": "6px",
  "--border-radius-lg": "8px",
  "--border-radius-xl": "12px",
  "--border-radius-full": "9999px",
  "--border-width-regular": "1px",
  "--shadow-sm": "0px 1px 2px 0px #17202a14",
  "--shadow-md": "0px 1px 2px 0px #17202a0f, 0px 4px 8px -2px #17202a1a",
  "--shadow-lg": "0px 4px 6px -2px #17202a0f, 0px 12px 24px -4px #17202a24",
  "--ravi-space-1": "0.25rem",
  "--ravi-space-2": "0.5rem",
  "--ravi-space-3": "0.75rem",
  "--ravi-space-4": "1rem",
  "--ravi-space-5": "1.5rem",
  "--ravi-space-6": "2rem",
  "--ravi-lane-width": "18rem",
  "--ravi-focus-width": "2px",
  "--ravi-touch-target": "24px",
};

/** Fallback of every theme variable the pieces read (exported for tests). */
export const PIECES_CSS_FALLBACKS: Readonly<Record<string, string>> = FALLBACKS;

function v(name: string): string {
  const fallback = FALLBACKS[name];
  if (fallback === undefined) throw new Error(`pieces.css: no fallback for ${name}`);
  return `var(${name}, ${fallback})`;
}

const OPTION_COLOR_NAMES = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
/** Chart series colors, in order: the option text colors with the widest separation first. */
const SERIES_COLORS = ["blue", "orange", "green", "purple", "red", "pink", "yellow", "brown", "gray"] as const;
const TONE_NAMES = ["info", "success", "warning", "danger"] as const;

// Built in a function marked pure so bundles that never read PIECES_CSS (the
// Pages runtime) drop the whole stylesheet.
function buildPiecesCss(): string {
  const border = `${v("--border-width-regular")} solid`;
  const focusRing = `${v("--ravi-focus-width")} solid ${v("--color-ring-primary")}`;
  const target = v("--ravi-touch-target");
  const s = (n: 1 | 2 | 3 | 4 | 5 | 6) => v(`--ravi-space-${n}`);

  const optionRules = OPTION_COLOR_NAMES.map(
    (color) => `  .ravi-option-${color} { background: ${v(`--ravi-option-${color}-bg`)}; color: ${v(`--ravi-option-${color}-text`)}; }`,
  ).join("\n");

  const toneTextRules = [
    `  .ravi-tone-primary { color: ${v("--color-text-primary")}; }`,
    `  .ravi-tone-secondary { color: ${v("--color-text-secondary")}; }`,
    `  .ravi-tone-tertiary { color: ${v("--color-text-tertiary")}; }`,
    ...TONE_NAMES.map((tone) => `  .ravi-tone-${tone} { color: ${v(`--color-text-${tone}`)}; }`),
  ].join("\n");

  // Badges and status steps draw their own surface, so the option colors need
  // a more specific rule after theirs (a plain `.ravi-option-*` loses to them).
  const optionSurfaceRules = [
    ...OPTION_COLOR_NAMES.map(
      (color) =>
        `  .ravi-badge.ravi-option-${color}, .ravi-step.ravi-option-${color} { background: ${v(`--ravi-option-${color}-bg`)}; color: ${v(`--ravi-option-${color}-text`)}; }`,
    ),
    `  ${OPTION_COLOR_NAMES.map((color) => `.ravi-badge.ravi-option-${color}`).join(", ")} { border-color: transparent; }`,
  ].join("\n");

  const toneBadgeRules = TONE_NAMES.map(
    (tone) => `  .ravi-badge.ravi-tone-${tone} { background: ${v(`--color-background-${tone}`)}; color: ${v(`--color-text-${tone}`)}; border-color: transparent; }`,
  ).join("\n");

  return `@layer ravi.pieces {
  ravi-view, ravi-widget, ravi-form { display: block; }
  ravi-chart { display: block; }
  :where(ravi-view, ravi-widget, ravi-form, ravi-chart, .ravi-card, .ravi-dialog, .ravi-menu) {
    font-family: ${v("--font-sans")};
    color: ${v("--color-text-primary")};
    overflow-wrap: anywhere;
  }
  /* A theme text color always comes with its background: in dark mode the
     tags are a dark surface, never light text on the page's own light
     background. Only the tags are painted; page CSS outside the layer wins. */
  :where(ravi-view, ravi-widget, ravi-form, ravi-chart) { background: ${v("--color-background-primary")}; }
  :where(ravi-view, ravi-widget, ravi-form, ravi-chart) *, :where(ravi-view, ravi-widget, ravi-form, ravi-chart) *::before, :where(ravi-view, ravi-widget, ravi-form, ravi-chart) *::after { box-sizing: border-box; }

  /* Visually hidden text: still read by screen readers and text extraction. */
  .ravi-sr-only, .ravi-live {
    position: absolute !important;
    inline-size: 1px;
    block-size: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  /* Focus: visible on every control, in the theme's focus color. */
  :where(ravi-view, ravi-widget, ravi-form, ravi-chart, .ravi-card, .ravi-dialog, .ravi-menu) :focus-visible,
  .ravi-button:focus-visible, .ravi-link:focus-visible, .ravi-input:focus-visible, .ravi-checkbox:focus-visible, .ravi-card:focus-visible {
    outline: ${focusRing};
    outline-offset: 2px;
  }

  /* Card */
  .ravi-card {
    display: flex;
    flex-direction: column;
    gap: ${s(2)};
    min-inline-size: 0;
    padding: ${s(3)};
    background: ${v("--color-background-primary")};
    border: ${border} ${v("--color-border-secondary")};
    border-radius: ${v("--border-radius-lg")};
    box-shadow: ${v("--shadow-sm")};
    font-size: ${v("--font-text-sm-size")};
    line-height: 1.45;
  }
  .ravi-card-subtle { background: ${v("--color-background-secondary")}; box-shadow: none; }
  .ravi-card-outline { background: transparent; box-shadow: none; border-color: ${v("--color-border-primary")}; }
  .ravi-card > .ravi-cover:first-child {
    margin: calc(-1 * ${s(3)}) calc(-1 * ${s(3)}) 0;
    inline-size: calc(100% + 2 * ${s(3)});
    max-inline-size: none;
    border-radius: ${v("--border-radius-lg")} ${v("--border-radius-lg")} 0 0;
  }
  .ravi-card-fields { display: grid; gap: ${s(2)}; }
  .ravi-record { display: contents; }

  /* Layout pieces */
  .ravi-row { display: flex; flex-wrap: nowrap; align-items: center; gap: ${s(2)}; min-inline-size: 0; }
  .ravi-row > * { min-inline-size: 0; }
  .ravi-wrap { flex-wrap: wrap; }
  .ravi-justify-start { justify-content: flex-start; }
  .ravi-justify-center { justify-content: center; }
  .ravi-justify-end { justify-content: flex-end; }
  .ravi-justify-between { justify-content: space-between; }
  .ravi-align-start { align-items: flex-start; }
  .ravi-align-center { align-items: center; }
  .ravi-align-end { align-items: flex-end; }
  .ravi-align-baseline { align-items: baseline; }
  .ravi-stack { display: flex; flex-direction: column; gap: ${s(2)}; min-inline-size: 0; }
  .ravi-grid { display: grid; gap: ${s(3)}; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ravi-cols-1 { grid-template-columns: minmax(0, 1fr); }
  .ravi-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ravi-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .ravi-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .ravi-gap-none { gap: 0; }
  .ravi-gap-xs { gap: ${s(1)}; }
  .ravi-gap-sm { gap: ${s(2)}; }
  .ravi-gap-md { gap: ${s(3)}; }
  .ravi-gap-lg { gap: ${s(5)}; }
  .ravi-divider { inline-size: 100%; margin: ${s(1)} 0; border: 0; border-block-start: ${border} ${v("--color-border-secondary")}; }

  /* Text */
  .ravi-title {
    margin: 0;
    font-size: ${v("--font-heading-sm-size")};
    font-weight: ${v("--font-weight-semibold")};
    line-height: 1.3;
    color: ${v("--color-text-primary")};
  }
  .ravi-title.ravi-size-sm { font-size: ${v("--font-text-md-size")}; }
  .ravi-title.ravi-size-md { font-size: ${v("--font-heading-md-size")}; }
  .ravi-title.ravi-size-lg { font-size: ${v("--font-heading-lg-size")}; }
  .ravi-text { margin: 0; font-size: ${v("--font-text-sm-size")}; line-height: 1.45; }
  .ravi-text.ravi-size-xs { font-size: ${v("--font-text-xs-size")}; }
  .ravi-text.ravi-size-sm { font-size: ${v("--font-text-sm-size")}; }
  .ravi-text.ravi-size-md { font-size: ${v("--font-text-md-size")}; }
  .ravi-text.ravi-size-lg { font-size: ${v("--font-text-lg-size")}; }
  .ravi-weight-normal { font-weight: ${v("--font-weight-normal")}; }
  .ravi-weight-medium { font-weight: ${v("--font-weight-medium")}; }
  .ravi-weight-semibold { font-weight: ${v("--font-weight-semibold")}; }
  .ravi-weight-bold { font-weight: ${v("--font-weight-bold")}; }
  .ravi-lines-1, .ravi-lines-2, .ravi-lines-3 { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
  .ravi-lines-1 { -webkit-line-clamp: 1; line-clamp: 1; }
  .ravi-lines-2 { -webkit-line-clamp: 2; line-clamp: 2; }
  .ravi-lines-3 { -webkit-line-clamp: 3; line-clamp: 3; }
${toneTextRules}
  .ravi-link { color: ${v("--color-text-info")}; text-decoration: underline; text-underline-offset: 2px; }
  .ravi-link:hover { text-decoration-thickness: 2px; }
  .ravi-empty { color: ${v("--color-text-tertiary")}; }
  .ravi-number, .ravi-big, .ravi-metric-value, .ravi-meter-text, .ravi-count { font-variant-numeric: tabular-nums; }
  .ravi-big { font-size: ${v("--font-heading-md-size")}; font-weight: ${v("--font-weight-bold")}; line-height: 1.2; }
  .ravi-body { white-space: pre-line; }
  .ravi-ref { font-family: ${v("--font-mono")}; font-size: ${v("--font-text-xs-size")}; color: ${v("--color-text-secondary")}; }
  .ravi-refs, .ravi-people, .ravi-pills { display: flex; flex-wrap: wrap; gap: ${s(1)}; margin: 0; padding: 0; list-style: none; }

  /* Fields */
  .ravi-field { display: inline-flex; align-items: center; gap: ${s(1)}; min-inline-size: 0; max-inline-size: 100%; }
  div.ravi-field { display: flex; }
  .ravi-field-labeled { flex-direction: column; align-items: flex-start; gap: 2px; }
  .ravi-field-label { font-size: ${v("--font-text-xs-size")}; font-weight: ${v("--font-weight-medium")}; color: ${v("--color-text-secondary")}; }
  .ravi-field-value { min-inline-size: 0; max-inline-size: 100%; }
  .ravi-field-edit { flex-wrap: wrap; }

  /* Options: color plus the name, always */
${optionRules}
  .ravi-pill, .ravi-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375em;
    min-block-size: 1.5rem;
    max-inline-size: 100%;
    padding: 0 ${s(2)};
    border: ${border} transparent;
    border-radius: ${v("--border-radius-full")};
    font-size: ${v("--font-text-xs-size")};
    font-weight: ${v("--font-weight-medium")};
    line-height: 1.2;
    white-space: normal;
  }
  .ravi-badge { background: ${v("--color-background-secondary")}; color: ${v("--color-text-primary")}; border-color: ${v("--color-border-secondary")}; }
  .ravi-badge.ravi-tone-primary, .ravi-badge.ravi-tone-secondary, .ravi-badge.ravi-tone-tertiary { background: ${v("--color-background-secondary")}; }
${toneBadgeRules}
  .ravi-dot { flex: none; inline-size: 0.5em; block-size: 0.5em; border-radius: 50%; background: currentColor; }
  .ravi-select-wrap > .ravi-dot { inline-size: 0.625rem; block-size: 0.625rem; background: currentColor; }
  .ravi-steps { display: flex; flex-wrap: wrap; gap: 2px; margin: 0; padding: 0; list-style: none; font-size: ${v("--font-text-xs-size")}; }
  .ravi-step {
    padding: 2px ${s(2)};
    background: ${v("--color-background-secondary")};
    color: ${v("--color-text-secondary")};
    border: ${border} ${v("--color-border-secondary")};
  }
  .ravi-step:first-child { border-start-start-radius: ${v("--border-radius-full")}; border-end-start-radius: ${v("--border-radius-full")}; }
  .ravi-step:last-child { border-start-end-radius: ${v("--border-radius-full")}; border-end-end-radius: ${v("--border-radius-full")}; }
  .ravi-step-done { color: ${v("--color-text-primary")}; }
  .ravi-step-current { font-weight: ${v("--font-weight-semibold")}; border-color: currentColor; }
${optionSurfaceRules}

  /* Meters, ratings, metrics */
  .ravi-progress { min-inline-size: 0; }
  .ravi-meter { min-inline-size: 0; }
  .ravi-bar { display: flex; align-items: center; gap: ${s(2)}; inline-size: 100%; min-inline-size: 5rem; }
  .ravi-bar .ravi-meter-track {
    position: relative;
    flex: 1 1 auto;
    block-size: 0.5rem;
    border-radius: ${v("--border-radius-full")};
    background: ${v("--color-background-tertiary")};
    box-shadow: inset 0 0 0 ${v("--border-width-regular")} ${v("--color-border-secondary")};
    overflow: hidden;
  }
  .ravi-bar .ravi-meter-fill { display: block; block-size: 100%; inline-size: var(--ravi-progress, 0%); background: ${v("--ravi-color-accent")}; border-radius: inherit; }
  .ravi-meter-text { flex: none; min-inline-size: 3.5ch; font-size: ${v("--font-text-xs-size")}; color: ${v("--color-text-secondary")}; text-align: end; }
  .ravi-ring { position: relative; display: inline-grid; place-items: center; inline-size: 2.75rem; block-size: 2.75rem; }
  .ravi-ring .ravi-meter-track {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(${v("--ravi-color-accent")} var(--ravi-progress, 0%), ${v("--color-background-tertiary")} 0);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 5px), currentColor calc(100% - 4px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 5px), currentColor calc(100% - 4px));
  }
  .ravi-ring .ravi-meter-fill { display: none; }
  .ravi-ring .ravi-meter-text { position: relative; min-inline-size: 0; text-align: center; color: ${v("--color-text-primary")}; }
  .ravi-rating { display: inline-flex; align-items: baseline; gap: ${s(1)}; }
  .ravi-stars { color: ${v("--color-text-warning")}; letter-spacing: 1px; }
  .ravi-rating-text { font-size: ${v("--font-text-xs-size")}; color: ${v("--color-text-secondary")}; }
  .ravi-canvas {
    display: block;
    position: relative;
    inline-size: 100%;
    block-size: var(--ravi-canvas-height, 16rem);
    min-inline-size: 0;
    overflow: hidden;
    border-radius: ${v("--border-radius-md")};
    background: ${v("--color-background-secondary")};
  }
  .ravi-metric { display: flex; flex-direction: column; gap: 2px; min-inline-size: 0; }
  .ravi-metric-label { font-size: ${v("--font-text-xs-size")}; font-weight: ${v("--font-weight-medium")}; color: ${v("--color-text-secondary")}; }
  .ravi-metric-value { font-size: ${v("--font-heading-lg-size")}; font-weight: ${v("--font-weight-bold")}; line-height: 1.15; }

  /* People, checks, images */
  .ravi-avatar {
    flex: none;
    display: inline-grid;
    place-items: center;
    inline-size: 2rem;
    block-size: 2rem;
    border-radius: 50%;
    overflow: hidden;
    object-fit: cover;
    background: ${v("--color-background-tertiary")};
    color: ${v("--color-text-primary")};
    font-size: ${v("--font-text-xs-size")};
    font-weight: ${v("--font-weight-semibold")};
    line-height: 1;
  }
  .ravi-avatar-sm { inline-size: 1.5rem; block-size: 1.5rem; font-size: 0.625rem; }
  .ravi-avatar-lg { inline-size: 2.75rem; block-size: 2.75rem; font-size: ${v("--font-text-sm-size")}; }
  .ravi-avatar-square { border-radius: ${v("--border-radius-md")}; }
  .ravi-person { display: inline-flex; align-items: center; gap: ${s(1)}; min-inline-size: 0; }
  .ravi-check { display: inline-flex; align-items: center; }
  .ravi-check-box {
    display: inline-grid;
    place-items: center;
    inline-size: 1rem;
    block-size: 1rem;
    border: ${border} ${v("--color-border-primary")};
    border-radius: ${v("--border-radius-xs")};
    font-size: 0.75rem;
    line-height: 1;
  }
  .ravi-check-on .ravi-check-box { background: ${v("--ravi-color-accent")}; border-color: ${v("--ravi-color-accent")}; color: ${v("--ravi-color-on-accent")}; }
  .ravi-image { display: block; max-inline-size: 100%; block-size: auto; object-fit: cover; background: ${v("--color-background-tertiary")}; border-radius: ${v("--border-radius-md")}; }
  .ravi-cover { inline-size: 100%; aspect-ratio: 16 / 9; }
  .ravi-thumb { inline-size: 3rem; block-size: 3rem; }
  .ravi-ratio-1-1 { inline-size: 100%; aspect-ratio: 1 / 1; }
  .ravi-ratio-4-3 { inline-size: 100%; aspect-ratio: 4 / 3; }
  .ravi-ratio-16-9 { inline-size: 100%; aspect-ratio: 16 / 9; }
  .ravi-ratio-3-4 { inline-size: 100%; aspect-ratio: 3 / 4; }
  .ravi-fit-contain { object-fit: contain; }

  /* Controls: buttons, inputs, selects, checkboxes (24px minimum targets) */
  .ravi-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: ${s(1)};
    min-block-size: max(${target}, 2rem);
    min-inline-size: ${target};
    padding: 0 ${s(3)};
    border: ${border} ${v("--color-border-primary")};
    border-radius: ${v("--border-radius-md")};
    background: ${v("--color-background-primary")};
    color: ${v("--color-text-primary")};
    font: inherit;
    font-size: ${v("--font-text-sm-size")};
    font-weight: ${v("--font-weight-medium")};
    line-height: 1.2;
    text-decoration: none;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease;
  }
  .ravi-button:hover { background: ${v("--color-background-secondary")}; }
  .ravi-button-primary { background: ${v("--ravi-color-accent")}; border-color: ${v("--ravi-color-accent")}; color: ${v("--ravi-color-on-accent")}; }
  .ravi-button-primary:hover { background: color-mix(in srgb, ${v("--ravi-color-accent")} 86%, ${v("--color-text-primary")}); }
  .ravi-button-ghost { background: transparent; border-color: transparent; }
  .ravi-button-danger { color: ${v("--color-text-danger")}; border-color: currentColor; }
  .ravi-button-danger:hover { background: ${v("--color-background-danger")}; }
  .ravi-button:disabled, .ravi-button[aria-disabled="true"] { cursor: not-allowed; opacity: 0.6; }
  .ravi-input, .ravi-form :where(input:not([type="checkbox"]):not([type="radio"]), select, textarea) {
    min-block-size: max(${target}, 2rem);
    max-inline-size: 100%;
    padding: 0 ${s(2)};
    border: ${border} ${v("--color-border-primary")};
    border-radius: ${v("--border-radius-md")};
    background: ${v("--color-background-primary")};
    color: ${v("--color-text-primary")};
    font: inherit;
    font-size: ${v("--font-text-sm-size")};
  }
  .ravi-form textarea, textarea.ravi-input { padding-block: ${s(2)}; min-block-size: 5rem; }
  .ravi-select-wrap { display: inline-flex; align-items: center; gap: ${s(1)}; max-inline-size: 100%; }
  .ravi-checkbox, .ravi-form input[type="checkbox"] {
    inline-size: ${target};
    block-size: ${target};
    margin: 0;
    accent-color: ${v("--ravi-color-accent")};
  }

  /* Runtime layouts */
  .ravi-list, .ravi-gallery, .ravi-lane-cards { margin: 0; padding: 0; list-style: none; }
  .ravi-list { display: grid; gap: ${s(2)}; }
  .ravi-list > li, .ravi-gallery > li, .ravi-lane { container-type: inline-size; min-inline-size: 0; }
  .ravi-gallery { display: grid; gap: ${s(3)}; grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr)); }
  .ravi-board { display: flex; align-items: flex-start; gap: ${s(3)}; overflow-x: auto; padding-block-end: ${s(2)}; }
  .ravi-lane {
    flex: 0 0 auto;
    inline-size: max(15rem, ${v("--ravi-lane-width")});
    display: flex;
    flex-direction: column;
    gap: ${s(2)};
    padding: ${s(2)};
    background: ${v("--color-background-secondary")};
    border-radius: ${v("--border-radius-lg")};
  }
  .ravi-lane-cards { display: flex; flex-direction: column; gap: ${s(2)}; }
  .ravi-lane-header { display: flex; align-items: center; justify-content: space-between; gap: ${s(2)}; margin: 0; font-size: ${v("--font-text-sm-size")}; font-weight: ${v("--font-weight-semibold")}; }
  .ravi-count { font-size: ${v("--font-text-xs-size")}; font-weight: ${v("--font-weight-medium")}; color: ${v("--color-text-secondary")}; }
  .ravi-table-scroll { max-inline-size: 100%; overflow-x: auto; }
  .ravi-table { inline-size: 100%; border-collapse: collapse; font-size: ${v("--font-text-sm-size")}; }
  .ravi-table th, .ravi-table td { padding: ${s(2)} ${s(3)}; text-align: start; vertical-align: top; border-block-end: ${border} ${v("--color-border-secondary")}; }
  .ravi-table th { font-size: ${v("--font-text-xs-size")}; font-weight: ${v("--font-weight-semibold")}; color: ${v("--color-text-secondary")}; }
  .ravi-status { margin: 0; padding: ${s(3)}; color: ${v("--color-text-secondary")}; font-size: ${v("--font-text-sm-size")}; }
  .ravi-error { margin: 0; padding: ${s(2)} ${s(3)}; border: ${border} currentColor; border-radius: ${v("--border-radius-md")}; background: ${v("--color-background-danger")}; color: ${v("--color-text-danger")}; font-size: ${v("--font-text-sm-size")}; }
  .ravi-pending { opacity: 0.72; }
  .ravi-pending, [aria-busy="true"] { cursor: progress; }
  .ravi-menu {
    position: absolute;
    z-index: 20;
    min-inline-size: 12rem;
    max-inline-size: min(20rem, calc(100vw - 2rem));
    margin: 0;
    padding: ${s(1)};
    list-style: none;
    background: ${v("--color-background-primary")};
    border: ${border} ${v("--color-border-primary")};
    border-radius: ${v("--border-radius-lg")};
    box-shadow: ${v("--shadow-lg")};
  }
  .ravi-menu :where([role="menuitem"], [role="menuitemradio"], button) {
    display: flex;
    align-items: center;
    inline-size: 100%;
    min-block-size: max(${target}, 2rem);
    padding: 0 ${s(2)};
    border: 0;
    border-radius: ${v("--border-radius-sm")};
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .ravi-menu :where([role="menuitem"], [role="menuitemradio"], button):hover { background: ${v("--color-background-secondary")}; }
  .ravi-dialog {
    max-inline-size: min(32rem, calc(100vw - 2rem));
    padding: ${s(4)};
    border: ${border} ${v("--color-border-primary")};
    border-radius: ${v("--border-radius-xl")};
    background: ${v("--color-background-primary")};
    color: ${v("--color-text-primary")};
    box-shadow: ${v("--shadow-lg")};
  }
  .ravi-dialog::backdrop { background: color-mix(in srgb, ${v("--color-background-inverse")} 40%, transparent); }
  .ravi-dialog-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: ${s(2)}; margin-block-start: ${s(4)}; }
  .ravi-form { display: grid; gap: ${s(3)}; max-inline-size: 40rem; }
  .ravi-form label { display: grid; gap: ${s(1)}; font-size: ${v("--font-text-sm-size")}; font-weight: ${v("--font-weight-medium")}; }

  /* Search, inline editors, approval and agent cells */
  .ravi-search { display: flex; flex-wrap: wrap; align-items: center; gap: ${s(2)}; margin-block-end: ${s(3)}; font-size: ${v("--font-text-sm-size")}; }
  .ravi-search .ravi-input { flex: 1 1 12rem; }
  .ravi-choices { display: flex; flex-wrap: wrap; align-items: center; gap: ${s(1)} ${s(3)}; margin: 0; padding: 0; border: 0; min-inline-size: 0; }
  .ravi-choices label { display: inline-flex; align-items: center; gap: ${s(1)}; font-size: ${v("--font-text-sm-size")}; }
  .ravi-approval { flex-wrap: wrap; align-items: center; gap: ${s(2)}; }
  .ravi-agent { display: inline-flex; flex-wrap: wrap; align-items: center; gap: ${s(1)}; }
  .ravi-details { display: grid; grid-template-columns: minmax(0, max-content) minmax(0, 1fr); gap: ${s(1)} ${s(3)}; margin: 0 0 ${s(3)}; }
  .ravi-details dt { color: ${v("--color-text-secondary")}; font-size: ${v("--font-text-sm-size")}; }
  .ravi-details dd { margin: 0; }

  /* Calendar */
  .ravi-calendar-nav { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: ${s(2)}; margin-block-end: ${s(2)}; }
  .ravi-calendar-nav :where(h1, h2, h3, h4, h5, h6) { margin: 0; font-size: ${v("--font-heading-sm-size")}; }
  .ravi-calendar { inline-size: 100%; table-layout: fixed; border-collapse: collapse; font-size: ${v("--font-text-sm-size")}; }
  .ravi-calendar th { padding: ${s(1)}; font-size: ${v("--font-text-xs-size")}; color: ${v("--color-text-secondary")}; text-align: start; }
  .ravi-calendar td { block-size: 5.5rem; padding: ${s(1)}; vertical-align: top; border: ${border} ${v("--color-border-secondary")}; }
  .ravi-day { display: block; font-size: ${v("--font-text-xs-size")}; color: ${v("--color-text-secondary")}; }
  .ravi-calendar [aria-current="date"] .ravi-day { color: ${v("--ravi-color-accent")}; font-weight: ${v("--font-weight-bold")}; }
  .ravi-calendar ul { display: grid; gap: 2px; margin: ${s(1)} 0 0; padding: 0; list-style: none; }
  .ravi-calendar li .ravi-button { inline-size: 100%; justify-content: flex-start; min-block-size: ${target}; padding: 0 ${s(1)}; font-size: ${v("--font-text-xs-size")}; text-align: start; }

  /* Charts: marks take the series color as currentColor; text stays in text colors */
  .ravi-chart { display: grid; gap: ${s(2)}; margin: 0; }
  .ravi-chart figcaption { font-weight: ${v("--font-weight-semibold")}; }
  .ravi-chart svg { display: block; inline-size: 100%; block-size: auto; overflow: visible; }
  .ravi-chart-axis { fill: ${v("--color-text-secondary")}; font-size: 11px; }
  .ravi-chart-grid { stroke: ${v("--color-border-secondary")}; }
  .ravi-chart-mark { stroke: ${v("--color-background-primary")}; stroke-width: 1px; }
  .ravi-chart-line { fill: none; stroke: currentColor; stroke-width: 2px; }
  .ravi-chart-label { fill: ${v("--color-text-primary")}; font-size: 11px; paint-order: stroke; stroke: ${v("--color-background-primary")}; stroke-width: 3px; }
${SERIES_COLORS.map((color, index) => `  .ravi-chart-s${index}, .ravi-chart-o-${color} { color: ${v(`--ravi-option-${color}-text`)}; }`).join("\n")}
  .ravi-legend { display: flex; flex-wrap: wrap; gap: ${s(1)} ${s(3)}; margin: 0; padding: 0; list-style: none; font-size: ${v("--font-text-sm-size")}; }
  .ravi-legend li { display: inline-flex; align-items: center; gap: ${s(1)}; }
  .ravi-swatch { display: inline-block; inline-size: 0.75rem; block-size: 0.75rem; border-radius: ${v("--border-radius-xs")}; background: currentColor; }

  /* Narrow containers: a 240px lane, a 320px screen (200% zoom) */
  @container (max-width: 16rem) {
    .ravi-row { flex-wrap: wrap; }
    .ravi-cols-2, .ravi-cols-3, .ravi-cols-4 { grid-template-columns: minmax(0, 1fr); }
  }
  @container (max-width: 26rem) {
    .ravi-cols-3, .ravi-cols-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 30rem) {
    .ravi-row { flex-wrap: wrap; }
    .ravi-cols-3, .ravi-cols-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .ravi-board { flex-direction: column; align-items: stretch; overflow-x: visible; }
    .ravi-lane { inline-size: auto; }
  }
  @media (max-width: 20rem) {
    .ravi-cols-2, .ravi-cols-3, .ravi-cols-4 { grid-template-columns: minmax(0, 1fr); }
  }

  @media (prefers-reduced-motion: reduce) {
    :where(ravi-view, ravi-widget, ravi-form, ravi-chart, .ravi-card, .ravi-dialog, .ravi-menu, .ravi-button),
    :where(ravi-view, ravi-widget, ravi-form, ravi-chart, .ravi-card, .ravi-dialog, .ravi-menu) * {
      transition: none !important;
      animation: none !important;
      scroll-behavior: auto !important;
    }
  }

  /* Windows high contrast: keep boundaries, focus and meter fills visible. */
  @media (forced-colors: active) {
    .ravi-card, .ravi-pill, .ravi-badge, .ravi-step, .ravi-button, .ravi-input, .ravi-menu, .ravi-dialog, .ravi-lane, .ravi-check-box, .ravi-avatar {
      border: 1px solid CanvasText;
    }
    .ravi-step-current { outline: 2px solid Highlight; outline-offset: -2px; }
    :where(ravi-view, ravi-widget, ravi-form, ravi-chart, .ravi-card, .ravi-dialog, .ravi-menu) :focus-visible,
    .ravi-button:focus-visible, .ravi-link:focus-visible, .ravi-input:focus-visible, .ravi-checkbox:focus-visible, .ravi-card:focus-visible {
      outline: 2px solid Highlight;
    }
    .ravi-meter-track { forced-color-adjust: none; background: Canvas; box-shadow: inset 0 0 0 1px CanvasText; }
    .ravi-chart-mark { stroke: Canvas; }
    .ravi-bar .ravi-meter-fill { forced-color-adjust: none; background: Highlight; }
    .ravi-ring .ravi-meter-track { background: conic-gradient(Highlight var(--ravi-progress, 0%), Canvas 0); }
    .ravi-check-on .ravi-check-box { forced-color-adjust: none; background: Highlight; color: HighlightText; }
    .ravi-dot { forced-color-adjust: none; background: CanvasText; }
  }
}
`;
}

/** The pieces stylesheet, wrapped in `@layer ravi.pieces`. */
export const PIECES_CSS: string = /* @__PURE__ */ buildPiecesCss();
