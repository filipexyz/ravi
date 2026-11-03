"use client";

import { useEffect, useState } from "react";

/**
 * `value` once it has stopped changing for `delay` ms, and how many times it
 * settled (0 until the first change), so a live region can announce each
 * update even when its text repeats.
 */
export function useDebounced<T>(value: T, delay: number): { value: T; tick: number } {
  const [state, setState] = useState({ value, tick: 0 });
  useEffect(() => {
    if (Object.is(state.value, value)) return;
    const timer = setTimeout(() => setState((current) => ({ value, tick: current.tick + 1 })), delay);
    return () => clearTimeout(timer);
  }, [value, delay, state.value]);
  return state;
}
