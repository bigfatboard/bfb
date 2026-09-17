// ABOUTME: Drives one artifact preview without ever touching bytes or credentials in DOM.
// ABOUTME: The secret answers the bootstrap's own channel port, then is wiped from memory.

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

/** How long one run waits for the bootstrap's ready signal before failing. */
export const VIEWER_READY_TIMEOUT_MS = 20000;

export function requiresExplicitPreview(format: string): boolean {
  return (EXPLICIT_PREVIEW_FORMATS as readonly string[]).includes(format);
}

export interface ViewerPort {
  postMessage(message: unknown): void;
  close(): void;
}

export interface ViewerFrame {
  /** The exact frame window; the ready signal is accepted only from this source. */
  source(): unknown;
  dispose(): void;
}

export interface ViewerMessage {
  origin: string;
  source: unknown;
  data: unknown;
  ports: unknown[];
}

export interface ViewerHost {
  readyTimeoutMs?: number;
  requestGrant(): Promise<ViewerGrant>;
  createFrame(viewId: string): ViewerFrame;
  listenMessages(handler: (event: ViewerMessage) => void): () => void;
}

export interface ArtifactViewerHandle {
  phase(): ViewerPhase;
  subscribe(listener: (phase: ViewerPhase) => void): () => void;
  run(): Promise<void>;
  stop(): void;
  reload(): Promise<void>;
}

function isGrantMessage(data: unknown): data is { type: "bfb-view-ready" } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  return keys.length === 1 && (data as { type?: unknown }).type === "bfb-view-ready";
}

function isPort(value: unknown): value is ViewerPort {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ViewerPort).postMessage === "function" &&
    typeof (value as ViewerPort).close === "function"
  );
}

/**
 * Owns the preview lifecycle: one grant per run, one bootstrap-offered channel
 * per frame, fresh grant per reload. The viewer answers the ready signal only
 * when it arrives from the exact frame object with a strict shape and a
 * single transferred port, then stops listening; the secret crosses that port
 * once and is wiped from memory. It never enters a URL, attribute, or DOM
 * node. The sender origin is intentionally not checked: a sandboxed frame
 * without `allow-same-origin` always reports the opaque origin `null`, so an
 * origin check could neither pass nor add signal. The binding is the exact
 * frame source plus one-shot listening — no attacker script runs in the
 * frame before redemption — plus the server-verified secret and nonce.
 */
export function createArtifactViewer(host: ViewerHost): ArtifactViewerHandle {
  let phase: ViewerPhase = "idle";
  let frame: ViewerFrame | null = null;
  let unlisten: (() => void) | null = null;
  let runSequence = 0;
  const listeners = new Set<(next: ViewerPhase) => void>();

  function setPhase(next: ViewerPhase): void {
    phase = next;
    for (const listener of listeners) listener(next);
  }

  function dropListener(): void {
    const currentUnlisten = unlisten;
    unlisten = null;
    try {
      currentUnlisten?.();
    } catch {
      // Listener removal must not break the stop/reload lifecycle.
    }
  }

  function cleanup(): void {
    const currentFrame = frame;
    frame = null;
    dropListener();
    try {
      currentFrame?.dispose();
    } catch {
      // Disposal must not break the stop/reload lifecycle.
    }
  }

  function awaitReady(sequence: number, current: ViewerFrame): Promise<ViewerPort> {
    return new Promise<ViewerPort>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("viewer ready signal timed out"));
      }, host.readyTimeoutMs ?? VIEWER_READY_TIMEOUT_MS);
      if (typeof (timeout as unknown as { unref?: () => void }).unref === "function") {
        (timeout as unknown as { unref: () => void }).unref();
      }
      unlisten = host.listenMessages((event) => {
        if (sequence !== runSequence) return;
        if (event.source !== current.source()) return;
        if (!isGrantMessage(event.data)) return;
        if (!Array.isArray(event.ports) || event.ports.length !== 1) return;
        const [port] = event.ports;
        if (!isPort(port)) return;
        clearTimeout(timeout);
        resolve(port);
      });
    });
  }

  async function run(): Promise<void> {
    const sequence = runSequence + 1;
    runSequence = sequence;
    cleanup();
    setPhase("loading");
    let issued: ViewerGrant;
    try {
      issued = await host.requestGrant();
    } catch {
      if (sequence === runSequence) setPhase("failed");
      return;
    }
    if (sequence !== runSequence) return;
    const current = host.createFrame(issued.view_id);
    frame = current;
    const secret = issued.secret;
    const nonce = issued.nonce;
    issued.secret = "";
    let port: ViewerPort;
    try {
      port = await awaitReady(sequence, current);
    } catch {
      if (sequence === runSequence) {
        cleanup();
        setPhase("failed");
      }
      return;
    }
    if (sequence !== runSequence || frame !== current) {
      try {
        port.close();
      } catch {
        // Ports are single-use; a close failure changes nothing.
      }
      return;
    }
    try {
      port.postMessage({ type: "bfb-view-grant", secret, nonce });
    } finally {
      // One-shot listening: after the single transfer, later ready signals —
      // including any from hostile content that navigates the frame after
      // redemption — are ignored, so the secret cannot cross a second port.
      dropListener();
      try {
        port.close();
      } catch {
        // Ports are single-use; a close failure changes nothing.
      }
    }
    if (sequence === runSequence) setPhase("ready");
  }

  function stop(): void {
    runSequence += 1;
    cleanup();
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
