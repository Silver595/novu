# Novu notification infrastructure baseline

## 1. Source and workspace

The baseline was reviewed against the clean fork checkout at [`c51a1932dabd725bdb75c39da7affebc141b3de1`](https://github.com/novuhq/novu/commit/c51a1932dabd725bdb75c39da7affebc141b3de1), 38 commits past the latest stable [`v3.20.0`](https://github.com/novuhq/novu/releases/tag/v3.20.0) tag at `083bdfe3cd999b7a6189adb7b0c8805dca4adbd3`. At inspection, `next`, `origin/next`, and `upstream/next` matched. The API, worker, and dashboard manifests report `3.20.0`. Source links below use the inspected commit.

GitHub verified that `origin` (`https://github.com/Silver595/novu.git`) is a fork of `upstream` (`https://github.com/novuhq/novu.git`). The GitHub CLI authenticated with admin access to the fork. This document is tracked on `docs/notification-baseline`.

The original design requirements specify durable acceptance, application isolation, and delivery tracking. This fork retains Novu's existing stack and starts with one development email workflow.

## 2. Layout, technology, and licensing

| Area | Source and technology |
| --- | --- |
| API and administration | [`apps/api`](https://github.com/novuhq/novu/tree/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/api) runs NestJS on Express. It provides event, workflow, subscriber, integration, and activity endpoints. [`apps/dashboard`](https://github.com/novuhq/novu/tree/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/dashboard) is the React administrative UI. |
| Job execution | [`apps/worker`](https://github.com/novuhq/novu/tree/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/worker) runs a separate NestJS process. [`libs/application-generic`](https://github.com/novuhq/novu/tree/c51a1932dabd725bdb75c39da7affebc141b3de1/libs/application-generic) contains shared use cases, queues, rendering, and instrumentation. BullMQ with Redis is the default. SQS and EventBridge also appear in dispatch code. |
| Data | [`libs/dal`](https://github.com/novuhq/novu/tree/c51a1932dabd725bdb75c39da7affebc141b3de1/libs/dal) contains MongoDB/Mongoose collections and repositories, including workflows, notifications, subscribers, jobs, messages, integration credentials, and execution details. ClickHouse backs analytical records when configured. |
| Providers and webhooks | [`packages/providers`](https://github.com/novuhq/novu/tree/c51a1932dabd725bdb75c39da7affebc141b3de1/packages/providers) includes the Resend SDK adapter. [`apps/webhook`](https://github.com/novuhq/novu/tree/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/webhook) handles legacy provider delivery callbacks. `apps/inbound-mail` serves a separate inbound mail path. |
| Tooling and deployment | TypeScript, Nx, pnpm workspaces, Biome, Mocha for backend tests, and Vitest for provider tests. [`docker/local`](https://github.com/novuhq/novu/tree/c51a1932dabd725bdb75c39da7affebc141b3de1/docker/local) supplies source-development dependencies. [`docker/community`](https://github.com/novuhq/novu/tree/c51a1932dabd725bdb75c39da7affebc141b3de1/docker/community) runs prebuilt community images. |

[`LICENSE-MIT`](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/LICENSE-MIT) applies to the open-source core and requires preserving the copyright and permission notice in copies or substantial portions. [`LICENSE-ENTERPRISE`](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/LICENSE-ENTERPRISE), [`EE-PACKAGES-LICENSE`](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/EE-PACKAGES-LICENSE), and the README establish separate restrictions for enterprise code. Review them before packaging or redistributing any deliverable. The enterprise terms restrict use, modification, redistribution, and commercial hosting. [`.gitmodules`](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/.gitmodules) points `.source` to a separate enterprise repository. Use the community path and review third-party package licenses when assembling distribution artifacts. The [API](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/api/package.json), [worker](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/worker/package.json), and [provider](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/packages/providers/package.json) manifests declare MIT. The [DAL manifest](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/libs/dal/package.json) declares ISC. Preserve applicable notices and reconcile package metadata with repository and distribution notices before packaging.

## 3. Request-to-delivery trace

This is the single-recipient, dashboard-managed email workflow path, traced in source.

1. `POST /v1/events/trigger` accepts `name` (workflow trigger identifier), `to`, `payload`, and optional `transactionId`. For the server-to-server test use `Authorization: ApiKey <NOVU_SECRET_KEY>`. Passport resolves a session for the API key. The controller builds its command with the session's environment and organization IDs, applies the event-write permission, and declares trigger-category throttling. Global DTO validation and body-parser configuration live in the API bootstrap. The rate-limit interceptor uses feature flags, so inspect effective enforcement in the selected deployment. Community API keys receive `ALL_PERMISSIONS` for the resolved session. [Community auth service](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/api/src/app/auth/services/community.auth.service.ts#L177). [Events controller](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/api/src/app/events/events.controller.ts#L52), [API-key strategy](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/api/src/app/auth/services/passport/apikey.strategy.ts), [API bootstrap](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/api/src/bootstrap.ts), [throttling interceptor](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/api/src/app/rate-limiting/guards/throttler.guard.ts).
2. `ParseEventRequest` resolves the environment-scoped workflow, checks workflow and recipient conditions, and awaits `WorkflowQueueService.add` before returning `acknowledged: true` with `status: processed`. Inspect the response body because other trigger outcomes can use an acknowledgment without a successful dispatch. The queue job carries the transaction ID and is grouped by organization. [Trigger parsing and dispatch](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/api/src/app/events/usecases/parse-event-request/parse-event-request.usecase.ts#L348), [queue backend configuration](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/libs/application-generic/src/config/queue-backend.ts).
3. `WorkflowWorker` calls shared `TriggerEvent`, which checks transaction ID reuse in the environment and dispatches multicast subscriber processing. `SubscriberProcessWorker` invokes `SubscriberJobBound`, which resolves and upserts the subscriber, evaluates preferences, creates the notification and builds step jobs. `StoreSubscriberJobs` stores the step jobs, records step-run data, then calls `AddJob` separately to dispatch the first step. [Workflow worker](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/worker/src/app/workflow/services/workflow.worker.ts), [trigger use case](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/libs/application-generic/src/usecases/trigger-event/trigger-event.usecase.ts), [multicast fan-out](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/libs/application-generic/src/usecases/trigger-multicast/trigger-multicast.usecase.ts), [subscriber binding](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/worker/src/app/workflow/usecases/subscriber-job-bound/subscriber-job-bound.usecase.ts), [notification creation](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/libs/application-generic/src/usecases/create-notification-jobs/create-notification-jobs.usecase.ts), [step storage](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/worker/src/app/workflow/usecases/store-subscriber-jobs/store-subscriber-jobs.usecase.ts#L28).
4. `StandardWorker` invokes `RunJob`. The use case checks cancellation, claims the MongoDB job, renews the running lease, and calls the channel handler. The email handler selects an integration, creates a message, renders subject/body/layout with Novu's template compiler, and sends through `MailFactory`. The existing Resend adapter calls the SDK with the rendered email and returns the provider's ID. The built-in integration delegates to that adapter through the [Resend handler](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/libs/application-generic/src/factories/mail/handlers/resend.handler.ts). The worker records a send execution detail and stores that ID on the environment-scoped message. [Standard worker](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/worker/src/app/workflow/services/standard.worker.ts), [job execution](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/worker/src/app/workflow/usecases/run-job/run-job.usecase.ts), [job repository](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/libs/dal/src/repositories/job/job.repository.ts), [email step](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/worker/src/app/workflow/usecases/send-message/send-message-email.usecase.ts), [template compiler](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/libs/application-generic/src/usecases/compile-email-template/compile-email-template.usecase.ts), [Resend adapter](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/packages/providers/src/lib/email/resend/resend.provider.ts#L90).
5. The separate webhook service captures the raw body. Its handler supports signature verification behind a flag that defaults to enabled. With a signing key configured, the Resend adapter verifies the raw bytes using Svix headers. Its verification method returns success when the signing key is absent, so the signed-callback test requires a configured key. The handler matches the provider ID against the message within the organization and environment and writes execution details for supported events such as delivery and bounce. Verify actual callback configuration and behavior in the community deployment. [Webhook bootstrap](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/webhook/src/bootstrap.ts), [webhook processing](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/webhook/src/webhooks/usecases/webhook/webhook.usecase.ts), [webhook execution details](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/webhook/src/webhooks/usecases/execution-details/create-execution-details.usecase.ts).

## 4. Capabilities to retain

Retain environment-scoped credentials, subscriber identity and preferences, dashboard-managed workflows, native channel rendering and integration selection, MongoDB repositories, the default BullMQ backend, job claims, execution details and activity views. The code also supports delayed steps and cancellation by transaction ID. Preserve cancellation checks and existing workflow-chain recovery. Trace logs, workflow and step runs, Pino request logs, and instrumentation support diagnosis. This checkout also writes scheduled and terminal step data through the newer StepRunV2 writer. Availability of specific activity views depends on deployment configuration. [Cancellation use case](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/api/src/app/events/usecases/cancel-delayed/cancel-delayed.usecase.ts), [analytical logs](https://github.com/novuhq/novu/tree/c51a1932dabd725bdb75c39da7affebc141b3de1/libs/application-generic/src/services/analytic-logs).

## 5. Product requirements still open

- A stable application event identity and a documented acceptance contract backed by demonstrated recovery.
- An event-only credential boundary for clients that should have fewer permissions than a native Community API key. Test cross-environment access, subscriber updates, and permissions for workflow, history, and integration endpoints.
- Provider failure classification, bounded email retries, handling for uncertain provider responses, and an observable recovery procedure.
- Verified delivery-state correlation, including signed callbacks, duplicate callback handling, terminal status mapping, and suppression.
- A client-side forwarding boundary tied to committed interview lifecycle state. Schedule version checks, reminder invalidation, explicit timezones, DST tests and results publication are later work.

## 6. Reliability risks and evidence

| Point | Source finding and open verification |
| --- | --- |
| API acknowledgment | A successful `processed` response follows queue insertion. MongoDB notification and step records are created later by workers. Redis persistence and failover determine whether the acknowledged item survives queue-node failure. Verify the actual Redis recovery-point objective. |
| Queue handoffs | Notification creation, job storage and first-step dispatch are separate operations. A crash or dependency failure between them could leave incomplete records. The workflow worker explicitly acknowledges SQS processing failures and describes that policy as matching BullMQ's attempt configuration. Run worker-kill and datastore outage tests against the default BullMQ path before choosing a recovery design. |
| Duplicate event intents | API idempotency is feature-gated and cache-backed. The API-key path scopes keys to the organization across its Novu environments. The interceptor uses a five-minute in-progress entry and a 24-hour result TTL, returns a conflict for in-progress requests, and rejects a conflicting body once a result exists. Test whether distinct applications need separate organizations or an application-scoped boundary. The worker separately checks `transactionId` with a job lookup scoped to the environment. Test simultaneous submissions, expiry, outage, and retry after an uncertain HTTP response. The lookup alone does not establish an atomic uniqueness guarantee. [Idempotency interceptor](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/apps/api/src/app/shared/framework/idempotency.interceptor.ts), [worker duplicate check](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/libs/application-generic/src/usecases/trigger-event/trigger-event.usecase.ts#L396). |
| Worker recovery | Running claims have a lease and heartbeat. A redelivered completed parent can resume a stranded child. Test competing workers, lease expiry, and crashes before first dispatch or after provider acceptance. Claims protect MongoDB state and do not atomically cover an external send. |
| Provider errors and retries | The adapter turns SDK errors into generic errors. The email step records a provider failure, and the worker's specialized backoff is for retryable webhook-filter errors. A queue retry ceiling of three does not establish retry behavior for Resend 429s, 5xxs, or timeouts. Resend offers a 24-hour idempotency window. The inspected send call has no explicit SDK-level idempotency option. [Resend idempotency](https://resend.com/changelog/idempotency-keys). |
| Delivery accuracy | Queue acknowledgment, notification stored, step queued, step running, and provider accepted mark distinct points in execution. Resend's returned ID supports correlation. A signed provider event can establish delivery or bounce. Capture the interval between provider acceptance and message ID persistence as a potential callback-correlation gap. Confirm suppression mapping and replay handling before exposing those states. An upstream canceled step is a workflow state. |
| Secrets and payloads | The trigger debug log includes the command, and worker execution details can include raw provider error data. Review effective redaction and retention, request limits, payload validation, template contexts and permissions with production-like settings. Keep participant data and meeting URLs out of smoke fixtures. |

## 7. Components to leave upstream-aligned

Keep the NestJS API, MongoDB data layer, BullMQ queues, scheduler primitives, workflow engine, template renderer, and the Resend adapter intact during the baseline. Keep commercial code out of the implementation and deployment plan. Track the smallest necessary patches in `docs/architecture/CUSTOMIZATIONS.md` when they exist.

## 8. Local setup and tests

From a confirmed checkout, use the release pin in [`.nvmrc`](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/.nvmrc) (Node 22.23.5) and [`package.json`](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/package.json) (pnpm 11.28.2). Older Node examples remain in the prose setup guides. [Contribution guide](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/CONTRIBUTING.md), [Docker guide](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/docker/Readme.md).

| Purpose | Repository-defined command or invocation |
| --- | --- |
| Start local dependencies | `docker compose -f docker/local/docker-compose.yml up -d` (MongoDB, Redis, LocalStack, and ClickHouse in the release file). |
| Install, generate local env files, build | `npm run setup:project`. The script calls the pinned pnpm version, copies missing environment files, and builds the monorepo. Check that services sharing integration data have the same `STORE_ENCRYPTION_KEY`. Keep local credentials untracked. |
| Run from source | `pnpm dev:portless` per Docker guide. Root scripts also include `pnpm start:api`, `pnpm start:worker`, `pnpm start:dashboard`, and `pnpm start:webhook` for individual services. Use the effective API URL from startup output. |
| Provider regression | `pnpm --filter @novu/providers test --run resend.provider.spec.ts`. |
| Community API E2E | `pnpm --filter @novu/api-service test:e2e:novu-v2-ce`. Follow the checkout's service setup and [CI build/test sequence](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/.github/workflows/reusable-api-e2e.yml). |
| Worker tests | `pnpm --filter @novu/worker test` and `pnpm --filter @novu/worker test:e2e`. Consult the [worker CI workflow](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/.github/workflows/reusable-worker-e2e.yml) for dependencies. |

The community Compose manifest at this tag specifies **3.19.0** app images and omits the separate webhook service. Launching it as written would exercise those images. Use the source workflow above to validate this checkout. [Community Compose](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/docker/community/docker-compose.yml).

### Local verification

Docker Compose was installed, but the current user could not access the Docker daemon. The checks used new loopback-only MongoDB 8.0.17, Redis 7.2.17, and ClickHouse 24.3.18.7 instances. Moto 5.2.5 provided an isolated S3 endpoint with the `novu-test` bucket. The first trigger run passed three cases and failed the attachment case because the S3 endpoint was absent. All four passed after starting the emulator.

The pinned toolchain ran the frozen install, built API and worker plus their 29 dependency tasks, and passed the three mocked Resend adapter tests.

```sh
pnpm install --frozen-lockfile
CI=1 NX_NO_CLOUD=true NX_DAEMON=false pnpm nx run-many --target=build --projects=@novu/api-service,@novu/worker --parallel=3
pnpm --filter @novu/providers test --run resend.provider.spec.ts
```

The worker job execution and email step specs passed 47 checks, including competing job claims, queue entry deduplication, redelivery recovery, and successor dispatch. Run these with the isolated test services available.

```sh
cd apps/worker
NODE_ENV=test NOVU_ENTERPRISE=false NEW_RELIC_ENABLED=false \
  pnpm exec mocha --timeout 10000 --require @novu/testing/swc-register --exit \
  --file e2e/setup.ts src/app/workflow/services/standard.worker.spec.ts \
  src/app/workflow/usecases/send-message/send-message-email.usecase.spec.ts
```

In a separate test run, start the built worker from `apps/worker` with `NODE_ENV=test NOVU_ENTERPRISE=false NEW_RELIC_ENABLED=false node dist/main.js` and wait for its `/v1/health-check` on port 1342. From `apps/api`, run the commands below. The unit command passed nine idempotency checks. The trigger E2E command passed four cases covering acceptance, jobs and provider selection, notification and message persistence with attachments, and unknown workflow rejection. Test mode suppresses external email sends.

```sh
export NODE_ENV=test NOVU_ENTERPRISE=false NEW_RELIC_ENABLED=false
pnpm exec mocha --no-config --timeout 15000 --require @novu/testing/swc-register --exit \
  src/app/shared/framework/idempotency.interceptor.spec.ts \
  src/app/shared/framework/idempotency-http-error.spec.ts

export CI_EE_TEST=false CLERK_ENABLED=true LOG_LEVEL=warn
pnpm exec mocha --no-config --timeout 30000 --require @novu/testing/swc-register --exit \
  --file e2e/setup.ts src/app/events/e2e/trigger-event.e2e.ts \
  --grep 'should trigger an event successfully|should store jobs & message provider id successfully|should generate message and notification based on event|should throw an error when workflow identifier provided is not in the database'

pnpm exec mocha --no-config --timeout 30000 --require @novu/testing/swc-register --exit \
  --file e2e/setup.ts src/app/shared/framework/idempotency.e2e.ts
```

The last command ran an existing idempotency E2E suite and returned nine passes and three failures on the unchanged upstream code. Two assertions expected errors to be thrown by a test helper that only returns the response's data and headers. The third case labeled unauthenticated calls a helper that explicitly adds an API key. Three supplemental direct HTTP checks on the same test endpoint returned the expected 422 for a changed body, 400 for an oversized key, and 401 with no idempotency response header for a request without credentials. The full Community E2E suite and live Resend delivery remain unverified.

## 9. Minimal Phase 1 and later integration

1. Start the community stack from the reviewed source. In its development environment, create one active dashboard-managed workflow, `interview-scheduled-smoke`, with one email step, a synthetic payload, and no delay.
2. In **Integrations**, activate Resend with a development API key and a From address on a verified domain. The Novu guide also documents `onboarding@resend.dev` for testing, subject to Resend's sender restrictions. Use Resend's `delivered@resend.dev` simulator and keep actual participant addresses out of fixtures. [Novu Resend setup](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/docs/platform/integrations/email/resend.mdx), [Resend test addresses](https://resend.com/changelog/sending-test-emails).
3. Trigger the workflow from a local terminal. Load the key through a local secret source before running the command.

   ```sh
   curl --fail-with-body --silent --show-error \
     "${NOVU_API_URL:?set the configured API URL}/v1/events/trigger" \
     -H "Authorization: ApiKey ${NOVU_API_KEY:?load the development environment key}" \
     -H 'Content-Type: application/json' \
     --data '{"name":"interview-scheduled-smoke","to":{"subscriberId":"smoke-recipient","email":"delivered@resend.dev"},"payload":{"interviewTitle":"Interview smoke test"},"transactionId":"interview-scheduled-smoke-001"}'
   ```

   Use a new transaction ID for a fresh smoke run. Retain the same ID when deliberately testing replay behavior. Inspect the response status and transaction ID, then correlate the workflow, step, message, and Resend provider ID in activity and provider records.
4. For Novu-side confirmation, start the webhook service, configure the callback manually in Resend on an authorized test endpoint, and set the signing key in the integration. Validate delivery and bounce with the test addresses. Confirm a malformed signature is rejected using the local test setup. If webhook ingress is unavailable, the Resend dashboard can verify simulator behavior while Novu-side callback correlation remains unverified. [Novu activity tracking setup](https://github.com/novuhq/novu/blob/c51a1932dabd725bdb75c39da7affebc141b3de1/docs/platform/integrations/email/activity-tracking/manual-configuration/resend.mdx).
5. After this succeeds, evaluate a thin, backend-only event mapping from `interview.scheduled` to a permitted workflow. Use an environment key scoped to the intended application, and keep lifecycle rules and durable forwarding in the client application. Add a versioned service endpoint only if native triggering cannot satisfy the public contract. Make that choice after testing the native acceptance and idempotency behavior.

## 10. Decisions that need runtime evidence

1. Run one native trigger with the default BullMQ backend and capture the transaction, job, message, and provider IDs. Measure the effective environment's permissions, payload limits and rate limits, including the Resend team's configured limit.
2. Inject worker termination and MongoDB/Redis errors around the workflow, subscriber, and first-step handoffs. Determine whether a persisted intent can be safely redispatched using existing primitives. Consider an outbox or reconciliation mechanism only after identifying what the existing recovery paths cover.
3. Test same-key concurrent requests, changed payload, cache expiry and Redis loss. Decide whether the public retry window needs a durable uniqueness record.
4. Simulate 429, permanent rejection, and a timeout after provider acceptance. Verify terminal status and provider correlation before selecting retry and provider idempotency behavior.
5. Verify webhook ordering, duplicates, invalid signatures, missing provider-ID mapping, and behavior when callback recording is unavailable. Measure which states the community deployment can expose.
6. Before enabling reminders, test reschedule and cancellation races and establish who owns the authoritative interview version. Represent schedule instants in UTC and use an explicit IANA timezone for display and DST tests.
