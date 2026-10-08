# A02 permission matrix

Minimum workspace role per attention kind (frozen in
`ATTENTION_KIND_ROLES` and the `required_role` column). Every answer and
resolve rechecks membership, authorization epoch, project access, and this
role; an answer records a decision and grants no authority.

| Kind | Required role | Owner | Member | Reviewer |
| --- | --- | --- | --- | --- |
| clarification | reviewer | answer | answer | answer |
| review | reviewer | answer | answer | answer |
| blocker | member | answer | answer | `forbidden` |
| credential | owner | answer | `forbidden` | `forbidden` |
| capability | owner | answer | `forbidden` | `forbidden` |
| destructive_action | owner | answer | `forbidden` | `forbidden` |

Proven by: `packages/domain/test/attention.test.ts` (role table, reviewer
clarification vs credential matrix, revocation, no-grant), the harness
`permission_matrix` recording (reviewer review ok; reviewer/member
credential `forbidden`; owner credential ok), route 403s, and the Playwright
reviewer flow. Cross-project requests stay hidden (`not_found`/empty list)
for readers without the project grant, including reviewers.
