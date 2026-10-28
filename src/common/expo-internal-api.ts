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
