# Private local pilot

This is the L07 Claude-first integration runtime, not a beta release certificate.
It runs the production Control and Artifact Workers with persistent local D1/R2,
real GitHub authentication and passkeys. It does not use the disposable browser
fixture server or a test-login route. Installed-provider certification and the
complete browser-to-Claude human loop remain separate acceptance requirements.

The dedicated pilot explicitly emulates jurisdiction-specific workspace Hub
names because local Workerd does not implement geographic jurisdiction
restrictions. EU and US workspace names remain logically distinct, using real
Durable Objects and the existing D1 command path. This is not EU residency or
deployed-placement evidence. The emulation setting is rejected outside the
local environment; see [ADR 0012](adr/0012-local-pilot-hub-jurisdiction.md).

## Prepare once

Use the repository's pinned Node, pnpm, Go and Xcode versions. From the checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:web
pnpm pilot:tls
pnpm pilot:tls:trust
```

TLS setup creates a private server key and a 90-day certificate restricted to
`localhost`, `artifacts.localhost` and `launch.localhost`. The separate trust
command adds SSL trust for that exact server certificate to the current macOS
user's login keychain, not the system trust store. macOS may require interaction.
It is not a general certificate authority. Certificate validation stays enabled
in the browser, Node and runner; never click through a browser security warning.
Existing files are preserved rather than automatically replaced or rotated.

Register a GitHub OAuth application with these exact public addresses:

| Field | Value |
| --- | --- |
| Homepage | `https://localhost:8787` |
| Authorization callback | `https://localhost:8787/auth/callback/github` |

Then run the hidden-input configurator in an interactive terminal:

```sh
pnpm pilot:configure
pnpm pilot:preflight
```

Enter the OAuth client ID and secret there, never in chat, command arguments or
repository files. Internal authentication/abuse keys are generated locally.
Credentials, TLS, the database, objects and operator logs live beneath the
dedicated `BFB Pilot` directory in the user's Application Support directory.
`BFB_PILOT_STATE_DIR` can select a different dedicated absolute private directory
outside the repository, using its physical path without symlink ancestors.
The code refuses public, symlinked or malformed secret files and preserves
existing keys on retries. Configuration does not sign a human in or create an
owner. Preflight reports presence/validity only, not secret values.

## Run and initialize

```sh
pnpm pilot:start
```

Start performs local-only migrations and runs until stopped. Keep that terminal
or background session alive. It reports the complete private Worker log paths.
Another terminal can run:

```sh
pnpm pilot:status
pnpm pilot:bootstrap
```

Bootstrap creates only an unconsumed one-time verifier in an empty migrated
database and keeps its corresponding code in a private local file. It creates
no human, workspace, membership or browser session. A retry reconciles the same
code without extending its original expiry; it must not overwrite an existing
owner or consumed/expired setup. Use the reported code file only in the app's
first-owner form after real GitHub reauthentication.

Open [BFB](https://localhost:8787), sign in with GitHub, create the first workspace
with the operator code, and enroll a passkey on Account security. The human must
complete authenticator/OS interactions. Continue through the existing runner
enrollment, project and exact-checkout registration flows. Provider setup uses
its preview/approval transaction; unknown provider versions remain unavailable
for tracked launch. The pilot does not bypass those checks.

The Artifact Worker serves `https://artifacts.localhost:8788`. The launch host
`https://launch.localhost:8787` shares the Control listener but remains a separate
hostname. These are loopback addresses: this setup alone is not proof of access
from a phone or another machine. Independently reachable HTTPS and an actual
second-client test remain required for the remote pilot.

## Experimental Claude permissions and supervision

[ADR 0013](adr/0013-claude-autonomy-and-root-supervision.md) separates two
independent choices in the exact-pinned Claude candidate. Neither changes
historical production-provider certification.

- **Manual permissions** remain the default for existing and new profiles.
- **Autonomous — full local-user access** must be selected explicitly on an
  interactive, standard Claude profile. It requests
  `--dangerously-skip-permissions`, including exact-session resume. It is not
  workspace confinement: Claude can use the files and tools available to the
  local OS user, subject to OS and provider-managed restrictions. Existing
  project policies, runner grants and BFB business-action authorization still
  apply. The new runner capability must be advertised; an older runner rejects
  the launch instead of silently reducing or expanding permissions.

Separately, the candidate's root-supervision mode accommodates Claude's
legitimate detached children. BFB still verifies the signed supervisor, exact
live provider root, authenticated checkout lock and current MCP caller before
granting run access. Unrelated callers, replaced processes and previously
closed executions do not regain access. Skipping permission prompts alone
does not repair a containment error.

Interrupt and terminate address only the original provider process group.
They do not prove that every background child stopped. When the root exits,
MCP authority closes and the checkout remains occupied because polling cannot
prove the absence of unobserved descendants. **Automatic release and legacy
local recovery are deliberately denied for root-supervised executions.** The
separate operator-acknowledged recovery path is not yet implemented. Do not
delete lock records, edit the database, or retry recovery to bypass this hold.
A fresh test requires a separately registered checkout and a new execution;
never revive the old run.

This is an experimental compatibility mode, not a macOS sandbox or completed
live-provider acceptance. Keep these cleanup limits visible when testing the
candidate, whether its permission profile is manual or autonomous.

## Stop, recover and test

```sh
pnpm pilot:stop
pnpm pilot:start
pnpm pilot:status
```

Stop addresses only the supervisor identified by its private instance record,
not arbitrary processes by port or a stale PID. D1, R2, keys and configuration
remain on disk. A stale/uncertain supervisor record fails visibly; do not delete
state or kill an unrelated process to make startup appear successful.

```sh
pnpm test:pilot
pnpm pilot:smoke
```

The tests exercise configuration, denied surfaces and the compiled first-run UI.
The stock-Worker smoke uses its own private synthetic OAuth bindings and empty
durable store, tests restart persistence, and creates no fake browser login or
human. It is operational evidence, not completed GitHub authentication or a live
provider certificate. It requires the pilot ports to be free and trusted local
TLS. Full package acceptance still requires exact clean-checkout L07 and
repository gates plus real launch, scoped MCP, attention, result and same-run
resume evidence.

Artifact viewing, artifact approval and discussions are disabled in both server
boundaries and the UI. Existing view grants cannot bypass that hold. Context,
progress, human attention, explicit results and artifact publication retain their
ordinary authority checks. The deferred surfaces and eight mandatory beta
requirements remain tracked in [the MVP plan](../mvp.plan.md).
