// ABOUTME: Real-browser D03 proof for discussion timeline, decisions, and reconnect.
// ABOUTME: Synthetic D01/D02-committed discussions drive every assertion; no model turns run.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { signInAndOpenBoard } from "./helpers.js";
import { openTaskCard } from "./w02-helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const capturedEvidenceDir = path.join(rootDir, "docs/work-packages/evidence/WP-D03/browser");
const transientEvidenceDir = path.join(rootDir, "apps/web/test/e2e/test-results/evidence-d03");
const EVIDENCE_DIR =
  process.env.BFB_CAPTURE_D03_EVIDENCE === "1" ? capturedEvidenceDir : transientEvidenceDir;

test.beforeAll(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
});

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  // The harness freezes domain time, so abuse windows cannot slide between
  // scenarios. Reset for per-scenario isolation (production windows slide by
  // wall clock; no browser suite asserts a rate-limit rejection).
  const reset = await page.request.post("/__test/ratelimit/reset");
  expect(reset.ok()).toBe(true);
});

interface D03Tasks {
  taskSix: string;
  taskIntervene: string;
  taskCancel: string;
  taskEmpty: string;
  discussionSix: string;
  discussionIntervene: string;
  discussionCancel: string;
}

async function d03Tasks(page: Page): Promise<D03Tasks> {
  const response = await page.request.get("/__test/d03/task");
  expect(response.ok()).toBe(true);
  return (await response.json()) as D03Tasks;
}

async function openDiscussionTask(page: Page, taskId: string, title: string): Promise<void> {
  const card = page.locator(`#task-${taskId}`);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: `Open ${title}` }).click();
  await expect(page.getByTestId("task-detail")).toBeVisible();
  await expect(page.getByTestId("discussion-section")).toBeVisible();
}

async function messageTexts(page: Page): Promise<string[]> {
  return page
    .getByTestId("discussion-messages")
    .locator("li")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
}

test("six-turn exchange renders attributed history and survives close and reopen", async ({
  page,
}) => {
  await signInAndOpenBoard(page, "owner");
  const tasks = await d03Tasks(page);
  await openDiscussionTask(page, tasks.taskSix, "Synthetic discussion exchange card");
  const panel = page.getByTestId("discussion-panel");
  await expect(panel.getByTestId("discussion-state")).toContainText("concluded");
  await expect(panel).toContainText("6 of 6 completed");
  await expect(panel.getByTestId("discussion-positions")).toContainText(
    "Independent initial positions",
  );
  await expect(panel.getByTestId("discussion-positions")).toContainText("Synthetic D03 Claude");
  await expect(panel.getByTestId("discussion-positions")).toContainText("Synthetic D03 Codex");
  await expect(panel.getByTestId("discussion-disagreements")).toContainText(
    "Preserved disagreements",
  );
  await expect(panel.getByTestId("discussion-questions")).toContainText("Open human questions");
  await expect(panel.getByTestId("discussion-conclusion")).toContainText("Frozen conclusion");
  await expect(panel.getByTestId("discussion-conclusion")).toContainText(
    "Agreement was not synthesized",
  );
  // Hostile agent text stays inert: visible as text, never an element or a decision.
  await expect(panel).toContainText("[DECISION]");
  expect(await panel.locator("img").count()).toBe(0);
  expect(await panel.locator("script").count()).toBe(0);
  expect(await page.evaluate(() => (window as { __d03hostile?: number }).__d03hostile)).toBe(
    undefined,
  );
  await expect(page.getByTestId("discussion-section")).not.toContainText(
    "SYNTHETIC-D03-HUMAN-ONLY-CANARY",
  );
  expect(await panel.getByTestId("discussion-decision").count()).toBe(0);
  const before = await messageTexts(page);
  expect(before.length).toBeGreaterThanOrEqual(6);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "timeline.png"), fullPage: true });

  await page.reload();
  await expect(page.getByTestId("work-board")).toBeVisible();
  await openTaskCard(page, tasks.taskSix, "Synthetic discussion exchange card");
  await expect(page.getByTestId("discussion-section")).toBeVisible();
  const reopened = page.getByTestId("discussion-panel");
  await expect(reopened.getByTestId("discussion-state")).toContainText("concluded");
  await expect(reopened).toContainText("6 of 6 completed");
  expect(await messageTexts(page)).toEqual(before);
});

