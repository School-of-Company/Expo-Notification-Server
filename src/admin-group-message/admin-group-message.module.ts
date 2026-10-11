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

@Module({
  controllers: [AdminGroupMessageController],
  providers: [
    AdminGroupMessageInternalGuard,
    AdminGroupMessageScheduler,
    AdminGroupMessageService,
    AdminGroupMessageStore,
    GroupMessageSolapiProvider,
    { provide: GROUP_MESSAGE_SENDER, useExisting: GroupMessageSolapiProvider },
  ],
})
export class AdminGroupMessageModule {}
