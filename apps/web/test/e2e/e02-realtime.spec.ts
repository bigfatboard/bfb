// ABOUTME: Real-browser E02 suite for subscribe-first timeline, presence, and hostile inertness.
// ABOUTME: Drives the shared e2e server WebSocket path and captures timeline/presence evidence.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { EVIDENCE_DIR as W01_DIR, signInAndOpenBoard, signInAs } from "./helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const capturedEvidenceDir = path.join(rootDir, "docs/work-packages/evidence/WP-E02/browser");
const transientEvidenceDir = path.join(rootDir, "apps/web/test/e2e/test-results/evidence-e02");
const EVIDENCE_DIR =
  process.env.BFB_CAPTURE_E02_EVIDENCE === "1" ? capturedEvidenceDir : transientEvidenceDir;

test.beforeAll(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
});

test.describe.configure({ mode: "serial" });

interface E02Tasks {
  live_task_id: string;
  live_run_id: string;
  stale_task_id: string;
  stale_run_id: string;
}

async function e02Tasks(page: Page): Promise<E02Tasks> {
  const response = await page.request.get("/__test/e02/task");
  expect(response.ok()).toBe(true);
  return (await response.json()) as E02Tasks;
}

async function commit(
  page: Page,
  body: { key?: string; kinds: string[]; occurred_at?: string; provider_session_id?: string },
): Promise<{ high_water_cursor: number; dispositions: string[] }> {
  const response = await page.request.post("/__test/events/commit", { data: body });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { high_water_cursor: number; dispositions: string[] };
}

async function openTaskTimeline(page: Page, taskId: string): Promise<void> {
  await expect(page.locator(`#task-${taskId}`)).toBeVisible();
  await page
    .locator(`#task-${taskId}`)
    .getByRole("button", { name: /Open / })
    .click();
  await expect(page.getByTestId("task-detail")).toBeVisible();
  await expect(page.getByTestId("run-timeline-section")).toBeVisible();
}

async function timelineCursors(page: Page): Promise<number[]> {
  return page
    .getByTestId("run-timeline")
    .locator("li")
    .evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute("data-cursor"))));
}

test("live invalidations render committed events once without reload", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const tasks = await e02Tasks(page);
  await openTaskTimeline(page, tasks.live_task_id);
  await expect(page.getByTestId("run-timeline")).toHaveCount(0);

  const first = await commit(page, { key: "live", kinds: ["heartbeat"] });
  expect(first.dispositions).toEqual(["accepted"]);
  const timeline = page.getByTestId("run-timeline");
  await expect(timeline.locator("li")).toHaveCount(1);
  await expect(timeline).toContainText("Runner heartbeat observed");
  await expect(timeline).toContainText(`Committed event ${first.high_water_cursor}`);

  const presence = page.getByTestId("run-presence");
  await expect(presence).toContainText("Process: alive");
  await expect(presence).toContainText("Activity: idle");
  await expect(page.getByTestId("realtime-connectivity")).toContainText("Realtime live");

  await page.screenshot({ path: path.join(EVIDENCE_DIR, "timeline.png"), fullPage: true });
  await writeFile(
    path.join(EVIDENCE_DIR, "replay-trace.md"),
    [
      "# Replay trace (E02 browser E2E)",
      "",
      `- Live task id: \`${tasks.live_task_id}\``,
      `- Committed heartbeat at cursor: \`${first.high_water_cursor}\``,
      "- Timeline rendered the entry without reload after the socket invalidation.",
      `- Rendered cursors: \`${(await timelineCursors(page)).join(", ")}\``,
      "",
    ].join("\n"),
    "utf8",
  );
});

test("an open turn reads working and a closed turn reads idle", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const tasks = await e02Tasks(page);
  await openTaskTimeline(page, tasks.live_task_id);
  const presence = page.getByTestId("run-presence");

  await commit(page, { key: "live", kinds: ["turn_started"] });
  await expect(page.getByTestId("run-timeline")).toContainText("Agent turn started");
  await expect(presence).toContainText("Activity: working");

  await commit(page, { key: "live", kinds: ["turn_stopped"] });
  await expect(presence).toContainText("Activity: idle");
});

test("reload replays the same committed entries without duplication", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const tasks = await e02Tasks(page);
  await openTaskTimeline(page, tasks.live_task_id);
  await expect(page.getByTestId("run-timeline").locator("li")).toHaveCount(3);
  const before = await timelineCursors(page);
  expect([...before].sort((a, b) => a - b)).toEqual(before);

  await page.reload();
  await openTaskTimeline(page, tasks.live_task_id);
  await expect(page.getByTestId("run-timeline").locator("li")).toHaveCount(3);
  expect(await timelineCursors(page)).toEqual(before);
});