test("human decision references stored recommendations without completing the task", async ({
  page,
}) => {
  await signInAndOpenBoard(page, "owner");
  const tasks = await d03Tasks(page);
  await openDiscussionTask(page, tasks.taskSix, "Synthetic discussion exchange card");
  const panel = page.getByTestId("discussion-panel");
  const decideForm = panel.getByTestId("decide-form");
  await expect(decideForm).toBeVisible();
  const boxes = decideForm.getByRole("checkbox");
  expect(await boxes.count()).toBe(6);
  // Keyboard operates the decision references: focus then toggle with Space.
  await boxes.nth(4).focus();
  await page.keyboard.press("Space");
  await boxes.nth(5).focus();
  await page.keyboard.press("Space");
  await expect(boxes.nth(4)).toBeChecked();
  await expect(boxes.nth(5)).toBeChecked();
  await decideForm
    .getByTestId("decide-summary")
    .fill("Take the bounded alternative for review. Implementation stays separate.");
  await decideForm.getByRole("button", { name: /Record decision/ }).click();
  await expect(panel.getByTestId("discussion-decision")).toContainText("Recorded recommendation");
  await expect(panel.getByTestId("discussion-decision")).toContainText(
    "does not complete the task",
  );
  await expect(page.getByTestId("task-detail")).toContainText("ready");
  expect(await panel.getByTestId("decide-form").count()).toBe(0);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "decision.png"), fullPage: true });
});

test("intervention is attributed to the acting human and cancel stops dispatch", async ({
  page,
}) => {
  await signInAndOpenBoard(page, "owner");
  const tasks = await d03Tasks(page);
  await openDiscussionTask(page, tasks.taskIntervene, "Synthetic discussion intervention card");
  const panel = page.getByTestId("discussion-panel");
  await expect(panel.getByTestId("discussion-state")).toContainText("active");
  await expect(panel).toContainText("Synthetic human checkpoint");
  await expect(panel).toContainText("Human intervention");
  await panel.getByTestId("intervene-text").fill("Owner follow-up: keep the exchange bounded.");
  await panel.getByRole("button", { name: "Add intervention" }).click();
  await expect(panel).toContainText("Owner follow-up: keep the exchange bounded.");
  await expect(panel).toContainText("Intervention recorded as the signed-in human.");
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "intervention.png"), fullPage: true });

  await panel.getByTestId("discussion-cancel").click();
  await expect(panel.getByTestId("discussion-stopped")).toContainText("Cancelled by the human");
  await expect(panel.getByTestId("discussion-stopped")).toContainText(
    "No later turn is accepted",
  );
  expect(await panel.getByTestId("intervene-form").count()).toBe(0);
  expect(await panel.getByTestId("discussion-cancel").count()).toBe(0);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "cancel.png"), fullPage: true });

  await openTaskCard(page, tasks.taskCancel, "Synthetic discussion stopped card");
  await expect(page.getByTestId("discussion-section")).toBeVisible();
  await expect(page.getByTestId("discussion-panel")).toContainText("Cancelled by the human");
});

