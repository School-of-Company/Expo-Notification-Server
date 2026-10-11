import { Kafka } from 'kafkajs';
import type { Consumer, ConsumerConfig } from 'kafkajs';

export class ObservedKafka extends Kafka {
  readonly fetches = new Map<string, number>();

  override consumer(config: ConsumerConfig): Consumer {
    const consumer = super.consumer(config);
    consumer.on(consumer.events.FETCH, () => {
      this.fetches.set(
        config.groupId,
        (this.fetches.get(config.groupId) ?? 0) + 1,
      );
    });
    return consumer;
  }
}
