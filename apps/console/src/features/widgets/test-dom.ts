// A happy-dom window as the global DOM for the React tests of the Library
// and widgets screens: render into it, act, and wait for a condition.
// `installTestDom()` at the top of a test file sets the globals before its
// tests and puts back what was there after them.

import { afterAll, beforeAll } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";

export function installTestDom() {
  let window: Window | null = null;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  beforeAll(() => {
    window = new Window({ url: "https://console.ravi.bot/" });
    const globals: Record<string, unknown> = {
      window,
      document: window.document,
      HTMLElement: window.HTMLElement,
      Node: window.Node,
      Event: window.Event,
      MouseEvent: window.MouseEvent,
      // A frame later, as in a browser: after React has committed what the handler set.
      requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(performance.now()), 0),
      cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(globals)) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
    }
  });
  afterAll(async () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    saved.clear();
    await window?.happyDOM.close();
  });
}

/** Runs `callback` inside React's `act`, so every update it causes is on screen when it returns. */
export async function act(callback: () => unknown = () => undefined) {
  const React = await import("react");
  await React.act(async () => {
    await callback();
  });
}

export async function render(node: ReactNode) {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(node));
  return {
    container,
    unmount: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
}

/** Waits (letting timers, frames and fetches run) until `check` holds. */
export async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor: condition not met in time");
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  }
}

export async function click(element: Element | null | undefined) {
  if (!element) throw new Error("click: no element");
  await act(() => (element as HTMLElement).click());
}

/** Types `value` into a text input or text area the way a person does (React's onChange runs). */
export async function type(element: Element | null | undefined, value: string) {
  if (!element) throw new Error("type: no element");
  const field = element as HTMLInputElement;
  const prototype = Object.getPrototypeOf(field) as object;
  await act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new (field.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
  });
}
