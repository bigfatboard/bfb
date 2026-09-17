// ABOUTME: Real Chromium proof for W02 runner and launch operations.
// ABOUTME: Synthetic C09 launches drive pending, wake, control, expiry, and recovery UI.

import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { runnerGrantsTarget } from "@bfb/domain";

import { signInAndOpenBoard } from "./helpers.js";
import { enrollVirtualPasskey } from "./webauthn-helpers.js";
import {
  apiFetch,
  ensureEvidenceDir,
  FIX,
  openTaskCard,
  stepUpProof,
  W02_EVIDENCE_DIR,
  waitForStartReady,
  writeW02Report,
} from "./w02-helpers.js";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await ensureEvidenceDir();
});

const RUNNER_LABEL = "Synthetic Launch Mac";
const W02_RUNNER_ID = "01JBFB0TASKW021000000000R1";
const LAUNCH_ORIGIN = "https://launch.bfb.example.test";
const trace: {
  startPosts?: { status: number; key: string; launch: string }[];
  wakeLaunches?: string[];
  controlIds?: string[];
} = {};

async function openRunners(page: Parameters<typeof openTaskCard>[0]): Promise<void> {
  await page.getByRole("button", { name: "Runners" }).click();
  await expect(page.getByTestId("runner-operations")).toBeVisible();
}

/**
 * Pins the Start form to W02's runner and checkout. The shared fixture also
 * enrols the E02 Mac, whose list position is random per server start, so the
 * launchable[0] default must never decide where a W02 launch posts.
 */
async function selectW02RunnerAndCheckout(page: Page): Promise<void> {
  await page.getByTestId("start-runner").selectOption(W02_RUNNER_ID);
  await expect(page.getByTestId("start-runner")).toHaveValue(W02_RUNNER_ID);
  const checkout = page.getByTestId("start-checkout");
  let alphaValue = "";
  await expect
    .poll(
      async () => {
        const options = await checkout.locator("option").evaluateAll((nodes) =>
          nodes.map((node) => ({
            value: (node as HTMLOptionElement).value,
            text: node.textContent ?? "",
          })),
        );
        alphaValue =
          options.find((option) => option.text.includes("Synthetic Alpha Checkout"))?.value ?? "";
        return alphaValue;
      },
      { timeout: 15_000 },
    )
    .not.toBe("");
  await checkout.selectOption(alphaValue);
}

test("granted member starts the shared Mac on the member card", async ({ page }) => {
  await signInAndOpenBoard(page, "member");
  await openTaskCard(page, FIX.taskLaunchStart, "Synthetic member launch card");
  await waitForStartReady(page);
  await selectW02RunnerAndCheckout(page);
  const runnerOptions = await page
    .getByTestId("start-runner")
    .locator("option")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).text));
  expect(runnerOptions.some((text) => text.includes(RUNNER_LABEL))).toBe(true);
  const checkoutOptions = await page
    .getByTestId("start-checkout")
    .locator("option")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).text));
  expect(checkoutOptions.some((text) => text.includes("Synthetic Alpha Checkout"))).toBe(true);
  await page.getByTestId("start-button").click();
  await expect(page.getByText("Pending Mac claim")).toBeVisible();
  await expect(page.getByTestId("launch-list").locator("article")).toHaveCount(1);
  await page.screenshot({ path: path.join(W02_EVIDENCE_DIR, "member-start.png") });
});

