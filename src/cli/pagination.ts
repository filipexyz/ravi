import { fail } from "./context.js";
import {
  buildCommand,
  buildOffsetPagination,
  paginateItems,
  type LimitOffsetOptions,
  type ListPage,
  type OffsetPagination,
} from "../utils/pagination.js";

export const DEFAULT_CLI_LIST_LIMIT = 50;
export const MAX_CLI_LIST_LIMIT = 500;

export interface CliListPageOptions extends LimitOffsetOptions {
  defaultLimit?: number;
  maxLimit?: number;
}

export function parseCliListLimit(value: string | number | null | undefined, options: CliListPageOptions = {}): number {
  return parseBoundedIntegerOption(value, "--limit", {
    defaultValue: options.defaultLimit ?? DEFAULT_CLI_LIST_LIMIT,
    min: options.minLimit ?? 1,
    max: options.maxLimit ?? MAX_CLI_LIST_LIMIT,
  });
}

export function parseCliListOffset(value: string | number | null | undefined): number {
  return parseBoundedIntegerOption(value, "--offset", {
    defaultValue: 0,
    min: 0,
  });
}

export function paginateCliItems<T>(
  items: readonly T[],
  input: { limit?: string | number | null; offset?: string | number | null },
  options: CliListPageOptions = {},
): ListPage<T> {
  return paginateItems(
    items,
    {
      limit: parseCliListLimit(input.limit, options),
      offset: parseCliListOffset(input.offset),
    },
    {
      defaultLimit: options.defaultLimit ?? DEFAULT_CLI_LIST_LIMIT,
      maxLimit: options.maxLimit ?? MAX_CLI_LIST_LIMIT,
      minLimit: options.minLimit ?? 1,
    },
  );
}

export function buildCliOffsetPagination(args: {
  baseCommand: ReadonlyArray<string | number | false | null | undefined>;
  limit: number;
  offset: number;
  returned: number;
  total: number;
  options?: ReadonlyArray<string | number | false | null | undefined>;
}): OffsetPagination {
  return buildOffsetPagination({
    limit: args.limit,
    offset: args.offset,
    returned: args.returned,
    total: args.total,
    nextCommand: (nextOffset) =>
      buildCommand([
        ...args.baseCommand,
        "--json",
        "--limit",
        args.limit,
        "--offset",
        nextOffset,
        ...(args.options ?? []),
      ]),
  });
}

function parseBoundedIntegerOption(
  value: string | number | null | undefined,
  label: string,
  options: { defaultValue: number; min: number; max?: number },
): number {
  if (value === undefined || value === null || value === "") return options.defaultValue;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    fail(`${label} must be an integer.`);
  }
  if (parsed < options.min) {
    fail(`${label} must be greater than or equal to ${options.min}.`);
  }
  return Math.min(options.max ?? parsed, parsed);
}
