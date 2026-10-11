import { createServer, type Server } from 'node:http';
import { ParticipantNamesProvider } from '../src/sms/participant-names.provider';
import { createAppConfig } from './fixtures/app-config.fixture';

describe('User names HTTP boundary', () => {
  let server: Server;
  let provider: ParticipantNamesProvider;
  let stallBody = false;
  const received: {
    path: string;
    token: string | string[] | undefined;
    body: string;
  }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push({
          path: req.url ?? '',
          token: req.headers['x-internal-token'],
          body,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (stallBody) {
          res.write('[');
          return;
        }
        res.end(JSON.stringify([{ participantId: 42, name: '홍길동' }]));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('HTTP listener unavailable');
    const config = createAppConfig({
      user: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        internalToken: 'a'.repeat(32),
      },
    });
    provider = new ParticipantNamesProvider(config);
  });
  beforeEach(() => {
    stallBody = false;
    received.length = 0;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('실제 HTTP에 POST/토큰/본문을 보내고 이름 응답을 읽는다', async () => {
    const names = await provider.findNames({
      expoId: 'expo-1',
      participantIds: [42],
    });
    expect(names.get(42)).toBe('홍길동');
    expect(received).toEqual([
      {
        path: '/internal/standard-participants/names',
        token: 'a'.repeat(32),
        body: JSON.stringify({ expoId: 'expo-1', participantIds: [42] }),
      },
    ]);
  });

  it('응답 헤더 후 본문이 멈춰도 2초 timeout으로 fallback한다', async () => {
    stallBody = true;
    const started = performance.now();
    const names = await provider.findNames({
      expoId: 'expo-1',
      participantIds: [42],
    });
    expect(names.size).toBe(0);
    expect(performance.now() - started).toBeLessThan(4000);
    expect(received).toHaveLength(1);
  }, 5000);
});
