# Subscriber dispatch and callback recovery

## Reproduced failure

On baseline `bf777e64ff`, Redis redelivered subscriber queue job `2` for transaction `6ffc9f68-ca4c-4218-837a-bf736c0fa8fe` after SIGKILL. Original jobs `6afe5dba2b5e35a4f0557038` and `6afe5dba2b5e35a4f0557039` stayed pending. The replay inserted another notification and completed two new jobs. The simulator observed one provider request. The subscriber worker bypasses the transaction check in the workflow-trigger worker. Its create path previously chose new MongoDB IDs for the notification and each step on every run.

## Subscriber recovery contract

- Scope the intent to organization, environment, workflow, subscriber and transaction. Distinct recipients sharing a transaction retain distinct intents.
- The existing MongoDB primary-key constraint arbitrates concurrent inserts. The job chain uses stable IDs and writes tail first. The tail pins the ordered step identities and the root appears only after all steps are written.
- A replay with a persisted root dispatches that root. A pending root transitions atomically to queued with `awaitingEnqueue`. A lost enqueue acknowledgment can be retried with the same job ID. Terminal and running roots are never reset by subscriber replay. Existing BullMQ job deduplication and MongoDB execution claims fence dispatch and execution respectively.
- If a worker dies during the chain write, matching retries can fill the missing prefix. A changed ordered step plan conflicts at the tail and halts safely. In-place workflow changes during a partial first write can therefore require inspection of the original plan. Fully persisted legacy chains can be reused. This change performs no cleanup of historical duplicates or partially written legacy chains.
- BullMQ has a bounded stalled-job allowance. Recovery after the transport exhausts that allowance requires another delivery of the original subscriber-processing work. Capture the transaction, environment, subscriber, notification, queue and root job IDs before intervention. Resubmitting through the public trigger is a different path and can hit transaction deduplication. Provider acceptance followed by a crash before recording the response remains an uncertain delivery outcome. Recovery assumes the job chain is still retained. SQS recovery and mixed-version worker rollouts were outside this BullMQ verification.

### Correlation from the synthetic regression

| Record | ID |
| --- | --- |
| Transaction | `79e07606-12ca-4564-8d3c-2685b73205f5` |
| Environment | `6afe61472276a17ea11b387c` |
| Subscriber | `interview-smoke` (MongoDB `6afe6152aaae1e1c65a4b6f6`) |
| Original BullMQ subscriber job | `2`, redelivered with the same ID |
| Fresh replay jobs | `3`, `4`, `5` |
| Reused notification | `79d6a445c4f6866f7a45069f` |
| Original jobs after recovery | `2a04038a0d87b98567a7a444`, `f572abe77c8296ee0f64b4cd`, both completed |
| Persisted email | `6afe619f7fcf4101e55ee70f` |
| Simulated Resend acceptance | `29bde244-8c9f-4057-9428-43aaf302537a` |
| Send execution detail | `6afe619f7fcf4101e55ee716` |

## Callback recovery contract

The legacy Resend endpoint authenticates the raw request before using its signed `svix-id`. MongoDB deduplicates writes using an identity derived from organization, environment, integration and Svix ID. Distinct delivery and bounce events for one message retain separate records. A write failure returns an error and a later authenticated retry can insert the detail. Requests without a verified signed ID retain legacy behavior. Keep this endpoint private until deployment signing configuration is verified.

See the [Resend smoke runbook](RESEND-SMOKE.md) for the commands and test scope.