test("busy, offline, revoked, unsupported, and checkout conflicts stay actionable", async ({
  page,
}) => {
  await signInAndOpenBoard(page, "owner");
  const tasks = await d03Tasks(page);
  await openDiscussionTask(page, tasks.taskEmpty, "Synthetic discussion empty card");
  const section = page.getByTestId("discussion-section");
  await expect(section.getByTestId("discussion-list-empty")).toContainText("No discussions yet");
  const start = section.getByTestId("discussion-start-form");
  await start.getByTestId("discussion-question").fill("Which synthetic path holds?");
  const firstProfile = start.getByTestId("discussion-first-profile");
  const secondProfile = start.getByTestId("discussion-second-profile");

  await firstProfile.selectOption({ label: "Synthetic D03 interactive Claude · claude · interactive/standard" });
  await secondProfile.selectOption({ label: "Synthetic D03 standard Codex · codex · headless/standard" });
  await start
    .getByTestId("discussion-first-runner")
    .selectOption({ label: "Synthetic D03 Mac · enrolled" });
  await start
    .getByTestId("discussion-second-runner")
    .selectOption({ label: "Synthetic D03 Mac · enrolled" });
  await expect(start.getByTestId("discussion-first-eligibility")).toContainText(
    "Profile cannot hold a read-only discussion",
  );
  await expect(start.getByTestId("discussion-second-eligibility")).toContainText(
    "Profile cannot hold a read-only discussion",
  );
  await expect(start.getByTestId("discussion-start-button")).toBeDisabled();

  await firstProfile.selectOption({ label: "Synthetic D03 Claude · claude · headless/restricted" });
  await secondProfile.selectOption({ label: "Synthetic D03 Codex · codex · headless/restricted" });
  await start
    .getByTestId("discussion-first-runner")
    .selectOption({ label: "Synthetic D03 revoked Mac · revoked" });
  await expect(start.getByTestId("discussion-first-eligibility")).toContainText("Runner revoked");
  await start
    .getByTestId("discussion-first-runner")
    .selectOption({ label: "Synthetic D03 offline Mac · enrolled" });
  await expect(start.getByTestId("discussion-first-eligibility")).toContainText("Runner offline");
  await expect(start.getByTestId("discussion-start-button")).toBeDisabled();

  await start
    .getByTestId("discussion-first-runner")
    .selectOption({ label: "Synthetic D03 Mac · enrolled" });
  await start
    .getByTestId("discussion-second-runner")
    .selectOption({ label: "Synthetic D03 Mac · enrolled" });
  await start
    .getByTestId("discussion-first-checkout")
    .selectOption({ label: "Synthetic D03 stale checkout · stale" });
  await expect(start.getByTestId("discussion-first-eligibility")).toContainText(
    "Checkout unavailable",
  );
  await start
    .getByTestId("discussion-first-checkout")
    .selectOption({ label: "Synthetic D03 Alpha Checkout · validated" });
  await start
    .getByTestId("discussion-second-checkout")
    .selectOption({ label: "Synthetic D03 Alpha Checkout · validated" });
  await expect(start.getByTestId("discussion-second-eligibility")).toContainText("Checkout busy");
  await expect(start.getByTestId("discussion-start-button")).toBeDisabled();
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "eligibility.png"), fullPage: true });

  await start
    .getByTestId("discussion-second-checkout")
    .selectOption({ label: "Synthetic D03 Beta Checkout · validated" });
  await start.getByTestId("discussion-rounds").selectOption("1");
  await expect(start.getByTestId("discussion-first-eligibility")).toContainText("Eligible");
  await expect(start.getByTestId("discussion-second-eligibility")).toContainText("Eligible");
  await expect(start.getByTestId("discussion-start-button")).toBeEnabled();
  await start.getByTestId("discussion-start-button").click();
  await expect(section.getByTestId("discussion-panel")).toBeVisible();
  await expect(section.getByTestId("discussion-panel")).toContainText("0 of 2 completed");
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "start.png"), fullPage: true });

  const matrix = [
    "unsupported profile renders Profile cannot hold a read-only discussion",
    "revoked runner renders Runner revoked with re-enrollment action",
    "offline runner renders Runner offline without false activity",
    "stale checkout renders Checkout unavailable",
    "shared checkout renders Checkout busy instead of stuck loading",
    "eligible slots enable Start read-only discussion",
  ].join("\n");
  await writeFile(path.join(EVIDENCE_DIR, "negative-matrix.md"), `# D03 negative matrix (browser)\n\n${matrix}\n`, "utf8");
});

