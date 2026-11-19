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

const crashTransactionId = process.env.NOVU_SMOKE_CRASH_TRANSACTION_ID;
if (crashTransactionId) {
  const stage = process.env.NOVU_SMOKE_RECOVERY_STAGE;
  const { AddJob } = require('../../../worker/dist/app/workflow/usecases/add-job/add-job.usecase');
  const pause = (id) => {
    process.send({ persistedJobId: id });
    return new Promise(() => {});
  };

  if (stage === 'after-claim') {
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
