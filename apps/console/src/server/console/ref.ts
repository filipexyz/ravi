const UUID_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidRef(value: string): boolean {
  return UUID_REF_PATTERN.test(value);
}
