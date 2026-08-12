# WP-C08 work-record matrix

Tested commit: `8217c75a78b2494320ebe053cf19fe17c9b89f14`

| Surface | Authority and invariant | Retained proof |
| --- | --- | --- |
| Tasks | Project access is checked on reads and mutations; human routing requires an active permitted member; agent-profile routing requires the effective project policy | Domain and route negative tests cover cross-project reads, restricted members, stale versions, routing, and proposals |
| Context | Human-only items never enter an agent view; every agent delivery binds the immutable context version to a run or OAuth delegation/client | Two context versions and four delivery rows remain after the real Workerd run |
| Runs | Creation snapshots workspace, project, repository, and agent-profile versions; later policy changes cannot rewrite the snapshot | One immutable snapshot remains and a direct update is rejected by D1 |
| Executions and sessions | Execution state follows allowed transitions; process/session end cannot submit or accept a result | The runtime ends one execution while its run result remains `open` |
| Dependencies, links, comments, and snapshots | Reads are project-scoped and paginated; reviewer comments are allowed; mutations use the Hub command path | Route tests exercise authorized reads, missing access, pagination, and reviewer behavior |
| Agent commands | MCP and web transports share command handlers; comments and progress retain distinct command names; delegated agents cannot change task routing | Handler-path tests cover the actual MCP tool calls and routing rejection |
| Projections | Project lanes and Needs Now ordering are deterministic; Needs Now queries eligible P0/P1 work directly and returns at most three items | Projection tests include urgent work beyond the ordinary first page |
| Serialization | Concurrent task and run changes execute through one WorkspaceHub Durable Object | Two independent Workers each produce one commit and one `stale_version`; the final cursor is 14 |

The real runtime result retained task state `active`, run result state `open`, execution state `ended`, one snapshot, one provider session, two context versions, four deliveries, fourteen semantic events, and migration head `0012_work_records.sql`.
