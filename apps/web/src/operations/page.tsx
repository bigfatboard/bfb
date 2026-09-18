// ABOUTME: Renders the X05 Operations surface with role-gated audit, queues, retention, and diagnostics.
// ABOUTME: Privileged actions obtain a fresh action-bound passkey proof; the UI never renders private payloads.

import { useCallback, useEffect, useState } from "react";

import { requestStepUpProof } from "../auth/webauthn.js";
import {
  buildRecoveryBody,
  describeStuckItem,
  formatCount,
  newIdempotencyKey,
  operationsPath,
  visibleSections,
  type OperationsRole,
  type RecoveryTarget,
} from "./api.js";

export interface OperationsPageProps {
  workspaceId: string;
  role: OperationsRole;
  authorizationEpoch: number;
  csrfToken: string;
  fetchImpl?: typeof fetch;
}

interface SectionState<T> {
  loading: boolean;
  error: string | null;
  data: T | null;
}

function initialSection<T>(): SectionState<T> {
  return { loading: true, error: null, data: null };
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<Record<string, unknown>> {
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new Error(`Operations read failed (${response.status}).`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export function OperationsPage(props: OperationsPageProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const sections = visibleSections(props.role);
  const [health, setHealth] = useState<SectionState<Record<string, unknown>>>(initialSection);
  const [queues, setQueues] = useState<SectionState<Record<string, unknown>>>(initialSection);
  const [activity, setActivity] =
    useState<SectionState<{ entries: Array<Record<string, unknown>> }>>(initialSection);
  const [audit, setAudit] =
    useState<SectionState<{ entries: Array<Record<string, unknown>> }>>(initialSection);
  const [retention, setRetention] = useState<SectionState<Record<string, unknown>>>(initialSection);
  const [bundles, setBundles] =
    useState<SectionState<{ bundles: Array<Record<string, unknown>> }>>(initialSection);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retentionDays, setRetentionDays] = useState("30");

  const load = useCallback(async () => {
    const base = (suffix: string) => operationsPath(props.workspaceId, suffix);
    if (sections.includes("health")) {
      try {
        setHealth({ loading: false, error: null, data: await getJson(fetchFn, base("/health")) });
      } catch (caught) {
        setHealth({
          loading: false,
          error: caught instanceof Error ? caught.message : "Health failed.",
          data: null,
        });
      }
    } else {
      setHealth({ loading: false, error: null, data: null });
    }
    if (sections.includes("queues")) {
      try {
        setQueues({ loading: false, error: null, data: await getJson(fetchFn, base("/queues")) });
      } catch (caught) {
        setQueues({
          loading: false,
          error: caught instanceof Error ? caught.message : "Queues failed.",
          data: null,
        });
      }
    } else {
      setQueues({ loading: false, error: null, data: null });
    }
    try {
      const feed = (await getJson(fetchFn, base("/activity"))) as {
        entries: Array<Record<string, unknown>>;
      };
      setActivity({ loading: false, error: null, data: feed });
    } catch (caught) {
      setActivity({
        loading: false,
        error: caught instanceof Error ? caught.message : "Activity failed.",
        data: null,
      });
    }
    if (props.role === "owner") {
      try {
        const rows = (await getJson(fetchFn, base("/security-audit"))) as {
          entries: Array<Record<string, unknown>>;
        };
        setAudit({ loading: false, error: null, data: rows });
      } catch (caught) {
        setAudit({
          loading: false,
          error: caught instanceof Error ? caught.message : "Audit failed.",
          data: null,
        });
      }
      try {
        setRetention({
          loading: false,
          error: null,
          data: await getJson(fetchFn, base("/retention")),
        });
      } catch (caught) {
        setRetention({
          loading: false,
          error: caught instanceof Error ? caught.message : "Retention failed.",
          data: null,
        });
      }
      try {
        const list = (await getJson(fetchFn, base("/diagnostics"))) as {
          bundles: Array<Record<string, unknown>>;
        };
        setBundles({ loading: false, error: null, data: list });
      } catch (caught) {
        setBundles({
          loading: false,
          error: caught instanceof Error ? caught.message : "Diagnostics failed.",
          data: null,
        });
      }
    } else {
      setAudit({ loading: false, error: null, data: null });
      if (props.role === "member") {
        try {
          setRetention({
            loading: false,
            error: null,
            data: await getJson(fetchFn, base("/retention")),
          });
        } catch (caught) {
          setRetention({
            loading: false,
            error: caught instanceof Error ? caught.message : "Retention failed.",
            data: null,
          });
        }
        try {
          const list = (await getJson(fetchFn, base("/diagnostics"))) as {
            bundles: Array<Record<string, unknown>>;
          };
          setBundles({ loading: false, error: null, data: list });
        } catch (caught) {
          setBundles({
            loading: false,
            error: caught instanceof Error ? caught.message : "Diagnostics failed.",
            data: null,
          });
        }
      } else {
        setRetention({ loading: false, error: null, data: null });
        setBundles({ loading: false, error: null, data: null });
      }
    }
  }, [fetchFn, props.role, props.workspaceId, sections]);

  useEffect(() => {
    void load();
  }, [load]);

  async function postRecovery(recovery: RecoveryTarget) {
    if (busy || props.role !== "owner") {
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const proof = await requestStepUpProof(fetchFn, props.csrfToken, {
        action: "ops.recover",
        workspaceId: props.workspaceId,
        targetId: `ops-recover:${recovery.kind}:${props.workspaceId}`,
        scopes: [],
        authorizationEpoch: props.authorizationEpoch,
      });
      const response = await fetchFn(operationsPath(props.workspaceId, "/recovery"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-bfb-csrf": props.csrfToken },
        body: JSON.stringify({
          ...buildRecoveryBody(recovery.kind, recovery.target),
          step_up_proof_id: proof,
        }),
      });
      if (!response.ok) {
        throw new Error(`Recovery failed (${response.status}).`);
      }
      setStatus("Recovery applied. Retries converge on the stored outcome.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Recovery failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveRetention() {
    if (busy || props.role !== "owner") {
      return;
    }
    const days = Number(retentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setError("Retention must be 1 to 365 days.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const proof = await requestStepUpProof(fetchFn, props.csrfToken, {
        action: "ops.retention",
        workspaceId: props.workspaceId,
        targetId: `ops-retention:${props.workspaceId}`,
        scopes: [],
        authorizationEpoch: props.authorizationEpoch,
      });
      const response = await fetchFn(operationsPath(props.workspaceId, "/retention"), {
        method: "PUT",
        headers: { "content-type": "application/json", "x-bfb-csrf": props.csrfToken },
        body: JSON.stringify({
          request_id: `ops-${newIdempotencyKey()}`,
          raw_log_retention_days: days,
          step_up_proof_id: proof,
        }),
      });
      if (!response.ok) {
        throw new Error(`Retention update failed (${response.status}).`);
      }
      setStatus("Retention policy updated after passkey verification.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Retention update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function generateBundle() {
    if (busy || props.role !== "owner") {
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const proof = await requestStepUpProof(fetchFn, props.csrfToken, {
        action: "diagnostic.generate",
        workspaceId: props.workspaceId,
        targetId: `diagnostic:generate:${props.workspaceId}`,
        scopes: [],
        authorizationEpoch: props.authorizationEpoch,
      });
      const response = await fetchFn(operationsPath(props.workspaceId, "/diagnostics"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-bfb-csrf": props.csrfToken },
        body: JSON.stringify({ request_id: `ops-${newIdempotencyKey()}`, step_up_proof_id: proof }),
      });
      if (!response.ok) {
        throw new Error(`Diagnostic generation failed (${response.status}).`);
      }
      setStatus("Diagnostic bundle generated. Review its inventory before consenting to upload.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Diagnostic generation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function consentBundle(bundleId: string) {
    if (busy || props.role !== "owner") {
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const proof = await requestStepUpProof(fetchFn, props.csrfToken, {
        action: "diagnostic.upload",
        workspaceId: props.workspaceId,
        targetId: `diagnostic:${bundleId}`,
        scopes: [],
        authorizationEpoch: props.authorizationEpoch,
      });
      const response = await fetchFn(
        operationsPath(props.workspaceId, `/diagnostics/${bundleId}/consent`),
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-bfb-csrf": props.csrfToken },
          body: JSON.stringify({
            request_id: `ops-${newIdempotencyKey()}`,
            step_up_proof_id: proof,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`Upload consent failed (${response.status}).`);
      }
      setStatus("Upload consented after inventory review. The redacted bundle uploads once.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload consent failed.");
    } finally {
      setBusy(false);
    }
  }

  const queueData = queues.data as {
    queues?: { notifications?: Record<string, number>; github_outbox?: Record<string, number> };
    stuck_uploads?: Array<{ version_id: string; age_ms: number }>;
    stuck_launches?: Array<{ command_id: string; age_ms: number }>;
  } | null;

  return (
    <div className="work-surface" data-testid="operations-page">
      <div className="work-titlebar">
        <div>
          <p className="section-label">OPERATIONS</p>
          <h1>Operations, audit, and retention</h1>
          <p>
            Committed counts and cursors only. No task text, paths, or secrets leave this surface.
          </p>
        </div>
      </div>
      {status ? (
        <p className="inline-status" role="status">
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}

      {sections.includes("health") ? (
        <section aria-label="Health" data-testid="operations-health">
          <h2>Health</h2>
          {health.loading ? <p>Loading health…</p> : null}
          {health.error ? <p className="inline-error">{health.error}</p> : null}
          {health.data ? (
            <ul>
              <li data-testid="health-retention">
                Retention:{" "}
                {formatCount(
                  (health.data.health as Record<string, Record<string, unknown>>)?.retention
                    ?.eligible_chunks,
                )}{" "}
                eligible chunks
              </li>
              <li data-testid="health-tokens">
                Tokens:{" "}
                {formatCount(
                  (health.data.health as Record<string, Record<string, number>>)?.tokens
                    ?.expiring_runner_tokens,
                )}{" "}
                expiring
              </li>
              <li data-testid="health-migrations">
                Migrations:{" "}
                {(health.data.migrations as { ok?: boolean })?.ok ? "complete" : "incomplete"}
              </li>
            </ul>
          ) : null}
        </section>
      ) : null}

      {sections.includes("queues") ? (
        <section aria-label="Queues and stuck work" data-testid="operations-queues">
          <h2>Queues &amp; stuck work</h2>
          {queues.loading ? <p>Loading queues…</p> : null}
          {queues.error ? <p className="inline-error">{queues.error}</p> : null}
          {queueData ? (
            <>
              <p data-testid="queue-counts">
                Notifications pending {formatCount(queueData.queues?.notifications?.pending)},
                dead-lettered {formatCount(queueData.queues?.notifications?.dead_lettered)}; GitHub
                outbox pending {formatCount(queueData.queues?.github_outbox?.pending)}, DLQ{" "}
                {formatCount(queueData.queues?.github_outbox?.dlq)}.
              </p>
              <ul>
                {(queueData.stuck_uploads ?? []).map((item) => (
                  <li key={item.version_id} data-testid={`stuck-upload-${item.version_id}`}>
                    Upload {describeStuckItem(item)}{" "}
                    {props.role === "owner" ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void postRecovery({
                            kind: "resolve_stuck_upload",
                            target: { version_ids: [item.version_id] },
                          })
                        }
                      >
                        Resolve stuck upload
                      </button>
                    ) : null}
                  </li>
                ))}
                {(queueData.stuck_launches ?? []).map((item) => (
                  <li key={item.command_id} data-testid={`stuck-launch-${item.command_id}`}>
                    Launch {describeStuckItem(item)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      <section aria-label="Activity" data-testid="operations-activity">
        <h2>Activity</h2>
        {activity.loading ? <p>Loading activity…</p> : null}
        {activity.error ? <p className="inline-error">{activity.error}</p> : null}
        <ul>
          {(activity.data?.entries ?? []).slice(0, 20).map((entry) => (
            <li
              key={String(entry.workspace_cursor)}
              data-testid={`activity-${String(entry.workspace_cursor)}`}
            >
              {String(entry.kind)} · {String(entry.actor_type)} · cursor{" "}
              {String(entry.workspace_cursor)}
            </li>
          ))}
        </ul>
      </section>

      {props.role === "owner" ? (
        <section aria-label="Security audit" data-testid="operations-audit">
          <h2>Security audit</h2>
          {audit.loading ? <p>Loading audit…</p> : null}
          {audit.error ? <p className="inline-error">{audit.error}</p> : null}
          <ul>
            {(audit.data?.entries ?? []).slice(0, 20).map((entry) => (
              <li key={String(entry.audit_id)} data-testid={`audit-${String(entry.audit_id)}`}>
                {String(entry.action)} · {String(entry.actor_principal_id)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {sections.includes("retention") ? (
        <section aria-label="Retention" data-testid="operations-retention">
          <h2>Retention</h2>
          {retention.data ? (
            <p data-testid="retention-policy">
              Raw logs:{" "}
              {(retention.data.policy as { raw_log_retention_days?: number } | null)
                ?.raw_log_retention_days ?? 30}{" "}
              days · {(retention.data.eligible as { eligible?: unknown[] })?.eligible?.length ?? 0}{" "}
              eligible chunks. Hashes, metadata, and blobs are never deleted.
            </p>
          ) : null}
          {props.role === "owner" ? (
            <div>
              <label>
                Raw-log window (days)
                <input
                  data-testid="retention-days"
                  value={retentionDays}
                  onChange={(event) => setRetentionDays(event.target.value)}
                  inputMode="numeric"
                />
              </label>
              <button type="button" disabled={busy} onClick={() => void saveRetention()}>
                Verify passkey &amp; save retention
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {sections.includes("diagnostics") ? (
        <section aria-label="Diagnostics" data-testid="operations-diagnostics">
          <h2>Diagnostics</h2>
          {props.role === "owner" ? (
            <button type="button" disabled={busy} onClick={() => void generateBundle()}>
              Verify passkey &amp; generate bundle
            </button>
          ) : null}
          <ul>
            {(bundles.data?.bundles ?? []).map((bundle) => (
              <li key={String(bundle.bundle_id)} data-testid={`bundle-${String(bundle.bundle_id)}`}>
                {String(bundle.bundle_id).slice(0, 8)}… · {String(bundle.state)} · redaction{" "}
                {String(bundle.redaction_status)}
                {props.role === "owner" && bundle.state === "pending_consent" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void consentBundle(String(bundle.bundle_id))}
                  >
                    Review inventory &amp; consent upload
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
