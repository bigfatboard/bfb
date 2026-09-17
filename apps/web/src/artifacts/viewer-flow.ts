// ABOUTME: Drives one artifact preview without ever touching bytes or credentials in DOM.
// ABOUTME: The secret crosses a fresh MessageChannel to the exact iframe, then is wiped.

export interface ViewerGrant {
  view_id: string;
  version_id: string;
  content_hash: string;
  format: string;
  nonce: string;
  secret: string;
  expires_at: string;
}

export type ViewerPhase = "idle" | "loading" | "ready" | "stopped" | "failed";

/** Exact sandbox flags for the redemption iframe; forms exist only for the single redeem POST. */
export const VIEWER_IFRAME_SANDBOX = "allow-scripts allow-forms";

/** Active formats never auto-run; the reviewer presses Run preview first. */
export const EXPLICIT_PREVIEW_FORMATS = ["html", "svg"] as const;

export function requiresExplicitPreview(format: string): boolean {
  return (EXPLICIT_PREVIEW_FORMATS as readonly string[]).includes(format);
}

export interface ViewerFrame {
  postGrant(message: { type: "bfb-view-grant"; secret: string; nonce: string }, port: unknown): void;
  dispose(): void;
}

export interface ViewerHost {
  requestGrant(): Promise<ViewerGrant>;
  createFrame(viewId: string, onLoad: () => void): ViewerFrame;
}

export interface ArtifactViewerHandle {
  phase(): ViewerPhase;
  subscribe(listener: (phase: ViewerPhase) => void): () => void;
  run(): Promise<void>;
  stop(): void;
  reload(): Promise<void>;
}

/**
 * Owns the preview lifecycle: one grant per run, one channel per frame, fresh
 * grant per reload. The secret is transferred once to the exact frame and
 * then wiped from memory; it never enters a URL, attribute, or DOM node.
 */
export function createArtifactViewer(host: ViewerHost): ArtifactViewerHandle {
  let phase: ViewerPhase = "idle";
  let frame: ViewerFrame | null = null;
  let runSequence = 0;
  const listeners = new Set<(next: ViewerPhase) => void>();

  function setPhase(next: ViewerPhase): void {
    phase = next;
    for (const listener of [...listeners]) listener(next);
  }

  function disposeFrame(): void {
    const current = frame;
    frame = null;
    try {
      current?.dispose();
    } catch {
      // Disposal must not break the stop/reload lifecycle.
    }
  }

  async function run(): Promise<void> {
    const sequence = runSequence + 1;
    runSequence = sequence;
    disposeFrame();
    setPhase("loading");
    let issued: ViewerGrant;
    try {
      issued = await host.requestGrant();
    } catch {
      if (sequence === runSequence) setPhase("failed");
      return;
    }
    if (sequence !== runSequence) return;
    const channel = new MessageChannel();
    const secret = issued.secret;
    const nonce = issued.nonce;
    issued.secret = "";
    frame = host.createFrame(issued.view_id, () => {
      if (sequence !== runSequence) return;
      try {
        frame?.postGrant({ type: "bfb-view-grant", secret, nonce }, channel.port1);
      } finally {
        try {
          channel.port1.close();
        } catch {
          // Ports are single-use; a close failure changes nothing.
        }
        try {
          channel.port2.close();
        } catch {
          // Ports are single-use; a close failure changes nothing.
        }
      }
      setPhase("ready");
    });
  }

  function stop(): void {
    runSequence += 1;
    disposeFrame();
    setPhase("stopped");
  }

  async function reload(): Promise<void> {
    await run();
  }

  return {
    phase: () => phase,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    run,
    stop,
    reload,
  };
}
