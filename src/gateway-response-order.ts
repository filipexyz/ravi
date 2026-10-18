/**
 * Keeps one session's responses in the order the runtime emitted them.
 *
 * The gateway handles subscription events fire-and-forget so a slow Omni send
 * does not stall other sessions. A reply the runtime emits as several
 * `.response` events would then race through mention lookup and the send, and
 * arrive in the chat out of order. This queue runs each session's handlers one
 * after another while different sessions still run concurrently.
 */
export class SessionResponseQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run(sessionName: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(sessionName) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    const tail = current.catch(() => {});
    this.tails.set(sessionName, tail);
    void tail.then(() => {
      if (this.tails.get(sessionName) === tail) this.tails.delete(sessionName);
    });
    return current;
  }

  get pendingSessions(): number {
    return this.tails.size;
  }
}
