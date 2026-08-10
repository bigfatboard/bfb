// ABOUTME: Renders the authenticated SPA shell with an honest Work surface placeholder path.
// ABOUTME: Board data is injected by tests or later loaders; no fabricated live activity.

import { WorkBoard, type WorkBoardProps } from "./work/board.js";

export interface AppShellProps {
  board?: WorkBoardProps;
  role?: "owner" | "member" | "restricted_member";
}

export function AppShell(props: AppShellProps = {}) {
  return (
    <main>
      <h1>BFB</h1>
      <p data-testid="substrate-package">W01</p>
      {props.role ? <p data-testid="current-role">{props.role}</p> : null}
      {props.board ? (
        <WorkBoard {...props.board} />
      ) : (
        <p>Sign in to open a workspace Work surface.</p>
      )}
    </main>
  );
}
