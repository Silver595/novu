const { Server } = require('node:net');

// Both child services use Nest's default host. Keep their test listeners on loopback.
const listen = Server.prototype.listen;
Server.prototype.listen = function listenOnLoopback(port, ...args) {
  if ((typeof port === 'number' || /^\d+$/.test(port)) && typeof args[0] !== 'string') {
    const ephemeral = process.env.NOVU_SMOKE_EPHEMERAL_PORT === '1';
    if (ephemeral) {
      this.once('listening', () => process.send({ port: this.address().port }));
    }
    return listen.call(this, ephemeral ? 0 : Number(port), '127.0.0.1', ...args);
  }

  return listen.call(this, port, ...args);
};

if (process.send) {
  process.on('disconnect', () => process.exit(1));
}

const probeJobId = process.env.NOVU_SMOKE_PROBE_JOB_ID;
if (probeJobId) {
  const { RunJob } = require('../../../worker/dist/app/workflow/usecases/run-job/run-job.usecase');
  const execute = RunJob.prototype.execute;
  RunJob.prototype.execute = function observeReplay(command) {
    if (command.jobId === probeJobId) process.send({ providerReplayJobId: probeJobId });
    return execute.call(this, command);
  };
}

const crashTransactionId = process.env.NOVU_SMOKE_CRASH_TRANSACTION_ID;
if (crashTransactionId) {
  const stage = process.env.NOVU_SMOKE_RECOVERY_STAGE;
  const { AddJob } = require('../../../worker/dist/app/workflow/usecases/add-job/add-job.usecase');
  const pause = (id) => {
    process.send({ persistedJobId: id });
    return new Promise(() => {});
  };

  if (stage === 'after-provider') {
    const { MessageRepository } = require('../../../worker/node_modules/@novu/dal');
    const update = MessageRepository.prototype.findOneAndUpdate;
    MessageRepository.prototype.findOneAndUpdate = async function pauseBeforeProviderId(query, operation, options) {
      if (operation.$set?.identifier) {
        const message = await this.findOne(query);
        if (message?.transactionId === crashTransactionId) return pause(message._jobId);
      }
      return update.call(this, query, operation, options);
    };
  } else if (stage === 'after-claim') {
    const queueJob = AddJob.prototype.queueJob;
    AddJob.prototype.queueJob = function pauseBeforeQueueWrite(params) {
      if (params.job.transactionId === crashTransactionId && !params.job._parentId) {
        return pause(params.job._id);
      }
      return queueJob.call(this, params);
    };
  } else if (stage === 'race') {
    const { NotificationRepository } = require('../../../worker/node_modules/@novu/dal');
    const ensure = NotificationRepository.prototype.ensureSubscriberNotification;
    let arrived = 0;
    let release;
    const gate = new Promise((done) => {
      release = done;
    });
    NotificationRepository.prototype.ensureSubscriberNotification = async function waitForCompetitor(identity, data) {
      if (identity.transactionId === crashTransactionId) {
        if (++arrived === 2) release();
        await gate;
      }
      return ensure.call(this, identity, data);
    };
  } else {
    const execute = AddJob.prototype.execute;
    AddJob.prototype.execute = function pauseBeforeDispatch(command) {
      if (command.job?.transactionId === crashTransactionId) {
        return pause(command.jobId);
      }
      return execute.call(this, command);
    };
  }
}