test("owner double submit records one durable launch", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  await openTaskCard(page, FIX.taskLaunch, "Synthetic launch card");
  await waitForStartReady(page);
  await selectW02RunnerAndCheckout(page);
  const posts: { status: number; body: Record<string, unknown> }[] = [];
  page.on("response", (response) => {
    const request = response.request();
    if (
      request.method() === "POST" &&
      /\/api\/v1\/workspaces\/[^/]+\/launches$/.test(new URL(request.url()).pathname)
    ) {
      posts.push({
        status: response.status(),
        body: request.postDataJSON() as Record<string, unknown>,
      });
    }
  });
  await page.evaluate(() => {
    const form = document.querySelector('[data-testid="start-form"]') as HTMLFormElement;
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(page.getByText("Pending Mac claim")).toBeVisible();
  await expect(page.getByTestId("launch-list").locator("article")).toHaveCount(1);
  await expect.poll(() => posts.length, { timeout: 15_000 }).toEqual(2);
  const created = posts.find((post) => post.status === 201);
  expect(created, "one of the duplicate submits records the launch").toBeTruthy();
  expect(posts[0]!.body["idempotency_key"]).toBe(posts[1]!.body["idempotency_key"]);
  const listed = (await apiFetch(
    page,
    "GET",
    `/api/v1/workspaces/${FIX.workspace}/launches?task_id=${FIX.taskLaunch}`,
  ).then((result) => result.body)) as { launches: { launch_id: string }[] };
  expect(listed.launches).toHaveLength(1);
  const replayed = await apiFetch(
    page,
    "POST",
    `/api/v1/workspaces/${FIX.workspace}/launches`,
    created!.body,
  );
  expect(replayed.status).toBe(201);
  expect((replayed.body as { launch_id: string }).launch_id).toBe(listed.launches[0]!.launch_id);
  trace.startPosts = posts.map((post) => ({
    status: post.status,
    key: post.body["idempotency_key"] as string,
    launch: listed.launches[0]!.launch_id,
  }));
  await page.screenshot({ path: path.join(W02_EVIDENCE_DIR, "start-pending.png") });
});

test("ungranted teammate cannot select or wake another human's runner", async ({ page }) => {
  await signInAndOpenBoard(page, "restricted");
  await openTaskCard(page, FIX.taskLaunch, "Synthetic launch card");
  await expect(page.getByTestId("launch-readonly")).toBeVisible();
  await expect(page.getByTestId("start-form")).toHaveCount(0);
  const launchId = await page.evaluate(
    async ({ workspace, taskId }) => {
      const response = await fetch(`/api/v1/workspaces/${workspace}/launches?task_id=${taskId}`);
      const body = (await response.json()) as { launches: { launch_id: string }[] };
      return body.launches[0]!.launch_id;
    },
    { workspace: FIX.workspace, taskId: FIX.taskLaunch },
  );
  const startDenied = await apiFetch(page, "POST", `/api/v1/workspaces/${FIX.workspace}/launches`, {
    schema_version: 1,
    idempotency_key: "X".repeat(26),
    task_id: FIX.taskLaunch,
    expected_task_version: 1,
    agent_profile_id: "X".repeat(26),
    agent_profile_version: 1,
    workspace_policy_version: 2,
    project_policy_version: 2,
    repository_config_version: 2,
    runner_id: "X".repeat(26),
    checkout_id: "X".repeat(26),
  });
  expect(startDenied.status).toBe(403);
  const wakeDenied = await apiFetch(
    page,
    "POST",
    `/api/v1/workspaces/${FIX.workspace}/launches/wake`,
    { schema_version: 1, launch_id: launchId },
  );
  expect(wakeDenied.status).toBe(403);
  await writeW02Report(
    "permission-matrix.md",
    [
      "# Permission matrix (W02 browser E2E)",
      "",
      "- Restricted human opens the launch card: start form absent, read-only notice shown.",
      `- Restricted Start POST: ${startDenied.status} (role is not owner/member).`,
      `- Restricted wake POST for another human's launch: ${wakeDenied.status}.`,
      "- Member with a launcher grant started the shared Mac on the member card.",
      "- Result: an ungranted teammate cannot select or wake another human's runner.",
      "",
    ].join("\n"),
  );
});

test("owner wakes the pending launch through C09's link only", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __w02Opened: string[] }).__w02Opened = [];
    window.open = ((url: string) => {
      (window as unknown as { __w02Opened: string[] }).__w02Opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await signInAndOpenBoard(page, "owner");
  await openTaskCard(page, FIX.taskLaunch, "Synthetic launch card");
  await expect(page.getByText("Pending Mac claim")).toBeVisible();
  await page.getByRole("button", { name: "Wake Mac (optional signal)" }).click();
  const anchor = page.locator('[data-testid^="wake-link-"] a');
  await expect(anchor).toBeVisible();
  const href = (await anchor.getAttribute("href"))!;
  expect(href).toMatch(
    new RegExp(`^${LAUNCH_ORIGIN.replaceAll(".", "\\.")}/l/[0-7][0-9A-HJKMNP-TV-Z]{25}$`),
  );
  const opened = await page.evaluate(
    () => (window as unknown as { __w02Opened: string[] }).__w02Opened,
  );
  expect(opened).toEqual([href]);
  const section = await page.getByTestId("launch-section").innerText();
  expect(section).not.toMatch(/__launch|terminal intent|uuid|argv/i);
  const launchId = await page.evaluate(
    async ({ workspace, taskId }) => {
      const response = await fetch(`/api/v1/workspaces/${workspace}/launches?task_id=${taskId}`);
      const body = (await response.json()) as { launches: { launch_id: string }[] };
      return body.launches[0]!.launch_id;
    },
    { workspace: FIX.workspace, taskId: FIX.taskLaunch },
  );
  const again = await apiFetch(page, "POST", `/api/v1/workspaces/${FIX.workspace}/launches/wake`, {
    schema_version: 1,
    launch_id: launchId,
  });
  expect(again.status).toBe(201);
  trace.wakeLaunches = [launchId, (again.body as { launch_id: string }).launch_id];
  expect(trace.wakeLaunches[0]).toBe(trace.wakeLaunches[1]);
  await page.screenshot({ path: path.join(W02_EVIDENCE_DIR, "wake-link.png") });
});

