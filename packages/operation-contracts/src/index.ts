/** Browser-safe operation descriptors. Metadata describes requirements, never grants. */
import type { ZodTypeAny } from "zod";
export type OperationService = "console" | "runtime";
export type OperationAudience = "human" | "installation";
export interface OperationArgument {
  name: string; index: number; required: boolean; variadic: boolean;
  description?: string; defaultValue?: unknown; schema: ZodTypeAny;
}
export interface OperationOption {
  name: string; description?: string; defaultValue?: unknown; schema: ZodTypeAny;
}
export interface OperationDescriptor {
  groupPath: string; groupSegments: string[]; command: string; fullName: string;
  description: string; scope: string; args: OperationArgument[]; options: OperationOption[];
  returns?: ZodTypeAny; binary?: boolean; cliOnly?: boolean;
  service?: OperationService; audience?: OperationAudience;
}
export interface OperationRegistry { commands: OperationDescriptor[] }
export function projectRegistry(registry: OperationRegistry, service: OperationService, audience: OperationAudience): OperationRegistry {
  const seen = new Set<string>();
  const commands = registry.commands.filter(command => !command.cliOnly && command.service === service && command.audience === audience);
  for (const command of commands) {
    if (seen.has(command.fullName)) throw new Error(`Duplicate operation: ${command.fullName}`);
    if (!command.returns && !command.binary) throw new Error(`Missing return schema: ${command.fullName}`);
    seen.add(command.fullName);
  }
  return { commands };
}
