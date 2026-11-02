import { RedisOptions } from 'ioredis';
import { AppConfig } from '../config/app-config';

// Redis 장애 시 POST /sms와 컨슈머가 수십 초 매달리지 않도록 연결·명령 타임아웃과 재시도 상한을 둔다(#130).
// ponytail: 명령 타임아웃은 Redis 쪽 실행을 취소하지 않는다. 쓰기 명령이 적용된 뒤에도 실패로 보일 수 있어
//   상태 전이 경로는 "결과 불명"으로 다뤄야 한다. 큰 Lua를 쓰는 경로가 생기면 별도 타임아웃이 필요하다.
export function buildRedisOptions(redis: AppConfig['redis']): RedisOptions {
  return {
    host: redis.host,
    port: redis.port,
    password: redis.password,
    connectTimeout: redis.connectTimeoutMs,
    commandTimeout: redis.commandTimeoutMs,
    maxRetriesPerRequest: redis.maxRetriesPerRequest,
    // 재연결 간격은 최대 2초로 묶는다.
    retryStrategy: (times) => Math.min(times * 200, 2000),
  };
}
