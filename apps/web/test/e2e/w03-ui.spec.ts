// ABOUTME: Exercises the compact board, on-demand task controls and personal themes in Chromium.
// ABOUTME: Records bounded synthetic viewport evidence, contrast and action budgets without operating a pilot.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { FIX, signInAndOpenBoard, type RoleKey } from "./helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const evidenceDir = path.join(
  rootDir,
  process.env.BFB_CAPTURE_W03_EVIDENCE === "1"
    ? "docs/work-packages/evidence/WP-W03/browser"
    : "apps/web/test/e2e/test-results/evidence-w03",
);
const observations: Record<string, unknown>[] = [];
test.beforeAll(async () => {
  await mkdir(evidenceDir, { recursive: true });
});
test.afterAll(async () => {
  await writeFile(
    path.join(evidenceDir, "ui-checks.json"),
    `${JSON.stringify({ fixture: "synthetic", observations }, null, 2)}\n`,
  );
});

async function visibleCommands(root: Locator): Promise<number> {
  return root
    .locator("button,summary,select,a[href]")
    .evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).length);
}

async function openTask(page: Page, taskId: string = FIX.taskDelegable): Promise<Locator> {
  await page.locator(`#task-${taskId}`).getByRole("button", { name: /Open / }).click();
  await expect(page.getByTestId("task-section")).toHaveValue("overview");
  return page.getByTestId("task-detail");
}

async function appearance(page: Page, value: "light" | "dark" | "system"): Promise<void> {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByTestId("theme-preference").selectOption(value);
  await page.keyboard.press("Escape");
}

for (const role of ["owner", "member", "restricted"] as RoleKey[]) {
  test(`${role} gets two task controls and discoverable role-appropriate sections`, async ({
    page,
  }) => {
    await signInAndOpenBoard(page, role);
    const cards = page.locator(".task-card");
    const counts = await cards.evaluateAll((nodes) =>
      nodes.map(
        (node) =>
          [...node.querySelectorAll("button,summary,select,a[href]")].filter(
            (control) => control.getClientRects().length > 0,
          ).length,
      ),
    );
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((count) => count === 2)).toBe(true);
    await expect(page.getByTestId("agent-work-state")).toHaveCount(1);
    expect(await page.locator(".needs-now .attention-item").count()).toBeLessThanOrEqual(3);
    await expect(page.getByTestId("pass-to-agent").first()).not.toBeVisible();
    const taskId = role === "restricted" ? FIX.taskAttention : FIX.taskDelegable;
    const card = page.locator(`#task-${taskId}`);
    await card.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(card.locator("details")).toHaveAttribute("open", "");
    await expect(card.locator(".card-details-content")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card.locator("summary")).toBeFocused();
    const sheet = await openTask(page, taskId);
    expect(await visibleCommands(sheet.locator(".task-panel-actions"))).toBe(2);
    await expect(sheet.locator("form,iframe")).toHaveCount(0);
    await expect(page.getByTestId("run-timeline-section")).toHaveCount(0);
    await expect(page.getByTestId("measurements-panel")).toHaveCount(0);
    const options = await page
      .getByTestId("task-section")
      .locator("option")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
    expect(options.includes("edit")).toBe(role !== "restricted");
    expect(options.includes("handoff")).toBe(role !== "restricted");
    await page.getByTestId("task-section").selectOption("comments");
    await expect(page.getByTestId("comment-form")).toHaveCount(0);
    await page.getByTestId("comment-compose-toggle").click();
    await expect(page.getByTestId("comment-body")).toBeFocused();
    expect(await visibleCommands(page.getByTestId("comment-form"))).toBe(2);
    observations.push({
      surface: "task-default",
      role,
      cardActions: 2,
      taskActions: 2,
      revealedComposerActions: 2,
    });
  });
}

