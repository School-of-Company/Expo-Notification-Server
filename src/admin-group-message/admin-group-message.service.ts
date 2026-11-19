import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { ExpoFeaturePolicyProvider } from '../common/expo-feature-policy.provider';
import { InternalCallError } from '../common/internal-http';
import { maskPhone } from '../common/mask-phone';
import { renderTemplate } from '../sms/kakao-message';
import { KakaoSenderProvider } from '../sms/kakao-sender.provider';
import {
  type AuthorizeGroupMessage,
  type CreateGroupMessagePreview,
  type GroupMessageJob,
  type GroupMessagePreviewRecord,
} from './admin-group-message.schema';
import { AdminGroupMessageStore } from './admin-group-message.store';
import {
  GROUP_MESSAGE_SENDER,
  type GroupMessageSender,
  type GroupMessageTargetRecord,
  groupKakaoMessage,
  groupTemplateVariables,
} from './group-message-sender.interface';

// ponytail: 묶음 안에서는 Solapi를 여전히 한 명씩 호출한다(멱등·SENDING 단위 유지). 다건 발송은 별도 과제.
const PROCESS_BATCH_SIZE = 20;

@Injectable()
export class AdminGroupMessageService {
  private readonly logger = new Logger(AdminGroupMessageService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: AdminGroupMessageStore,
    @Inject(GROUP_MESSAGE_SENDER) private readonly sender: GroupMessageSender,
    private readonly kakao: KakaoSenderProvider,
    private readonly features: ExpoFeaturePolicyProvider,
  ) {}

  configResponse() {
    const settings = this.config.adminGroupMessaging;
    const kakao = settings?.kakao;
    return {
      enabled: settings?.enabled === true,
      targetContracts: ['PREREGISTRATION_GROUP_MESSAGE_V1'],
      channels: {
        SMS: { enabled: settings?.enabled === true },
        KAKAO: {
          enabled:
            settings?.enabled === true &&
            kakao?.enabled === true &&
            kakao.templates.length > 0,
          templates:
            kakao?.enabled === true
              ? kakao.templates.map((template) => ({
                  id: template.id,
                  name: template.name,
                  content: template.content,
                  variableMapping: template.variableMapping,
                  fixedVariables: template.fixedVariables,
                  variables: Object.keys(template.variableMapping),
                }))
              : [],
        },
      },
      smsFallbackDefault: false,
    };
  }

  async createPreview(input: CreateGroupMessagePreview) {
    this.assertEnabled();
    this.assertContents(input);
    const preview = await this.store.createPreview(input);
    if (!preview) throw new GoneException('preview request has expired');
    if (!this.samePreview(preview, input))
      throw new ConflictException('requestId was already used');
    return this.previewResponse(preview);
  }

  async execute(previewId: string, authorization: AuthorizeGroupMessage) {
    const existing = await this.store.getJobForPreview(previewId);
    if (existing) {
      this.assertJobBinding(existing, authorization);
      if (existing.targetFingerprint !== authorization.targetFingerprint)
        throw new ConflictException('target fingerprint changed');
      // 남은 대상을 다시 보내는 재개만 막는다. 끝난 작업의 멱등 재호출은 작업 응답을 그대로 준다.
      if (existing.targets.some((target) => target.status === 'PENDING'))
        await this.assertBulkMessageOn(authorization.expoId);
      await this.refreshPendingAuthorization(existing.jobId);
      return this.jobResponse(
        (await this.store.getJob(existing.jobId)) ?? existing,
      );
    }
    const preview = await this.preview(previewId);
    this.assertBinding(preview, authorization);
    await this.assertBulkMessageOn(authorization.expoId);
    const job = await this.store.createJob(preview);
    await this.refreshPendingAuthorization(job.jobId);
    return this.jobResponse((await this.store.getJob(job.jobId)) ?? job);
  }

  async getJob(
    jobId: string,
    binding: { requesterUserId: number; expoId: string },
  ) {
    const job = await this.store.getJob(jobId);
    if (!job) throw new NotFoundException();
    this.assertJobBinding(job, binding);
    return this.jobResponse(job);
  }

