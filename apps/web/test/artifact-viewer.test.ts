// ABOUTME: Proves the viewer lifecycle answers one ready signal over one channel port.
// ABOUTME: Fake frames assert origin/source checks, secret wiping, and stop/reload semantics.

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArtifactViewer } from "../src/artifacts/ArtifactViewer.js";
import {
  createArtifactViewer,
  requiresExplicitPreview,
  VIEWER_IFRAME_SANDBOX,
  type ViewerGrant,
  type ViewerHost,
  type ViewerMessage,
  type ViewerPhase,
} from "../src/artifacts/viewer-flow.js";

const ARTIFACT_ORIGIN = "https://artifacts.bfb.example.test";

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
}

function fakeHost(issued: ViewerGrant[] = [grant()]): {
  posted: PostedCall[];
  disposed: string[];
  created: string[];
  sources: Map<string, object>;
  issuedRefs: ViewerGrant[];
  requests: () => number;
  emit: (event: ViewerMessage) => void;
  host: ViewerHost;
} {
  const posted: PostedCall[] = [];
  const disposed: string[] = [];
  const created: string[] = [];
  const issuedRefs: ViewerGrant[] = [];
  const handlers = new Set<(event: ViewerMessage) => void>();
  let requests = 0;
  const sources = new Map<string, object>();
  return {
    posted,
    disposed,
    created,
    sources,
    issuedRefs,
    requests: () => requests,
    emit: (event) => {
      for (const handler of handlers) handler(event);
    },
    host: {
      readyTimeoutMs: 50,
      requestGrant: async () => {
        requests += 1;
        const next = { ...issued[Math.min(requests - 1, issued.length - 1)]! };
        issuedRefs.push(next);
        return next;
      },
      createFrame: (viewId: string) => {
        created.push(viewId);
        const source = {};
        sources.set(viewId, source);
        return {
          source: () => source,
          dispose: () => {
            disposed.push(viewId);
          },
        };
      },
      listenMessages: (handler) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    },
  };
}

function answerReady(
  fake: ReturnType<typeof fakeHost>,
  viewId: string,
  mutate: (event: ViewerMessage) => ViewerMessage = (event) => event,
): void {
  const source = fake.sources.get(viewId);
  expect(source, "frame source").toBeDefined();
  fake.emit(
    mutate({
      origin: ARTIFACT_ORIGIN,
      source,
      data: { type: "bfb-view-ready" },
      ports: [
        {
          postMessage: (message: unknown) => {
            fake.posted.push({ message });
          },
          close: () => {},
        },
      ],
    }),
  );
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

  it("answers the exact ready signal once and wipes the secret", async () => {
    const fake = fakeHost();
    const seen: ViewerPhase[] = [];
    const viewer = createArtifactViewer(fake.host);
    viewer.subscribe((phase) => seen.push(phase));
    const running = viewer.run();
    for (let attempt = 0; attempt < 100 && fake.created.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(viewer.phase()).toBe("loading");
    expect(fake.requests()).toBe(1);
    expect(fake.posted).toEqual([]);
    // Forged ready signals from another frame, without a single port, or
    // with extra fields are ignored. Sender origin is not a signal: sandboxed
    // frames always report the opaque origin.
    for (const forged of [
      { origin: "null", source: {} },
      { origin: "null", source: fake.sources.get("01JBFB0V1EW00000000000000"), ports: [] },
      {
        origin: "null",
        source: fake.sources.get("01JBFB0V1EW00000000000000"),
        data: { type: "bfb-view-ready", extra: true },
      },
    ]) {
      fake.emit({
        origin: forged.origin,
        source: forged.source,
        data: (forged as { data?: unknown }).data ?? { type: "bfb-view-ready" },
        ports: (forged as { ports?: unknown[] }).ports ?? [
          { postMessage: () => {}, close: () => {} },
        ],
      });
      expect(fake.posted).toEqual([]);
    }
    answerReady(fake, "01JBFB0V1EW00000000000000");
    await running;
    expect(viewer.phase()).toBe("ready");
    expect(fake.posted).toEqual([
      { message: { type: "bfb-view-grant", secret: "s".repeat(43), nonce: "0".repeat(32) } },
    ]);
    expect(fake.issuedRefs[0]!.secret).toBe("");
    expect(seen).toEqual(["loading", "ready"]);
    // A second ready signal transfers nothing more.
    answerReady(fake, "01JBFB0V1EW00000000000000");
    expect(fake.posted.length).toBe(1);
  });

  it("stops the frame and ignores late ready signals", async () => {
    const fake = fakeHost();
    const viewer = createArtifactViewer(fake.host);
    const running = viewer.run();
    for (let attempt = 0; attempt < 100 && fake.created.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    viewer.stop();
    expect(viewer.phase()).toBe("stopped");
    expect(fake.disposed).toEqual(["01JBFB0V1EW00000000000000"]);
    await running;
    answerReady(fake, "01JBFB0V1EW00000000000000");
    expect(fake.posted).toEqual([]);
    expect(viewer.phase()).toBe("stopped");
  });

  it("reloads with a fresh grant and fails closed on issuance errors", async () => {
    const fake = fakeHost([grant(), grant("t".repeat(43), "1".repeat(32))]);
    const viewer = createArtifactViewer(fake.host);
    const first = viewer.run();
    for (let attempt = 0; attempt < 100 && fake.created.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    answerReady(fake, "01JBFB0V1EW00000000000000");
    await first;
    expect(fake.requests()).toBe(1);
    expect(fake.posted[0]!.message).toEqual({
      type: "bfb-view-grant",
      secret: "s".repeat(43),
      nonce: "0".repeat(32),
    });
    const reloading = viewer.reload();
    for (let attempt = 0; attempt < 100 && fake.created.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(fake.requests()).toBe(2);
    answerReady(fake, "01JBFB0V1EW00000000000000");
    await reloading;
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
      listenMessages: () => () => {},
    });
    await failing.run();
    expect(failing.phase()).toBe("failed");
  });

  it("fails when the bootstrap never signals ready", async () => {
    const fake = fakeHost();
    const viewer = createArtifactViewer(fake.host);
    await viewer.run();
    expect(viewer.phase()).toBe("failed");
    expect(fake.posted).toEqual([]);
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
