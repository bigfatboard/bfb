// ABOUTME: Renders one immutable artifact preview inside a sandboxed cross-origin frame.
// ABOUTME: Active formats wait for Run preview; bytes are never injected into trusted DOM.

import { useEffect, useMemo, useRef, useState } from "react";

import {
  createArtifactViewer,
  requiresExplicitPreview,
  VIEWER_IFRAME_SANDBOX,
  type ViewerGrant,
  type ViewerPhase,
} from "./viewer-flow.js";

export interface ArtifactViewerProps {
  workspaceId: string;
  versionId: string;
  format: string;
  contentHash?: string;
  csrfToken: string;
  artifactOrigin: string;
  fetchImpl?: typeof fetch;
}

async function requestViewGrant(props: ArtifactViewerProps): Promise<ViewerGrant> {
  const fetchFn = props.fetchImpl ?? fetch;
  const response = await fetchFn(
    `/api/v1/workspaces/${props.workspaceId}/artifacts/${props.versionId}/views`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bfb-csrf": props.csrfToken,
      },
      body: "{}",
    },
  );
  if (!response.ok) {
    throw new Error(`view grant failed with ${response.status}`);
  }
  return (await response.json()) as ViewerGrant;
}

export function ArtifactViewer(props: ArtifactViewerProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  void fetchFn;
  const gated = requiresExplicitPreview(props.format);
  const [armed, setArmed] = useState(!gated);
  const [phase, setPhase] = useState<ViewerPhase>("idle");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ReturnType<typeof createArtifactViewer> | null>(null);

  const host = useMemo(
    () => ({
      requestGrant: () => requestViewGrant(props),
      createFrame: (viewId: string, onLoad: () => void) => {
        const element = document.createElement("iframe");
        element.title = "Artifact preview";
        element.setAttribute("sandbox", VIEWER_IFRAME_SANDBOX);
        element.setAttribute("referrerpolicy", "no-referrer");
        element.src = `${props.artifactOrigin}/view/${viewId}`;
        element.addEventListener("load", onLoad, { once: true });
        containerRef.current?.appendChild(element);
        return {
          postGrant: (
            message: { type: "bfb-view-grant"; secret: string; nonce: string },
            port: unknown,
          ) => {
            element.contentWindow?.postMessage(message, props.artifactOrigin, [port as MessagePort]);
          },
          dispose: () => {
            element.remove();
          },
        };
      },
    }),
    // The grant request intentionally captures the issuing render's props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.workspaceId, props.versionId, props.csrfToken, props.artifactOrigin],
  );

  useEffect(() => {
    const handle = createArtifactViewer(host);
    handleRef.current = handle;
    const unsubscribe = handle.subscribe(setPhase);
    if (armed) {
      void handle.run();
    }
    return () => {
      unsubscribe();
      handle.stop();
      handleRef.current = null;
    };
  }, [host, armed]);

  return (
    <div data-testid="artifact-viewer" data-format={props.format} data-phase={phase}>
      {gated && !armed ? (
        <div>
          <p>This {props.format.toUpperCase()} preview runs only after an explicit action.</p>
          <button data-testid="run-preview" type="button" onClick={() => setArmed(true)}>
            Run preview
          </button>
        </div>
      ) : null}
      {phase === "loading" || (phase === "idle" && armed) ? <p>Loading preview.</p> : null}
      {phase === "failed" ? <p>Preview unavailable. Reload the preview to request a new grant.</p> : null}
      {phase === "stopped" ? <p>Preview stopped.</p> : null}
      <div ref={containerRef} data-testid="artifact-frame-container" />
      {armed && (phase === "ready" || phase === "loading" || phase === "stopped" || phase === "failed") ? (
        <div>
          <button data-testid="viewer-stop" type="button" onClick={() => handleRef.current?.stop()}>
            Stop
          </button>
          <button
            data-testid="viewer-reload"
            type="button"
            onClick={() => void handleRef.current?.reload()}
          >
            Reload
          </button>
        </div>
      ) : null}
    </div>
  );
}
