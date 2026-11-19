# Notification failure modes and recovery

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

## Resend submission and uncertain outcomes

On `8774b492ec`, the local simulator accepted two distinct sends for transaction `739be707-2f33-481d-9a3f-9e301ad28591` and email job `cc08e7f45952c2b76650df92` after a worker was killed before saving the first provider ID. The simulator assigned `6c6b92d1-1fc3-4e50-8dad-683f707635eb` and `3c2a94bd-e6b5-4a80-ba8c-f6e0434983f9`. MongoDB retained two messages for that same job, one without an identifier. Redis replay reacquired the stale MongoDB lease and ran the email step again. The baseline adapter omitted an idempotency key.

### Persistence boundary

1. BullMQ delivers the email step and `RunJob` claims it in MongoDB. The existing running lease and heartbeat fence live workers. BullMQ may redeliver a stalled job.
2. The worker reserves one message for the Resend step. It uses the same message ID to render reply-to addresses on a retry. Existing legacy Resend messages with a provider ID can resume without sending. Legacy messages without a provider ID are held for inspection because they may have been sent without a key.
3. After rendering, a MongoDB conditional write reserves the attempt before HTTP. The document stores the first-attempt time, attempt budget and a SHA-256 fingerprint of the request and integration credential configuration. This record stays on the existing message, with no new collection or migration. The worker will hold when the integration or prepared request changes. The key uses the environment and email-job IDs and contains no recipient address.
4. Installed SDK 6.0.3 accepts an `idempotencyKey` option and sends it as the HTTP `Idempotency-Key` header. Resend documents a 24-hour window and permits up to 256 characters. Within that window a matching request replays the original ID. A different request under the same key can return a conflict. [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).
5. The worker saves the provider ID before the send detail and outbound message webhook. It repeats a failed MongoDB write once using the same observed ID. If both writes fail, the durable attempt remains unresolved and the workflow records uncertainty if storage permits. An already saved ID fences later provider submissions even if the job was never marked complete.
6. The worker records its step outcome in MongoDB and the step-run history. Provider acceptance supplies an ID. Recipient delivery is recorded only when a correlated callback reports it. A crash after saving the ID can leave the supplementary send detail or outbound message webhook absent.

### Retry decisions

| Outcome | Behavior |
| --- | --- |
| Network timeout, SDK connection error, 500, or a concurrent idempotency request in progress | One bounded inline retry with the same key and fingerprint after a short pause. Each call has a 15-second deadline. An eligible BullMQ redelivery can reuse remaining budget. |
| First request returns 429 or a classified definitive rejection | Record rejection and halt provider attempts. A later request rejection cannot rule out acceptance of an earlier attempt. The SDK error response does not expose `Retry-After` to this worker path. |
| Same key rejected for conflicting content, unknown response, or a changed request or integration | Keep the outcome uncertain and retain the original message and attempt. A changed request is held before HTTP. |
| First attempt at least 23 hours old, clock earlier than the recorded first attempt, or three reservations consumed | Hold without submitting another request. The local cutoff leaves a one-hour margin within the documented provider window. |
| Valid signed callback arrives before correlation is saved | Return HTTP 503 for Resend so the event can be retried. Once the provider ID is stored, the callback correlates and retains its existing replay deduplication. |
| Valid signed callback arrives after a terminal uncertain outcome with no stored provider ID | Remain unresolved and return HTTP 503. Confirm the provider ID in authorized Resend records and verify the matching Novu attempt before reconciliation. Replay the provider callback once the identifier is known. Never infer acceptance or resend from an unmatched event or a missing detail alone. [Webhook retries and replays](https://resend.com/docs/webhooks/retries-and-replays). |

The worker reserves at most three provider requests per message and makes at most two per execution. A failed workflow has no automatic indefinite retry. Operator reconciliation is required after an uncertain terminal result, expired window, or changed request. An operator can inspect the message ID, job ID, attempt metadata and Resend logs to distinguish accepted, rejected and unresolved outcomes before taking action. The guarantees assume retained MongoDB records, consistent clocks and a single provider idempotency scope. Live Resend, mixed-version workers, Redis data loss and SQS replay were outside this verification.

### Reconcile an uncertain Resend attempt

1. Capture the organization, environment, transaction, email job, local message, integration, and existing provider ID if present. Note `data.resendDelivery.firstAttemptAt` in UTC, the reserved attempt count, and the recorded error or hold reason. Inspect the affected message and job within their tenant scope. Leave the attempt identity and deadline intact.
2. If the message has a provider ID, look it up in the Resend account used by the integration. Compare the send time, From address, recipient, and subject with the Novu record. Confirm delivery, delay, or bounce from the provider's event timeline. [Resend email lookup](https://resend.com/docs/api-reference/emails/retrieve-email)
3. If the provider ID is missing, locate the corresponding `POST /emails` in Resend **Logs** using the UTC attempt interval, account, and request details. Match the idempotency key if the record exposes it. Check all matching attempts before classifying a rejection. A later failure or an absent log does not resolve an earlier ambiguous attempt. If the evidence identifies exactly one acceptance, retain its provider ID and the matching evidence privately. An ambiguous or missing match stays unresolved. [Resend request logs](https://resend.com/changelog/logs-api)
4. When acceptance is confirmed but the identifier is absent, escalate for an approved, audited repair of the existing message. Require the exact tenant and job, an empty identifier, and a provider ID with no conflicting ownership. This checkout has no automatic backfill or operator command for that repair. Refresh the record after any approved repair and confirm correlation before replaying a callback. Preserve the job's recorded outcome as execution history. Leave a confirmed acceptance in place even if supplementary send activity is missing.
5. Inspect Resend **Webhooks** for the email ID. A delayed delivery or callback failure does not authorize another send. For repeated 503 responses, resolve the correlation first. For exhausted retries, restore the endpoint, re-enable it if Resend disabled it, and replay the original callback from the dashboard. Verify its response and the execution-detail count for that event. Resend documents the immediate attempt and seven scheduled retries, with the final two gaps at 10 hours each. This schedule and dashboard replay remain unverified against the live account for this checkout. [Resend retry schedule and manual replay](https://resend.com/docs/webhooks/retries-and-replays)

## Callback recovery contract

The legacy Resend endpoint authenticates the raw request before using its signed `svix-id`. MongoDB deduplicates writes using an identity derived from organization, environment, integration and Svix ID. Distinct delivery and bounce events for one message retain separate records. A write failure returns an error and a later authenticated retry can insert the detail. Requests without a verified signed ID retain legacy behavior. Keep this endpoint private until deployment signing configuration is verified.

Use the callback's `webhookStatus` to identify the delivery outcome. The adapter maps `email.delivery_delayed` to `delayed`. The legacy execution-detail mapper falls back to a generic `Success` for that value, so the generic status alone cannot establish delivery. This mapping was confirmed in source and the live delayed event remains unverified.

See the [Resend smoke runbook](RESEND-SMOKE.md) for the commands and test scope.
