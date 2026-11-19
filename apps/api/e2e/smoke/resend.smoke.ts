import { type ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BullMqService,
  type IProcessSubscriberDataDto,
  WorkflowInMemoryProviderService,
} from '@novu/application-generic';
import {
  ExecutionDetailsRepository,
  IntegrationRepository,
  JobRepository,
  MessageRepository,
  mongoose,
  NotificationRepository,
} from '@novu/dal';
import { EmailBlockTypeEnum, JobStatusEnum, JobTopicNameEnum, StepTypeEnum, TriggerTypeEnum } from '@novu/shared';
import { testServer, UserSession } from '@novu/testing';
import { expect } from 'chai';
import { parse } from 'dotenv';
import { Webhook } from 'svix';

const workflow = 'interview-scheduled-smoke';
const recipient = 'interview-smoke@example.invalid';
type WorkerCheckpoint = { persistedJobId: string };

const sender = 'notifications@example.invalid';

async function waitFor<T>(description: string, find: () => Promise<T | undefined>, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const result = await find();
    if (result !== undefined) return result;
    await delay(200);
  } while (Date.now() < deadline);

  throw new Error(`Timed out waiting for ${description}`);
}

async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill(signal);
  const forceExit = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(forceExit);
  }
}

describe('Resend smoke workflow (local HTTP simulation)', function () {
  this.timeout(140_000);

  const notifications = new NotificationRepository();
  const messages = new MessageRepository();
  const jobs = new JobRepository();
  const details = new ExecutionDetailsRepository();
  const requests: Array<{ from: string; to: string | string[]; subject: string; html: string; id: string }> = [];

  const simulator = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/emails') {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${process.env.RESEND_SMOKE_API_KEY}`) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'bad mock key' }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const id = randomUUID();
      requests.push({ ...body, id });
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'bad mock body' }));
    }
  });

  let session: UserSession;
  let worker: ChildProcess | undefined;
  let webhook: ChildProcess | undefined;
  let integrationId: string;
  let simulatorUrl: string;
  let callbackSigner: Webhook;
  let subscriberQueue: ReturnType<BullMqService['createQueue']>;
  let recoveryDelivery: IProcessSubscriberDataDto;
  let crashedQueueJobId: string | undefined;
  let webhookUrl: string;
  const transactionQuery = (transactionId: string) => ({
    _environmentId: session.environment._id,
    _organizationId: session.organization._id,
    transactionId,
  });

  async function startService(
    name: 'worker' | 'webhook',
    env: NodeJS.ProcessEnv,
    onMessage?: (message: WorkerCheckpoint) => void
  ) {
    const cwd = resolve('..', name);
    const child = fork('dist/main.js', {
      cwd,
      execArgv: ['--require', resolve('e2e/smoke/worker-preload.cjs')],
      env: {
        ...process.env,
        ...parse(readFileSync(resolve(cwd, 'src/.env.test'))),
        NOVU_ENTERPRISE: 'false',
        NEW_RELIC_ENABLED: 'false',
        LOG_LEVEL: 'error',
        LAUNCH_DARKLY_SDK_KEY: '',
        QUEUE_BACKEND: 'bullmq',
        NOVU_SMOKE_EPHEMERAL_PORT: '1',
        STORE_ENCRYPTION_KEY: process.env.STORE_ENCRYPTION_KEY,
        MONGO_URL: process.env.MONGO_URL,
        ...env,
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    if (name === 'worker') worker = child;
    else webhook = child;

    let port: number | undefined;
    child.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if ('port' in message && typeof message.port === 'number') {
        port = message.port;
      }
      if (onMessage && 'persistedJobId' in message && typeof message.persistedJobId === 'string') {
        onMessage({ persistedJobId: message.persistedJobId });
      }
    });

    await waitFor(`${name} health`, async () => {
      if (child.exitCode !== null) throw new Error(`${name} exited with code ${child.exitCode}`);
      if (!port) return undefined;
      const result = await fetch(`http://127.0.0.1:${port}/v1/health-check`).catch(() => undefined);
      return result?.ok ? true : undefined;
    });
    return `http://127.0.0.1:${port}`;
  }

  const startWorker = (
    crashTransactionId = '',
    onMessage?: (message: WorkerCheckpoint) => void,
    stage: 'before-dispatch' | 'after-claim' | 'race' = 'before-dispatch'
  ) =>
    startService(
      'worker',
      {
        NODE_ENV: 'dev', // The base email handler skips provider sends in test mode.
        PORT: '1342',
        RESEND_BASE_URL: simulatorUrl,
        NOVU_SMOKE_CRASH_TRANSACTION_ID: crashTransactionId,
        NOVU_SMOKE_RECOVERY_STAGE: stage,
        WORKER_DEFAULT_LOCK_DURATION: '3000',
      },
      onMessage
    );

  async function trigger(
    transactionId: string,
    title: string,
    targets = [{ subscriberId: 'interview-smoke', email: recipient }],
    workflowName = workflow
  ) {
    const { body } = await session.testAgent
      .post('/v1/events/trigger')
      .set('Authorization', `ApiKey ${session.apiKey}`)
      .send({
        name: workflowName,
        transactionId,
        to: targets,
        payload: { title },
      })
      .expect(201);
    expect(body.data).to.include({ transactionId, acknowledged: true, status: 'processed' });
  }

  before(async () => {
    if (!process.env.RESEND_SMOKE_API_KEY || !process.env.RESEND_SMOKE_WEBHOOK_SECRET) {
      throw new Error('Provide disposable RESEND_SMOKE_API_KEY and RESEND_SMOKE_WEBHOOK_SECRET values');
    }

    callbackSigner = new Webhook(process.env.RESEND_SMOKE_WEBHOOK_SECRET);
    const address = await new Promise<ReturnType<typeof simulator.address>>((done) => {
      simulator.listen(0, '127.0.0.1', () => done(simulator.address()));
    });
    if (!address || typeof address === 'string') throw new Error('Missing simulator address');
    simulatorUrl = `http://127.0.0.1:${address.port}`;

    const provider = testServer.getService(WorkflowInMemoryProviderService);
    subscriberQueue = new BullMqService(provider).createQueue(JobTopicNameEnum.PROCESS_SUBSCRIBER, {});
    session = new UserSession();
    await session.initialize();
    // Remove fixture email integrations before enabling real adapter I/O in the worker.
    await new IntegrationRepository().deleteMany({
      _organizationId: session.organization._id,
      _environmentId: session.environment._id,
      channel: 'email',
    });
    await session.createTemplate({
      name: workflow,
      triggers: [{ identifier: workflow, type: TriggerTypeEnum.EVENT, variables: [{ name: 'title' }] }],
      steps: [
        {
          type: StepTypeEnum.EMAIL,
          subject: 'Scheduled: {{title}}',
          content: [{ type: EmailBlockTypeEnum.TEXT, content: 'Interview: {{title}}' }],
        },
      ],
    });
    const { body } = await session.testAgent
      .post('/v1/integrations')
      .send({
        providerId: 'resend',
        channel: 'email',
        active: true,
        check: false,
        credentials: {
          apiKey: process.env.RESEND_SMOKE_API_KEY,
          from: sender,
        },
        configurations: { inboundWebhookSigningKey: process.env.RESEND_SMOKE_WEBHOOK_SECRET },
      })
      .expect(201);
    integrationId = body.data._id;
    await session.testAgent.post(`/v1/integrations/${integrationId}/set-primary`).send({}).expect(200);
    await startWorker();
    webhookUrl = await startService('webhook', {
      PORT: '1495',
      NODE_ENV: 'test',
      IS_LEGACY_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED: 'true',
    });
  });

  after(async () => {
    await Promise.all([stop(worker), stop(webhook)]);
    const jobId = crashedQueueJobId;
    if (subscriberQueue && jobId) {
      await waitFor('test subscriber job removal after its lock expires', async () => {
        const entry = await subscriberQueue.getJob(jobId);
        if (!entry) return true;
        return entry
          .remove()
          .then(() => true)
          .catch(() => undefined);
      });
    }
    await subscriberQueue?.close();
    simulator.close();
  });

  it('correlates the trigger, persisted email, and simulated Resend acceptance and delivery', async () => {
    const transactionId = randomUUID();
    await trigger(transactionId, 'Synthetic interview');
    const query = transactionQuery(transactionId);
    const message = await waitFor('persisted Resend ID', async () => {
      const row = await messages.findOne({ ...query, channel: 'email' });
      return row?.identifier ? row : undefined;
    });
    const notification = await notifications.findOne(query);
    const job = await waitFor(
      'completed email step',
      async () => (await jobs.findOne({ ...query, _id: message._jobId, status: JobStatusEnum.COMPLETED })) ?? undefined
    );
    expect(message._notificationId).to.equal(notification?._id);
    expect(job._notificationId).to.equal(notification?._id);
    expect(message.providerId).to.equal('resend');
    expect(requests).to.have.length(1);
    const [accepted] = requests;
    expect(accepted.id).to.equal(message.identifier);
    expect(accepted.from).to.include(sender);
    expect([accepted.to].flat()).to.deep.equal([recipient]);
    expect(accepted.subject).to.equal('Scheduled: Synthetic interview');
    expect(accepted.html).to.include('Interview: Synthetic interview');

    const callbackUrl = `${webhookUrl}/webhooks/organizations/${query._organizationId}/environments/${query._environmentId}/email/${integrationId}`;
    const now = new Date();
    const svixId = `msg_${randomUUID()}`;
    const body = JSON.stringify({
      type: 'email.delivered',
      created_at: now.toISOString(),
      data: {
        email_id: accepted.id,
        subject: accepted.subject,
        to: [recipient],
        from: sender,
        created_at: now.toISOString(),
      },
    });
    const signature = callbackSigner.sign(svixId, now, body);
    const callback = (rawBody: string, signed = true) =>
      fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(signed && {
            'svix-id': svixId,
            'svix-timestamp': String(Math.floor(now.getTime() / 1000)),
            'svix-signature': signature,
          }),
        },
        body: rawBody,
      });
    const deliveryRecords = () => details.find({ ...query, _messageId: message._id, webhookStatus: 'delivered' });
    expect(await deliveryRecords()).to.have.length(0);
    expect((await callback(body, false)).status).to.equal(401);
    expect((await callback(`${body} `)).status).to.equal(401);
    expect(await deliveryRecords()).to.have.length(0);
    const delivery = await callback(body);
    expect(delivery.status).to.equal(201);
    expect(await delivery.json()).to.have.deep.nested.property('[0].id', accepted.id);
    const [record] = await deliveryRecords();
    expect(record).to.include({ providerId: 'resend', status: 'Success', webhookStatus: 'delivered' });

    const replays = await Promise.all([callback(body), callback(body), callback(body)]);
    expect(replays.map((response) => response.status)).to.deep.equal([201, 201, 201]);
    expect(await deliveryRecords()).to.have.length(1);
    expect((await messages.findOne({ ...query, _id: message._id }))?.status).to.equal('sent');
    expect(requests).to.have.length(1);

    const bounceBody = JSON.stringify({ ...JSON.parse(body), type: 'email.bounced' });
    const bounceId = `msg_${randomUUID()}`;
    const bounce = () =>
      fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'svix-id': bounceId,
          'svix-timestamp': String(Math.floor(now.getTime() / 1000)),
          'svix-signature': callbackSigner.sign(bounceId, now, bounceBody),
        },
        body: bounceBody,
      });
    const bounceRecords = () => details.find({ ...query, _messageId: message._id, webhookStatus: 'bounced' });
    const database = mongoose.connection.db;
    if (!database) throw new Error('Test MongoDB is disconnected');
    const collection = details._model.collection.name;
    await database.command({ collMod: collection, validator: { webhookStatus: { $ne: 'bounced' } } });
    try {
      expect((await bounce()).status).to.equal(500);
      expect(await bounceRecords()).to.have.length(0);
    } finally {
      await database.command({ collMod: collection, validator: {} });
    }
    const concurrent = await Promise.all([bounce(), bounce()]);
    expect(concurrent.map((response) => response.status)).to.deep.equal([201, 201]);
    const [bounced] = await bounceRecords();
    expect(await bounceRecords()).to.have.length(1);
    expect(bounced).to.include({ webhookStatus: 'bounced', status: 'Failed' });
    expect(await deliveryRecords()).to.have.length(1);

    console.info(
      JSON.stringify({
        transactionId,
        notificationId: notification?._id,
        messageId: message._id,
        jobId: job._id,
        simulatedResendId: accepted.id,
      })
    );
  });

  async function replay(delivery: IProcessSubscriberDataDto, times: number) {
    const entries = await subscriberQueue.addBulk(
      Array.from({ length: times }, () => ({
        name: 'replayed-subscriber',
        data: delivery,
        opts: { removeOnComplete: false, removeOnFail: false },
      }))
    );

    await waitFor('subscriber replays to finish', async () => {
      const states = await Promise.all(entries.map((entry) => entry.getState()));
      if (states.includes('failed')) throw new Error('A subscriber replay failed');
      return states.every((state) => state === 'completed') ? true : undefined;
    });
    return entries.map((entry) => entry.id);
  }

  it('recovers the original chain across a pre-dispatch crash and a crash during recovery', async () => {
    await stop(worker);
    const transactionId = randomUUID();
    const query = transactionQuery(transactionId);
    let persistedJobId: string | undefined;
    await startWorker(transactionId, (message) => {
      persistedJobId = message.persistedJobId;
    });
    await trigger(transactionId, 'Recovery interview');
    const crashedJobId = await waitFor('pre-dispatch checkpoint', async () => persistedJobId);
    const active = (await subscriberQueue.getActive()).find((entry) => entry.data.transactionId === transactionId);
    if (!active) throw new Error('Original subscriber job is missing from BullMQ');
    recoveryDelivery = active.data;
    crashedQueueJobId = active.id;
    const originalJobs = await jobs.find(query);
    const original = originalJobs.find((job) => job._id === crashedJobId);
    if (!original) throw new Error('Pre-dispatch job is missing from MongoDB');
    expect(original.status).to.equal(JobStatusEnum.PENDING);
    expect(await notifications.find(query)).to.have.length(1);
    expect(await messages.find(query)).to.have.length(0);
    await stop(worker, 'SIGKILL');

    persistedJobId = undefined;
    await startWorker(
      transactionId,
      (message) => {
        persistedJobId = message.persistedJobId;
      },
      'after-claim'
    );
    const claimedId = await waitFor('stalled redelivery to claim the same root', async () => persistedJobId, 75_000);
    expect(claimedId).to.equal(crashedJobId);
    const recoveryJob = (await subscriberQueue.getActive()).find((entry) => entry.id === active.id);
    expect(recoveryJob?.id).to.equal(active.id);
    expect(await jobs.findOne({ ...query, _id: crashedJobId })).to.include({
      status: JobStatusEnum.QUEUED,
      awaitingEnqueue: true,
    });
    expect(await messages.find(query)).to.have.length(0);
    await stop(worker, 'SIGKILL');

    await startWorker();
    const replayIds = await replay(recoveryDelivery, 3);
    const recovered = await waitFor('recovered email', async () => {
      const row = await messages.findOne({ ...query, channel: 'email' });
      return row?.identifier ? row : undefined;
    });
    await waitFor('original jobs to complete', async () => {
      const rows = await jobs.find(query);
      return rows.length === originalJobs.length && rows.every((row) => row.status === JobStatusEnum.COMPLETED)
        ? rows
        : undefined;
    });
    await replay(recoveryDelivery, 1);
    const finalJobs = await jobs.find(query);
    const providerRequests = requests.filter((request) => request.subject === 'Scheduled: Recovery interview');
    const deliveredMessages = await messages.find(query);
    const attempts = await details.find({ ...query, _messageId: recovered._id, detail: 'Message sent' });
    expect((await notifications.find(query)).map(({ _id }) => _id)).to.deep.equal([original._notificationId]);
    expect(finalJobs.map(({ _id }) => _id)).to.have.members(originalJobs.map(({ _id }) => _id));
    expect(deliveredMessages).to.have.length(1);
    expect(attempts).to.have.length(1);
    expect(providerRequests).to.have.length(1);
    expect(recovered.identifier).to.equal(providerRequests[0].id);
    console.info(
      JSON.stringify({
        ...query,
        subscriberId: original.subscriberId,
        internalSubscriberId: original._subscriberId,
        subscriberQueueJobId: active.id,
        replayIds,
        notificationId: original._notificationId,
        jobs: finalJobs.map(({ _id, status }) => ({ id: _id, status })),
        messageId: recovered._id,
        providerId: recovered.identifier,
        deliveryAttemptId: attempts[0]._id,
      })
    );
  });

  it('atomically converges two concurrent first deliveries of the same subscriber intent', async () => {
    await stop(worker);
    const transactionId = randomUUID();
    await startWorker(transactionId, undefined, 'race');
    const transaction = { ...recoveryDelivery, transactionId, payload: { title: 'Concurrent interview' } };
    await replay(transaction, 2);
    const query = transactionQuery(transactionId);
    await waitFor('concurrent delivery to complete', async () => {
      const rows = await jobs.find(query);
      return rows.length === 2 && rows.every((row) => row.status === JobStatusEnum.COMPLETED) ? true : undefined;
    });
    expect(await notifications.find(query)).to.have.length(1);
    expect(await messages.find(query)).to.have.length(1);
    expect(requests.filter((request) => request.subject === 'Scheduled: Concurrent interview')).to.have.length(1);
  });

  it('fills a partially written job chain without replacing its tail', async () => {
    const transactionId = randomUUID();
    const transaction = { ...recoveryDelivery, transactionId, payload: { title: 'Partial plan interview' } };
    const query = transactionQuery(transactionId);
    const database = mongoose.connection.db;
    if (!database) throw new Error('Test MongoDB is disconnected');
    const collection = jobs._model.collection.name;
    const validator = { $or: [{ transactionId: { $ne: transactionId } }, { _parentId: { $type: 'objectId' } }] };
    await database.command({ collMod: collection, validator });
    try {
      const entry = await subscriberQueue.add('rejected-root', transaction, { removeOnFail: false });
      await waitFor('MongoDB to reject the root write', async () =>
        (await entry.getState()) === 'failed' ? true : undefined
      );
    } finally {
      await database.command({ collMod: collection, validator: {} });
    }
    const suffix = await jobs.find(query);
    expect(suffix).to.have.length(1);
    expect(suffix[0]).to.include({ type: StepTypeEnum.EMAIL, status: JobStatusEnum.PENDING });
    expect(await notifications.find(query)).to.have.length(1);
    expect(await messages.find(query)).to.have.length(0);

    await replay(transaction, 1);
    await waitFor('repaired chain to complete', async () => {
      const rows = await jobs.find(query);
      return rows.length === 2 && rows.every((row) => row.status === JobStatusEnum.COMPLETED) ? rows : undefined;
    });
    expect((await jobs.findOne({ ...query, _id: suffix[0]._id }))?.status).to.equal(JobStatusEnum.COMPLETED);
    expect(await notifications.find(query)).to.have.length(1);
    expect(await messages.find(query)).to.have.length(1);
    expect(requests.filter((request) => request.subject === 'Scheduled: Partial plan interview')).to.have.length(1);
  });

  it('preserves step order and separate recipients sharing a transaction', async () => {
    const multistep = 'interview-scheduled-multistep';
    await session.createTemplate({
      name: multistep,
      triggers: [{ identifier: multistep, type: TriggerTypeEnum.EVENT, variables: [{ name: 'title' }] }],
      steps: ['First', 'Second'].map((label) => ({
        type: StepTypeEnum.EMAIL,
        subject: `${label}: {{title}}`,
        content: [{ type: EmailBlockTypeEnum.TEXT, content: label }],
      })),
    });
    const transactionId = randomUUID();
    const targets = ['one', 'two'].map((id) => ({ subscriberId: id, email: `${id}@example.invalid` }));
    await trigger(transactionId, 'Multi-step interview', targets, multistep);
    const query = transactionQuery(transactionId);
    const persisted = await waitFor('both three-step chains to complete', async () => {
      const rows = await jobs.find(query);
      return rows.length === 6 && rows.every((row) => row.status === JobStatusEnum.COMPLETED) ? rows : undefined;
    });
    expect(await notifications.find(query)).to.have.length(2);
    expect(await messages.find(query)).to.have.length(4);
    for (const target of targets) {
      const chain = persisted.filter((row) => row.subscriberId === target.subscriberId);
      expect(chain).to.have.length(3);
      const root = chain.find((row) => !row._parentId);
      const first = chain.find((row) => row._parentId === root?._id);
      const second = chain.find((row) => row._parentId === first?._id);
      expect([root?.type, first?.type, second?.type]).to.deep.equal(['trigger', 'email', 'email']);
      const subjects = requests.filter((row) => [row.to].flat().includes(target.email)).map(({ subject }) => subject);
      expect(subjects).to.deep.equal(['First: Multi-step interview', 'Second: Multi-step interview']);
    }
  });
});