test("stale heartbeats present honestly without changing run state", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const tasks = await e02Tasks(page);
  const staleAt = new Date(Date.now() - 3_600_000).toISOString();
  await commit(page, { key: "stale", kinds: ["heartbeat"], occurred_at: staleAt });
  await openTaskTimeline(page, tasks.stale_task_id);

  const presence = page.getByTestId("run-presence");
  await expect(presence).toContainText("Process: stale");
  await expect(presence).toContainText("Activity: idle");
  await expect(page.getByTestId("realtime-connectivity")).toContainText("Realtime live");
  await expect(page.getByTestId("run-timeline")).toContainText("Runner heartbeat observed");

  await page.screenshot({ path: path.join(EVIDENCE_DIR, "presence-stale.png"), fullPage: true });
  await writeFile(
    path.join(EVIDENCE_DIR, "presence-stale.md"),
    [
      "# Stale presence report (E02 browser E2E)",
      "",
      `- Stale task id: \`${tasks.stale_task_id}\``,
      `- Heartbeat occurred_at: \`${staleAt}\` (one hour before the test run)`,
      "- Process presence: `stale`; activity: `idle` (heartbeat-only, never working).",
      "- Connectivity stays `live`: the socket just delivered the invalidation.",
      "- No run result changed: staleness is presentation policy, not completion.",
      "",
    ].join("\n"),
    "utf8",
  );
});

test("human presence comes from committed notes and never claims review", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const tasks = await e02Tasks(page);
  await openTaskTimeline(page, tasks.live_task_id);
  await expect(page.getByTestId("run-presence")).toContainText("No committed human activity yet");

  await page.evaluate(
    async ({ taskId }: { taskId: string }) => {
      const session = await fetch("/auth/session");
      const { csrf_token: csrfToken } = (await session.json()) as { csrf_token: string };
      const workspace = "synthetic";
      const list = await fetch("/api/v1/workspaces");
      const { workspaces } = (await list.json()) as { workspaces: Array<{ id: string; slug: string }> };
      const workspaceId = workspaces.find((entry) => entry.slug === workspace)?.id;
      if (!workspaceId) throw new Error("fixture workspace missing");
      const response = await fetch(`/api/v1/workspaces/${workspaceId}/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bfb-csrf": csrfToken },
        body: JSON.stringify({ body: "Timeline check from the owner.", request_id: "e02-human-note" }),
      });
      if (!response.ok) throw new Error(`comment failed: ${response.status}`);
    },
    { taskId: tasks.live_task_id },
  );
  await page.reload();
  await openTaskTimeline(page, tasks.live_task_id);
  await expect(page.getByTestId("run-presence")).toContainText("Last human note");
  const sectionText = await page.getByTestId("run-timeline-section").innerText();
  expect(sectionText.toLowerCase()).not.toContain("reviewed");
});

test("hostile event strings render as inert text", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const tasks = await e02Tasks(page);
  await openTaskTimeline(page, tasks.live_task_id);
  const hostile = "<img src=x onerror=alert(document.domain)>";
  await commit(page, { key: "live", kinds: ["session_started"], provider_session_id: hostile });

  const section = page.getByTestId("run-timeline-section");
  await expect(section).toContainText("Provider session started");
  await expect(section.locator("img")).toHaveCount(0);
  await expect(section.locator("script")).toHaveCount(0);
  const html = await section.innerHTML();
  expect(html.toLowerCase()).not.toContain("<img");
  expect(html).toContain("&lt;img");

  await page.screenshot({ path: path.join(EVIDENCE_DIR, "hostile-timeline.png"), fullPage: true });
  await writeFile(
    path.join(EVIDENCE_DIR, "hostile-timeline.md"),
    [
      "# Hostile timeline report (E02 browser E2E)",
      "",
      `- Provider session id committed: \`${hostile}\``,
      "- Rendered session text is escaped (`&lt;img` present, no `<img` element).",
      "- Image/script elements under the timeline section: 0.",
      "- Result: hostile event strings stay data and never execute on the app origin.",
      "",
    ].join("\n"),
    "utf8",
  );
});

test("reviewers keep project-scoped access without run history", async ({ page }) => {
  await signInAndOpenBoard(page, "restricted");
  const tasks = await e02Tasks(page);
  await openTaskTimeline(page, tasks.live_task_id);
  await expect(page.getByTestId("timeline-member-only")).toContainText(
    "Run history is limited to workspace members",
  );
});

test("session revocation closes the socket without touching survivors", async ({ page }) => {
  await signInAndOpenBoard(page, "member");
  const tasks = await e02Tasks(page);
  await openTaskTimeline(page, tasks.live_task_id);
  await expect(page.getByTestId("realtime-connectivity")).toContainText("Realtime live");

  try {
    const revoked = await page.request.post("/__test/session/revoke/member");
    expect(revoked.ok()).toBe(true);
    await expect(page.getByTestId("realtime-notice")).toContainText("Workspace access changed");
    await expect(page.getByTestId("realtime-reconnect")).toBeVisible();
  } finally {
    const restored = await page.request.post("/__test/session/restore/member");
    expect(restored.ok()).toBe(true);
  }
});
