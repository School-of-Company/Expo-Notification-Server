import { Module } from '@nestjs/common';
import {
  AdminGroupMessageController,
  AdminGroupMessageInternalGuard,
} from './admin-group-message.controller';
import { AdminGroupMessageScheduler } from './admin-group-message.scheduler';
import { AdminGroupMessageService } from './admin-group-message.service';
import { AdminGroupMessageStore } from './admin-group-message.store';
import { GroupMessageSolapiProvider } from './group-message-solapi.provider';
import { GROUP_MESSAGE_SENDER } from './group-message-sender.interface';
import {
  AdminGroupMessageHistoryController,
  AdminGroupMessageHistoryInternalGuard,
} from './admin-group-message-history.controller';
import { AdminGroupMessageHistoryService } from './admin-group-message-history.service';
import { AdminGroupMessageHistoryStore } from './admin-group-message-history.store';

@Module({
  controllers: [
    AdminGroupMessageController,
    AdminGroupMessageHistoryController,
  ],
  providers: [
    AdminGroupMessageInternalGuard,
    AdminGroupMessageScheduler,
    AdminGroupMessageService,
    AdminGroupMessageStore,
    AdminGroupMessageHistoryStore,
    AdminGroupMessageHistoryService,
    AdminGroupMessageHistoryInternalGuard,
    GroupMessageSolapiProvider,
    { provide: GROUP_MESSAGE_SENDER, useExisting: GroupMessageSolapiProvider },
  ],
})
export class AdminGroupMessageModule {}
