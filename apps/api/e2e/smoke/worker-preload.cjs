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
  const { AddJob } = require('../../../worker/dist/app/workflow/usecases/add-job/add-job.usecase');
  const execute = AddJob.prototype.execute;

  AddJob.prototype.execute = function pauseBeforeDispatch(command) {
    if (command.job?.transactionId === crashTransactionId) {
      process.send({ persistedJobId: command.jobId });
      return new Promise(() => {});
    }

    return execute.call(this, command);
  };
}
