# WP-C07 project permission matrix

| Operation | Owner | Member | Reviewer | Restricted project rule | Step-up rule |
| --- | --- | --- | --- | --- | --- |
| List/read workspace-visible project | Allow | Allow | Allow | Not applicable | None |
| List/read restricted project | Allow only with explicit grant | Allow only with explicit grant | Allow only with explicit grant | Hidden as not found without grant | None |
| Create restricted project | Allow | Deny | Deny | Creator receives an explicit grant | None |
| Create workspace-visible project | Allow | Deny | Deny | Not applicable | Exact action and payload proof required |
| Update project metadata | Allow with project access | Deny | Deny | Existing explicit grant required | None unless visibility widens |
| Change restricted project to workspace-visible | Allow with project access | Deny | Deny | Existing explicit grant required | Exact action, project, version, and payload proof required |
| Grant project access | Allow with project access | Deny | Deny | Target human is action-bound | Exact action, project, and human proof required |
| Revoke project access | Allow with project access | Deny | Deny | Revocation applies on the next request | None |
| Update workspace or project policy | Owner only | Deny | Deny | Project policy also requires project access | Exact policy version and settings proof required |
| Report repository configuration or manage agent profiles | Owner only | Deny | Deny | Repository config can only tighten policy | None |

Browser mutations reject bearer credentials and require the session-bound CSRF token. Sensitive widening proofs are one-time and are bound to the authenticated human, retained authorization epoch, workspace, optional project, exact action, and target digest before the Hub command runs.