  async retryFailures(jobId: string, authorization: AuthorizeGroupMessage) {
    const job = await this.store.getJob(jobId);
    if (!job) throw new NotFoundException();
    this.assertJobBinding(job, authorization);
    if (job.targetFingerprint !== authorization.targetFingerprint)
      throw new ConflictException('target fingerprint changed');
    if (!job.targets.some((target) => target.status === 'FAILED'))
      return this.jobResponse(job);
    await this.assertBulkMessageOn(authorization.expoId);
    const token = await this.store.claim(jobId);
    if (!token) return this.jobResponse(job);
    try {
      const current = await this.store.getJob(jobId);
      if (!current) throw new NotFoundException();
      if (!current.targets.some((target) => target.status === 'FAILED'))
        return this.jobResponse(current);
      const updated: GroupMessageJob = {
        ...current,
        authorizedUntil: this.authorizedUntil(),
        reason: undefined,
        targets: current.targets.map((target) =>
          target.status === 'FAILED'
            ? {
                ...target,
                status: 'PENDING' as const,
                attemptId: undefined,
                attemptedAt: undefined,
                groupId: undefined,
                messageId: undefined,
                deliveryCheckedAt: undefined,
                providerCode: undefined,
                failureReason: undefined,
              }
            : target,
        ),
      };
      updated.status = this.jobStatus(updated);
      const saved = await this.store.saveRetry(
        updated,
        token,
        authorization.idempotencyKey,
      );
      return this.jobResponse(
        saved ? updated : ((await this.store.getJob(jobId)) ?? current),
      );
    } finally {
      await this.store.release(jobId, token);
    }
  }

