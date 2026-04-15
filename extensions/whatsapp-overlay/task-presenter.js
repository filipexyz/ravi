(function attachTaskPresenter(root) {
  function clampTaskProgressValue(value) {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(100, Math.round(numeric)));
  }

  function getChildNodes(node) {
    return Array.isArray(node?.children) ? node.children : [];
  }

  function countTaskDescendants(node) {
    return getChildNodes(node).reduce(
      (total, childNode) => total + 1 + countTaskDescendants(childNode),
      0,
    );
  }

  function getOwnTaskProgressState(task) {
    const progress = clampTaskProgressValue(task?.progress ?? 0);
    switch (task?.status) {
      case "done":
        return { progress: 100, authoritative: true };
      case "failed":
      case "blocked":
        return { progress, authoritative: true };
      default:
        return { progress, authoritative: progress > 0 };
    }
  }

  function getTaskVisualProgressState(task, node) {
    const ownState = getOwnTaskProgressState(task);
    const childNodes = getChildNodes(node);
    const childCount = countTaskDescendants(node);
    if (!childNodes.length) {
      return {
        progress: ownState.progress,
        source: "task",
        childCount,
      };
    }

    const childProgresses = childNodes.map((childNode) =>
      getTaskVisualProgressState(childNode?.task, childNode).progress,
    );
    const aggregateProgress = clampTaskProgressValue(
      childProgresses.reduce((total, value) => total + value, 0) /
        childProgresses.length,
    );

    if (ownState.authoritative || aggregateProgress <= 0) {
      return {
        progress: ownState.progress,
        source: "task",
        childCount,
      };
    }

    return {
      progress: aggregateProgress,
      source: "children",
      childCount,
    };
  }

  function toFiniteCount(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
  }

  function getTaskDependencyEntries(task) {
    return Array.isArray(task?.dependencies) ? task.dependencies : [];
  }

  function getTaskReadinessState(task) {
    const dependencies = getTaskDependencyEntries(task);
    const explicitReadiness =
      task?.readiness && typeof task.readiness === "object" ? task.readiness : null;
    const totalCount =
      toFiniteCount(explicitReadiness?.dependencyCount) ??
      dependencies.length;
    const satisfiedCount =
      toFiniteCount(explicitReadiness?.satisfiedDependencyCount) ??
      dependencies.filter((dependency) => dependency?.satisfied === true).length;
    const pendingCount =
      toFiniteCount(explicitReadiness?.unsatisfiedDependencyCount) ??
      Math.max(0, totalCount - satisfiedCount);
    const explicitState = explicitReadiness?.state;
    const status = explicitState === "waiting" || pendingCount > 0 ? "waiting" : "ready";

    return {
      status,
      totalCount,
      satisfiedCount,
      pendingCount,
      hasLaunchPlan: explicitReadiness?.hasLaunchPlan === true || Boolean(task?.launchPlan),
      label:
        typeof explicitReadiness?.label === "string" && explicitReadiness.label.trim()
          ? explicitReadiness.label.trim()
          : null,
    };
  }

  function getTaskKanbanSurfaceStatus(task) {
    const status = task?.visualStatus || task?.status || "open";
    if (status === "waiting") {
      return "waiting";
    }
    if (status === "open") {
      return getTaskReadinessState(task).status === "waiting" ? "waiting" : "ready";
    }
    if (status === "dispatched") {
      return "queued";
    }
    if (status === "in_progress") {
      return "working";
    }
    return status;
  }

  function compareRowOrder(left, right) {
    const leftOrder = Number(left?.order);
    const rightOrder = Number(right?.order);
    const safeLeft = Number.isFinite(leftOrder) ? leftOrder : Number.POSITIVE_INFINITY;
    const safeRight = Number.isFinite(rightOrder) ? rightOrder : Number.POSITIVE_INFINITY;
    return safeLeft - safeRight;
  }

  function toPositiveTaskTimestamp(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }

  function getTaskRecencyTimestamp(task) {
    return (
      toPositiveTaskTimestamp(task?.updatedAt) ??
      toPositiveTaskTimestamp(task?.createdAt) ??
      0
    );
  }

  function compareTasksByRecencyDesc(left, right) {
    return (
      getTaskRecencyTimestamp(right) - getTaskRecencyTimestamp(left) ||
      (toPositiveTaskTimestamp(right?.createdAt) ?? 0) -
        (toPositiveTaskTimestamp(left?.createdAt) ?? 0) ||
      String(left?.id || "").localeCompare(String(right?.id || ""))
    );
  }

  function sortTaskTreeByRecency(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    const latestByNode = new WeakMap();

    function getNodeRecency(node) {
      if (!node || typeof node !== "object") return 0;
      const cached = latestByNode.get(node);
      if (typeof cached === "number") {
        return cached;
      }

      let latest = getTaskRecencyTimestamp(node?.task);
      getChildNodes(node).forEach((childNode) => {
        latest = Math.max(latest, getNodeRecency(childNode));
      });
      latestByNode.set(node, latest);
      return latest;
    }

    list.forEach((node) => {
      sortTaskTreeByRecency(getChildNodes(node));
    });

    list.sort(
      (left, right) =>
        getNodeRecency(right) - getNodeRecency(left) ||
        compareTasksByRecencyDesc(left?.task, right?.task),
    );

    return list;
  }

  function pickTaskGroupPrimaryRow(node) {
    let bestRow = null;

    function visit(currentNode) {
      const rows = Array.isArray(currentNode?.rows) ? currentNode.rows : [];
      rows.forEach((row) => {
        if (!bestRow || compareRowOrder(row, bestRow) < 0) {
          bestRow = row;
        }
      });

      getChildNodes(currentNode).forEach((childNode) => {
        visit(childNode);
      });
    }

    visit(node);
    return bestRow;
  }

  root.RaviWaOverlayTaskPresenter = {
    clampTaskProgressValue,
    getTaskVisualProgressState,
    getTaskReadinessState,
    getTaskKanbanSurfaceStatus,
    pickTaskGroupPrimaryRow,
    sortTaskTreeByRecency,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
