// ABOUTME: Presents the unavailable run timeline inside the task's Activity disclosure.
// ABOUTME: Held event history and live presence never trigger network effects or imply empty work.

import type { RealtimeTransport } from "./useRealtime.js";

export interface RunTimelineProps {
  workspaceId: string;
  taskId: string;
  fetchImpl?: typeof fetch | undefined;
  transport?: RealtimeTransport | undefined;
  nowImpl?: (() => number) | undefined;
}

export function RunTimeline(_props: RunTimelineProps) {
  return (
    <section className="run-timeline" aria-label="Run timeline" data-testid="run-timeline-section">
      <p className="section-label">RUN TIMELINE</p>
      <p className="section-help" role="status" data-testid="timeline-unavailable">
        Run timeline and live presence are unavailable.
      </p>
    </section>
  );
}