  async process(jobId: string): Promise<boolean> {
    const token = await this.store.claim(jobId);
    if (!token) return false;
    try {
      const job = await this.store.getJob(jobId);
      if (!job) {
        await this.store.removeDue(jobId);
        return false;
      }
      const interrupted = job.targets.find(
        (target) => target.status === 'SENDING',
      );
      if (interrupted) {
        interrupted.status = 'UNKNOWN';
        interrupted.failureReason = 'PROVIDER_ACCEPTANCE_UNKNOWN';
        job.status = this.jobStatus(job);
        await this.store.save(job, token);
        return false;
      }
      let index = this.nextPending(job, 0);
      if (index < 0) {
        const accepted = job.targets
          .filter((target) => target.status === 'ACCEPTED')
          .sort((left, right) =>
            (left.deliveryCheckedAt ?? '').localeCompare(
              right.deliveryCheckedAt ?? '',
            ),
          )
          .slice(0, 20);
        await Promise.all(
          accepted.map(async (target) => {
            await this.checkDelivery(job, target);
            target.deliveryCheckedAt = new Date().toISOString();
          }),
        );
        job.status = this.jobStatus(job);
        await this.store.save(job, token);
        return false;
      }
      // 한 번 claim으로 최대 PROCESS_BATCH_SIZE명을 처리한다. 대상별 상태는 saveTarget(O(1))으로만 쓰고,
      // 전체 job은 읽기·저장을 묶음당 한 번만 한다. SENDING 기록이 발송보다 먼저라 중단 시 재발송하지 않는다.
      for (let handled = 0; ;) {
        const pending = job.targets[index];
        if (Date.now() >= Date.parse(job.authorizedUntil)) {
          job.status = 'PAUSED';
          job.reason = 'AUTHORIZATION_EXPIRED';
          await this.store.save(job, token, 0);
          return false;
        }
        if (!this.sendConfigurationAvailable(job, pending)) {
          job.status = 'PAUSED';
          job.reason = 'CHANNEL_CONFIGURATION_UNAVAILABLE';
          await this.store.save(job, token, 0);
          return false;
        }
        // 묶음(PROCESS_BATCH_SIZE명)마다 첫 공급자 호출 직전에 BULK_MESSAGE를 한 번 확인한다. OFF면 남은 PENDING을
        // 그대로 두고 PAUSED(FEATURE_DISABLED)로 큐에서 뺀다. 다시 켜기만 해서는 재개하지 않고 명시적 실행(execute)이 필요하다.
        // 조회 실패면 보내지 않고 5초 뒤 다시 본다. 승인 만료(authorizedUntil)가 재시도 상한이다.
        // ponytail: 묶음 안에서는 OFF가 늦게 반영된다(최대 PROCESS_BATCH_SIZE-1명). 더 빨라야 하면 묶음을 줄인다.
        if (handled === 0) {
          const enabled = await this.features.enabledOrUnavailable(
            job.expoId,
            'BULK_MESSAGE',
          );
          if (enabled === false) {
            job.status = 'PAUSED';
            job.reason = 'FEATURE_DISABLED';
            await this.store.save(job, token, 0);
            return false;
          }
          if (enabled === undefined) {
            this.logger.warn(
              `단체 발송 기능 정책 조회 실패, 5초 뒤 재확인: jobId=${jobId}`,
            );
            job.status = this.jobStatus(job);
            job.reason = 'FEATURE_POLICY_UNAVAILABLE';
            await this.store.save(job, token, Date.now() + 5000);
            return false;
          }
          if (job.reason === 'FEATURE_POLICY_UNAVAILABLE')
            job.reason = undefined;
        }
        // 묶음의 첫 발송 전에 RUNNING과 큐 위치를 한 번 저장한다. 그래야 묶음 처리 중 상태 조회가
        // 이전 상태(QUEUED 등)를 보이지 않고, 묶음이 중간에 던져도 RUNNING이 남는다.
        if (handled === 0 && job.status !== 'RUNNING') {
          job.status = 'RUNNING';
          await this.store.save(job, token, Date.now());
        }
        const sending: GroupMessageTargetRecord = {
          ...pending,
          status: 'SENDING',
          attemptId: randomUUID(),
          attemptedAt: new Date().toISOString(),
          providerCode: undefined,
          failureReason: undefined,
        };
        job.targets[index] = sending;
        job.status = 'RUNNING';
        await this.store.saveTarget(jobId, token, sending);
        const receipt = await this.sender.send(job, sending);
        if (receipt.kind === 'accepted') {
          sending.status = 'ACCEPTED';
          sending.groupId = receipt.groupId;
          sending.messageId = receipt.messageId;
        } else if (receipt.kind === 'rejected') {
          sending.status = 'FAILED';
          sending.providerCode = receipt.code;
          sending.failureReason = 'PROVIDER_CONFIRMED_FAILURE';
        } else {
          sending.status = 'UNKNOWN';
          sending.failureReason = 'PROVIDER_ACCEPTANCE_UNKNOWN';
        }
        await this.store.saveTarget(jobId, token, sending);
        // ACCEPTED를 저장한 뒤에 보낸다. 상태·전달 확인은 문자 messageId만 따르고, 카톡 실패는 재시도하지 않는다.
        const kakaoMessage =
          receipt.kind === 'accepted'
            ? groupKakaoMessage(this.config, job, sending)
            : undefined;
        if (kakaoMessage && sending.attemptId) {
          await this.kakao.send([kakaoMessage], {
            jobId: job.jobId,
            targetId: sending.targetId,
            attemptId: sending.attemptId,
          });
        }
        handled += 1;
        index = this.nextPending(job, index + 1);
        if (index < 0 || handled >= PROCESS_BATCH_SIZE) break;
      }
      job.status = this.jobStatus(job);
      await this.store.save(job, token);
      return index >= 0;
    } finally {
      await this.store.release(jobId, token);
    }
  }

  // 새 발송(작업 생성·PENDING 재개·실패 재시도)만 막는다. 미리보기·설정·작업 조회·결과 수집은 OFF여도 허용한다.
  private async assertBulkMessageOn(expoId: string): Promise<void> {
    let enabled: boolean;
    try {
      enabled = await this.features.enabled(expoId, 'BULK_MESSAGE');
    } catch (error) {
      if (!(error instanceof InternalCallError)) throw error;
      if (error.status === 404) throw new NotFoundException();
      throw new ServiceUnavailableException(
        'expo feature policy is unavailable',
      );
    }
    if (!enabled)
      throw new ConflictException({
        statusCode: 409,
        message: 'BULK_MESSAGE feature is disabled',
        error: 'Conflict',
        code: 'FEATURE_DISABLED',
      });
  }

