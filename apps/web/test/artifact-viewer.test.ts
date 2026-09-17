// ABOUTME: Proves the viewer lifecycle transfers one grant over one channel and gates previews.
// ABOUTME: Fake frames assert exact postMessage targets, secret wiping, and stop/reload semantics.

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArtifactViewer } from "../src/artifacts/ArtifactViewer.js";
import {
  createArtifactViewer,
  requiresExplicitPreview,
  VIEWER_IFRAME_SANDBOX,
  type ViewerGrant,
  type ViewerPhase,
} from "../src/artifacts/viewer-flow.js";

function grant(secret = "s".repeat(43), nonce = "0".repeat(32)): ViewerGrant {
  return {
    view_id: "01JBFB0V1EW00000000000000",
    version_id: "01JBFB0VERS10N0000000000",
    content_hash: "a".repeat(64),
    format: "html",
    nonce,
    secret,
    expires_at: "2026-09-17T12:05:00.000Z",
  };
}

interface PostedCall {
  message: unknown;
  port: unknown;
}

function fakeHost(issued: ViewerGrant[] = [grant()]) {
  const posted: PostedCall[] = [];
  const disposed: string[] = [];
  const loads: Array<() => void> = [];
  let requests = 0;
  return {
    posted,
    disposed,
    loads,
    requests: () => requests,
    host: {
      requestGrant: async () => {
        requests += 1;
        const next = issued[Math.min(requests - 1, issued.length - 1)]!;
        return { ...next };
      },
      createFrame: (viewId: string, onLoad: () => void) => {
        loads.push(onLoad);
        return {
          postGrant: (message: unknown, port: unknown) => {
            posted.push({ message, port });
          },
          dispose: () => {
            disposed.push(viewId);
          },
        };
      },
    },
  };
}

describe("artifact viewer flow", () => {
  it("gates only active formats behind an explicit preview", () => {
    expect(requiresExplicitPreview("html")).toBe(true);
    expect(requiresExplicitPreview("svg")).toBe(true);
    for (const format of ["markdown", "mermaid", "diff", "png", "jpeg", "json", "log"]) {
      expect(requiresExplicitPreview(format)).toBe(false);
    }
    expect(VIEWER_IFRAME_SANDBOX).toBe("allow-scripts allow-forms");
  });

  it("transfers the grant once on load and wipes the secret", async () => {
    const fake = fakeHost();
    const seen: ViewerPhase[] = [];
    const viewer = createArtifactViewer(fake.host);
    viewer.subscribe((phase) => seen.push(phase));
    await viewer.run();
    expect(viewer.phase()).toBe("loading");
    expect(fake.requests()).toBe(1);
    expect(fake.posted).toEqual([]);
    expect(fake.loads.length).toBe(1);
    fake.loads[0]!();
    expect(fake.posted.length).toBe(1);
    expect(fake.posted[0]!.message).toEqual({
      type: "bfb-view-grant",
      secret: "s".repeat(43),
      nonce: "0".repeat(32),
    });
    expect(viewer.phase()).toBe("ready");
    expect(seen).toEqual(["loading", "ready"]);
  });

  it("stops the frame and ignores late loads", async () => {
    const fake = fakeHost();
    const viewer = createArtifactViewer(fake.host);
    await viewer.run();
    viewer.stop();
    expect(viewer.phase()).toBe("stopped");
    expect(fake.disposed).toEqual(["01JBFB0V1EW00000000000000"]);
    fake.loads[0]!();
    expect(fake.posted).toEqual([]);
    expect(viewer.phase()).toBe("stopped");
  });

  it("reloads with a fresh grant and fails closed on issuance errors", async () => {
    const second = grant("t".repeat(43), "1".repeat(32));
    const fake = fakeHost([grant(), second]);
    const viewer = createArtifactViewer(fake.host);
    await viewer.run();
    fake.loads[0]!();
    await viewer.reload();
    expect(fake.requests()).toBe(2);
    fake.loads[1]!();
    expect(fake.posted.length).toBe(2);
    expect(fake.posted[1]!.message).toEqual({
      type: "bfb-view-grant",
      secret: "t".repeat(43),
      nonce: "1".repeat(32),
    });
    const failing = createArtifactViewer({
      requestGrant: async () => {
        throw new Error("denied");
      },
      createFrame: () => {
        throw new Error("must not create a frame without a grant");
      },
    });
    await failing.run();
    expect(failing.phase()).toBe("failed");
  });
});

describe("artifact viewer component", () => {
  it("gates active formats behind Run preview without an iframe or secret", () => {
    const html = renderToString(
      createElement(ArtifactViewer, {
        workspaceId: "ws",
        versionId: "vv",
        format: "html",
        csrfToken: "csrf",
        artifactOrigin: "https://artifacts.bfb.example.test",
      }),
    );
    expect(html).toContain('data-testid="run-preview"');
    expect(html).toContain("Run preview");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("view_secret");
  });

  it("renders inert formats in a loading state with no secret in markup", () => {
    const html = renderToString(
      createElement(ArtifactViewer, {
        workspaceId: "ws",
        versionId: "vv",
        format: "markdown",
        csrfToken: "csrf",
        artifactOrigin: "https://artifacts.bfb.example.test",
      }),
    );
    expect(html).toContain("Loading preview.");
    expect(html).not.toContain("<iframe");
    expect(html).toContain('data-format="markdown"');
  });
});
