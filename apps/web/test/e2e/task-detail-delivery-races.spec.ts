// ABOUTME: Exercises denied task-detail presentation and keyboard retry in Chromium light and dark themes.
// ABOUTME: Uses disposable V03 read fixtures and intercepts every workspace POST without certifying server authorization.

import { expect, test, type Page } from "@playwright/test";

import { FIX, openWorkSurface, signInAs } from "./helpers.js";
import { V03_HOSTILE_ARTIFACT, V03_RUN, V03_TASK } from "../../../../tools/e2e/src/v03-fixture.js";

const BASE = `/api/v1/workspaces/${FIX.workspace}`;
const RESULT_CANARY = "SYNTHETIC PRESENTATION result — not a persisted submission";
const DRAFT = "Synthetic retained browser note";
type Theme = "light" | "dark";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function openPanel(page: Page, theme: Theme, section: string): Promise<void> {
  await signInAs(page, "owner");
  await openWorkSurface(page);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByTestId("theme-preference").selectOption(theme);
  await page.keyboard.press("Escape");
  await page.locator(`#task-${V03_TASK}`).getByRole("button", { name: /Open / }).click();
  await page.getByTestId("task-section").selectOption(section);
}

/** All mutations are intercepted presentation responses, including incidental viewer grants. */
async function holdDeniedMutation(page: Page, suffix: string, status = 403) {
  const entered = deferred<void>(),
    release = deferred<void>();
  let intercepted = 0;
  await page.route("**/api/v1/workspaces/**", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    if (new URL(route.request().url()).pathname.endsWith(suffix)) {
      intercepted += 1;
      entered.resolve();
      await release.promise;
      await route.fulfill({
        status,
        json: {
          ok: false,
          error: {
            code: status === 404 ? "not_found" : "forbidden",
            message: "Synthetic presentation authority denial — no business write",
          },
        },
      });
      return;
    }
    await route.fulfill({
      status: 409,
      json: {
        ok: false,
        error: {
          code: "request_rejected",
          message: "Synthetic presentation test does not admit workspace writes",
        },
      },
    });
  });
  return { entered: entered.promise, release: () => release.resolve(), count: () => intercepted };
}

async function keyboardRetry(page: Page, testId: string): Promise<void> {
  const retry = page.getByTestId(testId);
  await expect(retry).toBeVisible();
  await retry.focus();
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter");
}

