import { createHash } from "node:crypto";
import {
  getActiveProviderContinuityJournalForSession,
  getProviderContinuityEffect,
  requireProviderContinuityJournal,
  saveProviderContinuityEffect,
  saveProviderContinuityJournal,
  ProviderContinuityStoreError,
} from "./store.js";
import {
  PROVIDER_CONTINUITY_SNAPSHOT,
  providerContinuityContractHeader,
  providerContinuityEffectSchema,
  providerContinuityJournalSchema,
  type ProviderContinuityEffect,
  type ProviderContinuityJournal,
} from "./types.js";
import {
  providerContinuityFingerprint,
  recordProviderContinuityEvent,
  redactProviderContinuityValue,
} from "./events.js";
import { appendProviderContinuityToolRecord } from "./context.js";

export interface ProviderContinuityEffectPreparation {
  effect: ProviderContinuityEffect;
  journal: ProviderContinuityJournal;
  execute: boolean;
  deduplicated: boolean;
  reason: string;
}

export function buildProviderContinuityEffectId(input: {
  logicalRequestId: string;
  toolCallId: string;
  operation: string;
}): string {
  const digest = createHash("sha256")
    .update(`${input.logicalRequestId}\u0000${input.toolCallId}\u0000${input.operation}`)
    .digest("hex");
  return `pce_${digest}`;
}

function updateJournalEffect(input: {
  journal: ProviderContinuityJournal;
  effectId: string;
  boundary: ProviderContinuityJournal["effectBoundary"];
  state?: ProviderContinuityJournal["state"];
  holdReason?: ProviderContinuityJournal["holdReason"];
  now: number;
}): ProviderContinuityJournal {
  return saveProviderContinuityJournal(
    providerContinuityJournalSchema.parse({
      ...input.journal,
      activeEffectId: input.effectId,
      effectBoundary: input.boundary,
      ...(input.state ? { state: input.state } : {}),
      ...(input.holdReason !== undefined ? { holdReason: input.holdReason } : {}),
      updatedAt: input.now,
    }),
  );
}

function updateJournalToolRecord(input: {
  journal: ProviderContinuityJournal;
  effect: ProviderContinuityEffect;
  status: "requested" | "started" | "succeeded" | "failed" | "ambiguous";
  arguments?: unknown;
  output?: unknown;
  now: number;
}): ProviderContinuityJournal {
  return saveProviderContinuityJournal(
    providerContinuityJournalSchema.parse({
      ...input.journal,
      contextSnapshot: appendProviderContinuityToolRecord({
        context: input.journal.contextSnapshot,
        tool: {
          id: input.effect.toolCallId,
          name: input.effect.operation,
          input: input.arguments,
          output: input.output,
          status: input.status,
        },
      }),
      updatedAt: input.now,
    }),
  );
}

