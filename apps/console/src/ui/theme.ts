export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "ravi-console-theme";

/** Runs before paint so a pinned theme never flashes the system one. */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.rvTheme=t}catch(e){}`;

export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    const applied = document.documentElement.dataset.rvTheme;
    return applied === "light" || applied === "dark" ? applied : "system";
  }
}

const THEME_CHANGE_EVENT = "rv-theme-change";

/** For useSyncExternalStore: fires when the theme changes in this tab or another one. */
export function subscribeToThemePreference(onChange: () => void) {
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function applyThemePreference(preference: ThemePreference) {
  const root = document.documentElement;
  if (preference === "system") delete root.dataset.rvTheme;
  else root.dataset.rvTheme = preference;
  try {
    if (preference === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage can be blocked; the choice then lasts for this page only.
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}
