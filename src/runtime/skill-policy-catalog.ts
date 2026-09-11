import { basename, dirname } from "node:path";
import { listGroupSkillRules } from "../cli/skill-gates.js";
import {
  copySkillCatalogEntry,
  parseSkillRequirement,
  skillPolicyHash,
  type SkillCatalogEntry,
  type SkillPolicyDiagnostic,
  type SkillRequirement,
} from "./skill-policy.js";

export interface SkillPolicyCatalogSource {
  readonly name: string;
  readonly description?: string;
  readonly path: string;
  readonly skillFilePath: string;
  readonly content: string;
  readonly source: string;
  readonly pluginName?: string;
  readonly files?: readonly { readonly path: string; readonly content: string }[];
}

export interface SkillPolicyCatalog {
  readonly entries: readonly SkillCatalogEntry[];
  readonly revision: string;
  readonly diagnostics: readonly SkillPolicyDiagnostic[];
}

export function buildSkillPolicyCatalog(sources: readonly SkillPolicyCatalogSource[]): SkillPolicyCatalog {
  const entries: SkillCatalogEntry[] = [];
  const diagnostics: SkillPolicyDiagnostic[] = [];
  const sourceRevisions: string[] = [];
  for (const source of sources) {
    const namespace = source.pluginName ?? source.source;
    const id = `${namespace}:${source.name}`;
    sourceRevisions.push(skillPolicyHash({ ...source }));
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id) ||
      !source.name.trim() ||
      !namespace.trim() ||
      !source.skillFilePath.trim()
    ) {
      diagnostics.push({ skillId: id, code: "invalid-identity" });
      continue;
    }
    const metadata = readRequirements(source.content);
    if (metadata.state === "invalid") {
      diagnostics.push({ skillId: id, code: "invalid-requirements" });
      continue;
    }
    const requirements = metadata.state === "declared" ? metadata.requirements : migratedInternalRequirements(source);
    if (!requirements) diagnostics.push({ skillId: id, code: "missing-requirements" });
    const directoryName = basename(source.path);
    const aliases = [source.name, directoryName];
    if (source.pluginName) {
      aliases.push(
        `${source.pluginName}:${directoryName}`,
        `${source.pluginName}-${source.name}`,
        `${source.pluginName}-${directoryName}`,
      );
    }
    entries.push(
      copySkillCatalogEntry({
        id,
        aliases: aliases.filter(Boolean),
        name: source.name,
        ...(source.description === undefined ? {} : { description: source.description }),
        resource: {
          path: source.skillFilePath,
          ...(source.pluginName && !source.source.startsWith("catalog:")
            ? { pluginPath: dirname(dirname(source.path)) }
            : {}),
          // Packaged internal sources have no on-disk source tree; retain their authorized files.
          ...(source.files ? { files: source.files } : {}),
        },
        ...(requirements ? { requirements } : {}),
      }),
    );
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));
  diagnostics.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return Object.freeze({
    entries: Object.freeze(entries),
    revision: skillPolicyHash({ metadataVersion: 1, sources: sourceRevisions.sort() }),
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
  });
}

function readRequirements(
  content: string,
): { state: "missing" } | { state: "invalid" } | { state: "declared"; requirements: SkillRequirement } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if (frontmatter === undefined) return { state: "missing" };
  const declarations = frontmatter.split(/\r?\n/).filter((line) => /^ravi\.requires\s*:/.test(line));
  if (declarations.length === 0) return { state: "missing" };
  if (declarations.length !== 1) return { state: "invalid" };
  const declaration = declarations[0];
  if (declaration === undefined) return { state: "invalid" };
  try {
    const value: unknown = JSON.parse(declaration.slice(declaration.indexOf(":") + 1));
    const requirements = parseSkillRequirement(value);
    return requirements ? { state: "declared", requirements } : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

/** Existing first-party group declarations provide a narrow migration, never a custom-skill default. */
function migratedInternalRequirements(source: SkillPolicyCatalogSource): SkillRequirement | undefined {
  if (
    !source.pluginName ||
    !["ravi-system", "ravi-dev"].includes(source.pluginName) ||
    !source.source.startsWith(`catalog:${source.pluginName}/`)
  )
    return undefined;
  const slug = `${source.pluginName}-${source.name}`;
  const groups = listGroupSkillRules()
    .filter((rule) => rule.skill === slug)
    .flatMap((rule) => {
      if (rule.id === "routes") return ["routes", "instances.routes"];
      if (rule.id === "prox-calls") return ["prox.calls"];
      if (rule.id === "whatsapp") return ["whatsapp.dm", "whatsapp.group"];
      return [rule.id];
    });
  return groups.length > 0
    ? parseSkillRequirement({ kind: "any-of", alternatives: groups.map((group) => [`ravi.cli.${group}`]) })
    : undefined;
}