async function syntheticResultReads(page: Page): Promise<void> {
  // Only the presentation task state and result bodies are replaced. These are not canonical submissions.
  await page.route(`**${BASE}/tasks/${V03_TASK}`, async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { task: Record<string, unknown> };
    body.task.state = "review";
    await route.fulfill({ response, json: body });
  });
  await page.route(`**${BASE}/tasks/${V03_TASK}/runs*`, (route) =>
    route.fulfill({
      json: {
        runs: [{ id: V03_RUN, result_state: "submitted", activity: "idle", resource_version: 1 }],
      },
    }),
  );
  await page.route(`**${BASE}/runs/${V03_RUN}/results*`, (route) =>
    route.fulfill({
      json: {
        submissions: [
          {
            id: "synthetic-presentation-submission",
            version: 1,
            summary: RESULT_CANARY,
            limitations: "",
            evidence_refs: [],
            git_branch: null,
            git_commit: null,
            git_dirty: null,
            submitted_by_kind: "human",
            submitted_at: "2026-10-07T12:00:00Z",
            superseded: false,
            outdated: false,
            outdated_reasons: [],
          },
        ],
      },
    }),
  );
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme} measurement denial removes real fixture totals/timers and keyboard retry restores reads`, async ({
    page,
  }) => {
    const denial = await holdDeniedMutation(page, `/tasks/${V03_TASK}/review-timers`, 404);
    await openPanel(page, theme, "measurements");
    await expect(page.getByTestId("measurements-human")).toBeVisible();
    await expect(page.getByTestId("measurements-provenance")).toBeVisible();
    await page.getByTestId("review-timer-start").click();
    await denial.entered;
    denial.release();
    await expect(page.getByTestId("measurements-error")).toContainText(
      "Synthetic presentation authority denial",
    );
    await expect(page.getByTestId("measurements-human")).toHaveCount(0);
    await expect(page.getByTestId("measurements-provenance")).toHaveCount(0);
    await expect(page.getByTestId("review-timer-row")).toHaveCount(0);
    await expect(page.getByTestId("review-timer-start")).toHaveCount(0);
    await expect(page.getByTestId("review-timer-stop")).toHaveCount(0);
    await page.getByTestId("task-detail").screenshot({
      path: test.info().outputPath(`measurements-denied-${theme}.png`),
      animations: "disabled",
    });
    await keyboardRetry(page, "measurements-retry");
    await expect(page.getByTestId("measurements-human")).toBeVisible();
    await expect(page.getByTestId("review-timer-start")).toBeVisible();
    expect(denial.count()).toBe(1);
  });

  test(`${theme} artifact denial removes real fixture review/viewer/actions and retry retains the note`, async ({
    page,
  }) => {
    const denial = await holdDeniedMutation(page, `/artifacts/${V03_HOSTILE_ARTIFACT}/reviews`);
    await openPanel(page, theme, "artifacts");
    await page.getByTestId("review-artifact-select").selectOption(V03_HOSTILE_ARTIFACT);
    await expect(page.getByTestId("review-provenance")).toBeVisible();
    await expect(page.getByTestId("artifact-viewer")).toBeVisible();
    await page.getByTestId("review-note").fill(DRAFT);
    await page.getByTestId("review-comment-submit").click();
    await denial.entered;
    denial.release();
    await expect(page.getByTestId("review-error")).toContainText(
      "Synthetic presentation authority denial",
    );
    await expect(page.getByTestId("review-provenance")).toHaveCount(0);
    await expect(page.getByTestId("review-record")).toHaveCount(0);
    await expect(page.getByTestId("review-artifact-select")).toHaveCount(0);
    await expect(page.getByTestId("artifact-viewer")).toHaveCount(0);
    await expect(page.getByTestId("review-decide-form")).toHaveCount(0);
    await page.getByTestId("task-detail").screenshot({
      path: test.info().outputPath(`artifact-denied-${theme}.png`),
      animations: "disabled",
    });
    await keyboardRetry(page, "review-reload");
    await expect(page.getByTestId("review-provenance")).toBeVisible();
    await expect(page.getByTestId("review-artifact-select")).toHaveValue(V03_HOSTILE_ARTIFACT);
    await expect(page.getByTestId("review-note")).toHaveValue(DRAFT);
    expect(denial.count()).toBe(1);
  });

  test(`${theme} hidden synthetic result denial shows only an opt-in label and keyboard retry`, async ({
    page,
  }) => {
    const denial = await holdDeniedMutation(page, `/runs/${V03_RUN}/review`);
    await syntheticResultReads(page);
    await openPanel(page, theme, "results");
    await expect(page.getByTestId("result-summary")).toHaveText(RESULT_CANARY);
    await page.getByTestId("request-changes-comment").fill(DRAFT);
    await page.getByTestId("accept-result").click();
    await denial.entered;
    await page.getByTestId("task-section").selectOption("overview");
    denial.release();
    const notice = page.getByTestId("hidden-section-alert");
    await expect(notice).toBeVisible();
    await expect(notice).not.toContainText(RESULT_CANARY);
    await expect(notice).not.toContainText("Synthetic presentation authority denial");
    await expect(page.getByTestId("task-section")).toHaveValue("overview");
    await expect(page.locator('[data-panel="results"]')).toHaveAttribute("hidden", "");
    await expect(page.getByTestId("result-summary")).toHaveCount(0);
    await expect(page.getByTestId("run-result-row")).toHaveCount(0);
    await expect(page.getByTestId("accept-result")).toHaveCount(0);
    await expect(page.getByTestId("request-changes-form")).toHaveCount(0);
    await page.getByTestId("task-detail").screenshot({
      path: test.info().outputPath(`hidden-result-denied-${theme}.png`),
      animations: "disabled",
    });
    await notice.getByRole("button", { name: "Show section error" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("task-section")).toBeFocused();
    await expect(page.getByTestId("task-section")).toHaveValue("results");
    await keyboardRetry(page, "result-retry");
    await expect(page.getByTestId("result-summary")).toHaveText(RESULT_CANARY);
    await expect(page.getByTestId("request-changes-comment")).toHaveValue(DRAFT);
    expect(denial.count()).toBe(1);
  });
}
