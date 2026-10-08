# WP-V03 Review UI browser flow

Real Chromium drove the task-sheet Review surface against the shared fixture server.
Every row below was observed in this run.

| Step | Observation |
| --- | --- |
| Seed state | v2 unapproved with one historical v1 approval |
| Review timer | explicit start from the Review surface; stop control appears |
| Approve | exact version approved; second review recorded |
| Authority | run still open and task still ready after approval |
| Live publish | new version 01YWFQ9Y published mid-review |
| Conflict | stale approve rejected with an explicit reload action |
| Recovery | reload shows the live version unapproved; fresh approve lands |
| Hostile note | script payload visible only as inert text |
| Preview frame | exact sandbox wiring; no artifact bytes in trusted DOM |
| Presence | browser-open time never presented as review time |