test("duplicate cancel shares one disposition and settles the launch", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  await openTaskCard(page, FIX.taskLaunch, "Synthetic launch card");
  await expect(page.getByText("Pending Mac claim")).toBeVisible();
  const controls: Record<string, unknown>[] = [];
  page.on("response", (response) => {
    const request = response.request();
    if (
      request.method() === "POST" &&
      /\/api\/v1\/workspaces\/[^/]+\/run-controls$/.test(new URL(request.url()).pathname)
    ) {
      controls.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  await page.getByRole("button", { name: "Send cancel" }).click();
  await expect(page.locator('[data-testid^="control-result-"]')).toHaveCount(1);
  const first = await page.locator('[data-testid^="control-result-"]').innerText();
  expect(first).toMatch(/applied/);
  await expect(page.getByText("Launch rejected")).toBeVisible();
  await expect.poll(() => controls.length, { timeout: 15_000 }).toEqual(1);
  const repeated = await apiFetch(
    page,
    "POST",
    `/api/v1/workspaces/${FIX.workspace}/run-controls`,
    controls[0],
  );
  expect(repeated.status).toBe(201);
  const firstId = first.match(/Control ([0-9A-HJKMNP-TV-Z]{26})/)?.[1];
  expect((repeated.body as { control_id: string }).control_id).toBe(firstId);
  await expect(page.locator('[data-testid^="control-result-"]')).toHaveCount(1);
  trace.controlIds = [first];
  await writeW02Report(
    "idempotency-traces.md",
    [
      "# Idempotency traces (W02 browser E2E)",
      "",
      `- Double Start: two POSTs, one idempotency key \`${trace.startPosts?.[0]?.key}\`, one launch \`${trace.startPosts?.[0]?.launch}\`.`,
      `- Duplicate wake: two hints for one launch \`${trace.wakeLaunches?.[0]}\`; the durable command is unchanged.`,
      `- Duplicate cancel: one control result \`${first.trim()}\`; no second control exists.`,
      "- No cloud wake value reaches a Terminal command: the launch section renders no helper invocation.",
      "",
    ].join("\n"),
  );
});

test("expired launch waits for another explicit click", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  await openTaskCard(page, FIX.taskLaunchExpired, "Synthetic expired launch");
  await waitForStartReady(page);
  await selectW02RunnerAndCheckout(page);
  await expect(page.getByText("Launch expired")).toBeVisible();
  const expiredId = await page.evaluate(
    async ({ workspace, taskId }) => {
      const response = await fetch(`/api/v1/workspaces/${workspace}/launches?task_id=${taskId}`);
      const body = (await response.json()) as {
        launches: { launch_id: string; run_id: string }[];
      };
      return body.launches[0]!;
    },
    { workspace: FIX.workspace, taskId: FIX.taskLaunchExpired },
  );
  await page.waitForTimeout(6000);
  const count = await page.getByTestId("launch-list").locator("article").count();
  expect(count).toBe(1);
  await page.getByRole("button", { name: "Start again explicitly" }).click();
  await expect(page.getByText("Pending Mac claim")).toBeVisible();
  const launches = await page.evaluate(
    async ({ workspace, taskId }) => {
      const response = await fetch(`/api/v1/workspaces/${workspace}/launches?task_id=${taskId}`);
      return (await response.json()) as { launches: { launch_id: string; run_id: string }[] };
    },
    { workspace: FIX.workspace, taskId: FIX.taskLaunchExpired },
  );
  expect(launches.launches).toHaveLength(2);
  const retried = launches.launches.find((item) => item.launch_id !== expiredId.launch_id)!;
  expect(retried.run_id).toBe(expiredId.run_id);
  await page.screenshot({ path: path.join(W02_EVIDENCE_DIR, "expired-retry.png") });
});

test("containment unknown offers only the local handoff", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  await openTaskCard(page, FIX.taskLaunchContained, "Synthetic contained launch");
  await expect(page.getByText("Containment unknown")).toBeVisible();
  await expect(page.getByTestId("local-recovery")).toContainText("No web action clears");
  await expect(page.getByTestId("launch-result")).toContainText("Result: open");
  const section = page.getByTestId("launch-section");
  await expect(section.getByRole("button", { name: /clear|recover|resolve/i })).toHaveCount(0);
  await page.screenshot({ path: path.join(W02_EVIDENCE_DIR, "containment.png") });
});

