---
kind: capability
domain: runtime
title: Task Slot Release on Delete
status: implemented
version: 1.0.0
---

## Intent

Release ephemeral `task-*-work` runtime session slots when the corresponding task is deleted via the service API, preventing zombie sessions from accumulating in the 60-slot runtime pool.

Root cause: `dbDeleteTask()` performed DELETE-only without emitting cleanup events. When tasks were deleted (workflow attachment failure, fixture teardown, project cleanup), their runtime sessions remained active until TTL expiration (1-24h), occupying slots that could not be reclaimed.

Impact: In production, 8/12 (67%) of zombie sessions were caused by orphaned task deletions. Under load with 3+ daemon restarts + cascading deletions, this saturates the 60-slot pool within hours.

## Design

```
CLI ravi tasks done
  ↓ (service.completeTask → dbCompleteTask → NATS emit "task.done")
Runtime pool releases slot via:
  - host-subscriptions.subscribeToTaskEvents("ravi.task.*.event")
  - Sees type="task.done" || "task.failed" → dispatcher.abortSession()

CLI/API ravi tasks delete
  ↓ (service.deleteTask → dbDeleteTask → NATS emit "task.deleted")
Runtime pool releases slot via:
  - Same subscription pattern
  - Sees type="task.deleted" → dispatcher.abortSession({reason:"task_deleted"})
```

**Invariants:**
1. Service layer (not DB layer) wraps all task deletion operations
2. Deletion is idempotent: deleteTask(nonexistent_id) returns false, no-op
3. NATS event includes: { type: "task.deleted", taskId, assigneeSessionName: "task-{id}-work", timestamp }
4. Session abort is asynchronous via NATS (best-effort, same as task.done)
5. If NATS delivery fails, session persists until TTL (safety net)
6. Call sites: service.ts (error path), projects/service.ts (attachment failure), projects/fixtures.ts (teardown), cli/commands/workflows.ts (attachment failure)

## Implementation

### 1. Service wrapper (src/tasks/service.ts)

```typescript
export async function deleteTask(taskId: string): Promise<boolean> {
  const existingTask = dbGetTask(taskId);
  if (!existingTask) return false;

  const deleted = dbDeleteTask(taskId);
  if (deleted) {
    const sessionName = `task-${taskId}-work`;
    try {
      await nats.emit(`${TASK_EVENT_PREFIX}.${taskId}.event`, {
        type: "task.deleted",
        taskId,
        assigneeSessionName: sessionName,
        timestamp: new Date().toISOString(),
      } as unknown as Record<string, unknown>);
    } catch (err) {
      log.warn("Failed to emit task.deleted event", { taskId, error: err });
    }
  }
  return deleted;
}
```

### 2. Subscription handler (src/runtime/host-subscriptions.ts)

```typescript
private async subscribeToTaskEvents(): Promise<void> {
  for await (const event of nats.subscribe("ravi.task.*.event")) {
    const type = data.event?.type ?? data.type;
    const sessionName =
      type === "task.done" || type === "task.failed" || type === "task.deleted"
        ? (data.assigneeSessionName ?? data.event?.sessionName ?? undefined)
        : (data.event?.sessionName ?? data.assigneeSessionName ?? undefined);

    if ((type === "task.done" || type === "task.failed") && sessionName) {
      await this.options.dispatcher.startDeferredAfterTaskSessionIfDeliverable(sessionName);
      this.options.dispatcher.wakeStreamingSessionIfDeliverable(sessionName);
    } else if (type === "task.deleted" && sessionName) {
      await this.options.dispatcher.abortSession(sessionName, { reason: "task_deleted" });
    }
  }
}
```

### 3. Call site migration

- `src/cli/commands/workflows.ts:412` — attachment failure: `await deleteTask(created.task.id)`
- `src/projects/service.ts:775` — project task creation failure: `await cleanupCreatedTask()` (which calls deleteTask)
- `src/projects/fixtures.ts:306` — fixture teardown: `await deleteTask(taskId)` in clearCanonicalProjectFixtures

## Failure Modes

1. **Task already deleted by concurrent operation** → deleteTask returns false, NATS event not emitted, no-op ✓
2. **NATS event lost (pub/sub no JetStream)** → Session persists until TTL expiration (~24h), falls back to ephemeral cleanup ⚠️
3. **Dispatcher offline** → NATS emit still queued in-memory, lost on daemon crash → TTL fallback
4. **Restart during task.deleted subscription** → Snapshot re-resumes session, task doesn't exist in DB (separate Fix #2 for this)
5. **Concurrent deleteTask calls** → Only first wins (txn isolation), rest return false
6. **Session already aborted (race)** → abortSession is idempotent, no-op
7. **Orphaned artifacts** → Not covered by this fix; cascade cleanup handled separately
8. **DBDeleteTask without wrapper** → Direct dbDeleteTask calls still possible in tests/fixtures, must be migrated

## Validation

Pre-merge:
- [ ] Commit passes `bun typecheck && bun test && bunx biome check`
- [ ] Code review validates no direct dbDeleteTask calls remain in non-test prod code
- [ ] 3 call sites confirmed awaiting deleteTask async result

Post-merge (observational):
- [ ] Monitor zombie task-*-work sessions in production pool
- [ ] Count should stabilize at 0-1 (legitimate in_progress only)
- [ ] Measure slot reclaim latency (target <100ms via NATS)
- [ ] Watch for NATS emit failures in logs

## Related

- **Issue #71** — Zombie task session pool saturation (symptoms)
- **Spec daemon/restart/active-session-resume** — Prevents future session resurrection on restart (Fix #2, separate)
- **Spec ephemeral/runner** — TTL-based cleanup as safety net
