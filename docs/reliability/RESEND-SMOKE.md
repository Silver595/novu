# Resend workflow smoke test

The smoke suite exercises one synthetic `interview-scheduled-smoke` workflow through the Community API, BullMQ, MongoDB, the worker, the built-in Resend SDK adapter, and the legacy webhook service. A loopback HTTP simulator stands in for Resend. It checks the request and issues a synthetic provider ID. The suite generates its own signed delivery callback. The baseline source revision and previous setup checks are in [BASELINE.md](../architecture/BASELINE.md).

## Set up the test services

Use Node 22.23.5 and pnpm 11.28.2. From the repository root, install dependencies and build the services.

```sh
pnpm install --frozen-lockfile
NX_NO_CLOUD=true NX_DAEMON=false pnpm nx run-many --target=build --projects=@novu/api-service,@novu/worker --parallel=3
pnpm --filter @novu/webhook build
docker compose -f docker/local/docker-compose.yml up -d mongo redis clickhouse
```

The suite uses the checked-in test configuration. Run it against disposable local MongoDB, Redis, and ClickHouse with no other Novu process consuming those queues. The existing API E2E setup drops the test MongoDB database and truncates the test ClickHouse tables. The API defaults to port 1336. The suite starts the API, starts the built worker and webhook as child processes, and binds the test listeners to loopback. The worker, webhook, and HTTP simulator use ephemeral ports. No dashboard or S3 endpoint is needed for this email without attachments. Validation used standalone MongoDB 8.0.17, Redis 7.2.17, and ClickHouse 24.3.18.7 because Docker daemon access was unavailable.

## Run the tests

From the repository root:

```sh
cd apps/api
export NODE_ENV=test NOVU_ENTERPRISE=false CI_EE_TEST=false CLERK_ENABLED=true
export NEW_RELIC_ENABLED=false LOG_LEVEL=warn LAUNCH_DARKLY_SDK_KEY=''

pnpm exec mocha --no-config --timeout 30000 --require @novu/testing/swc-register --exit \
  --file e2e/setup.ts src/app/shared/framework/idempotency.e2e.ts

export RESEND_SMOKE_API_KEY="re_smoke_$(node -p 'require("node:crypto").randomUUID()')"
export RESEND_SMOKE_WEBHOOK_SECRET="whsec_$(node -p 'require("node:crypto").randomBytes(32).toString("base64")')"

pnpm exec mocha --no-config --timeout 100000 \
  --require ./e2e/smoke/worker-preload.cjs --require @novu/testing/swc-register --exit \
  --file e2e/setup.ts e2e/smoke/resend.smoke.ts

unset RESEND_SMOKE_API_KEY RESEND_SMOKE_WEBHOOK_SECRET
```

Use the generated values only for this simulator. The suite submits the API key via the integration credentials and configures the signing key in `configurations.inboundWebhookSigningKey`. The worker uses the SDK's `RESEND_BASE_URL` to reach the loopback simulator. The setup removes the fixture email integrations from the test environment so Resend is its only email provider. The worker uses `NODE_ENV=dev` with the test connection settings because Novu's base email handler skips HTTP sends in test mode. The API remains in test mode to create a disposable development environment through the existing test fixtures. The webhook has signature verification explicitly enabled.

## Trace the result

| Checkpoint | Observed result |
| --- | --- |
| Trigger | `POST /v1/events/trigger` returns HTTP 201 with `acknowledged: true`, `status: processed`, and the submitted transaction ID. The response follows workflow queue insertion. |
| Subscriber processing | The worker creates the notification and step jobs in MongoDB. Jobs are stored before the first dispatch. |
| Email | The real adapter submits `POST /emails` with the configured sender, synthetic recipient, rendered subject, and rendered HTML. The simulator validates the environment-supplied mock key and returns an ID. |
| Provider acceptance | MongoDB stores the provider ID in the email message's `identifier` and the step reaches `completed`. The message status reads `sent`. The suite logs synthetic transaction, notification, message, job, and provider IDs. |
| Signed callback | A valid `email.delivered` callback returns HTTP 201 and appends a `Success` execution detail with `webhookStatus: delivered`, linked to the same message and transaction. The message status remains `sent`. |
| Signature rejection | A missing signature and a signature submitted with altered raw bytes both return HTTP 401 and create no delivery record. |
| Replay | Sequential and concurrent retries of the same authenticated Svix ID return HTTP 201 and retain one detail. A distinct signed bounce for the same message creates its own detail. |

