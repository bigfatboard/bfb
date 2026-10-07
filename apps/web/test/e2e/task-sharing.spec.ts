// ABOUTME: Checks on-demand sharing controls, keyboard focus and reflow in compiled light/dark Chromium UI.
// ABOUTME: Uses disposable read fixtures and synthetic intercepted sharing responses, not server authority proof.

import { expect, test, type Page } from "@playwright/test";

import { FIX, openWorkSurface, signInAs } from "./helpers.js";
import { V03_TASK } from "../../../../tools/e2e/src/v03-fixture.js";

const BASE = `/api/v1/workspaces/${FIX.workspace}/tasks/${V03_TASK}/sharing`;
type Theme = "light" | "dark";
type Grant = { id: string; human_id: string; permission: "read" | "contribute" | "edit" };

async function fixture(page: Page, deniedRevoke = false) {
  let version = 1,
    reads = 0,
    mutations = 0,
    denied = false;
  let grants: Grant[] = [
    { id: "synthetic-existing-grant", human_id: FIX.member, permission: "read" },
  ];
  // Every workspace mutation is intercepted, including unrelated incidental requests.
  await page.route("**/api/v1/workspaces/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === BASE) {
      reads += 1;
      await route.fulfill({
        json: {
          sharing: {
            task_id: V03_TASK,
            access_version: version,
            grants: grants.map((grant) => ({
              ...grant,
              authorization_epoch: 1,
              created_at: "2026-10-08T12:00:00Z",
            })),
            has_more: false,
          },
        },
      });
      return;
    }
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    if (path.startsWith(`${BASE}/grants`)) {
      mutations += 1;
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(body.expected_access_version).toBe(version);
      expect(body.request_id).toMatch(/^web-sharing-/u);
      if (path.endsWith("/revoke") && deniedRevoke && !denied) {
        denied = true;
        await route.fulfill({ status: 404, json: { error: "not_found" } });
        return;
      }
      let id: string;
      if (path === `${BASE}/grants`) {
        id = "synthetic-added-grant";
        expect(body.human_id).toBe(FIX.reviewer);
        expect(body.permission).toBe("contribute");
        grants = [...grants, { id, human_id: FIX.reviewer, permission: "contribute" }];
      } else {
        id = path.split("/").at(-2)!;
        grants = grants.filter((grant) => grant.id !== id);
      }
      version += 1;
      await route.fulfill({
        json: {
          ok: true,
          replayed: false,
          result: { task_id: V03_TASK, grant_id: id, access_version: version },
        },
      });
      return;
    }
    await route.fulfill({ status: 409, json: { error: "request_rejected" } });
  });
  return { reads: () => reads, mutations: () => mutations };
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

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const panel = page.getByTestId("task-sharing-panel");
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 390]) {
    test(`${theme} sharing is on demand with keyboard composition and ${width}px reflow`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const responses = await fixture(page);
      await openTask(page, theme);
      expect(responses.reads()).toBe(0);
      await expect(page.getByTestId("task-sharing-panel")).toHaveCount(0);
      await page.getByTestId("task-section").selectOption("sharing");
      const panel = page.getByTestId("task-sharing-panel");
      await expect(panel.getByText("Synthetic Member", { exact: true })).toBeVisible();
      const initialReads = responses.reads();
      await expect(panel.locator("form")).toHaveCount(0);
      await expect(panel.getByRole("button")).toHaveCount(2);
      const add = panel.getByRole("button", { name: "Add person" });
      await add.focus();
      await page.keyboard.press("Enter");
      await expect(panel.getByRole("combobox", { name: "Person", exact: true })).toBeFocused();
      await panel.getByRole("combobox", { name: "Person", exact: true }).selectOption(FIX.reviewer);
      await panel
        .getByRole("combobox", { name: "Permission", exact: true })
        .selectOption("contribute");
      await expect(panel.locator("form").getByRole("button")).toHaveCount(2);
      await noHorizontalOverflow(page);
      await page.getByTestId("task-detail").screenshot({
        path: test.info().outputPath(`sharing-form-${theme}-${width}.png`),
        animations: "disabled",
      });
      await panel.getByRole("button", { name: "Share task" }).focus();
      await page.keyboard.press("Enter");
      await expect(panel.getByText("Access shared.", { exact: true })).toBeVisible();
      await expect(panel.getByRole("heading", { name: "Sharing" })).toBeFocused();
      await expect(panel.locator(".sharing-grant")).toHaveCount(2);
      await expect(panel.locator("form")).toHaveCount(0);
      await panel
        .locator(".sharing-grant")
        .filter({ hasText: "Synthetic Member" })
        .getByRole("button", { name: "Revoke access" })
        .click();
      await expect(panel.getByText("Access revoked.", { exact: true })).toBeVisible();
      await expect(panel.locator(".sharing-grant")).toHaveCount(1);
      await noHorizontalOverflow(page);
      await page.getByTestId("task-detail").screenshot({
        path: test.info().outputPath(`sharing-current-${theme}-${width}.png`),
        animations: "disabled",
      });
      expect(responses.mutations()).toBe(2);
      expect(responses.reads()).toBe(initialReads + 2);
    });
  }

  test(`${theme} denied sharing clears names and actions with an explicit keyboard retry`, async ({
    page,
  }) => {
    const responses = await fixture(page, true);
    await openTask(page, theme);
    await page.getByTestId("task-section").selectOption("sharing");
    const panel = page.getByTestId("task-sharing-panel");
    await expect(panel.getByText("Synthetic Member", { exact: true })).toBeVisible();
    const initialReads = responses.reads();
    await panel.getByRole("button", { name: "Revoke access" }).click();
    await expect(panel.getByText("Sharing is unavailable for this task.")).toBeVisible();
    await expect(panel.locator(".sharing-grant,form")).toHaveCount(0);
    await expect(panel.getByRole("button")).toHaveCount(1);
    const retry = panel.getByRole("button", { name: "Retry sharing" });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByText("Synthetic Member", { exact: true })).toBeVisible();
    expect(responses.mutations()).toBe(1);
    expect(responses.reads()).toBe(initialReads + 1);
  });
}
