// ABOUTME: Real Chromium proof for the G02 release golden surfaces.
// ABOUTME: Read-only synthetic fixtures; the recording keeps states, never content.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { V03_TASK } from "../../../../tools/e2e/src/v03-fixture.js";
import { signInAndOpenBoard } from "./helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const evidenceDir = path.join(rootDir, "docs/work-packages/evidence/WP-G02");
const recording: Record<string, unknown> = {
  spec: "g02-release",
  scenarios: [] as Array<Record<string, unknown>>,
};

function note(scenario: string, observation: string): void {
  (recording.scenarios as Array<Record<string, unknown>>).push({ scenario, observation });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await mkdir(evidenceDir, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(evidenceDir + "/browser-smoke.json", `${JSON.stringify(recording, null, 2)}\n`);
});

test("release board renders the work surface for the owner", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  await expect(page.getByTestId("work-board")).toBeVisible();
  await expect(page.getByTestId("current-role")).toContainText("owner");
  note("board", "work board renders with the owner role");
});

test("release attention home renders ranked requests read-only", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  await expect(page.getByTestId("attention-home")).toBeVisible();
  await expect(page.getByTestId("attention-list")).toBeVisible();
  await expect(page.getByTestId("attention-poll")).toContainText("Committed state as of");
  note("attention", "attention home renders the ranked list with committed-state polling");
});

test("release review surface binds the exact artifact version read-only", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  await page.locator(`#task-${V03_TASK}`).getByRole("button", { name: /Open / }).click();
  await expect(page.getByTestId("review-panel")).toBeVisible();
  await expect(page.getByTestId("review-hash")).not.toBeEmpty();
  note("review", "review panel binds the exact artifact version hash");
});
