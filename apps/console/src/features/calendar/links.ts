/** A meeting someone can open from anywhere they may see it (its project, or a grant). */
export function sharedMeetingHref(meetingId: string) {
  return `/shared/meetings/${encodeURIComponent(meetingId)}`;
}
