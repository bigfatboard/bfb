// ABOUTME: Resolves a personal light or dark theme without changing workspace authority.
// ABOUTME: Follows system changes unless the person selects a stored presentation override.

import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "bfb.theme";

export function readThemePreference(storage: Pick<Storage, "getItem"> | null): ThemePreference {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function useThemePreference(): readonly [ThemePreference, (value: ThemePreference) => void] {
  const [preference, setPreference] = useState(() => readThemePreference(browserStorage()));

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(preference, media?.matches ?? false);
    };
    apply();
    media?.addEventListener("change", apply);
    return () => media?.removeEventListener("change", apply);
  }, [preference]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        setPreference(readThemePreference(browserStorage()));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const chooseTheme = useCallback((value: ThemePreference) => {
    setPreference(value);
    try {
      browserStorage()?.setItem(THEME_STORAGE_KEY, value);
    } catch {
      // A blocked preference store must not prevent changing this tab's presentation.
    }
  }, []);

  return [preference, chooseTheme];
}
