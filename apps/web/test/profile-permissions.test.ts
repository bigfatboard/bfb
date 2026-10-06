// ABOUTME: Checks explicit permission-mode selection and truthful scope copy in owner profile settings.
// ABOUTME: Mounted synthetic requests prove the form defaults to manual and never silently opts into bypass.

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { WorkspaceSettings } from "../src/settings.js";

it("defaults new profiles to manual and sends autonomous mode only after explicit selection", async () => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const posts: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ ok: true });
    }
    return Response.json(
      url.includes("workspace-policy")
        ? { policy: null }
        : url.includes("agent-profiles")
          ? { profiles: [] }
          : { projects: [] },
    );
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(WorkspaceSettings, {
          workspaceId: "synthetic-workspace",
          authorizationEpoch: 1,
          csrfToken: "synthetic-csrf",
          fetchImpl,
          onChanged: () => {},
        }),
      ),
    );
    for (let i = 0; i < 5; i += 1)
      await act(async () => {
        await Promise.resolve();
      });
    const form = container.querySelector<HTMLFormElement>('[data-testid="create-profile-form"]')!;
    const mode = form.querySelector<HTMLSelectElement>('[name="permission_mode"]')!;
    expect(mode.value).toBe("manual");
    expect(mode.getAttribute("aria-describedby")).toBe("profile-permission-help");
    expect(container.querySelector("#profile-permission-help")?.textContent).toMatch(
      /not a workspace sandbox/,
    );
    expect(container.querySelector("#profile-permission-help")?.textContent).toMatch(
      /local OS user/,
    );
    const name = form.querySelector<HTMLInputElement>('[name="name"]')!;
    name.value = "Synthetic Claude Profile";
    form.querySelector<HTMLSelectElement>('[name="provider"]')!.value = "claude";
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(posts[0]).toMatchObject({ permission_mode: "manual", provider: "claude" });
    const autonomousForm = container.querySelector<HTMLFormElement>(
      '[data-testid="create-profile-form"]',
    )!;
    autonomousForm.querySelector<HTMLInputElement>('[name="name"]')!.value =
      "Synthetic Autonomous Profile";
    autonomousForm.querySelector<HTMLSelectElement>('[name="provider"]')!.value = "claude";
    autonomousForm.querySelector<HTMLSelectElement>('[name="permission_mode"]')!.value =
      "autonomous";
    await act(async () => {
      autonomousForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(posts[1]).toMatchObject({
      permission_mode: "autonomous",
      provider: "claude",
      execution_mode: "interactive",
      harness_mode: "standard",
    });
  } finally {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  }
});
