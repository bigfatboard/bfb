// ABOUTME: Authenticated W01 shell with URL-resolved workspaces and role-aware Work navigation.
// ABOUTME: Keeps attention, project lanes, task detail, and honest unavailable routes in one app.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { AttentionDeckItem, ProjectLane } from "@bfb/domain";

import { AttentionHome } from "./attention/home.js";
import { WorkBoard, type AgentProfileSummary } from "./work/board.js";
import { TaskComposer, WorkMutations } from "./work/mutations.js";
import { WorkspaceSettings } from "./settings.js";
import { RunnerEnrollmentPage } from "./runner-enrollment.js";

export interface AppShellProps {
  /** Test injection; production loads from /auth/session + browser APIs. */
  initialPath?: string;
  fetchImpl?: typeof fetch;
}

interface SessionHuman {
  id: string;
  email: string;
  display_name: string;
}

interface WorkspaceSummary {
  id: string;
  slug: string;
  jurisdiction: string;
  role: "owner" | "member" | "reviewer";
  authorization_epoch: number;
}

interface BoardResponse {
  human: { id: string; display_name: string };
  role: "owner" | "member" | "reviewer";
  authorization_epoch: number;
  lanes: ProjectLane[];
  needs_now: AttentionDeckItem[];
  agent_work_available: boolean;
}

type AppView = "work" | "attention" | "latest" | "load" | "settings";

interface ParsedRoute {
  workspaceSlug: string | null;
  view: AppView;
}

