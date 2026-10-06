// ABOUTME: Proves personal theme overrides, system changes, and storage failures stay presentation-only.
// ABOUTME: Checks declared light and dark text, action, priority, and focus token contrast.

// @vitest-environment happy-dom
import { readFileSync } from "node:fs";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  useThemePreference,
  type ThemePreference,
} from "../src/theme.js";

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

function mountTheme() {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function ThemeControl() {
    const [preference, choose] = useThemePreference();
    return createElement(
      "select",
      {
        value: preference,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          choose(event.target.value as ThemePreference),
      },
      ...["system", "light", "dark"].map((value) =>
        createElement("option", { key: value, value }, value),
      ),
    );
  }
  act(() => root.render(createElement(ThemeControl)));
  return {
    control: container.querySelector("select")!,
    choose(value: ThemePreference) {
      act(() => {
        this.control.value = value;
        this.control.dispatchEvent(new Event("change", { bubbles: true }));
      });
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("personal theme preference", () => {
  it("defaults absent, invalid, and inaccessible preferences to system", () => {
    expect(readThemePreference(null)).toBe("system");
    expect(readThemePreference({ getItem: () => "unknown" })).toBe("system");
    expect(readThemePreference({ getItem: () => "dark" })).toBe("dark");
    expect(
      readThemePreference({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("system");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("tracks system changes, preserves overrides, and cleans up the media listener", () => {
    const media = new EventTarget() as EventTarget & { matches: boolean };
    media.matches = false;
    vi.spyOn(window, "matchMedia").mockReturnValue(media as MediaQueryList);
    const remove = vi.spyOn(media, "removeEventListener");
    const mounted = mountTheme();
    try {
      expect(document.documentElement.dataset.theme).toBe("light");
      act(() => {
        media.matches = true;
        media.dispatchEvent(new Event("change"));
      });
      expect(document.documentElement.dataset.theme).toBe("dark");

      mounted.choose("light");
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
      expect(document.documentElement.dataset.theme).toBe("light");
      act(() => media.dispatchEvent(new Event("change")));
      expect(document.documentElement.dataset.theme).toBe("light");

      mounted.choose("system");
      expect(document.documentElement.dataset.theme).toBe("dark");
    } finally {
      mounted.unmount();
    }
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("reads an existing override and responds to personal preference changes in another tab", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const mounted = mountTheme();
    try {
      expect(document.documentElement.dataset.theme).toBe("dark");
      act(() => {
        window.localStorage.setItem(THEME_STORAGE_KEY, "light");
        window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
      });
      expect(mounted.control.value).toBe("light");
      expect(document.documentElement.dataset.theme).toBe("light");
    } finally {
      mounted.unmount();
    }
  });

  it("still changes this tab when storing the preference fails", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const mounted = mountTheme();
    try {
      mounted.choose("dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(mounted.control.value).toBe("dark");
    } finally {
      mounted.unmount();
    }
  });
});

function tokenLuminance(value: string): number {
  const match = value.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  if (!match) throw new Error(`Expected an opaque OKLCH token: ${value}`);
  const lightness = Number(match[1]);
  const chroma = Number(match[2]);
  const hue = (Number(match[3]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (channel: number) => Math.max(0, Math.min(1, channel));
  return (
    0.2126 * clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) +
    0.7152 * clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) +
    0.0722 * clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  );
}

describe("theme token contrast", () => {
  const css = readFileSync("apps/web/src/styles.css", "utf8");
  const light = css.match(/:root \{([\s\S]*?)\}/)![1]!;
  const dark = css.match(/\[data-theme="dark"\] \{([\s\S]*?)\}/)![1]!;
  const tokens = (block: string) =>
    Object.fromEntries(
      [...block.matchAll(/(--[\w-]+): (oklch\([^;]+\));/g)].map((entry) => [entry[1], entry[2]]),
    );
  const lightTokens = tokens(light);
  for (const [name, values] of [
    ["light", lightTokens],
    ["dark", { ...lightTokens, ...tokens(dark) }],
  ] as const) {
    it(`${name} keeps normal text and actions at AA contrast`, () => {
      const ratio = (foreground: string, background: string) => {
        const a = tokenLuminance(values[foreground]!);
        const b = tokenLuminance(values[background]!);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      for (const surface of ["--canvas", "--surface", "--surface-raised", "--surface-strong"]) {
        for (const text of ["--ink", "--ink-soft", "--ink-muted", "--accent-text", "--cyan-text"]) {
          expect(ratio(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(ratio("--focus", surface), `focus on ${surface}`).toBeGreaterThanOrEqual(3);
      }
      expect(ratio("--action-ink", "--action-surface")).toBeGreaterThanOrEqual(4.5);
      expect(ratio("--action-ink", "--action-surface-hover")).toBeGreaterThanOrEqual(4.5);
      for (const priority of ["--priority-p0", "--priority-p1", "--priority-p2"]) {
        expect(ratio("--priority-ink", priority), priority).toBeGreaterThanOrEqual(4.5);
      }
      expect(ratio("--priority-p3", "--surface-raised")).toBeGreaterThanOrEqual(4.5);
      expect(ratio("--ink", "--error-wash")).toBeGreaterThanOrEqual(4.5);
    });
  }
});
