(function attachRaviWaTaskDrawerState(scope) {
  function normalizeTaskId(value) {
    return typeof value === "string" && value ? value : null;
  }

  function getSnapshotSelectedTaskId(snapshot) {
    return (
      normalizeTaskId(snapshot?.selectedTask?.task?.id) ||
      normalizeTaskId(snapshot?.query?.taskId)
    );
  }

  function getSnapshotItems(snapshot) {
    return Array.isArray(snapshot?.items) ? snapshot.items : [];
  }

  function taskExistsInSnapshot(taskId, snapshot) {
    const normalizedTaskId = normalizeTaskId(taskId);
    if (!normalizedTaskId) return false;
    return getSnapshotItems(snapshot).some((task) => task?.id === normalizedTaskId);
  }

  function syncTaskDetailDrawerState(params) {
    const selectedTaskId = normalizeTaskId(params?.selectedTaskId);
    const drawerOpen = Boolean(params?.drawerOpen);
    const snapshot = params?.snapshot ?? null;
    const snapshotSelectedTaskId = getSnapshotSelectedTaskId(snapshot);

    if (!selectedTaskId) {
      return {
        nextSelectedTaskId: snapshotSelectedTaskId,
        nextDrawerOpen: drawerOpen,
        taskRemoved: false,
      };
    }

    if (taskExistsInSnapshot(selectedTaskId, snapshot)) {
      return {
        nextSelectedTaskId: selectedTaskId,
        nextDrawerOpen: drawerOpen,
        taskRemoved: false,
      };
    }

    return {
      nextSelectedTaskId: null,
      nextDrawerOpen: false,
      taskRemoved: drawerOpen,
    };
  }

  function resolveTaskDetailDrawerState(params) {
    const selectedTaskId = normalizeTaskId(params?.selectedTaskId);
    const drawerOpen = Boolean(params?.drawerOpen);
    const snapshot = params?.snapshot ?? null;
    const cachedSelection = params?.cachedSelection?.task
      ? params.cachedSelection
      : null;
    const snapshotSelection = snapshot?.selectedTask?.task
      ? snapshot.selectedTask
      : null;
    const snapshotSelectedTaskId = getSnapshotSelectedTaskId(snapshot);
    const effectiveTaskId = selectedTaskId || snapshotSelectedTaskId;
    const hasFreshSelection = Boolean(
      effectiveTaskId &&
        snapshotSelection?.task?.id &&
        snapshotSelection.task.id === effectiveTaskId
    );
    const selectedTask = hasFreshSelection
      ? snapshotSelection
      : selectedTaskId
        ? cachedSelection
        : snapshotSelection;
    const taskStillExists = taskExistsInSnapshot(effectiveTaskId, snapshot);

    return {
      effectiveTaskId,
      selectedTask: selectedTask?.task ? selectedTask : null,
      detailDrawerVisible: Boolean(drawerOpen && selectedTask?.task),
      isHydrating: Boolean(
        drawerOpen &&
          selectedTaskId &&
          selectedTask?.task &&
          !hasFreshSelection &&
          taskStillExists
      ),
      selectionSource: hasFreshSelection
        ? "snapshot"
        : selectedTask?.task
          ? "cache"
          : "none",
      taskStillExists,
    };
  }

  scope.__RAVI_WA_TASK_DRAWER_STATE__ = {
    taskExistsInSnapshot,
    syncTaskDetailDrawerState,
    resolveTaskDetailDrawerState,
  };
})(globalThis);
