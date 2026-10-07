// ABOUTME: Verifies rendered board suppression, current role and keyboard retry across workspace selections.
// ABOUTME: Uses explicit synthetic browser responses; server authorization is proved by the separate C11 domain and mounted suites.

import { expect, test, type Page } from "@playwright/test";
import type { ProjectLane } from "@bfb/domain";

import { syntheticUlid } from "../../../../packages/domain/src/ids.js";
import { FIX, signInAs } from "./helpers.js";

const SECONDARY_ID = syntheticUlid("BROWSER-BOARD-SECONDARY");
const SECONDARY_TITLE = "Synthetic secondary workspace task";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function secondaryWorkspace(page: Page, failFirstRead = false): Promise<void> {
  await page.route("**/api/v1/workspaces", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { workspaces: unknown[] };
    body.workspaces.push({
      id: SECONDARY_ID,
      slug: "synthetic-secondary",
      jurisdiction: "eu",
      role: "reviewer",
      authorization_epoch: 1,
    });
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/v1/workspaces/${SECONDARY_ID}/agent-profiles?limit=100`, (route) =>
    route.fulfill({ json: { profiles: [] } }),
  );
  let reads = 0;
  await page.route(`**/api/v1/workspaces/${SECONDARY_ID}/board`, async (route) => {
    reads += 1;
    if (failFirstRead && reads === 1) {
      await route.fulfill({ status: 404, json: { error: "synthetic unavailable board" } });
      return;
    }
    // Borrow only the synthetic presentation shape; this does not grant a second server workspace.
    const response = await page.request.get(`/api/v1/workspaces/${FIX.workspace}/board`);
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as {
      lanes: ProjectLane[];
      role: string;
      needs_now: unknown[];
    };
    const lane = body.lanes.find((candidate) => candidate.tasks.length > 0)!;
    expect(lane).toBeDefined();
    const card = lane.tasks[0]!;
    body.role = "reviewer";
    body.needs_now = [];
    body.lanes = [
      {
        ...lane,
        projectId: syntheticUlid("BROWSER-SECONDARY-PROJECT"),
        slug: "synthetic-secondary-project",
        name: "Synthetic secondary project",
        tasks: [
          {
            ...card,
            taskId: syntheticUlid("BROWSER-SECONDARY-TASK"),
            projectId: syntheticUlid("BROWSER-SECONDARY-PROJECT"),
            title: SECONDARY_TITLE,
            punchline: "Synthetic current workspace content",
            passToAgentProfileId: null,
          },
        ],
      },
    ];
    await route.fulfill({ json: body });
  });
}

async function selectWorkspace(page: Page, expected: string): Promise<void> {
  const picker = page.getByTestId("workspace-switcher");
  await picker.focus();
  await expect(picker).toBeFocused();
  // Native popup navigation is platform-dependent; use the browser driver's option selection.
  // Keyboard focus and retry are tested separately from the native popup menu.
  await picker.selectOption(expected);
  await expect(picker).toHaveValue(expected);
}

async function currentRole(page: Page, expected: string): Promise<void> {
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByTestId("current-role")).toHaveText(expected);
  await page.keyboard.press("Escape");
}

test("workspace selector focus and selection ignore a late previous-board reply and its owner controls", async ({
  page,
}) => {
  await secondaryWorkspace(page);
  const requested = deferred(),
    release = deferred();
  await page.route(`**/api/v1/workspaces/${FIX.workspace}/board`, async (route) => {
    const response = await route.fetch();
    requested.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await signInAs(page, "owner");
  await selectWorkspace(page, "synthetic");
  await requested.promise;
  await expect(page.getByTestId("work-board")).toHaveCount(0);
  await selectWorkspace(page, "synthetic-secondary");
  await expect(page.getByText(SECONDARY_TITLE, { exact: true })).toBeVisible();
  await currentRole(page, "reviewer");
  const previous = page.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/workspaces/${FIX.workspace}/board`),
  );
  release.resolve();
  await previous;
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(SECONDARY_TITLE, { exact: true })).toBeVisible();
  await currentRole(page, "reviewer");
  await page.getByRole("button", { name: "More navigation" }).click();
  await expect(page.getByRole("button", { name: "Projects & policy" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Operations", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const card = page.locator(".task-card");
  await expect(card.locator("button")).toHaveCount(1);
  await expect(card.locator("summary")).toHaveCount(1);
});

test("failed current board clears old authority and offers one retry in both themes", async ({
  page,
}) => {
  await secondaryWorkspace(page, true);
  await signInAs(page, "owner");
  await selectWorkspace(page, "synthetic");
  await expect(page.getByTestId("work-board")).toBeVisible();
  await currentRole(page, "owner");
  await selectWorkspace(page, "synthetic-secondary");
  await expect(page.getByRole("heading", { name: "Workspace not available." })).toBeVisible();
  await expect(page.getByTestId("work-board")).toHaveCount(0);
  await currentRole(page, "Role unavailable");
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toHaveCount(1);
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(SECONDARY_TITLE, { exact: true })).toBeVisible();
  await currentRole(page, "reviewer");
  for (const theme of ["light", "dark"] as const) {
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByTestId("theme-preference").selectOption(theme);
    await page.keyboard.press("Escape");
    await expect(page.getByText(SECONDARY_TITLE, { exact: true })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`current-board-${theme}.png`),
      animations: "disabled",
    });
  }
});
