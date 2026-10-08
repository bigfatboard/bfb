// ABOUTME: Checks on-demand private checkpoint composition and reflow in compiled Chromium UI.
// ABOUTME: Intercepts writes and uses synthetic checkpoints; server authority has separate owning proof.

import { expect, test, type Page } from "@playwright/test";

import { FIX, openWorkSurface, signInAs } from "./helpers.js";
import { V03_TASK } from "../../../../tools/e2e/src/v03-fixture.js";

const BASE = `/api/v1/workspaces/${FIX.workspace}/tasks/${V03_TASK}/checkpoints`;
type Theme = "light" | "dark";

async function fixture(page: Page, denySave = false) {
  let reads = 0,
    writes = 0;
  let notes = ["Synthetic private note. Only my checkpoint history."];
  await page.route("**/api/v1/workspaces/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === BASE && request.method() === "GET") {
      reads += 1;
      await route.fulfill({
        json: {
          progress: {
            task_id: V03_TASK,
            has_more: false,
            checkpoints: notes.map((body, index) => ({
              id: `synthetic-${index}`,
              body,
              content_hash: `sha256:${"a".repeat(64)}`,
              created_at: "2026-10-08T12:00:00Z",
              origin: "human",
            })),
          },
        },
      });
      return;
    }
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    if (path === BASE) {
      writes += 1;
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["body", "request_id"]);
      expect(body.request_id).toMatch(/^web-checkpoint-/u);
      if (denySave) {
        await route.fulfill({ status: 404, json: { error: "not_found" } });
        return;
      }
      notes = [String(body.body), ...notes];
      await route.fulfill({
        json: {
          ok: true,
          replayed: false,
          result: {
            task_id: V03_TASK,
            checkpoint_id: "synthetic-new",
            content_hash: `sha256:${"b".repeat(64)}`,
          },
        },
      });
      return;
    }
    await route.fulfill({ status: 409, json: { error: "request_rejected" } });
  });
  return { reads: () => reads, writes: () => writes };
}

async function openTask(page: Page, theme: Theme) {
  await signInAs(page, "owner");
  await openWorkSurface(page);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByTestId("theme-preference").selectOption(theme);
  await page.keyboard.press("Escape");
  await page.locator(`#task-${V03_TASK}`).getByRole("button", { name: /Open / }).click();
  await expect(page.getByTestId("task-section")).toHaveValue("overview");
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    await page
      .getByTestId("private-checkpoints-panel")
      .evaluate((item) => item.scrollWidth <= item.clientWidth),
  ).toBe(true);
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 390]) {
    test(`${theme} private checkpoints are on demand with keyboard composition at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const responses = await fixture(page);
      await openTask(page, theme);
      expect(responses.reads()).toBe(0);
      await expect(page.getByTestId("private-checkpoints-panel")).toHaveCount(0);
      await page.getByTestId("task-section").selectOption("checkpoints");
      const panel = page.getByTestId("private-checkpoints-panel");
      await expect(panel.getByText(/Synthetic private note/)).toBeVisible();
      await expect(panel.locator("form")).toHaveCount(0);
      await expect(panel.getByRole("button")).toHaveCount(1);
      const add = panel.getByRole("button", { name: "Add checkpoint", exact: true });
      await add.focus();
      await page.keyboard.press("Enter");
      const field = panel.getByRole("textbox", { name: "Your private checkpoint" });
      await expect(field).toBeFocused();
      await field.fill("Synthetic unsent checkpoint. " + "Wrapping_".repeat(32));
      await expect(panel.locator("form").getByRole("button")).toHaveCount(2);
      await noOverflow(page);
      await page.getByTestId("task-detail").screenshot({
        path: test.info().outputPath(`private-form-${theme}-${width}.png`),
        animations: "disabled",
      });
      await panel.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(add).toBeFocused();
      await page.getByTestId("task-section").selectOption("overview");
      await expect(panel).toBeHidden();
      const count = responses.reads();
      await page.getByTestId("task-section").selectOption("checkpoints");
      expect(responses.reads()).toBe(count);
      await add.click();
      await expect(field).toHaveValue(/^Synthetic unsent checkpoint/);
      await panel.getByRole("button", { name: "Save private checkpoint", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(
        panel.getByText("Private checkpoint saved. Not published to the task.", { exact: true }),
      ).toBeVisible();
      await expect(panel.getByRole("heading", { name: "Private checkpoints" })).toBeFocused();
      await expect(panel.locator("li")).toHaveCount(2);
      await expect(panel.locator("form")).toHaveCount(0);
      await noOverflow(page);
      await page.getByTestId("task-detail").screenshot({
        path: test.info().outputPath(`private-saved-${theme}-${width}.png`),
        animations: "disabled",
      });
      expect(responses.writes()).toBe(1);
      expect(responses.reads()).toBe(count + 1);
    });
  }

  test(`${theme} denied checkpoints clear bodies and offer explicit retry`, async ({ page }) => {
    const responses = await fixture(page, true);
    await openTask(page, theme);
    await page.getByTestId("task-section").selectOption("checkpoints");
    const panel = page.getByTestId("private-checkpoints-panel");
    await expect(panel.getByText(/Synthetic private note/)).toBeVisible();
    await panel.getByRole("button", { name: "Add checkpoint", exact: true }).click();
    await panel
      .getByRole("textbox", { name: "Your private checkpoint" })
      .fill("Synthetic denied save");
    await panel.getByRole("button", { name: "Save private checkpoint", exact: true }).click();
    await expect(
      panel.getByText("Private checkpoints are unavailable for this task.", { exact: true }),
    ).toBeVisible();
    await expect(panel.locator("li,form")).toHaveCount(0);
    await expect(panel.getByRole("button")).toHaveCount(1);
    const count = responses.reads();
    await panel.getByRole("button", { name: "Retry private checkpoints" }).focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByText(/Synthetic private note/)).toBeVisible();
    expect(responses.reads()).toBe(count + 1);
    expect(responses.writes()).toBe(1);
  });
}
