import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { OneBot12Adapter } from "../../plugins/adapter/onebot12/adapter.js"

export const self = { platform: "qq", user_id: "12345" }
export const HOLD = Symbol("hold")
export function event(type, detail_type, fields = {}) {
  return {
    id: "event-1",
    time: 1.25,
    type,
    detail_type,
    sub_type: "",
    ...(type === "meta" ? {} : { self }),
    ...fields,
  }
}
export const connect = () =>
  event("meta", "connect", { version: { impl: "test", version: "1", onebot_version: "12" } })
export const message = fields =>
  event("message", "private", {
    user_id: "user",
    message_id: "msg",
    alt_message: "hello",
    message: [{ type: "text", data: { text: "hello" } }],
    ...fields,
  })
export function method(filename, name, bindings = {}) {
  const source = readFileSync(new URL(`../../${filename}`, import.meta.url), "utf8")
  const match = source.match(new RegExp(`^  ${name}\\([^]*?^  \\}`, "m"))
  if (!match) throw new Error(`Missing method ${name}`)
  return new Function(...Object.keys(bindings), `return function ${match[0].trim()}`)(
    ...Object.values(bindings),
  )
}
export function makeBot() {
  const bot = new EventEmitter()
  Object.assign(bot, {
    bots: {},
    uin: [],
    wsf: Object.create(null),
    wsGuards: Object.create(null),
    logs: [],
    makeLog(...args) {
      this.logs.push(args)
    },
    async fileToUrl(file) {
      this.lastFile = file
      return "http://files.test/download"
    },
    makeForwardMsg: value => value,
  })
  bot.prepareEvent = method("lib/bot.js", "prepareEvent", {
    segment: { file: (file, name) => ({ type: "file", file, name }) },
  })
  bot.em = method("lib/bot.js", "em")
  bot.cleanupBotConnection = method("lib/bot.js", "cleanupBotConnection")
  return bot
}
export function defaults(request) {
  switch (request.action) {
    case "get_status":
      return { good: true, bots: [{ self, online: true }] }
    case "get_supported_actions":
      return [
        "get_status",
        "get_version",
        "get_supported_actions",
        "get_self_info",
        "get_friend_list",
        "get_group_list",
        "get_group_member_list",
        "get_group_member_info",
        "get_user_info",
        "get_group_info",
        "send_message",
        "delete_message",
        "upload_file",
        "get_file",
        "set_group_name",
        "leave_group",
      ]
    case "get_self_info":
      return { user_id: request.self.user_id, user_name: "Test Bot", user_displayname: "" }
    case "get_user_info":
    case "get_group_member_info":
      return {
        user_id: request.params.user_id,
        user_name: "User",
        user_displayname: "Display",
        user_remark: "",
      }
    case "get_group_info":
      return { group_id: request.params.group_id, group_name: "Group" }
    case "get_friend_list":
    case "get_group_list":
    case "get_group_member_list":
      return []
    case "send_message":
      return { message_id: "90071992547409931234", time: 1.75 }
    case "upload_file":
      return { file_id: "file-1" }
    case "get_file":
      return { name: "image.png", url: "https://files.test/image.png" }
    default:
      return null
  }
}
export class Socket extends EventEmitter {
  readyState = 1
  requests = []
  constructor(respond = defaults) {
    super()
    this.respond = respond
  }
  send(frame, callback) {
    const request = JSON.parse(frame)
    this.requests.push(request)
    callback?.()
    Promise.resolve()
      .then(() => this.respond(request))
      .then(data => {
        if (data !== HOLD && this.readyState === 1) this.response(request, data)
      })
      .catch(err => this.emit("error", err))
  }
  response(request, data, failure) {
    this.push({
      status: failure ? "failed" : "ok",
      retcode: failure || 0,
      data,
      message: failure ? "unsupported" : "",
      echo: request.echo,
    })
  }
  push(data) {
    this.emit("message", Buffer.from(JSON.stringify(data)), false)
  }
  terminate() {
    if (this.readyState !== 3) {
      this.readyState = 3
      this.emit("close")
    }
  }
}
export async function until(predicate) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return
    await delay(5)
  }
  throw new Error("Condition timed out")
}
export async function fixture(t, options = {}) {
  const Bot = makeBot()
  const adapter = new OneBot12Adapter(
    Bot,
    { enable: true, action_timeout: 150, ...options.config },
    options.fetch,
  )
  adapter.load()
  const ws = new Socket(options.respond)
  const session = adapter.accept(ws, { headers: { "sec-websocket-protocol": "12.test" } })
  t.after(() => {
    for (const session of [...adapter.sessions]) session.ws.terminate()
  })
  if (options.start !== false) {
    ws.push(connect())
    await until(() => session.ready)
    await until(() => !session.pending.size)
  }
  return { Bot, adapter, ws, session, bot: Object.values(Bot.bots)[0] }
}
