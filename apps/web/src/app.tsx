// ABOUTME: Authenticated SPA shell with explicit /w/<slug> workspace Work surface routing.
// ABOUTME: Loads board data and mutation forms from control APIs using the browser session cookie.

import { useCallback, useEffect, useState } from "react";

import type { AttentionDeckItem, ProjectLane } from "@bfb/domain";

import { WorkBoard } from "./work/board.js";
import { WorkMutations } from "./work/mutations.js";

/** Browser-safe fixture default; matches domain SYNTHETIC_PASSWORD without importing node:crypto. */
const DEFAULT_PASSWORD = "synthetic-password";

export interface AppShellProps {
  /** Test injection; production loads from /auth/session + board API. */
  initialPath?: string;
  fetchImpl?: typeof fetch;
}

interface SessionHuman {
  id: string;
  email: string;
  display_name: string;
}

interface BoardResponse {
  human: { id: string; display_name: string };
  role: string;
  lanes: ProjectLane[];
  needs_now: AttentionDeckItem[];
  agent_work_available: boolean;
}

function parseWorkspaceSlug(pathname: string): string | null {
  const match = pathname.match(/^\/w\/([^/]+)/);
  return match?.[1] ?? null;
}

export function AppShell(props: AppShellProps = {}) {
  const fetchFn = props.fetchImpl ?? fetch;
  const [path, setPath] = useState(
    () => props.initialPath ?? (typeof window !== "undefined" ? window.location.pathname : "/"),
  );
  const [human, setHuman] = useState<SessionHuman | null>(null);
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("owner@synthetic.test");
  const [password, setPassword] = useState(DEFAULT_PASSWORD);
  const [workspaceId, setWorkspaceId] = useState("");
  const [csrfToken, setCsrfToken] = useState("");

  const reloadBoard = useCallback(async () => {
    const slug = parseWorkspaceSlug(path);
    if (!human || !slug || !workspaceId) {
      return;
    }
    const response = await fetchFn(`/api/v1/workspaces/${workspaceId}/board`);
    if (!response.ok) {
      setError("Failed to load board");
      return;
    }
    setBoard((await response.json()) as BoardResponse);
    setError(null);
  }, [fetchFn, human, path, workspaceId]);

  useEffect(() => {
    void (async () => {
      const session = await fetchFn("/auth/session");
      if (session.ok) {
        const body = (await session.json()) as { human: SessionHuman; csrf_token?: string };
        setHuman(body.human);
        if (body.csrf_token) {
          setCsrfToken(body.csrf_token);
        }
      }
    })();
  }, [fetchFn]);

  useEffect(() => {
    void reloadBoard();
  }, [reloadBoard]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    const response = await fetchFn("/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) {
      setError("Sign-in failed");
      return;
    }
    const body = (await response.json()) as { human: SessionHuman; csrf_token?: string };
    setHuman(body.human);
    if (body.csrf_token) {
      setCsrfToken(body.csrf_token);
    }
    setError(null);
  }

  async function openWorkspace(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId) {
      setError("Workspace id required");
      return;
    }
    const slug = "synthetic";
    const next = `/w/${slug}`;
    setPath(next);
    if (typeof window !== "undefined") {
      window.history.pushState({}, "", next);
    }
  }

  const slug = parseWorkspaceSlug(path);
  const projectIds = board?.lanes.map((lane) => lane.projectId) ?? [];

  return (
    <main>
      <h1>BFB</h1>
      <p data-testid="substrate-package">W01</p>
      {!human ? (
        <form onSubmit={signIn} data-testid="sign-in-form">
          <label>
            Email
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              data-testid="sign-in-email"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="sign-in-password"
            />
          </label>
          <button type="submit">Sign in</button>
          {error ? <p role="alert">{error}</p> : null}
        </form>
      ) : (
        <>
          <p data-testid="current-human">{human.display_name}</p>
          <nav aria-label="Workspace">
            <form onSubmit={openWorkspace} data-testid="workspace-switcher">
              <label>
                Workspace id
                <input
                  value={workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                  data-testid="workspace-id-input"
                />
              </label>
              <button type="submit">Open Work surface</button>
            </form>
          </nav>
          {slug && board ? (
            <>
              <p data-testid="current-role">{board.role}</p>
              <WorkBoard
                humanDisplayName={board.human.display_name}
                lanes={board.lanes}
                needsNow={board.needs_now}
                agentWorkAvailable={board.agent_work_available}
              />
              <WorkMutations
                workspaceId={workspaceId}
                projectIds={projectIds}
                fetchImpl={fetchFn}
                csrfToken={csrfToken}
                onChanged={() => {
                  void reloadBoard();
                }}
              />
            </>
          ) : (
            <p data-testid="work-surface-prompt">
              Select a workspace to open the Work surface at /w/&lt;slug&gt;.
            </p>
          )}
          {error ? <p role="alert">{error}</p> : null}
        </>
      )}
    </main>
  );
}
