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

  function compareRowOrder(left, right) {
    const leftOrder = Number(left?.order);
    const rightOrder = Number(right?.order);
    const safeLeft = Number.isFinite(leftOrder) ? leftOrder : Number.POSITIVE_INFINITY;
    const safeRight = Number.isFinite(rightOrder) ? rightOrder : Number.POSITIVE_INFINITY;
    return safeLeft - safeRight;
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
    pickTaskGroupPrimaryRow,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
