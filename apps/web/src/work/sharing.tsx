// ABOUTME: Reveals creator-only task sharing controls inside an explicitly opened detail section.
// ABOUTME: Keeps grants, drafts and awaited replies bound to the current task without optimistic access changes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isPanelAuthorityDenied, usePanelDelivery } from "./panel-delivery.js";

type Permission = "read" | "contribute" | "edit";

interface SharingView {
  task_id: string;
  access_version: number;
  grants: Array<{
    id: string;
    human_id: string;
    authorization_epoch: number;
    permission: Permission;
    created_at: string;
  }>;
  has_more: boolean;
}

interface SharingProps {
  workspaceId: string;
  taskId: string;
  humanId: string;
  members: readonly { id: string; display_name: string }[];
  api: {
    get(path: string): Promise<Record<string, unknown>>;
    post(path: string, body: unknown): Promise<Record<string, unknown>>;
  };
  onChanged: () => void;
}

interface SharingState {
  selection: object;
  data: SharingView | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  status: string | null;
}

function sharingView(body: Record<string, unknown>, taskId: string): SharingView {
  const value = body.sharing as SharingView | undefined;
  if (
    !value ||
    value.task_id !== taskId ||
    !Number.isSafeInteger(value.access_version) ||
    value.access_version < 1 ||
    !Array.isArray(value.grants) ||
    value.grants.length > 100 ||
    typeof value.has_more !== "boolean" ||
    value.grants.some(
      (grant) =>
        !grant ||
        typeof grant.id !== "string" ||
        typeof grant.human_id !== "string" ||
        !["read", "contribute", "edit"].includes(grant.permission),
    )
  ) {
    throw new Error("Sharing could not be loaded. Try again.");
  }
  return value;
}