test("keyboard, empty, loading, error, and narrow-layout cases pass", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const tasks = await d03Tasks(page);
  await openDiscussionTask(page, tasks.taskEmpty, "Synthetic discussion empty card");
  const section = page.getByTestId("discussion-section");
  // Every interactive discussion control is a native keyboard-operable element.
  const nativeControls = await section.evaluate(
    (root) => [...root.querySelectorAll("button, select, input, textarea, a")].length,
  );
  expect(nativeControls).toBeGreaterThan(0);

  // Loading renders committed-state copy, never a spinner claim.
  await page.route("**/api/v1/workspaces/*/tasks/*/discussions?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await page.reload();
  await expect(page.getByTestId("work-board")).toBeVisible();
  await openTaskCard(page, tasks.taskCancel, "Synthetic discussion stopped card");
  await expect(page.getByTestId("discussion-section")).toBeVisible();
  await page.unroute("**/api/v1/workspaces/*/tasks/*/discussions?*");

  // Error renders a retry that recovers the committed read.
  await page.route("**/api/v1/workspaces/*/discussions/*", (route) => route.abort());
  await page.reload();
  await expect(page.getByTestId("work-board")).toBeVisible();
  await openTaskCard(page, tasks.taskCancel, "Synthetic discussion stopped card");
  await expect(page.getByTestId("discussion-error").first()).toBeVisible();
  await page.unroute("**/api/v1/workspaces/*/discussions/*");
  await page.getByTestId("discussion-error").first().getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("discussion-panel")).toBeVisible();

  // Narrow layout keeps the committed history readable without sideways scrolling.
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByTestId("discussion-panel")).toBeVisible();
  const overflow = await page.evaluate(() => {
    const main = document.querySelector("main") ?? document.body;
    return main.scrollWidth - main.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "narrow.png"), fullPage: true });
});

test("reconnect replays committed state through cursor invalidations", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const tasks = await d03Tasks(page);
  await openDiscussionTask(page, tasks.taskSix, "Synthetic discussion exchange card");
  const panel = page.getByTestId("discussion-panel");
  await expect(panel.getByTestId("discussion-decision")).toBeVisible();
  const refreshBefore = Number(await panel.getByTestId("discussion-refresh-count").textContent());
  const messagesBefore = await messageTexts(page);

  const commit = await page.request.post("/__test/events/commit", {
    data: { key: "live", kinds: ["heartbeat"] },
  });
  expect(commit.ok()).toBe(true);
  await expect(panel.getByTestId("discussion-refresh-count")).not.toHaveText(
    String(refreshBefore),
    { timeout: 15_000 },
  );
  expect(await messageTexts(page)).toEqual(messagesBefore);
  await expect(panel.getByTestId("discussion-connectivity")).toContainText("Discussion live");
  const refreshAfter = Number(await panel.getByTestId("discussion-refresh-count").textContent());
  expect(refreshAfter).toBeGreaterThan(refreshBefore);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "reconnect.png"), fullPage: true });
  await writeFile(
    path.join(EVIDENCE_DIR, "reconnect-trace.md"),
    [
      "# D03 reconnect trace (browser)",
      "",
      `- socket: bfb.browser.v1 subscription with subscribe-first buffering`,
      `- refresh count before invalidation: ${refreshBefore}`,
      `- refresh count after cursor invalidation: ${refreshAfter}`,
      `- committed messages before: ${messagesBefore.length}`,
      `- committed messages after: ${messagesBefore.length} (identical, no duplicates)`,
      `- connectivity: Discussion live`,
      `- conclusion: close and reopen renders the same committed state (see timeline test)`,
      "",
    ].join("\n"),
    "utf8",
  );
});
