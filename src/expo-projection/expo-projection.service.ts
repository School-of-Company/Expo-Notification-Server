import { Injectable, Logger } from '@nestjs/common';
import { ExpoChangedEvent, ProjectedExpo } from './expo-changed.schema';
import { ExpoProjectionStore } from './expo-projection.store';

export function toProjectedExpo(event: ExpoChangedEvent): ProjectedExpo | null {
  if (event.deleted) return null;
  return {
    expoId: event.expoId,
    title: event.expo.title,
    startedDay: event.expo.startedDay,
    finishedDay: event.expo.finishedDay,
    deleting: event.expo.deleting,
    sessions: event.preregisterSessions.map(({ id, title }) => ({ id, title })),
  };
}

@Injectable()
export class ExpoProjectionService {
  private readonly logger = new Logger(ExpoProjectionService.name);

  constructor(private readonly store: ExpoProjectionStore) {}

  /** 메시지 하나가 그 박람회의 전부다. 저장된 version 이하인 메시지는 버린다. */
  async apply(event: ExpoChangedEvent): Promise<boolean> {
    const applied = await this.store.apply(
      event.expoId,
      event.version,
      toProjectedExpo(event),
    );
    if (!applied) {
      this.logger.log(
        `이미 반영한 버전 이하라 무시: expoId=${event.expoId}, version=${event.version}, eventId=${event.eventId}`,
      );
    }
    return applied;
  }
}
