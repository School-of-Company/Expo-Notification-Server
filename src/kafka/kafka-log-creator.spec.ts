import { Logger } from '@nestjs/common';
import { logLevel } from 'kafkajs';
import { kafkaLogCreator } from './kafka-log-creator';

describe('kafkaLogCreator', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps kafkajs levels to the Nest logger with module kafkajs', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const write = kafkaLogCreator();
    const entry = {
      namespace: 'Connection',
      label: 'ERROR',
      log: {
        timestamp: '2026-01-01T00:00:00.000Z',
        logger: 'kafkajs',
        message: 'Connection error',
        broker: 'localhost:9092',
      },
    };

    write({ ...entry, level: logLevel.ERROR });
    write({ ...entry, level: logLevel.WARN });
    write({ ...entry, level: logLevel.INFO });
    write({ ...entry, level: logLevel.NOTHING });

    expect(error).toHaveBeenCalledWith(
      '[Connection] Connection error {"broker":"localhost:9092"}',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect((error.mock.contexts[0] as { context?: string }).context).toBe(
      'kafkajs',
    );
  });
});
