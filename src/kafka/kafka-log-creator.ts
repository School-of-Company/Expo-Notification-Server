import { Logger } from '@nestjs/common';
import { logLevel } from 'kafkajs';
import type { LogEntry } from 'kafkajs';

const logger = new Logger('kafkajs');

/**
 * Sends kafkajs logs through the Nest logger. kafkajs' default logger writes
 * its own JSON (`timestamp`, `logger`) to stderr, without the standard
 * `service`/`module` keys (CLAUDE.md "Logging"). `module` is `kafkajs`.
 */
export function kafkaLogCreator() {
  return ({ namespace, level, log }: LogEntry): void => {
    const { message } = log;
    // timestamp/logger duplicate the standard keys; the rest is call context.
    const extra = Object.fromEntries(
      Object.entries(log).filter(
        ([key]) => !['message', 'timestamp', 'logger'].includes(key),
      ),
    );
    const detail =
      Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
    // Some messages (the partitioner notice) arrive without a namespace.
    const prefix = namespace ? `[${namespace}] ` : '';
    const text = `${prefix}${message}${detail}`;
    switch (level) {
      case logLevel.ERROR:
        logger.error(text);
        break;
      case logLevel.WARN:
        logger.warn(text);
        break;
      case logLevel.INFO:
        logger.log(text);
        break;
      case logLevel.DEBUG:
        logger.debug(text);
        break;
      case logLevel.NOTHING:
        break;
    }
  };
}
