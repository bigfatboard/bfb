// ABOUTME: Renders the W01 Work surface from committed project-lane and attention projections.
// ABOUTME: Never invents live agent activity; unavailable states stay explicit.

import type { AttentionDeckItem, ProjectLane } from "@bfb/domain";
import { unavailableAgentWorkCopy } from "@bfb/domain";

export interface WorkBoardProps {
  humanDisplayName: string;
  lanes: ProjectLane[];
  needsNow: AttentionDeckItem[];
  agentWorkAvailable: boolean;
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function WorkBoard(props: WorkBoardProps) {
  return (
    <div className="work-board" data-testid="work-board">
      <section aria-label={`Needs ${props.humanDisplayName} Now`} data-testid="needs-now-deck">
        <h2>{`Needs ${escapeText(props.humanDisplayName)} Now`}</h2>
        {props.needsNow.length === 0 ? (
          <p data-testid="needs-now-empty">Nothing needs you right now.</p>
        ) : (
          <ol>
            {props.needsNow.map((item) => (
              <li key={item.taskId}>
                <a href={`#task-${item.taskId}`}>{escapeText(item.title)}</a>
                <span>{escapeText(item.priority)}</span>
                <p>{escapeText(item.punchline)}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-label="Project lanes" className="project-lanes" data-testid="project-lanes">
        {props.lanes.map((lane) => (
          <div
            key={lane.projectId}
            className="project-lane"
            data-testid={`lane-${lane.slug}`}
            style={{ borderTop: `3px solid ${lane.tint}` }}
          >
            <header>
              <span
                className="project-swatch"
                style={{ backgroundColor: lane.tint }}
                aria-hidden="true"
              />
              <h3>{escapeText(lane.name)}</h3>
            </header>
            <ul>
              {lane.tasks.map((card) => (
                <li
                  key={card.taskId}
                  id={`task-${card.taskId}`}
                  className="task-card"
                  style={{ borderTop: `${card.topEdgePx}px solid ${card.projectTint}` }}
                  data-side-stripe={card.sideStripe ? "yes" : "no"}
                >
                  <span className="priority-marker" data-testid="priority-marker">
                    {escapeText(card.priority)}
                  </span>
                  <span className="now-label">{card.nowLabel}</span>
                  <strong>{escapeText(card.title)}</strong>
                  <p className="punchline">{escapeText(card.punchline)}</p>
                  {card.whyHuman ? (
                    <p>{`Why ${escapeText(props.humanDisplayName)}: ${escapeText(card.whyHuman)}`}</p>
                  ) : null}
                  {card.whyDelegable ? (
                    <p>{`Why delegable: ${escapeText(card.whyDelegable)}`}</p>
                  ) : null}
                  {card.passToAgentProfileId ? (
                    <p data-testid="pass-to-agent">Pass to configured agent profile</p>
                  ) : null}
                  <p data-testid="agent-work-state">
                    {props.agentWorkAvailable
                      ? "Agent work state available"
                      : unavailableAgentWorkCopy()}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}
