/**
 * Public CLI commands that still lack an explicit @Returns schema.
 *
 * This is an intentional debt baseline, not an allow-forever list. The
 * return-schema coverage test requires the live registry to match this list
 * exactly, so adding a new SDK/OpenAPI command without @Returns fails tests,
 * and typing an existing command requires removing it from this baseline.
 */

export const UNTYPED_PUBLIC_RETURN_COMMANDS_BASELINE = [] as const;
