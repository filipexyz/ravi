(function attachTaskPresenter(root) {
  function clampTaskProgressValue(value) {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(100, Math.round(numeric)));
  }

  function getChildNodes(node) {
    return Array.isArray(node?.children) ? node.children : [];
  }

  function normalizeTaskListItem(item) {
    if (!item || typeof item !== "object") return null;

    const envelopeTask =
      item.task && typeof item.task === "object" ? item.task : null;
    const task = envelopeTask || item;
    if (!task?.id) return null;

    if (!envelopeTask) return task;

    return {
      ...task,
      activeAssignment: item.activeAssignment ?? task.activeAssignment ?? null,
      visualStatus: item.visualStatus ?? task.visualStatus ?? task.status ?? null,
      runtime: item.runtime ?? task.runtime ?? null,
      readiness: item.readiness ?? task.readiness ?? null,
      dependencyCount: item.dependencyCount ?? task.dependencyCount,
      unsatisfiedDependencyCount:
        item.unsatisfiedDependencyCount ?? task.unsatisfiedDependencyCount,
      launchPlan: item.launchPlan ?? task.launchPlan ?? null,
      project: item.project ?? task.project ?? null,
    };
  }

  function normalizeTaskListItems(items) {
    return (Array.isArray(items) ? items : [])
      .map((item) => normalizeTaskListItem(item))
      .filter(Boolean);
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

  function getTaskWorkflowSummary(task) {
    const workflow =
      task?.workflow && typeof task.workflow === "object" ? task.workflow : null;
    if (!workflow) {
      return null;
    }

    const runTitle =
      typeof workflow.workflowRunTitle === "string" &&
      workflow.workflowRunTitle.trim()
        ? workflow.workflowRunTitle.trim()
        : typeof workflow.workflowSpecTitle === "string" &&
            workflow.workflowSpecTitle.trim()
          ? workflow.workflowSpecTitle.trim()
          : typeof workflow.workflowRunId === "string" &&
              workflow.workflowRunId.trim()
            ? workflow.workflowRunId.trim()
            : "workflow";
    const nodeKey =
      typeof workflow.nodeKey === "string" && workflow.nodeKey.trim()
        ? workflow.nodeKey.trim()
        : null;
    const nodeLabel =
      typeof workflow.nodeLabel === "string" && workflow.nodeLabel.trim()
        ? workflow.nodeLabel.trim()
        : nodeKey;
    const waitingOnNodeKeys = Array.isArray(workflow.waitingOnNodeKeys)
      ? workflow.waitingOnNodeKeys
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean)
      : [];
    const currentTaskAttempt = toFiniteCount(workflow.currentTaskAttempt);
    const attemptCount = toFiniteCount(workflow.attemptCount);
    const attemptLabel =
      currentTaskAttempt !== null
        ? attemptCount !== null && attemptCount > currentTaskAttempt
          ? `attempt ${currentTaskAttempt} of ${attemptCount}`
          : `attempt ${currentTaskAttempt}`
        : attemptCount !== null && attemptCount > 0
          ? `${attemptCount} attempt${attemptCount === 1 ? "" : "s"}`
          : null;

    return {
      runId:
        typeof workflow.workflowRunId === "string" &&
        workflow.workflowRunId.trim()
          ? workflow.workflowRunId.trim()
          : null,
      runTitle,
      runStatus:
        typeof workflow.workflowRunStatus === "string" &&
        workflow.workflowRunStatus.trim()
          ? workflow.workflowRunStatus.trim()
          : null,
      specId:
        typeof workflow.workflowSpecId === "string" &&
        workflow.workflowSpecId.trim()
          ? workflow.workflowSpecId.trim()
          : null,
      specTitle:
        typeof workflow.workflowSpecTitle === "string" &&
        workflow.workflowSpecTitle.trim()
          ? workflow.workflowSpecTitle.trim()
          : null,
      nodeRunId:
        typeof workflow.workflowNodeRunId === "string" &&
        workflow.workflowNodeRunId.trim()
          ? workflow.workflowNodeRunId.trim()
          : null,
      nodeKey,
      nodeLabel,
      nodeKind:
        typeof workflow.nodeKind === "string" && workflow.nodeKind.trim()
          ? workflow.nodeKind.trim()
          : null,
      nodeRequirement:
        typeof workflow.nodeRequirement === "string" &&
        workflow.nodeRequirement.trim()
          ? workflow.nodeRequirement.trim()
          : null,
      nodeReleaseMode:
        typeof workflow.nodeReleaseMode === "string" &&
        workflow.nodeReleaseMode.trim()
          ? workflow.nodeReleaseMode.trim()
          : null,
      nodeStatus:
        typeof workflow.nodeStatus === "string" && workflow.nodeStatus.trim()
          ? workflow.nodeStatus.trim()
          : null,
      currentTaskId:
        typeof workflow.currentTaskId === "string" &&
        workflow.currentTaskId.trim()
          ? workflow.currentTaskId.trim()
          : null,
      currentTaskAttempt,
      attemptCount,
      attemptLabel,
      waitingOnNodeKeys,
      waitingOnLabel: waitingOnNodeKeys.length ? waitingOnNodeKeys.join(", ") : null,
      compactPath: [runTitle, nodeKey].filter(Boolean).join(" / "),
      isCurrentTask: workflow.isCurrentTask === true,
    };
  }

  function cleanTaskProjectText(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function getTaskProjectSummary(task) {
    const project =
      task?.project && typeof task.project === "object" ? task.project : null;
    if (!project) {
      return null;
    }

    const slug = cleanTaskProjectText(project.projectSlug);
    const title =
      cleanTaskProjectText(project.projectTitle) ||
      slug ||
      cleanTaskProjectText(project.projectId) ||
      "unlinked project";
    const hottestNodeKey = cleanTaskProjectText(project.hottestNodeKey);
    const hottestNodeLabel =
      cleanTaskProjectText(project.hottestNodeLabel) || hottestNodeKey;
    const hottestTaskId = cleanTaskProjectText(project.hottestTaskId);
    const hottestTaskTitle =
      cleanTaskProjectText(project.hottestTaskTitle) || hottestTaskId;

    return {
      id: cleanTaskProjectText(project.projectId),
      slug,
      title,
      status: cleanTaskProjectText(project.projectStatus),
      summary: cleanTaskProjectText(project.projectSummary),
      nextStep: cleanTaskProjectText(project.projectNextStep),
      lastSignalAt: toFiniteCount(project.projectLastSignalAt),
      workflowCount: toFiniteCount(project.workflowCount) ?? 0,
      workflowRunId: cleanTaskProjectText(project.workflowRunId),
      workflowRunTitle:
        cleanTaskProjectText(project.workflowRunTitle) ||
        cleanTaskProjectText(project.workflowRunId),
      workflowRunStatus: cleanTaskProjectText(project.workflowRunStatus),
      runtimeStatus:
        cleanTaskProjectText(project.workflowAggregateStatus) ||
        cleanTaskProjectText(project.hottestWorkflowStatus),
      hottestWorkflowRunId: cleanTaskProjectText(project.hottestWorkflowRunId),
      hottestWorkflowTitle:
        cleanTaskProjectText(project.hottestWorkflowTitle) ||
        cleanTaskProjectText(project.hottestWorkflowRunId),
      hottestWorkflowStatus: cleanTaskProjectText(project.hottestWorkflowStatus),
      hottestNodeRunId: cleanTaskProjectText(project.hottestNodeRunId),
      hottestNodeKey,
      hottestNodeLabel,
      hottestNodeStatus: cleanTaskProjectText(project.hottestNodeStatus),
      hottestTaskId,
      hottestTaskTitle,
      hottestTaskStatus: cleanTaskProjectText(project.hottestTaskStatus),
      hottestTaskProgress: toFiniteCount(project.hottestTaskProgress),
      hottestTaskPriority: cleanTaskProjectText(project.hottestTaskPriority),
    };
  }

  function groupTaskNodesByProject(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    const groups = new Map();

    list.forEach((node) => {
      const project = getTaskProjectSummary(node?.task);
      const key = project?.slug || project?.id || "__unlinked__";
      const current = groups.get(key) || {
        key,
        project,
        nodes: [],
        childCount: 0,
        lastSignalAt: project?.lastSignalAt ?? 0,
        latestTaskAt: 0,
      };

      current.nodes.push(node);
      current.childCount += countTaskDescendants(node);
      current.lastSignalAt = Math.max(current.lastSignalAt, project?.lastSignalAt ?? 0);
      current.latestTaskAt = Math.max(current.latestTaskAt, getNodeLatestTaskTimestamp(node));
      if (!current.project && project) {
        current.project = project;
      }
      groups.set(key, current);
    });

    const grouped = [...groups.values()];
    grouped.forEach((group) => {
      sortTaskTreeByRecency(group.nodes);
    });
    grouped.sort(
      (left, right) =>
        (right.lastSignalAt ?? 0) - (left.lastSignalAt ?? 0) ||
        (right.latestTaskAt ?? 0) - (left.latestTaskAt ?? 0) ||
        String(left.project?.slug || left.project?.title || left.key).localeCompare(
          String(right.project?.slug || right.project?.title || right.key),
        ),
    );
    return grouped;
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

  function getNodeLatestTaskTimestamp(node) {
    let latest = getTaskRecencyTimestamp(node?.task);
    getChildNodes(node).forEach((childNode) => {
      latest = Math.max(latest, getNodeLatestTaskTimestamp(childNode));
    });
    return latest;
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
    normalizeTaskListItem,
    normalizeTaskListItems,
    getTaskVisualProgressState,
    getTaskReadinessState,
    getTaskWorkflowSummary,
    getTaskProjectSummary,
    getTaskKanbanSurfaceStatus,
    groupTaskNodesByProject,
    pickTaskGroupPrimaryRow,
    sortTaskTreeByRecency,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
