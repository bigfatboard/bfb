# WP-C04 permission matrix

Tested commit: `f0b94285597928dd8fed4251f24c269470c5a748`

| Operation | Owner | Member | Reviewer | Unauthenticated |
| --- | --- | --- | --- | --- |
| Create invitation | allow | deny | deny | deny |
| Accept matching invitation | allow | allow | allow | deny |
| Change a non-owner member/reviewer role | allow | deny | deny | deny |
| Remove a non-owner member/reviewer | allow | deny | deny | deny |
| Remove or demote an owner through ordinary membership routes | deny | deny | deny | deny |
| Read workspace-authorized state | allow | allow | allow | deny |

The route workspace is authoritative. Request JSON cannot select a different workspace. An invitation conveys only its server-assigned workspace and role, and acceptance requires the exact normalized verified email.

Ownership changes require a separate step-up-authorized flow. The ordinary role and removal commands reject every owner target, which preserves the final-owner invariant without exposing an unguarded ownership mutation.