## Worker crash at the persistence handoff

The test pauses the first worker after `StoreSubscriberJobs` persists the chain and before `AddJob.execute` dispatches it. It records the subscriber queue ID, transaction and environment IDs, subscriber IDs, notification ID, and original jobs. The first SIGKILL causes BullMQ to stall and redeliver the same subscriber job. The replacement worker claims the existing root, leaving it `queued` with `awaitingEnqueue: true`. The test kills that worker before Redis accepts the root.

The harness submits three fresh copies of the subscriber work concurrently, then submits a fourth after completion. All copies converge on the original notification and original job IDs. The simulator observes one send, and MongoDB holds one correlated email and one send execution detail. The suite also races two initial subscriber jobs before either MongoDB notification write, lets MongoDB reject a root insert and verifies that a retry reuses the persisted tail, and verifies two recipients and two ordered email steps per recipient in a separate API trigger.

The callback case submits a valid delivery, checks callback replays, and then uses a temporary MongoDB collection validator to reject a distinct bounce write. The rejected write produces an HTTP error and adds zero records. After the validator is restored, concurrent retries write one bounce detail. See [failure modes and recovery](FAILURE-MODES.md) for operational limits.

## Resend acceptance before persistence

The simulator retains the first response for an idempotency key and tracks accepted emails separately from HTTP attempts. A worker preload pauses the real process after the provider response and before MongoDB saves the ID. The harness kills the process, expires the test lease, and runs replay deliveries. It also exercises socket timeout after acceptance, HTTP 500, HTTP 429, a provider conflict, and MongoDB rejecting the acceptance write. The time-expiry case removes the simulator's key record and ages the durable first-attempt timestamp past Resend's 24-hour window.

The baseline reproduced two accepted emails. With the fix, two replacement workers receive competing deliveries of the original email job. An eligible replay uses the same key and recovers the original provider ID. MongoDB retains one correlated message and the simulator records one accepted email. A socket timeout after acceptance also results in one acceptance across two HTTP attempts. Expired and changed requests are held without resubmission. Signed callbacks before correlation return 503 and can be replayed after the provider ID is stored. See [failure modes](FAILURE-MODES.md) for the difference between acceptance and delivery and the conditions requiring operator reconciliation.

## Verification

The Phase 3 local run on November 19, 2026 used source revision `7ecdbd97c1`. All 13 smoke cases passed against MongoDB, Redis, ClickHouse, and the loopback Resend simulator. The Community API, worker, and webhook builds passed.

```sh
pnpm --filter @novu/worker test
pnpm --filter @novu/worker test:e2e
pnpm --filter @novu/providers test --run resend.provider.spec.ts
pnpm --filter @novu/application-generic exec vitest run src/usecases/create-notification-jobs/create-notification-jobs.spec.ts
pnpm --filter @novu/webhook test:e2e

(
  cd apps/api
  pnpm exec mocha --no-config --timeout 15000 --require @novu/testing/swc-register --exit \
    src/app/shared/framework/idempotency.interceptor.spec.ts src/app/shared/framework/idempotency-http-error.spec.ts
)

(
  cd apps/webhook
  MONGO_URL=mongodb://127.0.0.1:27017/novu-webhook-security-test PORT=1488 \
    pnpm exec mocha --no-config --timeout 10000 --require @novu/testing/swc-register --exit \
    --file e2e/setup.ts src/webhooks/e2e/webhook-security.e2e.ts
)
```

