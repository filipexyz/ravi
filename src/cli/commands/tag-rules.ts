import "reflect-metadata";
import { readFileSync, statSync } from "node:fs";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
import {
  evaluateRulesForContact,
  loadTagRulesFromDirectory,
  parseTagRuleFromString,
  runTagRulesForContact,
  tickTagRules,
  type ApplyRuleResult,
  type TagRule,
} from "../../tag-rules/index.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function resolveContactRef(target: string): string {
  const cleaned = target.trim();
  if (!cleaned) fail("Target must be a non-empty value");
  if (cleaned.startsWith("contact:")) return cleaned.slice("contact:".length);
  return cleaned;
}

interface RuleSummary {
  id: string;
  enabled: boolean;
  scope: TagRule["scope"];
  priority: number;
  conditions: number;
  apply: number;
  description: string | null;
  source: string | null;
}

function summarizeRule(rule: TagRule, source?: string): RuleSummary {
  return {
    id: rule.id,
    enabled: rule.enabled,
    scope: rule.scope,
    priority: rule.priority,
    conditions: rule.conditions.length,
    apply: rule.apply.length,
    description: rule.description ?? null,
    source: source ?? null,
  };
}

function summarizeOutcome(outcome: ApplyRuleResult): Record<string, unknown> {
  return {
    ruleId: outcome.ruleId,
    matched: outcome.matched,
    applied: outcome.applied.map((entry) => ({
      added: entry.added,
      removed: entry.removed,
      noop: entry.noop,
    })),
    skipped: outcome.skipped,
  };
}

@Group({
  name: "tag-rules",
  description: "Deterministic tag classification rules",
  scope: "admin",
})
export class TagRulesCommands {
  @Command({ name: "list", description: "List loaded tag rules from .ravi/tag-rules" })
  list(
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of rules to skip (default: 0)" }) offset?: string,
  ): unknown {
    const loaded = loadTagRulesFromDirectory();
    const all = loaded.rules.map((entry) => summarizeRule(entry.rule, entry.source));
    const pageLimit = limit ? Math.max(1, Number(limit)) : 50;
    const pageOffset = offset ? Math.max(0, Number(offset)) : 0;
    const summary = all.slice(pageOffset, pageOffset + pageLimit);
    const total = all.length;
    if (asJson) {
      const payload = {
        rules: summary,
        errors: loaded.errors,
        pagination: { total, limit: pageLimit, offset: pageOffset, returned: summary.length },
      };
      printJson(payload);
      return payload;
    }
    console.log(
      `Loaded ${total} rule(s) (showing ${summary.length})${loaded.errors.length ? `, ${loaded.errors.length} error(s)` : ""}`,
    );
    for (const rule of summary) {
      console.log(`  ${rule.id.padEnd(28)} scope=${rule.scope} priority=${rule.priority} apply=${rule.apply}`);
    }
    for (const error of loaded.errors) {
      console.log(`  ! ${error.source}: ${error.error}`);
    }
    return { rules: summary, errors: loaded.errors, pagination: { total, limit: pageLimit, offset: pageOffset } };
  }

