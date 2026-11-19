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
| Replay | Resubmitting the same valid callback ID and signature returns HTTP 201 and writes a second delivery detail. The simulator still observes one send for that transaction. |

## Worker crash at the persistence handoff

The test preloads a hook in one worker process for one synthetic transaction. The hook pauses at `AddJob.execute` after `StoreSubscriberJobs` has saved the jobs and before dispatch. At that checkpoint, the test reads one MongoDB notification and a pending job, with zero email messages and zero provider requests for the transaction. It sends SIGKILL to the paused process, starts a fresh worker without the hook, and waits for BullMQ's stalled-job check. The verified recovery case took about 70 seconds, including worker startup.

The replacement worker replayed subscriber processing and completed the email. MongoDB held two notifications for the same transaction. The first jobs remained pending, and the replay created a new completed job chain. The simulator accepted one request, and MongoDB contained one correlated email message. A restart recovered the send in this specific window and left a duplicate persisted intent and stranded jobs. The test covers a crash before dispatch. The result makes no claim about a crash after provider acceptance, Redis data loss, or exactly-once delivery.

## Limits to production use

- The legacy webhook accepts callbacks when the Resend signing key is absent. Keep ingress private until signing-key presence and signature rejection are verified in the deployed configuration. The Community Compose manifest does not start the webhook service.
- Callback IDs are not deduplicated in the observed path. Activity consumers should expect repeated delivery details. Callback ordering and early callbacks before provider-ID persistence remain unverified.
- The restart test exercises a recoverable Redis stall and exposes duplicate persisted intent. Provider timeouts after acceptance and Redis durability under node loss remain open.
- The local delivery callback is simulated. Real Resend acceptance, account limits, verified-domain behavior, ingress, and actual delivery still require an authorized test account and endpoint.
