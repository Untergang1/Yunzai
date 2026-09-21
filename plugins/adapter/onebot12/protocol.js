import { timingSafeEqual } from "node:crypto"

export const META_ACTIONS = new Set([
  "get_latest_events",
  "get_supported_actions",
  "get_status",
  "get_version",
])
export const isObject = value =>
  value !== null && typeof value === "object" && !Array.isArray(value)
export const isSelf = value =>
  isObject(value) &&
  typeof value.platform === "string" &&
  value.platform.length > 0 &&
  typeof value.user_id === "string" &&
  value.user_id.length > 0
const encode = value => encodeURIComponent(value).replace(/\./g, "%2E")
export function botId(self) {
  if (!isSelf(self)) throw new TypeError("Invalid OneBot self")
  return `ob12/${encode(self.platform)}/${encode(self.user_id)}`
}
export function id(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value)
  if (typeof value !== "string" || !value.length)
    throw new TypeError("ID must be a nonempty string or safe integer")
  return value
}
export function error(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}
export function validateStatus(status) {
  return (
    isObject(status) &&
    typeof status.good === "boolean" &&
    Array.isArray(status.bots) &&
    status.bots.every(bot => isObject(bot) && isSelf(bot.self) && typeof bot.online === "boolean")
  )
}
export function validateEvent(event) {
  if (
    !isObject(event) ||
    typeof event.id !== "string" ||
    typeof event.time !== "number" ||
    !Number.isFinite(event.time) ||
    !["meta", "message", "notice", "request"].includes(event.type) ||
    typeof event.detail_type !== "string" ||
    typeof event.sub_type !== "string"
  )
    return false
  if (event.type !== "meta" && !isSelf(event.self)) return false
  if (event.type === "message" && ["private", "group"].includes(event.detail_type)) {
    if (
      typeof event.message_id !== "string" ||
      typeof event.user_id !== "string" ||
      typeof event.alt_message !== "string" ||
      !Array.isArray(event.message) ||
      !event.message.every(
        segment => isObject(segment) && typeof segment.type === "string" && isObject(segment.data),
      )
    )
      return false
    if (event.detail_type === "group" && typeof event.group_id !== "string") return false
  }
  return true
}
export function validateResponse(response) {
  return (
    isObject(response) &&
    ["ok", "failed"].includes(response.status) &&
    Number.isSafeInteger(response.retcode) &&
    Object.hasOwn(response, "data") &&
    typeof response.message === "string" &&
    typeof response.echo === "string"
  )
}

// A route guard runs before handleUpgrade. The existing server-wide auth still applies.
export function verifyRequest(req, config) {
  const url = new URL(req.url, "http://localhost")
  if (url.pathname !== "/OneBotv12") return { statusCode: 404, message: "Not Found" }
  const protocol = req.headers["sec-websocket-protocol"]
  if (typeof protocol !== "string" || !/^12\.[a-z0-9][a-z0-9._-]*$/.test(protocol))
    return { statusCode: 400, message: "Invalid OneBot subprotocol" }
  if (config.access_token) {
    const auth = req.headers.authorization
    const token =
      auth === undefined
        ? url.searchParams.get("access_token")
        : typeof auth === "string" && auth.startsWith("Bearer ")
          ? auth.slice(7)
          : null
    const expected = Buffer.from(config.access_token)
    const actual = Buffer.from(token ?? "")
    if (token === null || expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return { statusCode: 401, message: "Unauthorized" }
  }
}
