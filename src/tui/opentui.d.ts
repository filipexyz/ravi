/**
 * Type declarations for @opentui packages.
 *
 * The @opentui .d.ts files use extensionless relative imports which are
 * incompatible with TypeScript's "NodeNext" moduleResolution. We declare
 * the minimal surface we use so the rest of the codebase is unaffected.
 */

declare module "@opentui/core" {
  import { EventEmitter } from "node:events";

  // --- Renderer ---

  export interface CliRendererConfig {
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
    exitOnCtrlC?: boolean;
    exitSignals?: NodeJS.Signals[];
    targetFps?: number;
    maxFps?: number;
    useAlternateScreen?: boolean;
    useMouse?: boolean;
    autoFocus?: boolean;
    onDestroy?: () => void;
  }

  export class CliRenderer extends EventEmitter {
    width: number;
    height: number;
    readonly root: any;
    get isDestroyed(): boolean;
    start(): void;
    stop(): void;
    destroy(): void;
    requestRender(): void;
  }

  export function createCliRenderer(config?: CliRendererConfig): Promise<CliRenderer>;

  // --- SyntaxStyle ---

  export interface StyleDefinition {
    fg?: any;
    bg?: any;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    dim?: boolean;
  }

  export class SyntaxStyle {
    static create(): SyntaxStyle;
    static fromStyles(styles: Record<string, StyleDefinition>): SyntaxStyle;
    registerStyle(name: string, style: StyleDefinition): number;
    destroy(): void;
  }

  // --- Renderable base types ---

  export class BaseRenderable {}
  export class BoxRenderable extends BaseRenderable {}
  export class TextRenderable extends BaseRenderable {}
  export class ScrollBoxRenderable extends BoxRenderable {
    get stickyScroll(): boolean;
    set stickyScroll(value: boolean);
    scrollTo(position: number | { x: number; y: number }): void;
    scrollBy(delta: number | { x: number; y: number }): void;
    get scrollHeight(): number;
    get scrollTop(): number;
  }
  export class InputRenderable extends BaseRenderable {
    get value(): string;
    set value(value: string);
    focus(): void;
    blur(): void;
    submit(): boolean;
  }
  export class TextareaRenderable extends BaseRenderable {
    focus(): void;
    blur(): void;
    submit(): boolean;
  }
  export class CodeRenderable extends BaseRenderable {
    get content(): string;
    set content(value: string);
  }
  export class MarkdownRenderable extends BaseRenderable {
    get content(): string;
    set content(value: string);
  }
  export class TextNodeRenderable extends BaseRenderable {}

  // --- KeyEvent ---

  export interface KeyEvent {
    name: string;
    char?: string;
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
    meta?: boolean;
    repeated?: boolean;
    eventType?: "press" | "release";
  }
}

declare module "@opentui/react" {
  import type { ReactNode } from "react";
  import type { CliRenderer, KeyEvent } from "@opentui/core";

  export type Root = {
    render: (node: ReactNode) => void;
    unmount: () => void;
  };

  export function createRoot(renderer: CliRenderer): Root;

  export { createElement } from "react";

  // --- Hooks ---

  export function useKeyboard(handler: (key: KeyEvent) => void, options?: { release?: boolean }): void;

  export function useRenderer(): CliRenderer;
}
