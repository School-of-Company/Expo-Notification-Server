import { z } from 'zod';
import { getInternal, InternalCallError } from './internal-http';

export const expoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,36}$/);
const expoPage = z.object({
  content: z.array(
    z.object({ expoId: expoIdSchema, title: z.string().min(1) }),
  ),
  hasNext: z.boolean(),
});
const preregisterSessions = z.array(
  z.object({ id: z.number().int(), title: z.string().min(1) }),
);

export interface ActiveExpo {
  expoId: string;
  title: string;
}

export interface ExpoConnection {
  baseUrl: string;
  internalToken: string;
}

const PAGE_SIZE = 100;
// ponytail: 진행 중·예정 박람회가 1,000개를 넘으면 목록 조회가 실패한다. 그때 상한을 올린다.
const MAX_PAGES = 10;
const TIMEOUT_MS = 5_000;

/** Expo의 진행 중·예정 박람회 목록 전체 (`GET /internal/expo`). */
export async function fetchActiveExpos(
  connection: ExpoConnection,
): Promise<ActiveExpo[]> {
  const expos: ActiveExpo[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await getInternal(
      'expo',
      connection.baseUrl,
      `/internal/expo?page=${page}&size=${PAGE_SIZE}`,
      connection.internalToken,
      TIMEOUT_MS,
    );
    const parsed = expoPage.safeParse(await response.json());
    if (!parsed.success) {
      throw new InternalCallError('expo returned an invalid expo list');
    }
    expos.push(...parsed.data.content);
    if (!parsed.data.hasNext) return expos;
  }
  throw new InternalCallError(`expo list exceeded ${MAX_PAGES} pages`);
}

/** 박람회의 사전등록 회차 `id`→`title` (`GET /internal/expo/{id}/preregister-sessions`). */
export async function fetchPreregisterSessionTitles(
  connection: ExpoConnection,
  expoId: string,
): Promise<Map<number, string>> {
  const response = await getInternal(
    'expo',
    connection.baseUrl,
    `/internal/expo/${encodeURIComponent(expoId)}/preregister-sessions`,
    connection.internalToken,
    TIMEOUT_MS,
  );
  const parsed = preregisterSessions.safeParse(await response.json());
  if (!parsed.success) {
    throw new InternalCallError('expo returned invalid preregister sessions');
  }
  return new Map(parsed.data.map((session) => [session.id, session.title]));
}

export type ExpoFeatureKey = 'AUTO_NOTIFICATION' | 'BULK_MESSAGE';

const expoFeatures = z.object({
  features: z.array(
    z.object({ key: z.string(), effectiveEnabled: z.unknown() }),
  ),
});

/**
 * 박람회 기능의 실효 값 (`GET /internal/expo/{id}`의 `features`, Expo docs/expo-feature-settings.md).
 * `features`가 없거나(구형 Expo) 키가 없거나 boolean이 아니면 허용으로 보지 않고 InternalCallError를 던진다.
 */
export async function fetchExpoFeatureEnabled(
  connection: ExpoConnection,
  expoId: string,
  key: ExpoFeatureKey,
): Promise<boolean> {
  // URL 경로에 넣기 전에 화이트리스트로 검사한다(참가 등록 이벤트의 expoId는 형식 검증이 느슨하다).
  if (!expoIdSchema.safeParse(expoId).success)
    throw new InternalCallError('invalid expoId');
  const response = await getInternal(
    'expo',
    connection.baseUrl,
    `/internal/expo/${encodeURIComponent(expoId)}`,
    connection.internalToken,
    TIMEOUT_MS,
  );
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = expoFeatures.safeParse(body);
  const enabled = parsed.success
    ? parsed.data.features.find((feature) => feature.key === key)
        ?.effectiveEnabled
    : undefined;
  if (typeof enabled !== 'boolean') {
    throw new InternalCallError(`expo returned no ${key} feature`);
  }
  return enabled;
}
