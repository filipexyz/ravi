(function attachTaskDurationHelpers(root) {
  function toPositiveTimestamp(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }

  function getTaskDurationStartTimestamp(task) {
    return (
      toPositiveTimestamp(task?.dispatchedAt) ??
      toPositiveTimestamp(task?.createdAt) ??
      toPositiveTimestamp(task?.startedAt)
    );
  }

  function getTaskDurationEndTimestamp(task, now = Date.now()) {
    switch (task?.status) {
      case "dispatched":
      case "in_progress":
        return now;
      case "done":
      case "failed":
        return toPositiveTimestamp(task?.completedAt) ?? toPositiveTimestamp(task?.updatedAt);
      case "blocked":
        return toPositiveTimestamp(task?.updatedAt);
      default:
        return null;
    }
  }

  function getTaskDurationMs(task, now = Date.now()) {
    const startedAt = getTaskDurationStartTimestamp(task);
    if (startedAt === null) return null;

    const endedAt = getTaskDurationEndTimestamp(task, now);
    if (endedAt === null || endedAt < startedAt) {
      return null;
    }

    return Math.max(0, endedAt - startedAt);
  }

  root.RaviWaOverlayTaskDuration = {
    getTaskDurationStartTimestamp,
    getTaskDurationEndTimestamp,
    getTaskDurationMs,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