function parseRoute(pathname: string): ParsedRoute {
  const match = pathname.match(/^\/w\/([^/]+)(?:\/(work|attention|latest|load|settings))?\/?$/);
  return {
    workspaceSlug: match?.[1] ?? null,
    view: (match?.[2] as AppView | undefined) ?? "work",
  };
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function AppShell(props: AppShellProps = {}) {
  const fetchFn = props.fetchImpl ?? fetch;
  const [path, setPath] = useState(
    () => props.initialPath ?? (typeof window !== "undefined" ? window.location.pathname : "/"),
  );
  const [hash, setHash] = useState(() =>
    typeof window === "undefined" ? "" : window.location.hash,
  );
  const [human, setHuman] = useState<SessionHuman | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [agentProfiles, setAgentProfiles] = useState<AgentProfileSummary[]>([]);
  const [csrfToken, setCsrfToken] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [boardLoading, setBoardLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  const route = useMemo(() => parseRoute(path), [path]);
  const workspace = useMemo(
    () => workspaces.find((item) => item.slug === route.workspaceSlug) ?? null,
    [route.workspaceSlug, workspaces],
  );
  const workspaceUnavailable = Boolean(route.workspaceSlug && workspaces.length > 0 && !workspace);
  const canManageTasks = board?.role === "owner" || board?.role === "member";

  useEffect(() => {
    if (props.initialPath || typeof window === "undefined") {
      return;
    }
    const onPopState = () => {
      setPath(window.location.pathname);
      setHash(window.location.hash);
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onPopState);
    };
  }, [props.initialPath]);

  useEffect(() => {
    let active = true;
    void (async () => {
      setAuthLoading(true);
      try {
        const session = await fetchFn("/auth/session");
        if (!session.ok) {
          if (active) {
            setHuman(null);
          }
          return;
        }
        const sessionBody = (await session.json()) as {
          human: SessionHuman;
          csrf_token?: string;
        };
        const workspaceResponse = await fetchFn("/api/v1/workspaces");
        if (!workspaceResponse.ok) {
          throw new Error("Workspace list unavailable");
        }
        const workspaceBody = (await workspaceResponse.json()) as {
          workspaces: WorkspaceSummary[];
        };
        if (active) {
          setHuman(sessionBody.human);
          setCsrfToken(sessionBody.csrf_token ?? "");
          setWorkspaces(workspaceBody.workspaces);
          setOffline(false);
        }
      } catch {
        if (active) {
          setOffline(true);
          setError("BFB cannot reach the control plane.");
        }
      } finally {
        if (active) {
          setAuthLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [fetchFn]);

  const reloadBoard = useCallback(async () => {
    if (!human || !workspace) {
      setBoard(null);
      setAgentProfiles([]);
      return;
    }
    setBoardLoading(true);
    try {
      const [boardResponse, profilesResponse] = await Promise.all([
        fetchFn(`/api/v1/workspaces/${workspace.id}/board`),
        fetchFn(`/api/v1/workspaces/${workspace.id}/agent-profiles?limit=100`),
      ]);
      if (!boardResponse.ok || !profilesResponse.ok) {
        const status = boardResponse.ok ? profilesResponse.status : boardResponse.status;
        setError(
          status === 403 || status === 404 ? "Workspace not available." : "Board failed to load.",
        );
        setBoard(null);
        return;
      }
      const profileBody = (await profilesResponse.json()) as {
        profiles: AgentProfileSummary[];
      };
      setBoard((await boardResponse.json()) as BoardResponse);
      setAgentProfiles(profileBody.profiles);
      setError(null);
      setOffline(false);
    } catch {
      setOffline(true);
      setError("Board is offline. No cached state is presented as current.");
    } finally {
      setBoardLoading(false);
    }
  }, [fetchFn, human, workspace]);

  useEffect(() => {
    if (route.workspaceSlug && workspaces.length > 0 && !workspace) {
      setError("Workspace not available.");
      setBoard(null);
      return;
    }
    void reloadBoard();
  }, [reloadBoard, route.workspaceSlug, workspace, workspaces.length]);

  function navigate(nextPath: string): void {
    setPath(nextPath);
    setSelectedTaskId(null);
    setShowComposer(false);
    if (typeof window !== "undefined") {
      window.history.pushState({}, "", nextPath);
    }
  }

  function navigateToView(view: AppView): void {
    if (!workspace) {
      return;
    }
    navigate(view === "work" ? `/w/${workspace.slug}` : `/w/${workspace.slug}/${view}`);
  }

  async function signIn(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const response = await fetchFn("/auth/sign-in/github", { method: "POST" });
    const body = await jsonBody(response);
    if (!response.ok || typeof body.url !== "string" || typeof window === "undefined") {
      setError("GitHub sign-in could not start.");
      return;
    }
    window.location.assign(body.url);
  }

  async function signOut(): Promise<void> {
    const response = await fetchFn("/auth/sign-out", {
      method: "POST",
      ...(csrfToken ? { headers: { "x-bfb-csrf": csrfToken } } : {}),
    });
    if (!response.ok) {
      setError("Sign-out failed.");
      return;
    }
    setHuman(null);
    setWorkspaces([]);
    setBoard(null);
    navigate("/");
  }

  if (authLoading) {
    return (
      <main className="auth-state" aria-busy="true">
        <p className="brand-mark">BFB</p>
        <div className="auth-loading" role="status">
          <span />
          Loading workspace authority…
        </div>
      </main>
    );
  }

  if (path === "/runner-enroll") {
    return (
      <RunnerEnrollmentPage
        key={hash}
        fragment={hash}
        fetchImpl={fetchFn}
        csrfToken={csrfToken}
        humanName={human?.display_name ?? null}
        workspaces={workspaces}
      />
    );
  }

  if (!human) {
    return (
      <main className="sign-in-shell">
        <section className="sign-in-panel" aria-labelledby="sign-in-title">
          <p className="brand-mark">BFB</p>
          <p className="section-label">BIG FAT BOARD</p>
          <h1 id="sign-in-title">Your agents are working. Your tickets are guessing.</h1>
          <p>
            One board for the work, the handoffs, and the uncomfortable questions that actually need
            a human.
          </p>
          <form onSubmit={(event) => void signIn(event)} data-testid="sign-in-form">
            <button type="submit" className="button-primary">
              Continue with GitHub
            </button>
          </form>
          {error ? (
            <p role="alert" className="inline-error">
              {error}
            </p>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className={`app-shell${selectedTaskId ? " has-sheet" : ""}`}>
      <a className="skip-link" href="#needs-now">
        Skip to attention
      </a>
      <a className="skip-link" href="#project-board">
        Skip to project lanes
      </a>

      <header className="topbar">
        <button type="button" className="brand-mark brand-button" onClick={() => navigate("/")}>
          BFB
        </button>
        <label className="workspace-picker">
          <span>Workspace</span>
          <select
            data-testid="workspace-switcher"
            value={workspace?.slug ?? ""}
            onChange={(event) => navigate(`/w/${event.target.value}`)}
          >
            <option value="">Choose workspace</option>
            {workspaces.map((item) => (
              <option key={item.id} value={item.slug}>
                {item.slug}
              </option>
            ))}
          </select>
        </label>
        <div className="topbar-spacer" />
        <span className={`truth-status${offline ? " is-offline" : ""}`}>
          {offline ? "Control plane offline" : "Committed state"}
        </span>
        <div className="human-menu">
          <div>
            <strong data-testid="current-human">{human.display_name}</strong>
            <span data-testid="current-role">{board?.role ?? workspace?.role ?? "member"}</span>
          </div>
          <button type="button" className="button-quiet" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="route-nav" aria-label="Product">
        {(["work", "attention", "latest", "load"] as const).map((view) => (
          <button
            key={view}
            type="button"
            aria-current={route.view === view ? "page" : undefined}
            disabled={!workspace}
            onClick={() => navigateToView(view)}
          >
            {titleCase(view)}
          </button>
        ))}
        {board?.role === "owner" ? (
          <button
            type="button"
            aria-current={route.view === "settings" ? "page" : undefined}
            onClick={() => navigateToView("settings")}
          >
            Projects &amp; policy
          </button>
        ) : null}
      </nav>

      {!workspace ? (
        <section className="workspace-empty" data-testid="work-surface-prompt">
          <p className="section-label">
            {workspaceUnavailable ? "BOARD UNAVAILABLE" : "WORKSPACE REQUIRED"}
          </p>
          <h1>
            {workspaceUnavailable ? "Workspace not available." : "Choose the board you mean."}
          </h1>
          <p>The URL is a preference. Your retained membership remains the authority.</p>
          {workspaces.length === 0 ? (
            <p className="inline-error" role="alert">
              You do not have an active workspace membership.
            </p>
          ) : null}
        </section>
      ) : boardLoading && !board ? (
        <section className="board-loading" aria-busy="true" role="status">
          <span />
          <span />
          <span />
          Loading committed work…
        </section>
      ) : error && !board ? (
        <section className="workspace-empty">
          <p className="section-label">BOARD UNAVAILABLE</p>
          <h1>{error}</h1>
          <button type="button" className="button-secondary" onClick={() => void reloadBoard()}>
            Try again
          </button>
        </section>
      ) : board && route.view === "work" ? (
        <div className="work-surface">
          <div className="work-titlebar">
            <div>
              <p className="section-label">{workspace.slug.toUpperCase()} / WORK</p>
              <h1>Current work</h1>
              <p>What needs you, what can move, and what BFB can actually prove.</p>
            </div>
            {canManageTasks ? (
              <button
                type="button"
                className="button-primary"
                onClick={() => setShowComposer((current) => !current)}
              >
                {showComposer ? "Close composer" : "New task"}
              </button>
            ) : null}
          </div>

          {showComposer && canManageTasks ? (
            <TaskComposer
              workspaceId={workspace.id}
              projects={board.lanes.map((lane) => ({ id: lane.projectId, name: lane.name }))}
              fetchImpl={fetchFn}
              csrfToken={csrfToken}
              onCancel={() => setShowComposer(false)}
              onCreated={(taskId) => {
                setShowComposer(false);
                setSelectedTaskId(taskId);
                void reloadBoard();
              }}
            />
          ) : null}

          <WorkBoard
            humanDisplayName={board.human.display_name}
            lanes={board.lanes}
            needsNow={board.needs_now}
            agentWorkAvailable={board.agent_work_available}
            agentProfiles={agentProfiles}
            selectedTaskId={selectedTaskId}
            canManageTasks={canManageTasks}
            onSelectTask={setSelectedTaskId}
            onPassToAgent={(taskId) => setSelectedTaskId(taskId)}
          />
        </div>
      ) : board && route.view === "settings" && board.role === "owner" ? (
        <WorkspaceSettings
          workspaceId={workspace.id}
          authorizationEpoch={board.authorization_epoch}
          csrfToken={csrfToken}
          fetchImpl={fetchFn}
          onChanged={() => void reloadBoard()}
        />
      ) : board && route.view === "attention" ? (
        <div className="work-surface">
          <div className="work-titlebar">
            <div>
              <p className="section-label">{workspace.slug.toUpperCase()} / ATTENTION</p>
              <h1>What needs a person now</h1>
              <p>Ranked agent requests with committed answers. Newest truth is polled, never pushed.</p>
            </div>
          </div>
          <AttentionHome
            workspaceId={workspace.id}
            role={board.role}
            fetchImpl={fetchFn}
            csrfToken={csrfToken}
          />
        </div>
      ) : board ? (
        <section className="placeholder-route" data-testid={`${route.view}-placeholder`}>
          <p className="section-label">{route.view.toUpperCase()}</p>
          <h1>{`${titleCase(route.view)} is intentionally unavailable.`}</h1>
          <p>
            This route belongs to a later package. BFB will not fabricate activity, review, or time
            data while it waits.
          </p>
          <button type="button" className="button-secondary" onClick={() => navigateToView("work")}>
            Return to Work
          </button>
        </section>
      ) : null}

      {board && workspace ? (
        <WorkMutations
          workspaceId={workspace.id}
          selectedTaskId={selectedTaskId}
          role={board.role}
          agentProfiles={agentProfiles}
          fetchImpl={fetchFn}
          csrfToken={csrfToken}
          onChanged={() => void reloadBoard()}
          onClose={() => setSelectedTaskId(null)}
        />
      ) : null}
    </main>
  );
}
