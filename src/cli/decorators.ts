/**
 * CLI Decorators - Commander.js + Decorators pattern
 *
 * Provides declarative command definition similar to NestJS/oclif
 */

import type { ZodTypeAny } from "zod";

// Symbols for metadata storage
const GROUP_KEY = Symbol("cli:group");
const COMMANDS_KEY = Symbol("cli:commands");
const ARGS_KEY = Symbol("cli:args");
const OPTIONS_KEY = Symbol("cli:options");
const SCOPE_KEY = Symbol("cli:scope");
const RETURNS_KEY = Symbol("cli:returns");
const RETURNS_BINARY_KEY = Symbol("cli:returns:binary");
const CLI_ONLY_KEY = Symbol("cli:cliOnly");
const SKILL_GATE_KEY = Symbol("cli:skillGate");

// Types

/**
 * Scope types for command access control.
 *
 * - "superadmin"    — Only superadmin (admin relation on system:*). Auto-enforced.
 * - "admin"         — Only agents with execute relation on the group. Auto-enforced.
 * - "writeContacts" — Only agents with contactScope "all". Auto-enforced.
 * - "resource"      — Marker only; method must check canAccessResource() inline.
 * - "open"          — No restrictions.
 */
export type ScopeType = "superadmin" | "admin" | "writeContacts" | "resource" | "open";

export interface GroupOptions {
  name: string;
  description: string;
  scope?: ScopeType;
  skillGate?: SkillGateInput;
}

export interface CommandOptions {
  name: string;
  description: string;
  aliases?: string[];
  skillGate?: SkillGateInput;
}

export type SkillGateInput = string | SkillGateOptions | false;

export interface SkillGateOptions {
  skill: string;
}

export interface SkillGateMetadata {
  skill: string;
  source: "decorator" | "group" | "command" | "inferred" | "config";
}

export interface ArgOptions {
  required?: boolean;
  description?: string;
  defaultValue?: unknown;
  variadic?: boolean;
  schema?: ZodTypeAny;
}

export interface OptionOptions {
  flags: string;
  description?: string;
  defaultValue?: unknown;
  schema?: ZodTypeAny;
}

export interface ArgMetadata extends ArgOptions {
  name: string;
  index: number;
}

export interface OptionMetadata extends OptionOptions {
  propertyKey: string;
  index: number;
}

export interface CommandMetadata extends CommandOptions {
  method: string;
}

/**
 * @Group decorator - marks a class as a command group
 */
export function Group(options: GroupOptions) {
  return (target: Function) => {
    Reflect.defineMetadata(GROUP_KEY, options, target);
  };
}

/**
 * @Command decorator - marks a method as a command within a group
 */
export function Command(options: CommandOptions) {
  return (target: object, propertyKey: string, _descriptor: PropertyDescriptor) => {
    const commands: CommandMetadata[] = Reflect.getMetadata(COMMANDS_KEY, target.constructor) || [];
    commands.push({ ...options, method: propertyKey });
    Reflect.defineMetadata(COMMANDS_KEY, commands, target.constructor);
  };
}

/**
 * @RequiresSkill decorator - declares that a command must load a skill before use.
 *
 * This only records metadata. Runtime surfaces decide when to enforce it:
 * provider dynamic tools and SDK gateway calls can gate against session
 * `loadedSkills`; local human CLI execution remains unchanged.
 */
export function RequiresSkill(options: SkillGateInput) {
  return (target: object, propertyKey: string, _descriptor: PropertyDescriptor) => {
    const gate = normalizeSkillGateInput(options, "decorator");
    if (gate === undefined) {
      throw new Error("@RequiresSkill requires a skill gate declaration.");
    }
    const gates: Map<string, SkillGateMetadata | false> =
      Reflect.getMetadata(SKILL_GATE_KEY, target.constructor) || new Map();
    gates.set(propertyKey, gate);
    Reflect.defineMetadata(SKILL_GATE_KEY, gates, target.constructor);
  };
}

export const SkillGate = RequiresSkill;

/**
 * @Scope decorator - declares the access scope for a command method.
 * Overrides the group-level scope for this specific command.
 */
export function Scope(type: ScopeType) {
  return (target: object, propertyKey: string, _descriptor: PropertyDescriptor) => {
    const scopes: Map<string, ScopeType> = Reflect.getMetadata(SCOPE_KEY, target.constructor) || new Map();
    scopes.set(propertyKey, type);
    Reflect.defineMetadata(SCOPE_KEY, scopes, target.constructor);
  };
}

/**
 * @Arg decorator - marks a method parameter as a positional argument
 */
export function Arg(name: string, options: ArgOptions = {}) {
  return (target: object, propertyKey: string, parameterIndex: number) => {
    const args: ArgMetadata[] = Reflect.getMetadata(ARGS_KEY, target, propertyKey) || [];
    args.push({ name, index: parameterIndex, required: true, ...options });
    Reflect.defineMetadata(ARGS_KEY, args, target, propertyKey);
  };
}