test("ended process leaves result and task open", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  await openTaskCard(page, FIX.taskLaunchEnded, "Synthetic ended launch");
  await expect(page.getByText("Process ended")).toBeVisible();
  await expect(page.getByText(/not marked done/)).toBeVisible();
  await expect(page.getByTestId("launch-result")).toContainText("Result: open");
  await expect(page.getByTestId("launch-list")).toContainText("Mac fence: released");
  await page.screenshot({ path: path.join(W02_EVIDENCE_DIR, "process-ended.png") });
  const recording = await apiFetch(
    page,
    "GET",
    `/api/v1/workspaces/${FIX.workspace}/launches?task_id=${FIX.taskLaunchEnded}`,
  );
  await writeW02Report(
    "fake-launch-recording.md",
    [
      "# Provider-neutral fake-launch recording (W02 browser E2E)",
      "",
      "Synthetic `fake`/`synthetic` launches only. No provider credential, task body, or local path.",
      "",
      "```json",
      JSON.stringify(recording.body, null, 2),
      "```",
      "",
    ].join("\n"),
  );
  await writeW02Report(
    "blocked-states.md",
    [
      "# Blocked and recovery states (W02 browser E2E)",
      "",
      "- `start-pending.png`: pending Mac claim with optional wake and cancel.",
      "- `expired-retry.png`: expired launch requiring another explicit click; retry reuses the run.",
      "- `containment.png`: containment unknown with the local-only recovery handoff.",
      "- `process-ended.png`: ended execution with the result still open; the task is not done.",
      "- `member-start.png`: granted member Start on the shared Mac.",
      "- `wake-link.png`: C09 wake link opened as an optional signal, never a command.",
      "- `runners.png`: runner operations with checkouts, capability, and last Mac report.",
      "",
    ].join("\n"),
  );
});

