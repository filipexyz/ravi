const APPROVAL_EMOJIS = new Set(["👍", "❤️", "❤"]);

const SLACK_NAME_TO_EMOJI: Record<string, string> = {
  "+1": "👍",
  thumbsup: "👍",
  thumbs_up: "👍",
  heart: "❤️",
  red_heart: "❤️",
  heavy_black_heart: "❤",
};

export function slackReactionShortName(value: string): string {
  return (
    value
      .trim()
      .replace(/^:+|:+$/g, "")
      .split("::")[0]
      ?.toLowerCase() ?? ""
  );
}

/** Map Slack short names (`+1`, `heart`) and skin-tone thumbs to the unicode approval set. */
export function normalizeReactionEmoji(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "👍" || trimmed.startsWith("👍")) return "👍";
  if (trimmed === "❤️") return "❤️";
  if (trimmed === "❤") return "❤";

  const shortName = slackReactionShortName(trimmed);
  if (!shortName) return trimmed;
  return SLACK_NAME_TO_EMOJI[shortName] ?? shortName;
}

export function isApprovalReactionEmoji(value: string | undefined): boolean {
  if (!value) return false;
  return APPROVAL_EMOJIS.has(normalizeReactionEmoji(value));
}
