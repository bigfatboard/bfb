// ABOUTME: Exercises mounted first-run routing and real passkey creation with isolated browser fixtures.
// ABOUTME: Keeps synthetic bootstrap responses distinct from production OAuth and owner authority.

import { expect, test } from "@playwright/test";

const flow = "01K00000000000000000000009";

test("signed-in first-run routing retains opaque flow IDs and sends a one-time code only in the body", async ({
  page,
}) => {
  // These intercepted responses exercise UI transitions, not production bootstrap authority.
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        human: { id: flow, email: "operator@synthetic.test", display_name: "Operator" },
        csrf_token: "synthetic-csrf",
      },
    }),
  );
  await page.route("**/api/v1/workspaces", (route) => route.fulfill({ json: { workspaces: [] } }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Set up first workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Set up first workspace" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("button", { name: "Verify with GitHub" })).toBeVisible();

  let body: Record<string, unknown> | undefined;
  await page.route("**/api/v1/workspace-access/bootstrap/complete", async (route) => {
    expect(route.request().headers()["x-bfb-csrf"]).toBe("synthetic-csrf");
    body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { workspaceId: flow, slug: "pilot", role: "owner" } });
  });
  await page.route("**/auth/passkeys", (route) => route.fulfill({ json: { passkeys: [] } }));
  await page.goto(`/onboarding?workspace_bootstrap=${flow}`);
  await expect(page.getByLabel("Setup code")).toBeFocused();
  await page.getByLabel("Workspace address").fill("pilot");
  await page.getByLabel("Setup code").fill("synthetic-private-operator-code");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/security\?workspace=pilot$/);
  expect(body).toEqual({
    flow_id: flow,
    bootstrap_secret: "synthetic-private-operator-code",
    slug: "pilot",
  });
  expect(page.url()).not.toContain("operator-code");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Secure your account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Verify with GitHub" })).toBeVisible();
});

test("mounted security flow creates a virtual passkey through the actual options and verification routes", async ({
  page,
}) => {
  await page.goto("/__test/session/owner");
  await expect(page.getByTestId("current-human")).toBeVisible();
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  const authenticator = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  try {
    const fixture = await page.evaluate(async () => {
      const response = await fetch("/__test/passkey-flow", { method: "POST" });
      if (!response.ok) throw new Error("Synthetic fresh reauthentication fixture failed.");
      return (await response.json()) as { flow_id: string };
    });
    await page.goto(`/settings/security?passkey_enrollment=${fixture.flow_id}`);
    await page.getByLabel("Passkey name").fill("Pilot browser fixture");
    await page.getByRole("button", { name: "Create passkey", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Passkey registered");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Registered passkeys" })).toBeVisible();
    await expect(page.getByText("Pilot browser fixture", { exact: true })).toBeVisible();
  } finally {
    await client.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: authenticator.authenticatorId,
    });
  }
});