test("runner operations show checkouts, capability, and step-up sharing", async ({
  page,
  browser,
}) => {
  await signInAndOpenBoard(page, "owner");
  await openRunners(page);
  const w02Card = page.getByTestId(`runner-${W02_RUNNER_ID}`);
  await expect(w02Card.getByText(RUNNER_LABEL)).toBeVisible();
  await expect(w02Card.getByText("Synthetic Alpha Checkout")).toBeVisible();
  await expect(w02Card.getByText("Synthetic Beta Checkout")).toBeVisible();
  await expect(w02Card.getByText("Synthetic Gamma Checkout")).toBeVisible();
  await expect(w02Card.getByText(/launch.interactive/)).toBeVisible();
  await page.screenshot({ path: path.join(W02_EVIDENCE_DIR, "runners.png") });

  const runnerId = await page.evaluate(
    async ({ workspace, w02RunnerId }) => {
      const response = await fetch(`/api/v1/workspaces/${workspace}/runners`);
      const body = (await response.json()) as {
        runners: { runner_id: string; grant_epoch: number }[];
      };
      const found = body.runners.find((runner) => runner.runner_id === w02RunnerId);
      if (!found) {
        throw new Error(`W02 runner ${w02RunnerId} is not visible to the owner`);
      }
      return found;
    },
    { workspace: FIX.workspace, w02RunnerId: W02_RUNNER_ID },
  );
  const memberPage = await browser.newPage();
  const restrictedPage = await browser.newPage();
  const authenticator = await enrollVirtualPasskey(page);
  try {
    await restrictedPage.goto("/__test/session/restricted");
    await signInAndOpenBoard(restrictedPage, "restricted");
    await openRunners(restrictedPage);
    await expect(restrictedPage.getByText("No runners available")).toBeVisible();
    await expect(restrictedPage.getByTestId(`grants-${runnerId.runner_id}`)).toHaveCount(0);
    const reviewerDenied = await apiFetch(
      restrictedPage,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/runners/${runnerId.runner_id}/grants`,
      {
        expected_grant_epoch: runnerId.grant_epoch,
        project_ids: [FIX.projectA],
        launcher_human_ids: [FIX.owner],
        step_up_proof_id: "X".repeat(26),
      },
    );
    expect(reviewerDenied.status).toBe(403);

    const denied = await apiFetch(
      page,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/runners/${runnerId.runner_id}/grants`,
      {
        expected_grant_epoch: runnerId.grant_epoch,
        project_ids: [],
        launcher_human_ids: [],
      },
    );
    expect(denied.status).toBe(403);

    const grantsForm = page.getByTestId(`grants-${runnerId.runner_id}`);
    await grantsForm.getByText(/Synthetic Member/).click();
    await grantsForm.getByText("I recognize every named launcher.").click();
    await grantsForm.getByRole("button", { name: "Verify passkey & save sharing" }).click();
    await expect(page.getByRole("status")).toContainText("Sharing updated");
    await memberPage.goto("/__test/session/member");
    const memberGone = await apiFetch(
      memberPage,
      "GET",
      `/api/v1/workspaces/${FIX.workspace}/runners/${runnerId.runner_id}/checkouts`,
    );
    expect(memberGone.status).toBe(403);

    const staleTarget = runnerGrantsTarget({
      runnerId: runnerId.runner_id,
      expectedGrantEpoch: runnerId.grant_epoch,
      projectIds: [FIX.projectA],
      launcherHumanIds: [FIX.owner, FIX.member],
    });
    const stale = await stepUpProof(page, "runner.grants.replace", staleTarget);
    expect(stale.proof, stale.failure).toBeTruthy();
    const staleDenied = await apiFetch(
      page,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/runners/${runnerId.runner_id}/grants`,
      {
        expected_grant_epoch: runnerId.grant_epoch,
        project_ids: [FIX.projectA],
        launcher_human_ids: [FIX.owner, FIX.member],
        step_up_proof_id: stale.proof,
      },
    );
    expect(staleDenied.status).toBe(403);

    const wrong = await stepUpProof(page, "runner.revoke", runnerId.runner_id);
    expect(wrong.proof, wrong.failure).toBeTruthy();
    const wrongDenied = await apiFetch(
      page,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/runners/${runnerId.runner_id}/grants`,
      {
        expected_grant_epoch: runnerId.grant_epoch + 1,
        project_ids: [FIX.projectA],
        launcher_human_ids: [FIX.owner, FIX.member],
        step_up_proof_id: wrong.proof,
      },
    );
    expect(wrongDenied.status).toBe(403);

    await grantsForm.getByText(/Synthetic Member/).click();
    await grantsForm.getByText("I recognize every named launcher.").click();
    await grantsForm.getByRole("button", { name: "Verify passkey & save sharing" }).click();
    await expect(page.getByRole("status")).toContainText("Sharing updated");
    const memberBack = await apiFetch(
      memberPage,
      "GET",
      `/api/v1/workspaces/${FIX.workspace}/runners/${runnerId.runner_id}/checkouts`,
    );
    expect(memberBack.status).toBe(200);
    await page.screenshot({ path: path.join(W02_EVIDENCE_DIR, "grants.png") });
    await writeW02Report(
      "step-up-trace.md",
      [
        "# Step-up trace (W02 browser E2E)",
        "",
        `- Runner: ${RUNNER_LABEL} (\`${runnerId.runner_id}\`)`,
        `- Sharing change without proof: ${denied.status} (fresh assertion required).`,
        "- Reviewer sees no sharing form and their change is 403.",
        "- Stale-epoch proof after removal: 403 (each change consumes its own assertion).",
        "- Mismatched-action proof (`runner.revoke` for grants): 403.",
        "- Removal then re-add of the member launcher succeeded through the UI with fresh assertions.",
        "- Result: adding/removing a named launcher requires a fresh action-bound passkey assertion.",
        "",
      ].join("\n"),
    );
  } finally {
    await authenticator.cleanup();
    await memberPage.close();
    await restrictedPage.close();
  }
});
