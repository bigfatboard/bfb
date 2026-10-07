// ABOUTME: Proves immutable review using compiled React and real authenticated Worker/D1/R2 paths.
// ABOUTME: Synthetic task/run records exercise loaded previews, history, timers, denial and redaction.

import { expect, test } from "@playwright/test";
import { FIX, listArtifactAuditCandidates } from "@bfb/domain";
import { v02ProbeScript } from "../../../../tools/artifact-viewer/e2e-fixture.js";
import {
  startV02RuntimeFixture,
  type V02RuntimeFixture,
} from "../../../../tools/artifact-viewer/runtime-fixture.js";

let fixture: V02RuntimeFixture;
let taskId: string;
let runId: string;
let version: { id: string; artifactId: string; hash: string };
const NOTE = "</script><script>alert(document.cookie)</script><img src=x onerror=alert(1)>";
const BASE = `/api/v1/workspaces/${FIX.workspace}`;
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fixture = await startV02RuntimeFixture(4225, 4226, { reviewEnabled: true });
  const created = await fixture.browser(`${BASE}/tasks`, {
    project_id: FIX.projectA,
    title: "Synthetic connected review task",
    priority: "P1",
    request_id: "v03-runtime-task-create",
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const task = (await created.json()) as { ok: boolean; result: { id: string } };
  expect(task.ok).toBe(true);
  taskId = task.result.id;
  const started = await fixture.browser(`${BASE}/tasks/${taskId}/runs`, {
    expected_task_version: 1,
    agent_profile_id: FIX.profileCodex,
    workspace_policy_version: 1,
    project_policy_version: 1,
    repository_config_version: 1,
    agent_profile_version: 1,
    request_id: "v03-runtime-run-create",
  });
  expect(started.status, await started.clone().text()).toBe(200);
  const run = (await started.json()) as { ok: boolean; result: { run: { id: string } } };
  expect(run.ok).toBe(true);
  runId = run.result.run.id;
  // Creating a canonical run record starts no provider or local process.
  version = await fixture.publish(
    "html",
    `<!doctype html><html><body><h1>Synthetic connected review</h1><script>${v02ProbeScript(fixture.appUrl)}</script></body></html>`,
    { runId },
  );
});

test.afterAll(async () => {
  await fixture?.close();
});

function surface() {
  return `${fixture.appUrl}/__test/component?panel=review&task_id=${taskId}`;
}

async function readState() {
  return {
    task: await fixture.db
      .prepare("SELECT state, resource_version FROM tasks WHERE id = ?")
      .get(taskId),
    run: await fixture.db
      .prepare("SELECT result_state, resource_version FROM runs WHERE id = ?")
      .get(runId),
    launches: await fixture.db.prepare("SELECT COUNT(*) AS n FROM launch_commands").get(),
    results: await fixture.db.prepare("SELECT COUNT(*) AS n FROM result_submissions").get(),
  };
}

