// ABOUTME: Covers C07 project registry, tints, and agent profiles from synthetic fixtures.
// ABOUTME: Project access remains authorization-scoped through C04 grants.

import { describe, expect, it } from "vitest";

import { loadPrincipal } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { openDomainDb } from "./helpers.js";

describe("projects and profiles", () => {
  it("lists projects and profiles for authorized humans", () => {
    const db = openDomainDb();
    const projects = db
      .prepare(`SELECT id, tint FROM projects WHERE workspace_id = ? ORDER BY slug`)
      .all(FIX.workspace) as Array<{ id: string; tint: string }>;
    expect(projects).toHaveLength(2);
    expect(projects.every((project) => project.tint.startsWith("#"))).toBe(true);
    const profiles = db
      .prepare(`SELECT name, provider FROM agent_profiles WHERE workspace_id = ?`)
      .all(FIX.workspace) as Array<{ name: string; provider: string }>;
    expect(profiles.map((profile) => profile.provider).sort()).toEqual(["codex", "grok"]);
    const restricted = loadPrincipal(db, FIX.workspace, FIX.restricted);
    expect(restricted.projectIds).toEqual([FIX.projectA]);
  });
});
