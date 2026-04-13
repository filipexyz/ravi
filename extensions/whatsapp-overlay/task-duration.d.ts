export {};

declare global {
  var RaviWaOverlayTaskDuration:
    | {
        getTaskDurationStartTimestamp(task: Record<string, unknown> | null | undefined): number | null;
        getTaskDurationEndTimestamp(
          task: Record<string, unknown> | null | undefined,
          now?: number,
        ): number | null;
        getTaskDurationMs(task: Record<string, unknown> | null | undefined, now?: number): number | null;
      }
    | undefined;
}
