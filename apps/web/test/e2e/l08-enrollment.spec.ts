// ABOUTME: Verifies the browser's public Mac-pairing form, explicit project grant and passkey approval.
// ABOUTME: Exercises invalid links, reviewer denial, non-UV failure, success and replay-safe reload.

import { expect, test } from "@playwright/test";
import { FIX, canonicalRunnerKey, randomUlid } from "@bfb/domain";
import { signInAs, EVIDENCE_DIR } from "./helpers.js";
import { enrollVirtualPasskey } from "./webauthn-helpers.js";
import path from "node:path";

test("Mac pairing uses a public link, selected projects and a verified passkey", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": "192.0.2.108" });
  await signInAs(page, "owner");
  const authenticator = await enrollVirtualPasskey(page);
  try {
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const exported = await crypto.subtle.exportKey("jwk", key.publicKey);
    const publicKey = await canonicalRunnerKey({
      crv: exported.crv,
      kty: exported.kty,
      x: exported.x,
      y: exported.y,
    });
    const handoff = {
      device_label: "Synthetic Mac Studio",
      public_key: publicKey,
      runner_id: randomUlid(),
      schema_version: 1,
      workspace_id: FIX.workspace,
    };
    const url = "/runner-enroll#" + Buffer.from(JSON.stringify(handoff)).toString("base64url");
    await page.goto(url);
    const submit = page.getByRole("button", { name: "Verify passkey & approve Mac" });
    await expect(submit).toBeDisabled();
    await page.getByLabel("Alpha", { exact: true }).check();
    await page.getByLabel("I recognize this Mac and its key fingerprint.").check();
    await expect(submit).toBeEnabled();
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "l08-pairing-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "l08-pairing-mobile.png"),
      fullPage: true,
    });
    await authenticator.setBadUserVerification(true);
    await submit.click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Mac approved." })).toHaveCount(0);
    await authenticator.setBadUserVerification(false);
    await submit.click();
    await expect(page.getByRole("heading", { name: "Mac approved." })).toBeVisible();
    await expect(
      page.getByText("Approval alone does not mean the Mac is online.", { exact: false }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Mac approved." })).toBeVisible();
    const report = await page.evaluate(async (workspace) => {
      const response = await fetch(`/api/v1/workspaces/${workspace}/runners`);
      return await response.json();
    }, FIX.workspace);
    expect(
      report.runners.find(
        (runner: { runner_id: string }) => runner.runner_id === handoff.runner_id,
      ),
    ).toMatchObject({ granted_project_ids: [FIX.projectA], launcher_human_ids: [FIX.owner] });
    await page.goto("/runner-enroll#invalid");
    await expect(page.getByRole("alert")).toContainText("enrollment link is invalid");
    await expect(submit).toHaveCount(0);
    await signInAs(page, "restricted");
    await page.goto(url);
    await expect(page.getByRole("alert")).toContainText("owner or member role");
    await expect(submit).toHaveCount(0);
  } finally {
    await authenticator.cleanup();
  }
});
