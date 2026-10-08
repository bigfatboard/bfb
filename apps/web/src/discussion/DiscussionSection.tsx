// ABOUTME: Task-sheet discussion section listing task discussions around one panel.
// ABOUTME: Creating, closing, or reopening the browser always renders the same committed state.

import { useCallback, useEffect, useState } from "react";

import { createDiscussionClient, type DiscussionListEntry } from "./api.js";
import { DiscussionPanel, type RealtimeTransport } from "./DiscussionPanel.js";
import { DiscussionStart } from "./DiscussionStart.js";

export interface DiscussionSectionProps {
  workspaceId: string;
  taskId: string;
  taskVersion: number;
  projectId: string;
  humanId: string;
  humanDisplayName: string;
  role: "owner" | "member" | "reviewer";
  fetchImpl?: typeof fetch | undefined;
  csrfToken?: string | undefined;
  transport?: RealtimeTransport | undefined;
  nowImpl?: (() => number) | undefined;
}

export function DiscussionSection(props: DiscussionSectionProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const [entries, setEntries] = useState<DiscussionListEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const body = await createDiscussionClient(
        fetchFn,
        props.workspaceId,
        props.csrfToken ?? "",
      ).list(props.taskId);
      setEntries(body.discussions);
      setSelectedId((current) => {
        if (current && body.discussions.some((entry) => entry.id === current)) {
          return current;
        }
        return body.discussions.length > 0
          ? (body.discussions[body.discussions.length - 1]?.id ?? null)
          : null;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Discussions are unavailable.");
    } finally {
      setLoading(false);
    }
  }, [fetchFn, props.csrfToken, props.taskId, props.workspaceId]);

  useEffect(() => {
    setLoading(true);
    setEntries([]);
    setSelectedId(null);
    void load();
  }, [load]);

  return (
    <section aria-labelledby="discussions-heading" data-testid="discussion-section">
      <h3 id="discussions-heading">Discussions</h3>
      <p className="section-help">
        Bounded read-only exchanges between two agents. Recommendations never complete this task.
      </p>
      {loading ? (
        <div className="sheet-loading" role="status">
          Loading committed discussions…
        </div>
      ) : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}{" "}
          <button type="button" className="button-secondary" onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : null}
      {!loading && entries.length === 0 ? (
        <p className="compact-empty" data-testid="discussion-list-empty">
          No discussions yet. Start the first bounded exchange below.
        </p>
      ) : null}
      {entries.length > 1 ? (
        <label className="timeline-run-picker">
          <span>Discussion</span>
          <select
            data-testid="discussion-select"
            value={selectedId ?? ""}
            onChange={(event) => setSelectedId(event.target.value || null)}
          >
            {entries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {`${entry.id.slice(0, 8)}… · ${entry.state}`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {entries.length === 1 && selectedId === null ? (
        <p className="compact-empty">Select a discussion to follow it.</p>
      ) : null}
      {selectedId ? (
        <DiscussionPanel
          key={selectedId}
          workspaceId={props.workspaceId}
          discussionId={selectedId}
          humanId={props.humanId}
          humanDisplayName={props.humanDisplayName}
          role={props.role}
          fetchImpl={props.fetchImpl}
          csrfToken={props.csrfToken}
          transport={props.transport}
          nowImpl={props.nowImpl}
          onChanged={() => void load()}
        />
      ) : null}
      <DiscussionStart
        workspaceId={props.workspaceId}
        taskId={props.taskId}
        taskVersion={props.taskVersion}
        projectId={props.projectId}
        humanId={props.humanId}
        role={props.role}
        fetchImpl={props.fetchImpl}
        csrfToken={props.csrfToken}
        onStarted={(discussionId) => {
          setSelectedId(discussionId);
          void load();
        }}
      />
    </section>
  );
}
