// ABOUTME: Renders the W01 attention deck and horizontally scrolling project lanes.
// ABOUTME: Project, priority, state, and ownership remain separate visual and semantic channels.

import type { AttentionDeckItem, ProjectLane } from "@bfb/domain";

export interface AgentProfileSummary {
  id: string;
  name: string;
  provider: string;
}

export interface WorkBoardProps {
  humanDisplayName: string;
  lanes: ProjectLane[];
  needsNow: AttentionDeckItem[];
  agentWorkAvailable: boolean;
  agentProfiles: readonly AgentProfileSummary[];
  selectedTaskId?: string | null;
  canManageTasks: boolean;
  onSelectTask?: (taskId: string) => void;
  onPassToAgent?: (taskId: string, profileId: string) => void;
}

const PRIORITY_LABELS: Record<string, string> = {
  P0: "P0 BLOCKING",
  P1: "P1 HIGH",
  P2: "P2 NORMAL",
  P3: "P3 LOW",
};

function profileName(profiles: readonly AgentProfileSummary[], id: string): string {
  return profiles.find((profile) => profile.id === id)?.name ?? "configured agent";
}

function laneTaskCount(count: number): string {
  return `${count} ${count === 1 ? "task" : "tasks"}`;
}

export function WorkBoard(props: WorkBoardProps) {
  const projected = new Set(props.needsNow.map((item) => item.taskId));

  return (
    <div className="work-board" data-testid="work-board">
      <section
        id="needs-now"
        className="needs-now"
        aria-labelledby="needs-now-title"
        data-testid="needs-now-deck"
      >
        <div className="section-heading needs-now-heading">
          <div>
            <p className="section-label">ATTENTION ROUTER</p>
            <h2 id="needs-now-title">{`Needs ${props.humanDisplayName} now`}</h2>
          </div>
          <p className="section-summary">Only persisted P0/P1 work that is blocked or due.</p>
        </div>
        {props.needsNow.length === 0 ? (
          <div className="attention-empty" data-testid="needs-now-empty">
            <strong>Nothing needs you right now.</strong>
            <span>Enjoy the suspicious silence.</span>
          </div>
        ) : (
          <ol className="attention-list">
            {props.needsNow.map((item) => (
              <li key={item.taskId} className="attention-item" data-priority={item.priority}>
                <button
                  type="button"
                  className="attention-open"
                  onClick={() => props.onSelectTask?.(item.taskId)}
                >
                  <span className="attention-priority">
                    {PRIORITY_LABELS[item.priority] ?? item.priority}
                  </span>
                  <strong>{item.title}</strong>
                  <span className="attention-punchline">{item.punchline}</span>
                  <span className="attention-reason">{`Why ${props.humanDisplayName}: ${item.reason}`}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section
        id="project-board"
        aria-labelledby="project-board-title"
        className="project-board"
        data-testid="project-lanes"
      >
        <div className="section-heading board-heading">
          <div>
            <p className="section-label">PROJECT LANES</p>
            <h2 id="project-board-title">Where the work is</h2>
          </div>
          <p className="section-summary">
            Lanes are projects. Status-column theater remains unavailable.
          </p>
        </div>

        <nav className="project-jump" aria-label="Jump to project">
          {props.lanes.map((lane) => (
            <a key={lane.projectId} href={`#lane-${lane.slug}`}>
              <span style={{ backgroundColor: lane.tint }} aria-hidden="true" />
              {lane.name}
            </a>
          ))}
        </nav>

        {props.lanes.length === 0 ? (
          <div className="board-empty">
            <strong>No accessible projects.</strong>
            <span>Ask a workspace owner for a project grant.</span>
          </div>
        ) : (
          <div className="project-lane-scroll" tabIndex={0} aria-label="Project lane canvas">
            {props.lanes.map((lane) => (
              <section
                key={lane.projectId}
                id={`lane-${lane.slug}`}
                className="project-lane"
                data-testid={`lane-${lane.slug}`}
                aria-labelledby={`lane-title-${lane.projectId}`}
              >
                <header className="lane-header" style={{ borderTopColor: lane.tint }}>
                  <div className="lane-identity">
                    <span
                      className="project-swatch"
                      style={{ backgroundColor: lane.tint }}
                      aria-hidden="true"
                    />
                    <div>
                      <h3 id={`lane-title-${lane.projectId}`}>{lane.name}</h3>
                      <p>{laneTaskCount(lane.tasks.length)}</p>
                    </div>
                  </div>
                  <span className="lane-slug">{lane.slug}</span>
                </header>

                {lane.tasks.length === 0 ? (
                  <p className="lane-empty">No open work. Suspicious, but allowed.</p>
                ) : (
                  <ol className="task-list">
                    {lane.tasks.map((card) => {
                      const selected = props.selectedTaskId === card.taskId;
                      const assignedProfile = card.passToAgentProfileId
                        ? profileName(props.agentProfiles, card.passToAgentProfileId)
                        : null;
                      return (
                        <li key={card.taskId}>
                          <article
                            id={`task-${card.taskId}`}
                            className={`task-card${selected ? " is-selected" : ""}`}
                            style={
                              {
                                borderTopColor: card.projectTint,
                                "--project-tint": card.projectTint,
                              } as React.CSSProperties
                            }
                            data-priority={card.priority}
                            data-state={card.state}
                            data-side-stripe={card.sideStripe ? "yes" : "no"}
                          >
                            <span className="priority-marker" data-testid="priority-marker">
                              {PRIORITY_LABELS[card.priority] ?? card.priority}
                            </span>
                            <button
                              type="button"
                              className="task-open"
                              aria-pressed={selected}
                              aria-label={`Open ${card.title}`}
                              onClick={() => props.onSelectTask?.(card.taskId)}
                            >
                              <span className="task-state">{card.state.replaceAll("_", " ")}</span>
                              <strong>{card.title}</strong>
                              <span className="now-label">{card.nowLabel}</span>
                              <span className="punchline">{card.punchline}</span>
                              {projected.has(card.taskId) ? (
                                <span className="pinned-label">Pinned above</span>
                              ) : null}
                            </button>

                            {card.whyHuman ? (
                              <p className="routing-reason">
                                <span>{`Why ${card.humanOwnerName ?? "human"}`}</span>
                                {card.whyHuman}
                              </p>
                            ) : null}
                            {card.whyDelegable ? (
                              <p className="routing-reason is-delegable">
                                <span>Why delegable</span>
                                {card.whyDelegable}
                              </p>
                            ) : null}
                            {assignedProfile ? (
                              <div className="task-handoff">
                                <span>{`Intended owner: ${assignedProfile}`}</span>
                                {props.canManageTasks && card.passToAgentProfileId ? (
                                  <button
                                    type="button"
                                    className="button-link"
                                    data-testid="pass-to-agent"
                                    onClick={() =>
                                      props.onPassToAgent?.(card.taskId, card.passToAgentProfileId!)
                                    }
                                  >
                                    {`Pass to ${assignedProfile}`}
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                            {card.latestEvent ? (
                              <p className="card-record" data-testid="latest-event">
                                {`Latest · ${card.latestEvent.kind} · ${card.latestEvent.createdAt}`}
                              </p>
                            ) : null}
                            {card.runSummary ? (
                              <p className="card-record" data-testid="run-summary">
                                {`Run · ${card.runSummary.resultState} · ${card.runSummary.activity}`}
                              </p>
                            ) : null}
                            <p className="agent-truth" data-testid="agent-work-state">
                              <span aria-hidden="true">○</span>
                              {props.agentWorkAvailable
                                ? "Committed agent work is available"
                                : "Agent work unavailable"}
                            </p>
                          </article>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