The worker suite passed 449 cases, worker E2E passed one, the provider spec passed three, and the workflow-planning spec passed 19. The API idempotency suite passed 12 E2E and nine unit tests. The dedicated webhook security suite passed all ten with its local MongoDB fixture. The full legacy webhook suite completed with 13 passes and two SendGrid response assertions failing on string versus object serialization. Both failures reproduced using the archived webhook source from `bf777e64ff`.

## Live Resend verification

The live verification on source revision `7ecdbd97c1` is blocked. The local session had no supplied live credentials, approved sender or recipient, send authorization, or approved webhook ingress. The local services and signing checks use generated fixture credentials. There is no live HTTP response, real provider ID, callback receipt, or observed recipient delivery for this run.

### Before the send

1. Use a dedicated Novu development environment with one active Resend email integration and a single-step smoke workflow. Supply the Resend API key through the approved secret channel. Confirm the From address and the authorized test recipient before triggering. Resend offers labeled test recipients that generate provider-side simulated delivery or bounce events and count against quota. A signed callback from a Resend test address verifies the provider-to-Novu path. An approved mailbox is needed to verify delivery to that mailbox. [Resend test recipients](https://resend.com/docs/dashboard/emails/send-test-emails)
2. Use the already approved HTTPS callback endpoint for the legacy webhook service at `/webhooks/organizations/<organizationId>/environments/<environmentId>/email/<integrationId>`. Set `IS_LEGACY_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED=true` for the webhook service, and store that endpoint's signing secret in the Resend integration's `configurations.inboundWebhookSigningKey`. Confirm the route preserves raw request bytes and the three Svix headers. Verify that an unsigned request and an invalid signature return HTTP 401 for this integration before accepting Resend events. Keep the route private if this check fails or public ingress is unavailable. [Resend signature verification](https://resend.com/docs/webhooks/verify-webhooks-requests)
3. Check API and worker health and their MongoDB and Redis connections. Verify that the worker uses the live Resend host and a mode that permits outbound email. The Mocha smoke harness always routes email to loopback. Set `check: false` when configuring the integration through the API. The provider check itself submits an email and would consume the one-send budget.

### Capture and replay

1. Trigger once with a unique transaction ID and a searchable, non-personal subject marker. Record the UTC submission time and Novu response. Confirm one notification intent for the subscriber and workflow, and record the original job IDs and sole email message ID.
2. In the matching Resend account, use **Logs** to capture the send HTTP status and provider-assigned email ID. Compare that ID with the Novu message's `identifier` and verify the email job reached `completed`. Record provider acceptance separately from the delivery result. [Resend request logs](https://resend.com/changelog/logs-api)
3. In Resend **Webhooks**, find the corresponding delivery attempt. Match its `data.email_id` to the stored identifier, confirm Resend marks Novu's response successful, and verify one linked Novu execution detail with `webhookStatus: delivered`. If safe in that environment, replay the original webhook message from Resend and verify the detail count stays at one. Record the original and replayed Svix IDs privately to verify the deduplication identity. Use simulation for bounce and destructive cases unless another provider send is explicitly authorized. [Resend webhook retries and replays](https://resend.com/docs/webhooks/retries-and-replays)

Keep the actual IDs and response evidence in a restricted incident or test record. Use placeholders in the repository and omit recipient information, credentials, signatures, and raw provider payloads.

## Limits to production use

- The legacy webhook accepts callbacks when the Resend signing key is absent. Keep ingress private until signing-key presence and signature rejection are verified in the deployed configuration. The Community Compose manifest does not start the webhook service.
- Older callback rows created before the change have no replay identity. Signed Resend callbacks before provider-ID persistence return a retryable 503. Ordering of different callback event types remains unverified.
- BullMQ bounds stalled-job recovery. The second injected crash uses fresh subscriber deliveries to verify the stored state remains recoverable. Provider timeouts after acceptance are exercised against the simulator. Redis durability under node loss remains open.
- The local delivery callback is simulated. Real Resend acceptance, account limits, verified-domain behavior, ingress, and actual delivery still require an authorized test account and endpoint.
