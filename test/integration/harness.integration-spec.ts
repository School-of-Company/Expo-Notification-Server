import * as childProcess from 'node:child_process';
import { LocalInfra, until } from './local-infra';

describe('integration container cleanup', () => {
  afterEach(() => jest.restoreAllMocks());

  it('attempts every owned container when one removal fails', async () => {
    const calls: string[][] = [];
    const docker = jest.spyOn(childProcess, 'execFileSync');
    docker.mockImplementation((_command, args) => {
      const argv = [...(args ?? [])];
      calls.push(argv);
      if (argv[0] === 'run')
        return `${argv.includes('redis:7.4-alpine') ? 'redis-id' : 'kafka-id'}\n`;
      if (argv[0] === 'rm' && argv[2] === 'kafka-id')
        throw new Error('synthetic removal failure');
      return '';
    });
    const infra = new LocalInfra();
    jest.spyOn(infra, 'waitForReady').mockResolvedValue();
    await infra.start();
    expect(() => infra.stop()).toThrow();
    expect(
      calls.filter((args) => args[0] === 'rm').map((args) => args[2]),
    ).toEqual(['kafka-id', 'redis-id']);
  });

  it('fails immediately when the shared deadline has expired', async () => {
    await expect(until(() => false, Date.now() - 1)).rejects.toThrow(
      'integration condition timed out',
    );
  });
});