  @Command({ name: "show", description: "Show a single rule definition" })
  show(
    @Arg("id", { description: "Rule id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ): unknown {
    const loaded = loadTagRulesFromDirectory();
    const entry = loaded.rules.find((candidate) => candidate.rule.id === id);
    if (!entry) fail(`Rule not found: ${id}`);
    if (asJson) {
      printJson({ rule: entry.rule, source: entry.source });
      return { rule: entry.rule, source: entry.source };
    }
    console.log(JSON.stringify(entry.rule, null, 2));
    return { rule: entry.rule, source: entry.source };
  }

  @Command({ name: "validate", description: "Validate all rule files without applying" })
  validate(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean): unknown {
    const loaded = loadTagRulesFromDirectory();
    const ok = loaded.errors.length === 0;
    const payload = {
      status: ok ? ("ok" as const) : ("error" as const),
      ruleCount: loaded.rules.length,
      errors: loaded.errors,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`status=${payload.status} rules=${payload.ruleCount} errors=${payload.errors.length}`);
      for (const error of loaded.errors) {
        console.log(`  ! ${error.source}: ${error.error}`);
      }
    }
    if (!ok) process.exitCode = 1;
    return payload;
  }

  @Command({ name: "explain", description: "Explain which rules currently match a target asset (dry-run)" })
  explain(
    @Option({ flags: "--target <ref>", description: "Target (e.g. contact:<id>)" }) target?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ): unknown {
    if (!target) fail("Provide --target contact:<id>");
    const contactRef = resolveContactRef(target);
    const result = runTagRulesForContact({
      contactRef,
      cause: { evaluation: "manual", triggerType: "cli-explain" },
      apply: false,
    });
    const payload = {
      target: { type: "contact", id: contactRef },
      rules: result.rules,
      loaded: { errors: result.loaded.errors, count: result.loaded.rules.length },
      outcomes: result.outcomes.map((outcome) => ({
        ruleId: outcome.ruleId,
        matched: outcome.matched,
        wouldApply: outcome.applied
          .filter((entry) => !entry.noop)
          .map((entry) => ({ added: entry.added, removed: entry.removed })),
        skipped: outcome.skipped,
        trace: outcome.trace,
      })),
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`target=contact:${contactRef}`);
    console.log(
      `rules total=${payload.rules.total} matched=${payload.rules.matched} would-apply=${payload.rules.appliedActions}`,
    );
    for (const outcome of payload.outcomes) {
      const status = outcome.matched ? "MATCH" : "miss";
      const summary = outcome.wouldApply
        .map((entry) => `+[${entry.added.join(",")}] -[${entry.removed.join(",")}]`)
        .join(" ");
      console.log(`  [${status}] ${outcome.ruleId.padEnd(28)} ${summary}`);
      if (outcome.skipped.length > 0) {
        for (const skip of outcome.skipped) {
          console.log(`    ! skipped ${skip.reason}`);
        }
      }
    }
    return payload;
  }

  @Command({ name: "tick", description: "Run all rules against all contacts (use for cron/periodic schedules)" })
  async tick(
    @Option({ flags: "--apply", description: "Apply tag changes (default: dry-run)" }) applyChanges?: boolean,
    @Option({ flags: "--limit <n>", description: "Limit number of contacts processed" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ): Promise<unknown> {
    const limitNumber = limit ? Number(limit) : undefined;
    if (limit !== undefined && (!Number.isFinite(limitNumber) || (limitNumber ?? 0) < 1)) {
      fail("--limit must be a positive number");
    }
    const result = await tickTagRules({
      apply: Boolean(applyChanges),
      limit: limitNumber,
      cause: { evaluation: "periodic", triggerType: "cli-tick" },
    });
    if (asJson) {
      printJson(result);
      return result;
    }
    console.log(
      `rules=${result.rulesLoaded} contacts=${result.contactsProcessed} matched=${result.matched} applied=${result.appliedActions}`,
    );
    for (const contact of result.contacts) {
      console.log(`  ${contact.contactId.padEnd(28)} matched=${contact.matched} applied=${contact.appliedActions}`);
    }
    return result;
  }

  @Command({ name: "evaluate", description: "Evaluate a rule against a target asset" })
  evaluate(
    @Arg("ruleId", { description: "Rule id to evaluate" }) ruleId: string,
    @Option({ flags: "--target <ref>", description: "Target (e.g. contact:<id>)" }) target?: string,
    @Option({ flags: "--apply", description: "Actually apply tag changes (default: dry-run)" }) applyChanges?: boolean,
    @Option({ flags: "--file <path>", description: "Load rule from a file path instead of the registry" })
    file?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ): unknown {
    if (!target) fail("Provide --target contact:<id>");
    const contactRef = resolveContactRef(target);

    let rule: TagRule | null = null;
    if (file) {
      try {
        const stat = statSync(file);
        if (!stat.isFile()) fail(`Rule file is not a regular file: ${file}`);
      } catch (error) {
        fail(`Cannot read rule file: ${(error as Error).message}`);
      }
      rule = parseTagRuleFromString(readFileSync(file, "utf8"));
    } else {
      const loaded = loadTagRulesFromDirectory();
      const entry = loaded.rules.find((candidate) => candidate.rule.id === ruleId);
      if (!entry) fail(`Rule not found in registry: ${ruleId}`);
      rule = entry.rule;
    }
    if (!rule) fail(`Rule could not be resolved: ${ruleId}`);

    const outcomes = evaluateRulesForContact({
      rules: [rule],
      contactRef,
      cause: { evaluation: "manual", triggerType: "cli" },
      apply: Boolean(applyChanges),
    });

    const payload = {
      ruleId: rule.id,
      target: { type: "contact", id: contactRef },
      apply: Boolean(applyChanges),
      outcomes: outcomes.map(summarizeOutcome),
      traces: outcomes.map((outcome) => ({ ruleId: outcome.ruleId, trace: outcome.trace })),
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(JSON.stringify(payload, null, 2));
    }
    return payload;
  }
}
