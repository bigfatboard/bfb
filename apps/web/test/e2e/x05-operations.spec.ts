// ABOUTME: Real Chromium proof for the X05 Operations surface across roles.
// ABOUTME: Synthetic fixtures only; the recording keeps counts and states, never content.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { signInAndOpenBoard } from "./helpers.js";

test.describe.configure({ mode: "serial" });

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const evidenceDir = path.join(rootDir, "docs/work-packages/evidence/WP-X05");
const recording: Record<string, unknown> = {
  spec: "x05-operations",
  scenarios: [] as Array<Record<string, unknown>>,
};

function note(scenario: string, fields: Record<string, unknown> = {}): void {
  (recording.scenarios as Array<Record<string, unknown>>).push({ scenario, ...fields });
}

test.beforeAll(async () => {
  await mkdir(evidenceDir, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(
    path.join(evidenceDir, "operations-ui.json"),
    `${JSON.stringify(recording, null, 2)}\n`,
  );
});

async function openOperations(page: Parameters<typeof signInAndOpenBoard>[0]): Promise<void> {
  await page.getByRole("button", { name: "Operations" }).click();
  await expect(page.getByTestId("operations-page")).toBeVisible();
}

test("owner sees health, queues, activity, audit, retention, and diagnostics", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  await openOperations(page);
  for (const section of [
    "operations-health",
    "operations-queues",
    "operations-activity",
    "operations-audit",
    "operations-retention",
    "operations-diagnostics",
  ]) {
    await expect(page.getByTestId(section)).toBeVisible();
  }
  const counts = await page.getByTestId("queue-counts").textContent();
  expect(counts).toMatch(/Notifications pending \d+/);
  note("owner-sections", { visible: 6, queueCounts: (counts ?? "").slice(0, 160) });
});

test("member sees operations without the security audit", async ({ page }) => {
  await signInAndOpenBoard(page, "member");
  await openOperations(page);
  await expect(page.getByTestId("operations-health")).toBeVisible();
  await expect(page.getByTestId("operations-queues")).toBeVisible();
  await expect(page.getByTestId("operations-activity")).toBeVisible();
  await expect(page.getByTestId("operations-audit")).toHaveCount(0);
  await expect(page.getByTestId("operations-retention")).toBeVisible();
  await expect(page.getByTestId("operations-diagnostics")).toBeVisible();
  note("member-sections", { auditHidden: true });
});

test("reviewer gets no operations navigation", async ({ page }) => {
  await signInAndOpenBoard(page, "restricted");
  await expect(page.getByRole("button", { name: "Operations" })).toHaveCount(0);
  note("reviewer-sections", { navHidden: true });
});

test("operations surface renders no private payload content", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  await openOperations(page);
  const body = (await page.getByTestId("operations-page").textContent()) ?? "";
  for (const forbidden of ["cookie", "Bearer", "ghp_", "__Host-bfb", "BEGIN PRIVATE"]) {
    expect(body).not.toContain(forbidden);
  }
  note("redaction", { forbiddenClassesAbsent: 5 });
});
