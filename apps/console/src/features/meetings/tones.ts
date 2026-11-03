// Color classes for a speaker's slot (see `--rv-speaker-*` in src/ui/theme.css).
// Written out in full so Tailwind finds them.

const BG = ["bg-speaker-1", "bg-speaker-2", "bg-speaker-3", "bg-speaker-4", "bg-speaker-5", "bg-speaker-6"];
const SOFT = ["bg-speaker-1/15", "bg-speaker-2/15", "bg-speaker-3/15", "bg-speaker-4/15", "bg-speaker-5/15", "bg-speaker-6/15"];
const TEXT = ["text-speaker-1", "text-speaker-2", "text-speaker-3", "text-speaker-4", "text-speaker-5", "text-speaker-6"];
const BORDER = ["border-speaker-1", "border-speaker-2", "border-speaker-3", "border-speaker-4", "border-speaker-5", "border-speaker-6"];

export function toneBg(tone: number | null) {
  return tone === null ? "bg-ink-3" : BG[tone % BG.length]!;
}

export function toneSoft(tone: number | null) {
  return tone === null ? "bg-sunken" : SOFT[tone % SOFT.length]!;
}

export function toneText(tone: number | null) {
  return tone === null ? "text-ink-3" : TEXT[tone % TEXT.length]!;
}

export function toneBorder(tone: number | null) {
  return tone === null ? "border-line-strong" : BORDER[tone % BORDER.length]!;
}
