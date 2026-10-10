// Log redaction for connection credentials. No application imports.
export function requestLog(req, authKeys = []) {
  const sensitive = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "access_token",
    ...authKeys.map(key => key.toLowerCase()),
  ])
  const redact = object =>
    Object.fromEntries(
      Object.entries(object || {}).map(([key, value]) => [
        key,
        sensitive.has(key.toLowerCase()) ? "[redacted]" : value,
      ]),
    )
  return {
    headers: redact(req.headers),
    ...(Object.keys(req.query || {}).length ? { query: redact(req.query) } : {}),
  }
}
export function logUrl(value, authKeys = []) {
  const url = new URL(value)
  const sensitive = new Set([
    "access_token",
    "authorization",
    ...authKeys.map(key => key.toLowerCase()),
  ])
  for (const key of url.searchParams.keys())
    if (sensitive.has(key.toLowerCase())) url.searchParams.set(key, "[redacted]")
  return url.toString()
}
