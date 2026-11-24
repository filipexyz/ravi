/**
 * Slack may deliver the same interaction more than once (a retry after a slow ack, a reconnect).
 * A consumer that must answer a tap once remembers the envelope ids it has seen.
 *
 * The memory is the process's own: a restart empties it, so a tap redelivered across a restart is
 * answered again. What a tap does is built to absorb that (`close` on a closed thread says it was
 * already closed, `stop` with nothing running says so), and the freshness window refuses a tap
 * that is too old to run.
 *
 * Spec: channels/slack/commands.
 */

/** Envelope ids remembered per consumer: enough for a busy workspace, bounded so it never grows. */
export const SEEN_ENVELOPES_MAX = 1000;

/** A function that is true the first time it sees an envelope id and false after. No id is always new. */
export function createEnvelopeDedupe(max: number = SEEN_ENVELOPES_MAX): (envelopeId: string | undefined) => boolean {
  const seen = new Set<string>();
  return (envelopeId) => {
    if (!envelopeId) return true;
    if (seen.has(envelopeId)) return false;
    seen.add(envelopeId);
    if (seen.size > max) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };
}
