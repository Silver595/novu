import { Injectable, Logger } from '@nestjs/common';
import {
  BulkCreateExecutionDetails,
  buildStepRunTraceFromJob,
  InstrumentUsecase,
  mapEventTypeToTitle,
  StepRunRepository,
  StepRunV2Writer,
  TraceLogRepository,
} from '@novu/application-generic';
import { DalException, JobEntity, JobRepository, JobStatusEnum, NotificationEntity } from '@novu/dal';
import { PlatformException } from '../../../shared/utils';
import { AddJob } from '../add-job';
import { StoreSubscriberJobsCommand } from './store-subscriber-jobs.command';

@Injectable()
export class StoreSubscriberJobs {
  constructor(
    private addJob: AddJob,
    private jobRepository: JobRepository,
    protected bulkCreateExecutionDetails: BulkCreateExecutionDetails,
    private stepRunRepository: StepRunRepository,
    private traceLogRepository: TraceLogRepository,
    private stepRunV2Writer: StepRunV2Writer
  ) {}

  async resume(notification: NotificationEntity | null): Promise<boolean> {
    if (!notification) return false;

    const root = await this.jobRepository.findOne({
      _environmentId: notification._environmentId,
      _notificationId: notification._id,
      _parentId: null,
    });
    if (!root) return false;

    await this.dispatchRoot(root);
    return true;
  }

  @InstrumentUsecase()
  async execute(command: StoreSubscriberJobsCommand) {
    let storedJobs;
    try {
      storedJobs = await this.jobRepository.storeJobs(command.jobs);
    } catch (e) {
      if (e instanceof DalException) {
        throw new PlatformException(e.message);
      }
      throw e;
    }

    const pendingJobs = storedJobs.filter((job) => job.status === JobStatusEnum.PENDING);
    if (pendingJobs.length > 0) {
      await this.stepRunRepository.createMany(pendingJobs, { status: JobStatusEnum.QUEUED });
      this.stepRunV2Writer.writeMany(pendingJobs);
      await this.emitStepCreatedTraces(pendingJobs);
    }
    if (storedJobs[0]) await this.dispatchRoot(storedJobs[0]);
  }

  private async dispatchRoot(firstJob: JobEntity) {
    const addJobCommand = {
      userId: firstJob._userId,
      environmentId: firstJob._environmentId,
      organizationId: firstJob._organizationId,
      jobId: firstJob._id,
      job: firstJob,
      recoverableRoot: true,
    };

    await this.addJob.execute(addJobCommand);
  }

  private async emitStepCreatedTraces(storedJobs: JobEntity[]): Promise<void> {
    if (storedJobs.length === 0) {
      return;
    }

    try {
      await this.traceLogRepository.createStepRun(
        storedJobs.map((job) =>
          buildStepRunTraceFromJob(job, {
            event_type: 'step_created',
            title: mapEventTypeToTitle('step_created'),
            status: 'success',
          })
        )
      );
    } catch (error) {
      Logger.error({ err: error, jobIds: storedJobs.map((job) => job._id) }, 'Failed to emit step_created traces');
    }
  }
}