/**
 * @Option decorator - marks a method parameter as a flag option
 */
export function Option(options: OptionOptions) {
  return (target: object, propertyKey: string, parameterIndex: number) => {
    const opts: OptionMetadata[] = Reflect.getMetadata(OPTIONS_KEY, target, propertyKey) || [];
    opts.push({ ...options, propertyKey, index: parameterIndex });
    Reflect.defineMetadata(OPTIONS_KEY, opts, target, propertyKey);
  };
}

/**
 * @Returns decorator - declares the Zod schema for a command's return value.
 * Used by the schema registry to expose typed return shapes to SDK consumers.
 *
 * For commands that return binary payloads (e.g. file blobs) and cannot be
 * encoded as JSON, use `@Returns.binary()` instead. The dispatcher will skip
 * Zod return-shape validation and pass the handler's `Response` through
 * unchanged. SDK codegen emits `Promise<Response>` for these methods.
 */
export function Returns(schema: ZodTypeAny) {
  return (target: object, propertyKey: string, _descriptor: PropertyDescriptor) => {
    const map: Map<string, ZodTypeAny> = Reflect.getMetadata(RETURNS_KEY, target.constructor) || new Map();
    map.set(propertyKey, schema);
    Reflect.defineMetadata(RETURNS_KEY, map, target.constructor);
  };
}

Returns.binary = () => (target: object, propertyKey: string, _descriptor: PropertyDescriptor) => {
  const set: Set<string> = Reflect.getMetadata(RETURNS_BINARY_KEY, target.constructor) || new Set();
  set.add(propertyKey);
  Reflect.defineMetadata(RETURNS_BINARY_KEY, set, target.constructor);
};

/**
 * @CliOnly decorator - marks a command as CLI-exclusive.
 *
 * The command is excluded from the SDK gateway route table, OpenAPI emit, and
 * client codegen. Use for handlers that have no remote-call semantics:
 *
 * - Streaming/long-lived loops (NATS subscribe, file watchers, polling) that
 *   never return a JSON-safe payload.
 * - Process-level commands (daemon bootstrap, dev watcher) that only make
 *   sense as foreground entry points.
 * - Interactive commands that exec a foreground client (tmux attach,
 *   instances connect).
 *
 * The handler stays callable via the local CLI; only the SDK surface ignores
 * it. When a streaming consumer eventually needs over-the-wire access, design
 * a dedicated SSE endpoint instead of forcing the request/response dispatcher.
 */
export function CliOnly() {
  return (target: object, propertyKey: string, _descriptor: PropertyDescriptor) => {
    const set: Set<string> = Reflect.getMetadata(CLI_ONLY_KEY, target.constructor) || new Set();
    set.add(propertyKey);
    Reflect.defineMetadata(CLI_ONLY_KEY, set, target.constructor);
  };
}

// Metadata getters
export function getGroupMetadata(target: Function): GroupOptions | undefined {
  return Reflect.getMetadata(GROUP_KEY, target);
}

export function getCommandsMetadata(target: Function): CommandMetadata[] {
  return Reflect.getMetadata(COMMANDS_KEY, target) || [];
}

export function getArgsMetadata(target: object, propertyKey: string): ArgMetadata[] {
  const args = Reflect.getMetadata(ARGS_KEY, target, propertyKey) || [];
  // Sort by index to maintain parameter order
  return args.sort((a: ArgMetadata, b: ArgMetadata) => a.index - b.index);
}

export function getOptionsMetadata(target: object, propertyKey: string): OptionMetadata[] {
  return Reflect.getMetadata(OPTIONS_KEY, target, propertyKey) || [];
}

export function getScopeMetadata(target: Function): Map<string, ScopeType> {
  return Reflect.getMetadata(SCOPE_KEY, target) || new Map();
}

export function getReturnsMetadata(target: Function): Map<string, ZodTypeAny> {
  return Reflect.getMetadata(RETURNS_KEY, target) || new Map();
}

export function getReturnsBinaryMetadata(target: Function): Set<string> {
  return Reflect.getMetadata(RETURNS_BINARY_KEY, target) || new Set();
}

export function getCliOnlyMetadata(target: Function): Set<string> {
  return Reflect.getMetadata(CLI_ONLY_KEY, target) || new Set();
}

export function getSkillGateMetadata(target: Function): Map<string, SkillGateMetadata | false> {
  return Reflect.getMetadata(SKILL_GATE_KEY, target) || new Map();
}

export function normalizeSkillGateInput(
  input: SkillGateInput | undefined,
  source: SkillGateMetadata["source"],
): SkillGateMetadata | false | undefined {
  if (input === undefined) return undefined;
  if (input === false) return false;

  const options = typeof input === "string" ? { skill: input } : input;
  const skill = options.skill.trim();
  if (!skill) {
    throw new Error("Skill gate requires a non-empty skill name.");
  }
  return {
    skill,
    source,
  };
}
