/**
 * CLI Decorators - Commander.js + Decorators pattern
 *
 * Provides declarative command definition similar to NestJS/oclif
 */

// Symbols for metadata storage
const GROUP_KEY = Symbol("cli:group");
const COMMANDS_KEY = Symbol("cli:commands");
const ARGS_KEY = Symbol("cli:args");
const OPTIONS_KEY = Symbol("cli:options");

// Types
export interface GroupOptions {
  name: string;
  description: string;
}

export interface CommandOptions {
  name: string;
  description: string;
  aliases?: string[];
}

export interface ArgOptions {
  required?: boolean;
  description?: string;
  defaultValue?: unknown;
}

export interface OptionOptions {
  flags: string;
  description?: string;
  defaultValue?: unknown;
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
  return function (target: Function) {
    Reflect.defineMetadata(GROUP_KEY, options, target);
  };
}

/**
 * @Command decorator - marks a method as a command within a group
 */
export function Command(options: CommandOptions) {
  return function (
    target: object,
    propertyKey: string,
    _descriptor: PropertyDescriptor
  ) {
    const commands: CommandMetadata[] =
      Reflect.getMetadata(COMMANDS_KEY, target.constructor) || [];
    commands.push({ ...options, method: propertyKey });
    Reflect.defineMetadata(COMMANDS_KEY, commands, target.constructor);
  };
}

/**
 * @Arg decorator - marks a method parameter as a positional argument
 */
export function Arg(name: string, options: ArgOptions = {}) {
  return function (
    target: object,
    propertyKey: string,
    parameterIndex: number
  ) {
    const args: ArgMetadata[] =
      Reflect.getMetadata(ARGS_KEY, target, propertyKey) || [];
    args.push({ name, index: parameterIndex, required: true, ...options });
    Reflect.defineMetadata(ARGS_KEY, args, target, propertyKey);
  };
}

/**
 * @Option decorator - marks a method parameter as a flag option
 */
export function Option(options: OptionOptions) {
  return function (
    target: object,
    propertyKey: string,
    parameterIndex: number
  ) {
    const opts: OptionMetadata[] =
      Reflect.getMetadata(OPTIONS_KEY, target, propertyKey) || [];
    opts.push({ ...options, propertyKey, index: parameterIndex });
    Reflect.defineMetadata(OPTIONS_KEY, opts, target, propertyKey);
  };
}

// Metadata getters
export function getGroupMetadata(target: Function): GroupOptions | undefined {
  return Reflect.getMetadata(GROUP_KEY, target);
}

export function getCommandsMetadata(target: Function): CommandMetadata[] {
  return Reflect.getMetadata(COMMANDS_KEY, target) || [];
}

export function getArgsMetadata(
  target: object,
  propertyKey: string
): ArgMetadata[] {
  const args = Reflect.getMetadata(ARGS_KEY, target, propertyKey) || [];
  // Sort by index to maintain parameter order
  return args.sort((a: ArgMetadata, b: ArgMetadata) => a.index - b.index);
}

export function getOptionsMetadata(
  target: object,
  propertyKey: string
): OptionMetadata[] {
  return Reflect.getMetadata(OPTIONS_KEY, target, propertyKey) || [];
}
