# WP-C07 — Projects, repository identity, and policy

Status: `planned`

Risk: High

Test target: `pnpm test:c07`

Evidence manifest: `docs/work-packages/evidence/WP-C07/manifest.json`

## Outcome

Authorized humans can register project/repository identities and manage project access, provider policy, agent profiles, and immutable configuration versions without coupling cloud identity to a local path.

## Dependencies

- **Requires:** C01, C04.
- **Unlocks:** C05, C06, C08, C09, X02, X03A, X04, X05.
- **Can run with:** nothing that changes the shared D1 migration head.

## Scope

- Add projects, repository/subpath identity, project access, provider policies, agent profiles, and configuration versions.
- Use immutable hosted-repository ID where available plus normalized workspace-relative monorepo subpath; never use a local path as cloud project identity.
- Support projects visible to all workspace members or restricted through explicit project grants, extending C04's authorization context.
- Implement the workspace ceiling → project tightening → repository-config tightening → profile → runner-capability → allowed run-override policy inputs owned by the cloud project layer.
- Implement repository `.bfb/config.yaml` hash/report fields without reading local files in cloud code.
- Expose paginated `/api/v1` project/profile/policy/config reads and typed hub commands for mutations.
- Preserve every policy/profile/config change as an immutable version and semantic event so C08/C09 can bind historical run snapshots.

## Non-goals

- Tasks, runs, executions, sessions, context, comments, launch delivery, hook ingestion, attention, results, artifact bytes, or GitHub synchronization.
- Reading local files, widening workspace policy from repository configuration, automatic merge/deploy, or provider credentials.


## Contracts

### Consumes

- C01/C04 authorization and persistence.

### Produces

- Projects, tints, agent profiles, and project policies.
- Stable test target `pnpm test:c07` and evidence path `docs/work-packages/evidence/WP-C07/manifest.json`.

## Work plan

1. Add project/repository/access/policy/profile/config migrations and identity constraints.
2. Implement project and project-access commands/reads through the hub.
3. Implement immutable policy/profile/config versions and repository-config hash reporting.
4. Add repository identity, policy-tightening, stale-version, and cross-project negative tests.

## Acceptance

- Authorized users can create/read/update only permitted projects, and a project restriction is enforced in addition to workspace role.
- Hosted repository identity plus normalized monorepo subpath is unique within a workspace; SSH/HTTPS aliases cannot create an unintended second GitHub project identity.
- Repository configuration can tighten but never widen workspace/project policy.
- Stale project/policy/profile/config versions fail atomically.
- Changing policy/profile/config creates a new immutable version and never mutates a version already available to a run snapshot.
- No project record, event, API body, or log stores an absolute checkout path or provider credential.

## Evidence and handoff

- Commit repository-identity fixtures, project permission matrix, policy-tightening tests, API/pagination fixtures, and immutable configuration snapshots.
- C06 consumes project IDs/grants; C08 consumes project authorization/configuration versions; C09 consumes policy/profile/config inputs for an immutable launch snapshot; X03A consumes the bounded authorized project read; X04 may strengthen identity with GitHub's immutable repository ID.

## Risks and decisions

- Repository aliases and monorepo subpaths are security and attribution boundaries. Cloud project identity must remain independent of any runner's local path.