export function prepareProviderContinuityEffect(input: {
  logicalRequestId: string;
  toolCallId: string;
  operation: string;
  arguments: unknown;
  now?: number;
}): ProviderContinuityEffectPreparation {
  const now = input.now ?? Date.now();
  const journal = requireProviderContinuityJournal(input.logicalRequestId);
  if (journal.terminalOutcome !== null) {
    throw new Error(`Logical request '${input.logicalRequestId}' is already terminal.`);
  }
  const effectId = buildProviderContinuityEffectId(input);
  const inputFingerprint = providerContinuityFingerprint(input.arguments);
  const existing = getProviderContinuityEffect(effectId);
  if (existing) {
    if (
      existing.logicalRequestId !== input.logicalRequestId ||
      existing.toolCallId !== input.toolCallId ||
      existing.operation !== input.operation ||
      existing.inputFingerprint !== inputFingerprint
    ) {
      const held = updateJournalEffect({
        journal,
        effectId,
        boundary: "ambiguous",
        state: "reconciliation_required",
        holdReason: "idempotency_collision",
        now,
      });
      recordProviderContinuityEvent({
        logicalRequestId: journal.logicalRequestId,
        agentId: journal.agentId,
        type: "continuity.effect.collision",
        payload: { effectId, operation: input.operation },
        now,
      });
      throw new ProviderContinuityStoreError("conflict", `Effect id collision for '${effectId}'.`, {
        journalState: held.state,
      });
    }
    if (existing.status === "succeeded" || existing.status === "failed" || existing.status === "reconciled") {
      let recoveredJournal = journal;
      if (journal.activeEffectId === effectId && journal.effectBoundary !== "terminal") {
        recoveredJournal = updateJournalEffect({
          journal,
          effectId,
          boundary: "terminal",
          now,
        });
      }
      const reconciledOutcome =
        existing.status === "reconciled" &&
        existing.result &&
        typeof existing.result === "object" &&
        !Array.isArray(existing.result)
          ? existing.result.outcome
          : null;
      const terminalStatus = existing.status === "failed" || reconciledOutcome === "failed" ? "failed" : "succeeded";
      const toolRecord = recoveredJournal.contextSnapshot.toolRecords.find(
        (record) => record.id === existing.toolCallId,
      );
      if (
        toolRecord?.status !== terminalStatus ||
        toolRecord.outputFingerprint !== providerContinuityFingerprint(existing.result)
      ) {
        recoveredJournal = updateJournalToolRecord({
          journal: recoveredJournal,
          effect: existing,
          status: terminalStatus,
          output: existing.result,
          now,
        });
      }
      return {
        effect: existing,
        journal: recoveredJournal,
        execute: false,
        deduplicated: true,
        reason: `terminal_${existing.status}`,
      };
    }
    if (existing.status === "started" || existing.status === "ambiguous") {
      const heldBoundary = updateJournalEffect({
        journal,
        effectId,
        boundary: "ambiguous",
        state: "reconciliation_required",
        holdReason: "effect_ambiguous",
        now,
      });
      const held = updateJournalToolRecord({
        journal: heldBoundary,
        effect: existing,
        status: "ambiguous",
        arguments: input.arguments,
        now,
      });
      return {
        effect: existing,
        journal: held,
        execute: false,
        deduplicated: true,
        reason: "reconciliation_required",
      };
    }
    return {
      effect: existing,
      journal,
      execute: true,
      deduplicated: false,
      reason: "resume_persisted_intention",
    };
  }

  const effect = saveProviderContinuityEffect(
    providerContinuityEffectSchema.parse({
      effectId,
      logicalRequestId: input.logicalRequestId,
      toolCallId: input.toolCallId,
      operation: input.operation,
      inputFingerprint,
      status: "intention",
      result: null,
      evidenceFingerprint: null,
      createdAt: now,
      updatedAt: now,
      compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
    }),
  );
  const boundaryJournal = updateJournalEffect({
    journal,
    effectId,
    boundary: "intention",
    now,
  });
  const updatedJournal = updateJournalToolRecord({
    journal: boundaryJournal,
    effect,
    status: "requested",
    arguments: input.arguments,
    now,
  });
  recordProviderContinuityEvent({
    logicalRequestId: journal.logicalRequestId,
    agentId: journal.agentId,
    type: "continuity.effect.intended",
    payload: { effectId, toolCallId: input.toolCallId, operation: input.operation, inputFingerprint },
    now,
  });
  return {
    effect,
    journal: updatedJournal,
    execute: true,
    deduplicated: false,
    reason: "new_intention",
  };
}

export function markProviderContinuityEffectStarted(effectId: string, now = Date.now()) {
  const current = getProviderContinuityEffect(effectId);
  if (!current) throw new Error(`Provider continuity effect not found: ${effectId}.`);
  if (current.status === "succeeded" || current.status === "failed" || current.status === "reconciled") {
    return { effect: current, journal: requireProviderContinuityJournal(current.logicalRequestId) };
  }
  const effect = saveProviderContinuityEffect(
    providerContinuityEffectSchema.parse({ ...current, status: "started", updatedAt: now }),
  );
  const boundaryJournal = updateJournalEffect({
    journal: requireProviderContinuityJournal(current.logicalRequestId),
    effectId,
    boundary: "started",
    now,
  });
  const journal = updateJournalToolRecord({
    journal: boundaryJournal,
    effect,
    status: "started",
    now,
  });
  recordProviderContinuityEvent({
    logicalRequestId: journal.logicalRequestId,
    agentId: journal.agentId,
    type: "continuity.effect.started",
    payload: { effectId, operation: effect.operation },
    now,
  });
  return { effect, journal };
}