  private nextPending(job: GroupMessageJob, from: number): number {
    for (let index = from; index < job.targets.length; index += 1)
      if (job.targets[index].status === 'PENDING') return index;
    return -1;
  }

  private async checkDelivery(
    job: GroupMessageJob,
    target: GroupMessageTargetRecord,
  ): Promise<void> {
    const result = await this.sender.delivery(job, target);
    if (!result) return;
    target.providerCode = result.code;
    if (result.kind === 'delivered') target.status = 'DELIVERED';
    if (result.kind === 'failed') {
      target.status = 'FAILED';
      target.failureReason = 'PROVIDER_CONFIRMED_FAILURE';
    }
  }

  private sendConfigurationAvailable(
    job: GroupMessageJob,
    target: GroupMessageTargetRecord,
  ): boolean {
    if (!this.config.adminGroupMessaging?.enabled) return false;
    if (job.channel === 'SMS') return true;
    const template = this.config.adminGroupMessaging.kakao?.templates.find(
      (candidate) => candidate.id === job.templateId,
    );
    if (
      !this.config.adminGroupMessaging.kakao?.enabled ||
      !template ||
      !target.content
    )
      return false;
    const resolved = groupTemplateVariables(template, target.templateVariables);
    if ('missing' in resolved) return false;
    return (
      renderTemplate(template.content, resolved.variables) === target.content
    );
  }

  private async refreshPendingAuthorization(jobId: string): Promise<void> {
    const token = await this.store.claim(jobId);
    if (!token) return;
    try {
      const job = await this.store.getJob(jobId);
      if (!job) return;
      if (!job.targets.some((target) => target.status === 'PENDING')) return;
      job.authorizedUntil = this.authorizedUntil();
      job.reason = undefined;
      job.status = this.jobStatus(job);
      await this.store.save(job, token, Date.now());
    } finally {
      await this.store.release(jobId, token);
    }
  }

  private async preview(id: string): Promise<GroupMessagePreviewRecord> {
    const preview = await this.store.getPreview(id);
    if (preview) return preview;
    if (await this.store.isKnownPreview(id))
      throw new GoneException('preview expired');
    throw new NotFoundException();
  }

  private assertEnabled(): void {
    if (!this.config.adminGroupMessaging?.enabled)
      throw new UnprocessableEntityException(
        'admin group messaging is disabled',
      );
  }

  private assertContents(input: CreateGroupMessagePreview): void {
    for (const target of input.targets) {
      if (!target.content) continue;
      if (
        input.channel === 'SMS' &&
        Buffer.byteLength(target.content, 'utf8') > 2000
      )
        throw new UnprocessableEntityException('SMS exceeds 2000 UTF-8 bytes');
      if (input.channel === 'KAKAO' && Array.from(target.content).length > 1000)
        throw new UnprocessableEntityException(
          'Kakao message exceeds 1000 characters',
        );
    }
    if (input.channel !== 'KAKAO') return;
    const template = this.config.adminGroupMessaging?.kakao?.templates.find(
      (candidate) => candidate.id === input.templateId,
    );
    if (!this.config.adminGroupMessaging?.kakao?.enabled || !template)
      throw new UnprocessableEntityException(
        'Kakao template is not configured',
      );
    for (const target of input.targets) {
      if (target.missingReason) continue;
      const resolved = groupTemplateVariables(
        template,
        target.templateVariables,
      );
      if ('missing' in resolved)
        throw new UnprocessableEntityException(
          `missing Kakao variable: ${resolved.missing}`,
        );
      if (
        renderTemplate(template.content, resolved.variables) !== target.content
      )
        throw new UnprocessableEntityException(
          'rendered Kakao content does not match approved template',
        );
    }
  }