test("comment drafts survive sections, cancel, close and failed submission; committed success clears", async ({
  page,
}) => {
  await signInAndOpenBoard(page, "owner");
  await openTask(page);
  await page.getByTestId("comment-compose-toggle").click();
  const draft = "Synthetic W03 draft <img src=x onerror=alert(1)>";
  await page.getByTestId("comment-body").fill(draft);
  await page.getByTestId("task-section").selectOption("context");
  await page.getByTestId("task-section").selectOption("comments");
  await expect(page.getByTestId("comment-body")).toHaveValue(draft);
  await page.getByTestId("comment-form").getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("comment-compose-toggle").click();
  await expect(page.getByTestId("comment-body")).toHaveValue(draft);
  await page.getByRole("button", { name: "Close task" }).click();
  await openTask(page);
  await page.getByTestId("comment-compose-toggle").click();
  await expect(page.getByTestId("comment-body")).toHaveValue(draft);
  const commentsURL = `**/api/v1/workspaces/${FIX.workspace}/tasks/${FIX.taskDelegable}/comments`;
  await page.route(commentsURL, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "forbidden", message: "Synthetic denied submission" }),
    }),
  );
  await page
    .getByTestId("comment-form")
    .getByRole("button", { name: "Add comment", exact: true })
    .click();
  await expect(page.getByTestId("mutation-error")).toContainText("Synthetic denied submission");
  await expect(page.getByTestId("comment-body")).toHaveValue(draft);
  await page.unroute(commentsURL);
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/tasks/${FIX.taskDelegable}/comments`),
  );
  await page
    .getByTestId("comment-form")
    .getByRole("button", { name: "Add comment", exact: true })
    .click();
  expect((await submitted).ok()).toBe(true);
  await expect(page.getByTestId("mutation-status")).toHaveText("Comment added");
  await expect(page.getByTestId("comment-form")).toHaveCount(0);
  await expect(page.getByTestId("task-detail")).toContainText(draft);
  await expect(page.getByTestId("task-detail").locator("img,script")).toHaveCount(0);
  await page.getByTestId("comment-compose-toggle").click();
  await expect(page.getByTestId("comment-body")).toHaveValue("");
  observations.push({
    surface: "comments",
    draftRetention: "section/cancel/close/failure",
    success: "server-confirmed",
    escaped: true,
  });
});

test("closing the detail returns focus and does not move the board", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const opener = page.locator(`#task-${FIX.taskDelegable}`).getByRole("button", { name: /Open / });
  await opener.scrollIntoViewIfNeeded();
  await opener.focus();
  const before = await page.evaluate(() => ({
    y: window.scrollY,
    x: document.querySelector(".project-lane-scroll")?.scrollLeft,
  }));
  await page.keyboard.press("Enter");
  await expect(page.locator("#task-detail-title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("task-detail")).toHaveCount(0);
  await expect(opener).toBeFocused();
  const after = await page.evaluate(() => ({
    y: window.scrollY,
    x: document.querySelector(".project-lane-scroll")?.scrollLeft,
  }));
  expect(after).toEqual(before);
});

