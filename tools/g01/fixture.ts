// ABOUTME: Deterministic golden system fixture for WP-G01 integrated hardening.
// ABOUTME: Fixed seed, fixed synthetic IDs, and fixed timestamps keep evidence byte-identical.

import { syntheticUlid } from "@bfb/domain";

/** Frozen fixture seed and version recorded in every G01 evidence file. */
export const G01_SEED = "bfb-g01/v1";
export const G01_FIXTURE_VERSION = 1;

/** Fixed harness wall-clock: every command, grant, and expiry derives from this value. */
export const G01_NOW = "2026-09-18T12:00:00.000Z";

export interface G01ProjectSpec {
  tag: string;
  name: string;
  slug: string;
  tint: string;
  reviewer: boolean;
}

export const G01_EXTRA_PROJECTS: G01ProjectSpec[] = [
  { tag: "G01PR03", name: "Gamma", slug: "gamma", tint: "#8B5CF6", reviewer: false },
  { tag: "G01PR04", name: "Delta", slug: "delta", tint: "#EC4899", reviewer: false },
  { tag: "G01PR05", name: "Epsilon", slug: "epsilon", tint: "#F59E0B", reviewer: false },
  { tag: "G01PR06", name: "Zeta", slug: "zeta", tint: "#14B8A6", reviewer: false },
  { tag: "G01PR07", name: "Eta", slug: "eta", tint: "#EF4444", reviewer: false },
  { tag: "G01PR08", name: "Theta", slug: "theta", tint: "#6366F1", reviewer: false },
  { tag: "G01PR09", name: "Iota", slug: "iota", tint: "#84CC16", reviewer: false },
  { tag: "G01PR10", name: "Kappa", slug: "kappa", tint: "#06B6D4", reviewer: false },
];

export interface G01ProfileSpec {
  alias: string;
  name: string;
  provider: "claude" | "codex" | "grok" | "fake";
  model?: string;
  executionMode: "interactive" | "headless";
  harnessMode: "restricted" | "standard";
}

export const G01_EXTRA_PROFILES: G01ProfileSpec[] = [
  {
    alias: "claude",
    name: "G01 Claude Build",
    provider: "claude",
    model: "synthetic-g01",
    executionMode: "interactive",
    harnessMode: "restricted",
  },
  {
    alias: "fake-interactive",
    name: "G01 Fake Interactive",
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  },
  {
    alias: "fake-headless",
    name: "G01 Fake Headless",
    provider: "fake",
    model: "synthetic",
    executionMode: "headless",
    harnessMode: "restricted",
  },
];

export interface G01RunnerSpec {
  alias: string;
  tag: string;
  label: string;
  thumbprint: string;
  checkoutTags: string[];
}

export const G01_RUNNERS: G01RunnerSpec[] = [
  {
    alias: "mac-a",
    tag: "G01MACA",
    label: "Synthetic G01 Mac A",
    thumbprint: "synthetic-g01-harness-key-a",
    checkoutTags: ["G01CKA1", "G01CKA2"],
  },
  {
    alias: "mac-b",
    tag: "G01MACB",
    label: "Synthetic G01 Mac B",
    thumbprint: "synthetic-g01-harness-key-b",
    checkoutTags: ["G01CKB1", "G01CKB2"],
  },
];

export function g01Id(tag: string): string {
  return syntheticUlid(tag);
}

/** Every stable fixture ID must be unique; the harness asserts this before seeding. */
export function g01StableIds(): string[] {
  return [
    ...G01_EXTRA_PROJECTS.map((spec) => g01Id(spec.tag)),
    ...G01_RUNNERS.map((spec) => g01Id(spec.tag)),
    ...G01_RUNNERS.flatMap((spec) => spec.checkoutTags.map((tag) => g01Id(tag))),
  ];
}
