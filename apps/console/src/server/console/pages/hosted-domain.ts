/** Installation configuration, never a substitute for the registered-site lookup. */
export function hostedPagesDomain(): string {
  const value = (process.env.RAVI_PAGES_HOSTED_DOMAIN ?? "ravi.page").trim().toLowerCase();
  if (!/^(?=.{1,190}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value)) {
    throw new Error("Invalid RAVI_PAGES_HOSTED_DOMAIN");
  }
  return value;
}