test("loaded hostile preview stays isolated while exact review and explicit timers persist", async ({
  page,
}, testInfo) => {
  const before = await readState();
  await page.goto(surface());
  await expect(page.getByTestId("review-unapproved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run preview" })).toBeVisible();
  expect(await page.locator("iframe").count()).toBe(0);
  await page.getByRole("button", { name: "Run preview" }).click();
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Synthetic connected review" }),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts allow-forms");
  await expect(page.locator("iframe")).toHaveAttribute("referrerpolicy", "no-referrer");
  await page.getByTestId("review-timer-start").click();
  await expect(page.getByTestId("review-timer-stop")).toBeVisible();
  await page.getByTestId("review-timer-stop").click();
  await expect(page.getByTestId("review-timer-start")).toBeVisible();
  await page.getByTestId("review-note").fill(NOTE);
  await page.getByTestId("review-approve").click();
  await expect(page.getByTestId("review-approved")).toBeVisible();
  await expect(page.getByTestId("review-comment")).toHaveText(NOTE);
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const action of ["review-approve", "review-request-changes", "review-comment-submit"]) {
      const bounds = await page.getByTestId(action).boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
  }
  expect(await page.locator("[onerror]").count()).toBe(0);
  const stored = await fixture.db
    .prepare("SELECT version_id, content_hash, comment FROM artifact_reviews WHERE artifact_id = ?")
    .get(version.artifactId);
  expect(stored).toEqual({ version_id: version.id, content_hash: version.hash, comment: NOTE });
  expect(await readState()).toEqual(before);
  expect(
    await fixture.db
      .prepare(
        "SELECT COUNT(*) AS n FROM review_timer_observations AS o JOIN review_timers AS t ON t.workspace_id = o.workspace_id AND t.id = o.timer_id WHERE t.task_id = ?",
      )
      .get(taskId),
  ).toEqual({ n: 2 });
  expect(
    await fixture.db.prepare("SELECT COUNT(*) AS n FROM browser_activity_observations").get(),
  ).toEqual({ n: 0 });
  for (const table of [
    "semantic_events",
    "audit_events",
    "outbox_records",
    "artifact_audit_outbox",
  ]) {
    expect(
      JSON.stringify(await fixture.db.prepare(`SELECT payload_json FROM ${table}`).all()),
    ).not.toContain(NOTE);
  }
  await page.reload();
  await expect(page.getByTestId("review-approved")).toBeVisible();
  await expect(page.getByTestId("review-comment")).toHaveText(NOTE);
  expect(fixture.counts.artifactCookies).toBe(0);
  expect(fixture.counts.appHits).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("connected-review.png"), fullPage: true });
});

test("real publication creates a version conflict then reload exposes unapproved exact new bytes", async ({
  page,
}) => {
  await page.goto(surface());
  await expect(page.getByTestId("review-approved")).toBeVisible();
  const old = version;
  version = await fixture.publish(
    "html",
    "<!doctype html><html><body><h1>Synthetic newer review</h1></body></html>",
    { runId, artifactId: old.artifactId },
  );
  await page.getByTestId("review-approve").click();
  await expect(page.getByTestId("review-error")).toContainText("This version changed.");
  await page.getByTestId("review-reload").click();
  await expect(page.getByTestId("review-unapproved")).toBeVisible();
  await expect(page.getByTestId("review-record")).toContainText("historical");
  await page.getByRole("button", { name: "Run preview" }).click();
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Synthetic newer review" }),
  ).toBeVisible();
  await page.getByTestId("review-approve").click();
  await expect(page.getByTestId("review-approved")).toBeVisible();
  expect(
    await fixture.db
      .prepare("SELECT COUNT(*) AS n FROM artifact_reviews WHERE artifact_id = ?")
      .get(version.artifactId),
  ).toEqual({ n: 2 });
});

test("notes are required for changes and authentication loss cannot commit a review", async ({
  page,
  context,
}) => {
  await page.goto(surface());
  await expect(page.getByTestId("review-approved")).toBeVisible();
  const before = await fixture.db.prepare("SELECT COUNT(*) AS n FROM artifact_reviews").get();
  await page.getByTestId("review-request-changes").click();
  await expect(page.getByTestId("review-error")).toContainText("A note is required");
  expect(await fixture.db.prepare("SELECT COUNT(*) AS n FROM artifact_reviews").get()).toEqual(
    before,
  );
  await page.getByTestId("review-note").fill("Synthetic changes requested");
  await page.getByTestId("review-request-changes").click();
  await expect(page.getByTestId("review-changes-note")).toBeVisible();
  const authenticatedCookies = await context.cookies();
  await context.clearCookies();
  await page.getByTestId("review-note").fill("Synthetic unsent draft");
  const afterChanges = await fixture.db.prepare("SELECT COUNT(*) AS n FROM artifact_reviews").get();
  const deniedReview = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `${BASE}/artifacts/${version.artifactId}/reviews`,
  );
  await page.getByTestId("review-comment-submit").click();
  expect((await deniedReview).status()).toBe(401);
  await expect(page.getByTestId("review-error")).toContainText("Artifact details unavailable.");
  await expect(page.getByTestId("review-error")).toContainText("unauthenticated");
  for (const id of [
    "review-provenance",
    "review-record",
    "review-artifact-select",
    "artifact-viewer",
    "review-decide-form",
    "review-note",
  ])
    await expect(page.getByTestId(id)).toHaveCount(0);
  expect(await fixture.db.prepare("SELECT COUNT(*) AS n FROM artifact_reviews").get()).toEqual(
    afterChanges,
  );
  await context.addCookies(authenticatedCookies);
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await retry.focus();
  await expect(retry).toBeFocused();
  await retry.press("Enter");
  await expect(page.getByTestId("review-changes-note")).toBeVisible();
  await expect(page.getByTestId("review-note")).toHaveValue("Synthetic unsent draft");
  expect(await fixture.db.prepare("SELECT COUNT(*) AS n FROM artifact_reviews").get()).toEqual(
    afterChanges,
  );
});

