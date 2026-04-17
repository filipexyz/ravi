export class SessionTypingTracker {
  private sessionStates = new Map<string, boolean>();

  shouldEmit(sessionName: string, active: boolean): boolean {
    const previous = this.sessionStates.get(sessionName);
    if (previous === active) return false;
    this.sessionStates.set(sessionName, active);
    return true;
  }

  clear(sessionName: string): void {
    this.sessionStates.delete(sessionName);
  }
}
