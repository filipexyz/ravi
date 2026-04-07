import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

export const EVAL_SPEC_VERSION = 1 as const;

const EvalSessionSpecSchema = z
  .object({
    name: z.string().min(1),
    agentId: z.string().min(1).optional(),
  })
  .strict();

const EvalFileArtifactSpecSchema = z
  .object({
    path: z.string().min(1),
    label: z.string().min(1).optional(),
  })
  .strict();

const EvalArtifactsSpecSchema = z
  .object({
    files: z.array(EvalFileArtifactSpecSchema).default([]),
    transcript: z.boolean().default(true),
  })
  .strict()
  .default({
    files: [],
    transcript: true,
  });

const EvalRunnerSpecSchema = z
  .object({
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(120_000),
  })
  .strict()
  .default({
    timeoutMs: 120_000,
  });

const EvalCriterionBaseSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1).optional(),
  })
  .strict();

const ResponseContainsCriterionSchema = EvalCriterionBaseSchema.extend({
  type: z.literal("response.contains"),
  needle: z.string().min(1),
});

const TranscriptContainsCriterionSchema = EvalCriterionBaseSchema.extend({
  type: z.literal("transcript.contains"),
  needle: z.string().min(1),
});

const FileExistsCriterionSchema = EvalCriterionBaseSchema.extend({
  type: z.literal("file.exists"),
  path: z.string().min(1),
});

const FileContainsCriterionSchema = EvalCriterionBaseSchema.extend({
  type: z.literal("file.contains"),
  path: z.string().min(1),
  needle: z.string().min(1),
});

const FileChangedCriterionSchema = EvalCriterionBaseSchema.extend({
  type: z.literal("file.changed"),
  path: z.string().min(1),
});

export const EvalCriterionSchema = z.discriminatedUnion("type", [
  ResponseContainsCriterionSchema,
  TranscriptContainsCriterionSchema,
  FileExistsCriterionSchema,
  FileContainsCriterionSchema,
  FileChangedCriterionSchema,
]);

export const EvalTaskSpecSchema = z
  .object({
    version: z.literal(EVAL_SPEC_VERSION).default(EVAL_SPEC_VERSION),
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    prompt: z.string().min(1),
    session: EvalSessionSpecSchema,
    artifacts: EvalArtifactsSpecSchema,
    rubric: z.array(EvalCriterionSchema).min(1),
    runner: EvalRunnerSpecSchema,
  })
  .strict();

export type EvalTaskSpec = z.infer<typeof EvalTaskSpecSchema>;
export type EvalCriterion = z.infer<typeof EvalCriterionSchema>;

export interface LoadedEvalTaskSpec {
  path: string;
  baseDir: string;
  spec: EvalTaskSpec;
}

export function loadEvalTaskSpec(path: string): LoadedEvalTaskSpec {
  const absolutePath = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const raw = readFileSync(absolutePath, "utf8");
  const parsed = EvalTaskSpecSchema.parse(JSON.parse(raw));
  return {
    path: absolutePath,
    baseDir: dirname(absolutePath),
    spec: parsed,
  };
}

export function resolveEvalSpecPath(task: LoadedEvalTaskSpec, candidate: string): string {
  return isAbsolute(candidate) ? candidate : resolve(task.baseDir, candidate);
}