test("actual review audit sources dispatch exactly once without private notes", async () => {
  const sources = (await fixture.db
    .prepare(
      "SELECT id, version_id FROM artifact_audit_outbox WHERE action = 'artifact.review_recorded'",
    )
    .all()) as Array<{ id: string; version_id: string }>;
  expect(sources.length).toBe(3);
  const candidates = await listArtifactAuditCandidates(fixture.db);
  const source = sources[0]!;
  expect(candidates.some((row) => row.id === source.id)).toBe(true);
  const responses = await Promise.all([
    fixture.dispatchAudit(source.id),
    fixture.dispatchAudit(source.id),
  ]);
  const outcomes = await Promise.all(
    responses.map(async (response) => {
      expect(response.status).toBe(200);
      return (await response.json()) as { ok: boolean; replayed: boolean };
    }),
  );
  expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  expect(outcomes.filter((outcome) => outcome.replayed).length).toBe(1);
  for (const [table, idField] of [
    ["semantic_events", "event_id"],
    ["audit_events", "audit_id"],
  ]) {
    const rows = (await fixture.db
      .prepare(`SELECT payload_json FROM ${table} WHERE ${idField} = ?`)
      .all(source.id)) as Array<{ payload_json: string }>;
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      source_action: "artifact.review_recorded",
      version_id: source.version_id,
    });
    expect(rows[0]!.payload_json).not.toContain(NOTE);
  }
});

test("project revocation withholds browser cached replies, conflicts and private reads", async ({
  page,
}) => {
  const input = {
    version_id: version.id,
    expected_content_hash: version.hash,
    expected_latest_version_id: version.id,
    decision: "comment",
    comment: "Synthetic cached private response",
    request_id: "v03-runtime-current-authority-proof",
  };
  const path = `${BASE}/artifacts/${version.artifactId}/reviews`;
  const accepted = await fixture.browser(path, input);
  expect(accepted.status).toBe(201);
  await accepted.json();
  await fixture.db
    .prepare(
      "DELETE FROM project_access WHERE workspace_id = ? AND project_id = ? AND human_id = ?",
    )
    .run(FIX.workspace, FIX.projectA, FIX.owner);
  const retainedReviews = await fixture.db
    .prepare("SELECT * FROM artifact_reviews ORDER BY rowid")
    .all();
  const retainedWork = await readState();
  for (const body of [input, { ...input, comment: "Changed private input" }]) {
    const denied = await fixture.browser(path, body);
    expect(denied.status).toBe(404);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(await denied.text()).not.toContain(input.comment);
  }
  expect(await fixture.db.prepare("SELECT * FROM artifact_reviews ORDER BY rowid").all()).toEqual(
    retainedReviews,
  );
  expect(await readState()).toEqual(retainedWork);
  await page.goto(surface());
  const read = await page.evaluate(async (path) => {
    const response = await fetch(path);
    return { status: response.status, body: await response.text() };
  }, path);
  expect(read.status).toBe(404);
  expect(read.body).not.toContain(input.comment);
  await expect(page.getByTestId("review-error")).toBeVisible();
  expect(await page.locator("iframe").count()).toBe(0);
});
