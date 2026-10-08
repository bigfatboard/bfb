// ABOUTME: Proves the compiled artifact viewer against browser-authenticated production Worker paths.
// ABOUTME: Disposable synthetic D1/R2 fixtures cover explicit preview, reload, denial and single consumption.

import { expect, test } from "@playwright/test";
import { bumpMemberEpoch, FIX } from "@bfb/domain";
import {
  startV02RuntimeFixture,
  type V02RuntimeFixture,
} from "../../../../tools/artifact-viewer/runtime-fixture.js";

let fixture: V02RuntimeFixture;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  fixture = await startV02RuntimeFixture(
    Number(process.env.BFB_E2E_PORT ?? "4185") + 20,
    Number(process.env.BFB_V02_ARTIFACT_PORT ?? "4186") + 20,
  );
});
test.afterAll(async () => {
  await fixture?.close();
});

test("compiled active preview requires a click and reload issues a fresh grant", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const before = { ...fixture.counts };
  const loaded = await page.goto(`${fixture.appUrl}/__test/component?format=html`);
  expect(loaded?.status()).toBe(200);
  await page.waitForLoadState("networkidle");
  expect(errors).toEqual([]);
  await expect(page.getByRole("button", { name: "Run preview" })).toBeVisible();
  expect(await page.locator("iframe").count()).toBe(0);
  expect(fixture.counts.grants).toBe(before.grants);
  await page.getByRole("button", { name: "Run preview" }).click();
  const frame = page.frameLocator('iframe[title="Artifact preview"]');
  await expect(frame.getByRole("heading", { name: "Synthetic isolated preview" })).toBeVisible();
  await expect.poll(() => fixture.counts.redemptions).toBe(before.redemptions + 1);
  expect(fixture.counts.artifactCookies).toBe(0);
  const firstUrl = await page.locator("iframe").getAttribute("src");
  expect(await page.locator("iframe").getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  expect(await page.locator("iframe").getAttribute("referrerpolicy")).toBe("no-referrer");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Preview stopped.", { exact: true })).toBeVisible();
  expect(await page.locator("iframe").count()).toBe(0);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(frame.getByRole("heading", { name: "Synthetic isolated preview" })).toBeVisible();
  await expect.poll(() => fixture.counts.grants).toBe(before.grants + 2);
  expect(await page.locator("iframe").getAttribute("src")).not.toBe(firstUrl);
  expect(fixture.counts.artifactCookies).toBe(0);
});

test("compiled passive preview loads real bytes and auth loss preserves a useful failure state", async ({
  page,
  context,
}) => {
  const before = { ...fixture.counts };
  await page.goto(`${fixture.appUrl}/__test/component?format=markdown`);
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Synthetic isolated plan" }),
  ).toBeVisible();
  await expect.poll(() => fixture.counts.grants).toBe(before.grants + 1);
  await context.clearCookies();
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(
    page.getByText("Preview unavailable. Reload the preview to request a new grant.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.locator("iframe").count()).toBe(0);
  expect(fixture.counts.grants).toBe(before.grants + 1);
  expect(fixture.counts.artifactCookies).toBe(0);
});

test("production browser grant routes reject missing CSRF before creating a grant", async ({
  page,
}) => {
  await page.goto(`${fixture.appUrl}/__test/component?format=html`);
  const before = fixture.counts.grants;
  const status = await page.evaluate(async (workspaceId) => {
    const props = (window as unknown as { __v02Props: { versionId: string } }).__v02Props;
    return (
      await fetch(`/api/v1/workspaces/${workspaceId}/artifacts/${props.versionId}/views`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status;
  }, FIX.workspace);
  expect(status).toBe(403);
  expect(fixture.counts.grants).toBe(before);
});

test("real D1 allows one winner among simultaneous same-clock redemptions", async ({
  page,
  request,
}) => {
  await page.goto(`${fixture.appUrl}/__test/component?format=html`);
  const issued = await page.evaluate(async (workspaceId) => {
    const props = (window as unknown as { __v02Props: { versionId: string; csrfToken: string } })
      .__v02Props;
    const response = await fetch(
      `/api/v1/workspaces/${workspaceId}/artifacts/${props.versionId}/views`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-bfb-csrf": props.csrfToken },
        body: "{}",
      },
    );
    if (response.status !== 201) throw new Error("Synthetic grant creation failed.");
    return (await response.json()) as { view_id: string; secret: string; nonce: string };
  }, FIX.workspace);
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      request.post(`${fixture.artUrl}/view/${issued.view_id}/redeem`, {
        form: { view_secret: issued.secret, view_nonce: issued.nonce },
      }),
    ),
  );
  expect(responses.map((response) => response.status()).sort()).toEqual([
    200, 403, 403, 403, 403, 403, 403, 403,
  ]);
  const audits = await fixture.db
    .prepare(
      "SELECT COUNT(*) AS n FROM artifact_audit_outbox WHERE grant_id = ? AND action = 'artifact.view_redeemed'",
    )
    .get(issued.view_id);
  expect(audits).toEqual({ n: 1 });
  const persisted = JSON.stringify(
    await fixture.db.prepare("SELECT * FROM artifact_view_grants WHERE id = ?").get(issued.view_id),
  );
  expect(persisted).not.toContain(issued.secret);
  expect(persisted).not.toContain(issued.nonce);
  expect(await page.content()).not.toContain(issued.secret);
  expect(page.url()).not.toContain(issued.secret);
});

test("revocation fences both queued grants and compiled-viewer reload", async ({
  page,
  request,
}) => {
  await page.goto(`${fixture.appUrl}/__test/component?format=html`);
  const issued = await page.evaluate(async (workspaceId) => {
    const props = (window as unknown as { __v02Props: { versionId: string; csrfToken: string } })
      .__v02Props;
    const response = await fetch(
      `/api/v1/workspaces/${workspaceId}/artifacts/${props.versionId}/views`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-bfb-csrf": props.csrfToken },
        body: "{}",
      },
    );
    if (response.status !== 201) throw new Error("Synthetic grant creation failed.");
    return (await response.json()) as { view_id: string; secret: string; nonce: string };
  }, FIX.workspace);
  await bumpMemberEpoch(fixture.db, FIX.workspace, FIX.owner);
  const before = fixture.counts.redemptions;
  expect(
    (
      await request.post(`${fixture.artUrl}/view/${issued.view_id}/redeem`, {
        form: { view_secret: issued.secret, view_nonce: issued.nonce },
      })
    ).status(),
  ).toBe(403);
  expect(
    await fixture.db
      .prepare("SELECT consumed_at FROM artifact_view_grants WHERE id = ?")
      .get(issued.view_id),
  ).toEqual({ consumed_at: null });
  expect(fixture.counts.redemptions).toBe(before);
  // A new browser grant binds current membership, so revoked authority must
  // remove membership rather than merely rotate its epoch for this half.
  await fixture.db
    .prepare(
      "UPDATE workspace_authorization_epochs SET revoked_at = ? WHERE workspace_id = ? AND human_id = ?",
    )
    .run("2026-09-17T12:00:01.000Z", FIX.workspace, FIX.owner);
  await page.getByRole("button", { name: "Run preview" }).click();
  await expect(
    page.getByText("Preview unavailable. Reload the preview to request a new grant.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.locator("iframe").count()).toBe(0);
});
