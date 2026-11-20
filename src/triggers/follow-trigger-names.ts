/** The name `gh-watch` gives a PR follow trigger: `gh-follow:<repo>#<number>`. */
export const GH_FOLLOW_TRIGGER_PREFIX = "gh-follow:";

export function isGhFollowTriggerName(name: string): boolean {
  return name.startsWith(GH_FOLLOW_TRIGGER_PREFIX);
}
