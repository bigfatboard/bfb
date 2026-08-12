# WP-C03 step-up contract

Tested commit: `ec75d9894b76312a894dd72cee7e56af5cc14f3b`

`StepUpAction` binds a proof to:

- action name;
- optional client and resource;
- optional workspace, project, task, and target identifiers;
- an exact sorted scope set;
- authorization epoch;
- exact expiry; and
- the human who completed the user-verifying assertion.

Proof lifetime is positive and at most 15 minutes. Consumption rejects missing, expired, already-consumed, or boundary-mismatched proofs. The conditional D1 update writes a unique consumption stamp, and the post-commit ownership check permits only the winning consumer to continue.

Consumers must copy the proof's exact action fields and expiry into the authority they create. Downstream authority cannot outlive the proof that authorized it.