  private assertBinding(
    preview: GroupMessagePreviewRecord,
    input: AuthorizeGroupMessage,
  ): void {
    if (
      preview.requesterUserId !== input.requesterUserId ||
      preview.expoId !== input.expoId ||
      preview.targetFingerprint !== input.targetFingerprint
    )
      throw new ConflictException('preview authorization changed');
  }

  private assertJobBinding(
    job: GroupMessageJob,
    input: { requesterUserId: number; expoId: string },
  ): void {
    if (
      job.requesterUserId !== input.requesterUserId ||
      job.expoId !== input.expoId
    )
      throw new ConflictException('job owner changed');
  }

  private samePreview(
    record: GroupMessagePreviewRecord,
    input: CreateGroupMessagePreview,
  ): boolean {
    const saved: CreateGroupMessagePreview = {
      requesterUserId: record.requesterUserId,
      expoId: record.expoId,
      requestId: record.requestId,
      applicationCount: record.applicationCount,
      targetFingerprint: record.targetFingerprint,
      channel: record.channel,
      templateId: record.templateId,
      fallbackToSms: record.fallbackToSms,
      targets: record.targets,
    };
    return JSON.stringify(saved) === JSON.stringify(input);
  }

  private authorizedUntil(): string {
    const seconds =
      this.config.adminGroupMessaging?.authorizationTtlSeconds ?? 300;
    return new Date(Date.now() + seconds * 1000).toISOString();
  }

  private jobStatus(job: GroupMessageJob): GroupMessageJob['status'] {
    if (job.targets.some((target) => target.status === 'UNKNOWN'))
      return 'ATTENTION';
    if (
      job.targets.some(
        (target) =>
          target.status === 'PENDING' ||
          target.status === 'SENDING' ||
          target.status === 'ACCEPTED',
      )
    )
      return 'RUNNING';
    if (job.targets.some((target) => target.status === 'FAILED'))
      return 'COMPLETED_WITH_FAILURES';
    return 'COMPLETED';
  }

  private previewResponse(preview: GroupMessagePreviewRecord) {
    const sendable = preview.targets.filter((target) => !target.missingReason);
    return {
      previewId: preview.previewId,
      targetFingerprint: preview.targetFingerprint,
      applicationCount: preview.applicationCount,
      recipientCount: new Set(
        sendable.map((target) => target.recipientPhone).filter(Boolean),
      ).size,
      messageCount: sendable.length,
      targetCount: preview.targets.length,
      sendableCount: sendable.length,
      missingCount: preview.targets.filter((target) => target.missingReason)
        .length,
      expiresAt: preview.expiresAt,
      items: preview.targets.map((target) => ({
        targetId: target.targetId,
        ledgerKey: target.ledgerKey,
        applicationId: target.applicationId,
        participantId: target.participantId,
        recipientMasked: target.recipientPhone
          ? maskPhone(target.recipientPhone)
          : undefined,
        content: target.content,
        missingReason: target.missingReason,
      })),
    };
  }

  private jobResponse(job: GroupMessageJob) {
    const count = (status: GroupMessageJob['targets'][number]['status']) =>
      job.targets.filter((target) => target.status === status).length;
    return {
      jobId: job.jobId,
      previewId: job.previewId,
      status: job.status,
      reason: job.reason,
      createdAt: job.createdAt,
      counts: {
        total: job.targets.length,
        pending: count('PENDING'),
        sending: count('SENDING'),
        accepted: count('ACCEPTED'),
        delivered: count('DELIVERED'),
        failed: count('FAILED'),
        unknown: count('UNKNOWN'),
        missing: count('MISSING'),
      },
      items: job.targets.map((target) => ({
        targetId: target.targetId,
        ledgerKey: target.ledgerKey,
        applicationId: target.applicationId,
        participantId: target.participantId,
        recipientMasked: target.recipientPhone
          ? maskPhone(target.recipientPhone)
          : undefined,
        status: target.status,
        providerCode: target.providerCode,
        failureReason: target.failureReason,
        missingReason: target.missingReason,
      })),
    };
  }
}
