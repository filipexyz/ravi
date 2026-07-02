import { z } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const jsonArraySchema = z.array(jsonValueSchema);

export const looseObjectSchema = jsonObjectSchema;

export const stringMapSchema = z.record(z.string(), jsonValueSchema);

export const stringNumberRecordSchema = z.record(z.string(), z.number());

export const strictCliOffsetPaginationSchema = z.object({
  limit: z.number(),
  offset: z.number(),
  returned: z.number(),
  total: z.number(),
  hasMore: z.boolean().optional(),
  nextOffset: z.number().nullable().optional(),
  nextCommand: z.string().nullable().optional(),
});

export const cliOffsetPaginationSchema = z.object({
  limit: z.number(),
  offset: z.number(),
  returned: z.number(),
  total: z.number(),
  hasMore: z.boolean().optional(),
  nextOffset: z.number().nullable().optional(),
  nextCommand: z.string().nullable().optional(),
});

export const cliCursorPageSchema = z.object({
  limit: z.number(),
  count: z.number(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  nextCommand: z.string().nullable(),
  sort: z.string().optional(),
  order: z.string().optional(),
});

export const commandTargetSchema = z.object({ type: z.string() });

export const mutationAckSchema = z.object({
  success: z.boolean().optional(),
  status: z.string().optional(),
  action: z.string().optional(),
  changed: z.boolean().optional(),
  changedCount: z.number().optional(),
  target: commandTargetSchema.optional(),
});