test("pending decisions expose Answer/Resolve and Details, not a wall of forms", async ({
  page,
}) => {
  await signInAndOpenBoard(page, "owner");
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  const items = page.getByTestId("attention-item");
  await expect(items.first()).toBeVisible();
  const counts = await items.evaluateAll((nodes) =>
    nodes.map((node) => node.querySelectorAll("button").length),
  );
  expect(counts.every((count) => count <= 2)).toBe(true);
  await expect(page.locator(".attention-answer-form")).toHaveCount(0);
  const first = items.first();
  await first.getByRole("button", { name: "Details", exact: true }).click();
  await expect(first.locator(".attention-details")).toBeVisible();
  await first.getByRole("button", { name: "Answer", exact: true }).click();
  const input = first.locator("textarea");
  await input.fill("Synthetic retained answer");
  await first.getByRole("button", { name: "Cancel" }).click();
  await expect(first.getByRole("button", { name: "Answer", exact: true })).toBeFocused();
  await first.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(input).toHaveValue("Synthetic retained answer");
  await expect(first.locator("form")).toContainText("Provider-native permission");
  await page.screenshot({ path: path.join(evidenceDir, "attention.png"), fullPage: false });
  observations.push({
    surface: "attention",
    defaultActions: counts,
    draftRetained: true,
    nativePermissionSeparation: true,
  });
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} theme persists and visible product text has AA contrast`, async ({ page }) => {
    await signInAndOpenBoard(page, "owner");
    await appearance(page, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.reload();
    await expect(page.getByTestId("work-board")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const contrasts = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      function rgba(color: string): number[] {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data];
      }
      function luminance(color: number[]): number {
        const rgb = color.slice(0, 3).map((value) => {
          const c = value / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      }
      return [
        ...document.querySelectorAll(
          ".brand-mark,.section-summary,.task-state,.task-open strong,.punchline,.priority-marker,.attention-priority,.attention-reason,.workspace-status,.route-nav>button",
        ),
      ]
        .filter((node) => node.getClientRects().length)
        .map((node) => {
          const style = getComputedStyle(node);
          let ancestor: Element | null = node;
          let background = [255, 255, 255, 255];
          while (ancestor) {
            const color = rgba(getComputedStyle(ancestor).backgroundColor);
            if (color[3] === 255) {
              background = color;
              break;
            }
            ancestor = ancestor.parentElement;
          }
          const ink = luminance(rgba(style.color));
          const surface = luminance(background);
          return {
            selector: node.className,
            ratio: Number(
              ((Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05)).toFixed(2),
            ),
          };
        });
    });
    expect(contrasts.length).toBeGreaterThan(10);
    expect(contrasts.filter((check) => check.ratio < 4.5)).toEqual([]);
    await page.screenshot({ path: path.join(evidenceDir, `board-${theme}.png`), fullPage: false });
    await page.getByTestId("project-lanes").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(evidenceDir, `board-lanes-${theme}.png`),
      fullPage: false,
    });
    await openTask(page);
    await page.screenshot({ path: path.join(evidenceDir, `task-${theme}.png`), fullPage: false });
    observations.push({
      surface: "theme",
      theme,
      minimumTextContrast: Math.min(...contrasts.map((check) => check.ratio)),
      sampledTextNodes: contrasts.length,
    });
  });
}

test("system appearance reacts to media changes unless explicitly overridden", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signInAndOpenBoard(page, "owner");
  await appearance(page, "system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await appearance(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

for (const width of [320, 390, 768, 1440]) {
  test(`${width}px reflows without losing task or account controls`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signInAndOpenBoard(page, "owner");
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      laneScrollable:
        (document.querySelector(".project-lane-scroll")?.scrollWidth ?? 0) >
        (document.querySelector(".project-lane-scroll")?.clientWidth ?? 0),
    }));
    expect(layout.document).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "More navigation" }).click();
    await expect(page.getByRole("button", { name: "Runners", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Projects & policy" })).toBeVisible();
    await page.keyboard.press("Escape");
    await openTask(page);
    await page.getByTestId("comment-compose-toggle").click();
    await page.getByTestId("comment-body").fill("A long synthetic word ".repeat(35));
    const sheet = page.getByTestId("task-detail");
    if (width <= 720) {
      await expect(sheet).toHaveAttribute("aria-modal", "true");
      await expect(page.locator(".topbar")).toHaveAttribute("inert", "");
      await page
        .getByTestId("comment-form")
        .getByRole("button", { name: "Cancel", exact: true })
        .focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Close task" })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(
        page.getByTestId("comment-form").getByRole("button", { name: "Cancel", exact: true }),
      ).toBeFocused();
    }
    const bounds = await sheet.evaluate((node) => ({
      width: node.clientWidth,
      scrollWidth: node.scrollWidth,
      animation: getComputedStyle(node).animationDuration,
    }));
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1);
    expect(parseFloat(bounds.animation)).toBeLessThanOrEqual(0.001);
    await expect(page.getByRole("button", { name: "Close task" })).toBeVisible();
    await page.screenshot({ path: path.join(evidenceDir, `task-${width}.png`), fullPage: false });
    await page.getByRole("button", { name: "Close task" }).click();
    await expect(page.locator(".topbar")).not.toHaveAttribute("inert", "");
    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByTestId("theme-preference")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Account security" }).click();
    await expect(page.getByRole("heading", { name: "Secure your account" })).toBeVisible();
    observations.push({
      surface: "responsive",
      width,
      ...layout,
      sheetFits: true,
      accountControls: true,
      reducedMotion: true,
    });
  });
}

test("200 percent zoom keeps disclosure and close within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await signInAndOpenBoard(page, "owner");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await openTask(page);
  await expect
    .poll(async () => {
      const size = await page.getByTestId("task-detail").boundingBox();
      return Boolean(size && size.x >= 0 && size.x + size.width <= 1281);
    })
    .toBe(true);
  await expect(page.getByTestId("task-section")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close task" })).toBeVisible();
  observations.push({ surface: "zoom", factor: 2, closeVisible: true, sectionVisible: true });
});

test("read failures and empty board projections remain truthful and recoverable", async ({
  page,
}) => {
  await signInAndOpenBoard(page, "owner");
  const taskURL = `**/api/v1/workspaces/${FIX.workspace}/tasks/${FIX.taskDelegable}`;
  await page.route(taskURL, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "unavailable", message: "Synthetic read unavailable" }),
    }),
  );
  await page.locator(`#task-${FIX.taskDelegable}`).getByRole("button", { name: /Open / }).click();
  await expect(page.getByTestId("mutation-error")).toContainText("Synthetic read unavailable");
  await expect(page.getByTestId("task-section")).toHaveCount(0);
  await page.unroute(taskURL);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByTestId("task-section")).toHaveValue("overview");
  await page.getByRole("button", { name: "Close task" }).click();
  await page.route("**/api/v1/workspaces/*/board*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, lanes: [], needs_now: [] } });
  });
  await page.reload();
  await expect(page.getByTestId("needs-now-empty")).toBeVisible();
  await expect(page.getByText("No accessible projects.", { exact: true })).toBeVisible();
});
