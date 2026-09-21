// Shared upgrade routing. No application imports: this can be exercised with a local WS server.
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
function reject(socket, statusCode, message) {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}
export function upgrade(
  bot,
  req,
  socket,
  head,
  authKeys = [],
  log,
  stringify = value => (typeof value === "string" ? value : JSON.stringify(value)),
) {
  req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers["sec-websocket-key"]}`
  let url
  try {
    url = new URL(req.url, `ws://${req.headers.host || "localhost"}`)
  } catch {
    return reject(socket, 400, "Bad Request")
  }
  req.query = Object.fromEntries(url.searchParams.entries())
  req.sid = logUrl(url, authKeys)
  if (bot.serverAuth(req) === false) return reject(socket, 401, "Unauthorized")
  const context = requestLog(req, authKeys)
  const path = url.pathname.split("/")[1]
  if (!(path in bot.wsf)) {
    log("error", ["WebSocket 处理器", path, "不存在", context], `${req.sid} <≠> ${req.rid}`, true)
    return reject(socket, 404, "Not Found")
  }
  const failure = bot.wsGuards?.[path]?.(req)
  if (failure) return reject(socket, failure.statusCode, failure.message)
  bot.wss.handleUpgrade(req, socket, head, conn => {
    log("mark", ["建立连接", context], `${req.sid} <=> ${req.rid}`, true)
    conn.on("error", (...args) => log("error", args, `${req.sid} <=> ${req.rid}`, true))
    conn.on("close", () => {
      log("mark", "断开连接", `${req.sid} <≠> ${req.rid}`, true)
      bot.cleanupBotConnection(conn)
    })
    // OB12 files carry Base64 bytes; log frame size only, including raw extension payloads.
    conn.on("message", msg =>
      log(
        "debug",
        ["消息", path === "OneBotv12" ? `${msg.length} bytes` : stringify(msg)],
        `${req.sid} <= ${req.rid}`,
        true,
      ),
    )
    conn.sendMsg = msg => {
      if (!Buffer.isBuffer(msg)) msg = stringify(msg)
      log(
        "debug",
        ["消息", path === "OneBotv12" ? `${msg.length} bytes` : msg],
        `${req.sid} => ${req.rid}`,
        true,
      )
      return conn.send(msg)
    }
    for (const handler of bot.wsf[path]) handler(conn, req, socket, head)
  })
}
