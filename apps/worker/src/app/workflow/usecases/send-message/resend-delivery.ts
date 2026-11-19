import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { IntegrationEntity, MessageEntity, MessageRepository } from '@novu/dal';
import type { IEmailOptions } from '@novu/shared';
import type { ISendMessageSuccessResponse } from '@novu/stateless';

const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_CODES = new Set(['application_error', 'internal_server_error', 'concurrent_idempotent_requests']);
const REJECTION_CODES = new Set([
  'invalid_idempotency_key',
  'missing_required_field',
  'invalid_access',
  'invalid_parameter',
  'invalid_region',
  'rate_limit_exceeded',
  'daily_quota_exceeded',
  'monthly_quota_exceeded',
  'missing_api_key',
  'invalid_api_key',
  'restricted_api_key',
  'invalid_from_address',
  'validation_error',
  'not_found',
  'method_not_allowed',
]);

type AttemptStamp = { firstAttemptAt: number; fingerprint: string; attempts: number; held?: boolean };
type Outcome =
  | { status: 'accepted'; result: ISendMessageSuccessResponse; recorded: boolean }
  | { status: 'rejected' | 'uncertain'; reason: string };

export async function submitResendDelivery(
  repository: MessageRepository,
  message: MessageEntity,
  integration: IntegrationEntity,
  mailData: IEmailOptions,
  send: (mail: IEmailOptions & { providerIdempotencyKey: string }) => Promise<ISendMessageSuccessResponse>
): Promise<Outcome> {
  const scope = { _id: message._id, _environmentId: message._environmentId, _jobId: message._jobId };
  const pending = { ...scope, identifier: null, status: 'warning' };
  const prefix = 'data.resendDelivery';
  const idempotencyKey = `novu-email/${message._environmentId}/${message._jobId}`;
  // Only the digest is stored. Include the credential and integration so a retry
  // cannot escape Resend's deduplication scope if account configuration changes.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([integration._id, integration.credentials.apiKey, integration.credentials.senderName, mailData])
    )
    .digest('hex');

  async function reserve() {
    const now = Date.now();
    const first = await repository.findOneAndUpdate(
      { ...pending, [prefix]: { $exists: false } },
      { $set: { [prefix]: { firstAttemptAt: now, fingerprint, attempts: 1 }, errorId: 'resend_outcome_uncertain' } },
      { new: true }
    );
    if (first) return first;
    return repository.findOneAndUpdate(
      {
        ...pending,
        [`${prefix}.firstAttemptAt`]: { $gt: now - RETRY_WINDOW_MS, $lte: now },
        [`${prefix}.fingerprint`]: fingerprint,
        [`${prefix}.attempts`]: { $lt: MAX_ATTEMPTS },
        [`${prefix}.held`]: { $ne: true },
      },
      { $inc: { [`${prefix}.attempts`]: 1 } },
      { new: true }
    );
  }

  async function hold(reason: string, status: 'rejected' | 'uncertain'): Promise<Outcome> {
    const updated = await repository.findOneAndUpdate(
      pending,
      { $set: { [`${prefix}.held`]: true, status: status === 'rejected' ? 'error' : 'warning', errorId: reason } },
      { new: true }
    );
    if (!updated) {
      const observed = await repository.findOne(scope);
      if (observed?.identifier) return observedAcceptance(observed.identifier);
    }

    return { status, reason };
  }

  async function sendReserved(attempt: MessageEntity): Promise<Outcome | undefined> {
    let result: ISendMessageSuccessResponse;
    try {
      result = await send({ ...mailData, providerIdempotencyKey: idempotencyKey });
    } catch (error) {
      const code = error instanceof Error && 'resendCode' in error ? String(error.resendCode) : 'application_error';
      if (RETRYABLE_CODES.has(code)) return undefined;
      // Rejection of a later request does not rule out acceptance of an earlier one.
      const reserved = attempt.data?.resendDelivery as AttemptStamp | undefined;
      const rejected = reserved?.attempts === 1 && REJECTION_CODES.has(code);
      const reason = rejected ? `resend_${code}` : 'resend_outcome_uncertain';

      return hold(reason, rejected ? 'rejected' : 'uncertain');
    }

    return result.id ? recordAcceptance(result) : undefined;
  }

  async function recordAcceptance(result: ISendMessageSuccessResponse): Promise<Outcome> {
    const update = () =>
      repository.findOneAndUpdate(
        { ...scope, identifier: null },
        { $set: { identifier: result.id, status: 'sent' }, $unset: { errorId: 1, errorText: 1 } },
        { new: true }
      );
    // Retry the database write using the observed ID before attempting any
    // provider replay. A commit followed by a lost DB response is also safe.
    const stored = await update().catch(update);
    if (stored) return { status: 'accepted', result, recorded: true };
    const observed = await repository.findOne(scope);
    if (!observed?.identifier) throw new Error('Resend acceptance could not be persisted');

    return observedAcceptance(observed.identifier);
  }

  async function explainBlockedAttempt(): Promise<Outcome> {
    const observed = await repository.findOne(scope);
    if (observed?.identifier) return observedAcceptance(observed.identifier);
    if (observed?.status === 'error') {
      return { status: 'rejected', reason: observed.errorId ?? 'resend_rejected' };
    }

    const stamp = observed?.data?.resendDelivery as AttemptStamp | undefined;
    if (stamp?.held) return { status: 'uncertain', reason: observed?.errorId ?? 'resend_retry_blocked' };
    if (stamp && Date.now() - stamp.firstAttemptAt >= RETRY_WINDOW_MS) {
      return hold('resend_retry_window_expired', 'uncertain');
    }
    if (stamp && stamp.fingerprint !== fingerprint) return hold('resend_request_changed', 'uncertain');
    if (stamp && stamp.attempts >= MAX_ATTEMPTS) return hold('resend_attempts_exhausted', 'uncertain');

    return hold('resend_retry_blocked', 'uncertain');
  }

  for (let index = 0; index < 2; index++) {
    const attempt = await reserve();
    if (!attempt) return explainBlockedAttempt();
    const stamp = attempt.data?.resendDelivery as AttemptStamp | undefined;
    const age = stamp ? Date.now() - stamp.firstAttemptAt : Number.NaN;
    if (!(age >= 0 && age < RETRY_WINDOW_MS)) return explainBlockedAttempt();
    const outcome = await sendReserved(attempt);
    if (outcome) return outcome;
    if (index === 0) await delay(250);
  }

  // An eligible later queue redelivery may use the remaining attempt budget.
  // SDK errors include network failures and provider 5xxs in the same class.
  return { status: 'uncertain', reason: 'resend_outcome_uncertain' };
}

function observedAcceptance(id: string): Outcome {
  return { status: 'accepted', result: { id, date: new Date().toISOString() }, recorded: false };
}