export function completeProviderContinuityEffect(input: {
  effectId: string;
  outcome: "succeeded" | "failed";
  result?: unknown;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const current = getProviderContinuityEffect(input.effectId);
  if (!current) throw new Error(`Provider continuity effect not found: ${input.effectId}.`);
  if (current.status === "succeeded" || current.status === "failed" || current.status === "reconciled") {
    const boundaryJournal = updateJournalEffect({
      journal: requireProviderContinuityJournal(current.logicalRequestId),
      effectId: current.effectId,
      boundary: "terminal",
      now,
    });
    const reconciledOutcome =
      current.status === "reconciled" &&
      current.result &&
      typeof current.result === "object" &&
      !Array.isArray(current.result)
        ? current.result.outcome
        : null;
    const journal = updateJournalToolRecord({
      journal: boundaryJournal,
      effect: current,
      status: current.status === "failed" || reconciledOutcome === "failed" ? "failed" : "succeeded",
      output: current.result,
      now,
    });
    return {
      effect: current,
      journal,
      deduplicated: true,
    };
  }
  const effect = saveProviderContinuityEffect(
    providerContinuityEffectSchema.parse({
      ...current,
      status: input.outcome,
      result: redactProviderContinuityValue(input.result ?? null),
      updatedAt: now,
    }),
  );
  const boundaryJournal = updateJournalEffect({
    journal: requireProviderContinuityJournal(current.logicalRequestId),
    effectId: current.effectId,
    boundary: "terminal",
    now,
  });
  const journal = updateJournalToolRecord({
    journal: boundaryJournal,
    effect,
    status: input.outcome,
    output: input.result,
    now,
  });
  recordProviderContinuityEvent({
    logicalRequestId: journal.logicalRequestId,
    agentId: journal.agentId,
    type: `continuity.effect.${input.outcome}`,
    payload: { effectId: effect.effectId, operation: effect.operation },
    now,
  });
  return { effect, journal, deduplicated: false };
}

export function markProviderContinuityEffectAmbiguous(input: { effectId: string; error?: unknown; now?: number }) {
  const now = input.now ?? Date.now();
  const current = getProviderContinuityEffect(input.effectId);
  if (!current) throw new Error(`Provider continuity effect not found: ${input.effectId}.`);
  if (current.status === "succeeded" || current.status === "failed" || current.status === "reconciled") {
    return { effect: current, journal: requireProviderContinuityJournal(current.logicalRequestId) };
  }
  const effect = saveProviderContinuityEffect(
    providerContinuityEffectSchema.parse({
      ...current,
      status: "ambiguous",
      result: null,
      evidenceFingerprint: input.error === undefined ? null : providerContinuityFingerprint(input.error),
      updatedAt: now,
    }),
  );
  const boundaryJournal = updateJournalEffect({
    journal: requireProviderContinuityJournal(current.logicalRequestId),
    effectId: current.effectId,
    boundary: "ambiguous",
    state: "reconciliation_required",
    holdReason: "effect_ambiguous",
    now,
  });
  const journal = updateJournalToolRecord({
    journal: boundaryJournal,
    effect,
    status: "ambiguous",
    now,
  });
  recordProviderContinuityEvent({
    logicalRequestId: journal.logicalRequestId,
    agentId: journal.agentId,
    type: "continuity.effect.ambiguous",
    payload: {
      effectId: effect.effectId,
      operation: effect.operation,
      evidenceFingerprint: effect.evidenceFingerprint,
    },
    now,
  });
  return { effect, journal };
}

export function reconcileProviderContinuityEffect(input: {
  effectId: string;
  outcome: "succeeded" | "failed";
  evidenceRef: string;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const current = getProviderContinuityEffect(input.effectId);
  if (!current) throw new Error(`Provider continuity effect not found: ${input.effectId}.`);
  const evidenceFingerprint = providerContinuityFingerprint(input.evidenceRef);
  if (current.status === "reconciled") {
    if (
      current.evidenceFingerprint !== evidenceFingerprint ||
      (current.result as { outcome?: string } | null)?.outcome !== input.outcome
    ) {
      throw new Error(`Effect '${input.effectId}' was already reconciled with different evidence or outcome.`);
    }
    return {
      ...providerContinuityContractHeader(),
      changed: false,
      effect: current,
      journal: requireProviderContinuityJournal(current.logicalRequestId),
    };
  }
  if (current.status !== "started" && current.status !== "ambiguous") {
    throw new Error(
      `Effect '${input.effectId}' is ${current.status}; only started or ambiguous effects can be reconciled.`,
    );
  }
  const effect = saveProviderContinuityEffect(
    providerContinuityEffectSchema.parse({
      ...current,
      status: "reconciled",
      result: { outcome: input.outcome },
      evidenceFingerprint,
      updatedAt: now,
    }),
  );
  const boundaryJournal = saveProviderContinuityJournal(
    providerContinuityJournalSchema.parse({
      ...requireProviderContinuityJournal(current.logicalRequestId),
      effectBoundary: "terminal",
      activeEffectId: current.effectId,
      state: "pending",
      holdReason: null,
      terminalDetail: `effect_reconciled_${input.outcome}`,
      updatedAt: now,
    }),
  );
  const journal = updateJournalToolRecord({
    journal: boundaryJournal,
    effect,
    status: input.outcome,
    output: effect.result,
    now,
  });
  recordProviderContinuityEvent({
    logicalRequestId: journal.logicalRequestId,
    agentId: journal.agentId,
    type: "continuity.effect.reconciled",
    payload: { effectId: effect.effectId, outcome: input.outcome, evidenceFingerprint },
    now,
  });
  return { ...providerContinuityContractHeader(), changed: true, effect, journal };
}

export function findActiveProviderContinuityEffectContext(sessionName: string): {
  journal: ProviderContinuityJournal;
} | null {
  const journal = getActiveProviderContinuityJournalForSession(sessionName);
  return journal ? { journal } : null;
}
