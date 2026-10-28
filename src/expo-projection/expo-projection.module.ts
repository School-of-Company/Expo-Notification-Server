import { Module } from '@nestjs/common';
import { ExpoChangedConsumer } from './expo-changed.consumer';
import { ExpoProjectionService } from './expo-projection.service';
import { ExpoProjectionStore } from './expo-projection.store';
import { ExpoReadProvider } from './expo-read.provider';

@Module({
  providers: [
    ExpoProjectionStore,
    ExpoProjectionService,
    ExpoChangedConsumer,
    ExpoReadProvider,
  ],
  exports: [ExpoReadProvider],
})
export class ExpoProjectionModule {}
