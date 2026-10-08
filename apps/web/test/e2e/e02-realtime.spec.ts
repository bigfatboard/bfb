// ABOUTME: Proves the held timeline is truthful and makes no public feed or socket attempts in Chromium.
// ABOUTME: Synthetic committed history remains stored without becoming live presence or an empty-history claim.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

import { signInAndOpenBoard, type RoleKey } from "./helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const EVIDENCE_DIR =
  process.env.BFB_CAPTURE_E02_EVIDENCE === "1"
    ? path.join(rootDir, "docs/work-packages/evidence/WP-E02/browser")
    : path.join(rootDir, "apps/web/test/e2e/test-results/evidence-e02");
test.beforeAll(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
});
test.describe.configure({ mode: "serial" });

async function taskIds(page: Page): Promise<{ live_task_id: string; stale_task_id: string }> {
  const response = await page.request.get("/__test/e02/task");
  expect(response.ok()).toBe(true);
  return (await response.json()) as { live_task_id: string; stale_task_id: string };
}

function observePublicAttempts(page: Page) {
  const feeds: string[] = [];
  const sockets: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.endsWith("/events") ||
      url.pathname.endsWith("/events/high-water") ||
      url.pathname.endsWith("/activity") ||
      url.pathname.endsWith("/measurement-sources")
    )
      feeds.push(url.pathname);
  });
  // Vite HMR is a development transport, not a public BFB subscription.
  page.on("websocket", (socket) => {
    if (/^\/realtime\/workspaces\/[^/]+\/subscribe$/u.test(new URL(socket.url()).pathname))
      sockets.push(socket.url());
  });
  return { feeds, sockets };
}

async function openTimeline(page: Page, taskId: string): Promise<void> {
  await page.locator(`#task-${taskId}`).getByRole("button", { name: /Open / }).click();
  await expect(page.getByTestId("task-section")).toHaveValue("overview");
  await expect(page.getByTestId("run-timeline-section")).toHaveCount(0);
  await page.getByTestId("task-section").selectOption("activity");
  await expect(page.getByTestId("timeline-unavailable")).toHaveText(
    "Run timeline and live presence are unavailable.",
  );
}

async function noInventedState(page: Page): Promise<void> {
  const section = page.getByTestId("run-timeline-section");
  await expect(
    section.locator("[data-cursor], [data-testid=run-presence], button, select"),
  ).toHaveCount(0);
  await expect(page.getByTestId("realtime-connectivity")).toHaveCount(0);
  await expect(section).not.toContainText(/No runs|No committed|Realtime live|offline|Reviewed/);
}

for (const role of ["owner", "restricted"] as RoleKey[]) {
  test(`${role} sees an on-demand unavailable timeline without public attempts`, async ({
    page,
  }) => {
    const attempts = observePublicAttempts(page);
    await signInAndOpenBoard(page, role);
    const tasks = await taskIds(page);
    await openTimeline(page, tasks.live_task_id);
    await noInventedState(page);
    expect(attempts).toEqual({ feeds: [], sockets: [] });
    if (role === "owner") {
      for (const theme of ["light", "dark"] as const) {
        await page.getByRole("button", { name: "Account menu" }).click();
        await page.getByTestId("theme-preference").selectOption(theme);
        await page.keyboard.press("Escape");
        await page.getByTestId("run-timeline-section").screenshot({
          path: path.join(EVIDENCE_DIR, `timeline-unavailable-${theme}.png`),
        });
      }
    }
  });
}

test("a committed event cannot nudge or populate a hidden timeline", async ({ page }) => {
  const attempts = observePublicAttempts(page);
  await signInAndOpenBoard(page, "owner");
  const tasks = await taskIds(page);
  await openTimeline(page, tasks.live_task_id);
  await page.getByTestId("task-section").selectOption("overview");
  await expect(page.getByTestId("run-timeline-section")).not.toBeVisible();
  const committed = await page.request.post("/__test/events/commit", {
    data: { key: "live", kinds: ["heartbeat"] },
  });
  expect(committed.ok()).toBe(true);
  expect(((await committed.json()) as { dispositions: string[] }).dispositions).toEqual([
    "accepted",
  ]);
  await page.getByTestId("task-section").selectOption("activity");
  await noInventedState(page);
  await expect(page.getByTestId("timeline-unavailable")).toBeVisible();
  expect(attempts).toEqual({ feeds: [], sockets: [] });
});

test("reload and task changes cannot restore stale timeline or presence state", async ({
  page,
}) => {
  const attempts = observePublicAttempts(page);
  await signInAndOpenBoard(page, "owner");
  const tasks = await taskIds(page);
  await openTimeline(page, tasks.live_task_id);
  await page.reload();
  await expect(page.getByTestId("work-board")).toBeVisible();
  await openTimeline(page, tasks.live_task_id);
  await noInventedState(page);
  await page.getByRole("button", { name: "Close task" }).click();
  await openTimeline(page, tasks.stale_task_id);
  await noInventedState(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("timeline-unavailable")).toBeVisible();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "timeline-unavailable-narrow.png"),
    fullPage: true,
  });
  expect(attempts).toEqual({ feeds: [], sockets: [] });
});
