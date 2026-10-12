import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { GroupMessageHistoryQuery } from './admin-group-message-history.schema';
import { AdminGroupMessageHistoryStore } from './admin-group-message-history.store';

@Injectable()
export class AdminGroupMessageHistoryService {
  constructor(private readonly store: AdminGroupMessageHistoryStore) {}

  async list(expoId: string, query: GroupMessageHistoryQuery) {
    const from = query.from ? Date.parse(query.from) : undefined;
    const to = query.to ? Date.parse(query.to) : undefined;
    if (from !== undefined && (from < 0 || from > 9_999_999_999_999))
      throw new BadRequestException('from is outside the supported range');
    if (to !== undefined && (to < 0 || to > 9_999_999_999_999))
      throw new BadRequestException('to is outside the supported range');
    if (from !== undefined && to !== undefined && from >= to)
      throw new BadRequestException('from must be earlier than to');
    try {
      return await this.store.list(expoId, query);
    } catch {
      throw new ServiceUnavailableException(
        'group message history unavailable',
      );
    }
  }
}
