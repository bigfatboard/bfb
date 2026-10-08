// ABOUTME: Proves browser runner approval and sharing require fresh user-verifying passkeys.
// ABOUTME: Real Chromium assertions cover non-UV denial, action binding, replay, removal, and revoke.

import { expect, test, type Page } from "@playwright/test";
import {
  FIX,
  canonicalRunnerKey,
  randomUlid,
  runnerEnrollmentTarget,
  runnerGrantsTarget,
} from "@bfb/domain";

import { signInAs } from "./helpers.js";
import { enrollVirtualPasskey } from "./webauthn-helpers.js";

async function post(page: Page, path: string, body: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const session = await fetch("/auth/session");
      const { csrf_token } = (await session.json()) as { csrf_token: string };
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bfb-csrf": csrf_token },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
}

async function stepUp(page: Page, action: string, target: string) {
  return page.evaluate(
    async ({ action, target, workspace }) => {
      const modulePath = "/src/auth/webauthn.ts";
      const { requestStepUpProof } = await import(modulePath);
      const session = await fetch("/auth/session");
      const { csrf_token } = (await session.json()) as { csrf_token: string };
      try {
        return {
          proof: (await requestStepUpProof(fetch, csrf_token, {
            action,
            targetId: target,
            workspaceId: workspace,
            scopes: [],
            authorizationEpoch: 1,
          })) as string,
        };
      } catch (error) {
        return { failure: error instanceof Error ? error.message : "step-up failed" };
      }
    },
    { action, target, workspace: FIX.workspace },
  );
}

test("runner approval and every sharing change consume their own user-verifying assertion", async ({
  page,
}) => {
  // The suite shares a fixed server clock. Give this security scenario its own
  // synthetic client address so it does not exhaust later tests' auth budget.
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": "192.0.2.66" });
  await signInAs(page, "owner");
  const authenticator = await enrollVirtualPasskey(page);
  try {
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
    const input = {
      runnerId: randomUlid(),
      deviceLabel: "Browser Synthetic Mac",
      publicKey: await canonicalRunnerKey({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
      projectIds: [FIX.projectA],
    };
    const path = `/api/v1/workspaces/${FIX.workspace}/runners`;
    const body = {
      runner_id: input.runnerId,
      device_label: input.deviceLabel,
      public_key: input.publicKey,
      project_ids: input.projectIds,
    };
    expect((await post(page, path, body)).status).toBe(403);
    const target = runnerEnrollmentTarget(input);
    await authenticator.setBadUserVerification(true);
    const nonUV = await stepUp(page, "runner.enroll", target);
    expect(nonUV.proof).toBeUndefined();
    expect(nonUV.failure).toBeTruthy();
    expect((await post(page, path, { ...body, step_up_proof_id: nonUV.proof })).status).toBe(403);
    await authenticator.setBadUserVerification(false);
    const wrong = await stepUp(page, "runner.grants.replace", target);
    expect(wrong.proof, wrong.failure).toBeTruthy();
    expect((await post(page, path, { ...body, step_up_proof_id: wrong.proof })).status).toBe(403);
    const enrollment = await stepUp(page, "runner.enroll", target);
    expect(enrollment.proof, enrollment.failure).toBeTruthy();
    expect((await post(page, path, { ...body, step_up_proof_id: enrollment.proof })).status).toBe(
      201,
    );
    expect((await post(page, path, { ...body, step_up_proof_id: enrollment.proof })).status).toBe(
      403,
    );

    const sharing = {
      runnerId: input.runnerId,
      expectedGrantEpoch: 1,
      projectIds: [FIX.projectA],
      launcherHumanIds: [FIX.owner, FIX.member],
    };
    const sharePath = `${path}/${input.runnerId}/grants`;
    const shareBody = {
      expected_grant_epoch: 1,
      project_ids: sharing.projectIds,
      launcher_human_ids: sharing.launcherHumanIds,
    };
    expect(
      (await post(page, sharePath, { ...shareBody, step_up_proof_id: enrollment.proof })).status,
    ).toBe(403);
    const shareProof = await stepUp(page, "runner.grants.replace", runnerGrantsTarget(sharing));
    expect(shareProof.proof, shareProof.failure).toBeTruthy();
    expect(
      (await post(page, sharePath, { ...shareBody, step_up_proof_id: shareProof.proof })).body,
    ).toMatchObject({
      runner: { grant_epoch: 2, launcher_human_ids: expect.arrayContaining([FIX.member]) },
    });
    const removal = { ...sharing, expectedGrantEpoch: 2, launcherHumanIds: [FIX.owner] };
    const removeBody = {
      ...shareBody,
      expected_grant_epoch: 2,
      launcher_human_ids: removal.launcherHumanIds,
    };
    expect(
      (await post(page, sharePath, { ...removeBody, step_up_proof_id: shareProof.proof })).status,
    ).toBe(403);
    const removeProof = await stepUp(page, "runner.grants.replace", runnerGrantsTarget(removal));
    expect(removeProof.proof, removeProof.failure).toBeTruthy();
    const removed = await post(page, sharePath, {
      ...removeBody,
      step_up_proof_id: removeProof.proof,
    });
    expect(removed.body).toMatchObject({
      signals: [
        expect.objectContaining({
          kind: "runner.channel.close",
          removed_human_id: FIX.member,
          reason: "grants_changed",
        }),
      ],
    });
    const revokeProof = await stepUp(page, "runner.revoke", input.runnerId);
    expect(revokeProof.proof, revokeProof.failure).toBeTruthy();
    const revoked = await post(page, `${path}/${input.runnerId}/revoke`, {
      step_up_proof_id: revokeProof.proof,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({
      signal: { kind: "runner.channel.close", reason: "revoked" },
    });
  } finally {
    await authenticator.cleanup();
  }
});
