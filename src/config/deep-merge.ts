type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function deepMerge(
  base: PlainObject,
  override: PlainObject,
): PlainObject {
  const merged: PlainObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === '__proto__') {
      continue;
    }
    const current = merged[key];
    merged[key] =
      isPlainObject(current) && isPlainObject(value)
        ? deepMerge(current, value)
        : value;
  }
  return merged;
}