export function TaskSharingPanel(props: SharingProps) {
  const selection = useMemo(
    () => ({
      workspaceId: props.workspaceId,
      taskId: props.taskId,
      humanId: props.humanId,
      api: props.api,
    }),
    [props.workspaceId, props.taskId, props.humanId, props.api],
  );
  const beginDelivery = usePanelDelivery(selection);
  const [stored, setStored] = useState<SharingState | null>(null);
  const [draft, setDraft] = useState({ selection, humanId: "", permission: "read" as Permission });
  const [composing, setComposing] = useState<object | null>(null);
  const pendingIntent = useRef<{ signature: string; requestId: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const personSelect = useRef<HTMLSelectElement>(null);
  const state = stored?.selection === selection ? stored : null;
  const currentDraft =
    draft.selection === selection
      ? draft
      : { selection, humanId: "", permission: "read" as Permission };
  const data = state?.data ?? null;
  const loading = state?.loading ?? true;
  const base = `/api/v1/workspaces/${props.workspaceId}/tasks/${props.taskId}/sharing`;
  const members = props.members.filter((member) => member.id !== props.humanId);
  const availableMembers = members.filter(
    (member) => !data?.grants.some((grant) => grant.human_id === member.id),
  );

  const failure = useCallback(
    (cause: unknown) => {
      setStored({
        selection,
        data: null,
        loading: false,
        error: isPanelAuthorityDenied(cause)
          ? null
          : cause instanceof Error
            ? cause.message
            : "Sharing could not be loaded. Try again.",
        unavailable: isPanelAuthorityDenied(cause),
        status: null,
      });
      if (isPanelAuthorityDenied(cause)) setComposing(null);
    },
    [selection],
  );

  const load = useCallback(async () => {
    const isCurrent = beginDelivery();
    if (!isCurrent) return;
    setStored({
      selection,
      data: null,
      loading: true,
      error: null,
      unavailable: false,
      status: null,
    });
    try {
      const next = sharingView(await props.api.get(base), props.taskId);
      if (!isCurrent()) return;
      setStored({
        selection,
        data: next,
        loading: false,
        error: null,
        unavailable: false,
        status: null,
      });
    } catch (cause) {
      if (isCurrent()) failure(cause);
    }
  }, [base, beginDelivery, failure, props.api, props.taskId, selection]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (composing === selection) personSelect.current?.focus();
  }, [composing, selection]);

  useEffect(() => {
    if (state?.status) heading.current?.focus({ preventScroll: true });
  }, [state?.status]);

  async function mutate(kind: "grant" | "revoke", grantId?: string) {
    if (!data || loading) return;
    const isCurrent = beginDelivery();
    if (!isCurrent) return;
    const input =
      kind === "grant"
        ? {
            human_id: currentDraft.humanId,
            permission: currentDraft.permission,
            expected_access_version: data.access_version,
          }
        : { expected_access_version: data.access_version };
    const path = kind === "grant" ? `${base}/grants` : `${base}/grants/${grantId}/revoke`;
    const signature = JSON.stringify([props.workspaceId, props.taskId, path, input]);
    if (pendingIntent.current?.signature !== signature) {
      pendingIntent.current = { signature, requestId: `web-sharing-${crypto.randomUUID()}` };
    }
    setStored({ selection, data, loading: true, error: null, unavailable: false, status: null });
    try {
      const receipt = await props.api.post(path, {
        ...input,
        request_id: pendingIntent.current.requestId,
      });
      if (!isCurrent()) return;
      props.onChanged();
      const next = sharingView(await props.api.get(base), props.taskId);
      if (!isCurrent()) return;
      const committedGrantId = (receipt.result as { grant_id?: string } | undefined)?.grant_id;
      const grantIsCurrent = next.grants.some((grant) => grant.id === committedGrantId);
      const status =
        receipt.replayed === true
          ? "Sharing refreshed."
          : kind === "grant" && grantIsCurrent
            ? "Access shared."
            : kind === "revoke" && !next.grants.some((grant) => grant.id === grantId)
              ? "Access revoked."
              : "Sharing refreshed.";
      setStored({ selection, data: next, loading: false, error: null, unavailable: false, status });
      pendingIntent.current = null;
      if (kind === "grant") {
        setComposing(null);
        setDraft({ selection, humanId: "", permission: "read" });
      }
    } catch (cause) {
      if (isCurrent()) failure(cause);
    }
  }

  return (
    <section
      aria-labelledby="task-sharing-heading"
      data-testid="task-sharing-panel"
      aria-busy={loading}
    >
      <div className="panel-title-row">
        <h3 id="task-sharing-heading" ref={heading} tabIndex={-1}>
          Sharing
        </h3>
        {data && composing !== selection && availableMembers.length ? (
          <button
            type="button"
            className="button-secondary"
            disabled={loading}
            onClick={() => setComposing(selection)}
          >
            Add person
          </button>
        ) : null}
      </div>
      {loading && !data ? <p role="status">Loading sharing…</p> : null}
      {state?.unavailable ? <p>Sharing is unavailable for this task.</p> : null}
      {state?.error ? (
        <p className="inline-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.unavailable || state?.error ? (
        <button type="button" className="button-secondary" onClick={() => void load()}>
          Retry sharing
        </button>
      ) : null}
      {state?.status ? <p role="status">{state.status}</p> : null}
      {data ? (
        <>
          <p className="section-help">
            Only you manage sharing. Project access and workspace roles still apply. Private
            checkpoints stay private.
          </p>
          {!data.grants.length ? (
            <p>No one else currently has access through a task grant.</p>
          ) : (
            <ul className="sharing-list" aria-label="Current task grants">
              {data.grants.map((grant) => (
                <li key={grant.id} className="sharing-grant">
                  <div className="sharing-recipient">
                    <strong>
                      {props.members.find((member) => member.id === grant.human_id)?.display_name ??
                        grant.human_id}
                    </strong>
                    <span>
                      {grant.permission === "read"
                        ? "Can read"
                        : grant.permission === "contribute"
                          ? "Can contribute"
                          : "Can edit · subject to workspace role"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="button-quiet"
                    disabled={loading}
                    onClick={() => void mutate("revoke", grant.id)}
                  >
                    Revoke access
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data.has_more ? (
            <p className="section-help">
              More current grants exist. This view shows the first 100.
            </p>
          ) : null}
          {!availableMembers.length ? (
            <p className="section-help">
              No additional project members are available to share with.
            </p>
          ) : null}
          {composing === selection ? (
            <form
              className="sharing-form"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate("grant");
              }}
            >
              <label>
                Person
                <select
                  ref={personSelect}
                  required
                  value={currentDraft.humanId}
                  disabled={loading}
                  onChange={(event) => setDraft({ ...currentDraft, humanId: event.target.value })}
                >
                  <option value="">Choose a project member</option>
                  {availableMembers.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Permission
                <select
                  value={currentDraft.permission}
                  disabled={loading}
                  onChange={(event) =>
                    setDraft({ ...currentDraft, permission: event.target.value as Permission })
                  }
                >
                  <option value="read">Read</option>
                  <option value="contribute">Contribute</option>
                  <option value="edit">Edit</option>
                </select>
              </label>
              <div className="task-controls">
                <button
                  type="submit"
                  className="button-primary"
                  disabled={loading || !currentDraft.humanId}
                >
                  {loading ? "Sharing…" : "Share task"}
                </button>
                <button
                  type="button"
                  className="button-quiet"
                  disabled={loading}
                  onClick={() => setComposing(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
