import { Account } from "./account.js"
import { Messages } from "./messages.js"
import { Session } from "./session.js"
import { botId, verifyRequest } from "./protocol.js"
import { WechatAIAccount, handleWechatAIEvent } from "./wechat-ai.js"

const notices = {
  friend_increase: ["friend", "increase"],
  friend_decrease: ["friend", "decrease"],
  private_message_delete: ["friend", "recall"],
  group_member_increase: ["group", "increase"],
  group_member_decrease: ["group", "decrease"],
  group_message_delete: ["group", "recall"],
}

export class OneBot12Adapter {
  id = "OneBotv12"
  name = "OneBotv12"
  path = "OneBotv12"
  sessions = new Set()
  owners = new Map()
  sequence = 0

  constructor(Bot, config = {}, fetch = globalThis.fetch) {
    this.Bot = Bot
    this.fetch = fetch
    this.config = {
      enable: false,
      access_token: "",
      action_timeout: 60000,
      max_file_size: 10485760,
      ...config,
    }
    this.messages = new Messages(this)
  }
  log(level, message, key = this.name) {
    this.Bot.makeLog(level, message, key)
  }
  load() {
    if (typeof this.config.enable !== "boolean") throw new TypeError("enable must be a boolean")
    if (!this.config.enable) return
    if (typeof this.config.access_token !== "string")
      throw new TypeError("access_token must be a string")
    for (const key of ["action_timeout", "max_file_size"])
      if (
        !Number.isSafeInteger(this.config[key]) ||
        this.config[key] <= 0 ||
        this.config[key] > 2147483647
      )
        throw new TypeError(`${key} must be a positive integer <= 2147483647`)
    this.Bot.wsGuards ||= Object.create(null)
    this.Bot.wsGuards[this.path] = req => verifyRequest(req, this.config)
    this.Bot.wsf[this.path] ||= []
    this.handler ||= (ws, req) => this.accept(ws, req)
    if (!this.Bot.wsf[this.path].includes(this.handler)) this.Bot.wsf[this.path].push(this.handler)
  }
  accept(ws, req) {
    const session = new Session(this, ws, req, ++this.sequence)
    this.sessions.add(session)
    return session
  }
  raw(session, event, bot) {
    handleWechatAIEvent(this, session, event)
    this.Bot.emit("onebot12.event", {
      event: structuredClone(event),
      bot,
      self_id: event.self ? botId(event.self) : undefined,
      version: session.version,
    })
  }
  updateAccount(session, item) {
    const key = botId(item.self)
    if (session.revoked.has(key)) return
    const owner = this.owners.get(key)
    if (owner && owner !== session) {
      if (owner.sequence > session.sequence) {
        session.revoked.add(key)
        return
      }
      owner.revoked.add(key)
      owner.rejectAccount(key)
      this.removeAccount(owner, key, owner.accounts.get(key))
    }
    this.owners.set(key, session)
    let bot = session.accounts.get(key)
    if (!item.online) {
      session.rejectAccount(key)
      this.removeAccount(session, key, bot)
      return
    }
    if (bot?.active) {
      Object.assign(bot.stat, item)
      return
    }
    const AccountClass =
      session.version.impl === "wechat-ai" && item.self.platform === "wechat"
        ? WechatAIAccount
        : Account
    bot = new AccountClass(this, session, key, item)
    session.accounts.set(key, bot)
    this.Bot.bots[key] = bot
    if (!this.Bot.uin.includes(key)) this.Bot.uin.push(key)
    this.log("mark", `${session.version.impl} ${session.version.version} 已连接`, key)
    this.Bot.em(`connect.${key}`, { self_id: key, self_user_id: bot.self.user_id, bot })
    bot.refresh().catch(err => this.log("warn", err.message, key))
  }
  removeAccount(session, key, bot) {
    if (!bot?.active) return
    bot.active = false
    bot.stat.online = false
    if (this.Bot.bots[key] === bot) {
      delete this.Bot.bots[key]
      for (let index = this.Bot.uin.length - 1; index >= 0; index--)
        if (this.Bot.uin[index] === key) this.Bot.uin.splice(index, 1)
      if (this.Bot.uin.now === key) delete this.Bot.uin.now
    }
    this.log("mark", "账号离线", key)
    this.Bot.em(`offline.${key}`, { self_id: key, self_user_id: bot.self.user_id, bot })
    session.accounts.delete(key)
  }
  async handleEvent(bot, source) {
    if (source.type === "message" && ["private", "group"].includes(source.detail_type)) {
      const message = await this.messages.decode(bot, source.message)
      if (!bot.isActive()) return
      const event = this.event(bot, source)
      Object.assign(event, {
        post_type: "message",
        message_type: source.detail_type,
        sub_type: source.sub_type,
        raw_message: source.alt_message,
        message,
      })
      this.Bot.em(
        `message.${event.message_type}${event.sub_type ? `.${event.sub_type}` : ""}`,
        event,
      )
    } else if (source.type === "notice" && notices[source.detail_type]) {
      const [notice_type, sub_type] = notices[source.detail_type]
      for (const key of [
        "user_id",
        ...(notice_type === "group" ? ["group_id"] : []),
        ...(sub_type === "recall" ? ["message_id"] : []),
      ])
        if (typeof source[key] !== "string") throw new TypeError(`Invalid notice ${key}`)
      if (
        notice_type === "group" &&
        sub_type !== "recall" &&
        typeof source.operator_id !== "string"
      )
        throw new TypeError("Invalid notice operator_id")
      if (notice_type === "friend" && sub_type !== "recall") bot.fl.delete(source.user_id)
      if (notice_type === "group" && sub_type !== "recall") {
        bot.gml.delete(source.group_id)
        if (source.user_id === bot.self.user_id) {
          if (sub_type === "decrease") bot.gl.delete(source.group_id)
          else
            bot.gl.set(source.group_id, { group_id: source.group_id, group_name: source.group_id })
        }
      }
      const event = this.event(bot, source)
      Object.assign(event, { post_type: "notice", notice_type, sub_type })
      this.Bot.em(`notice.${notice_type}.${sub_type}`, event)
    }
  }
  event(bot, source) {
    const event = {
      self_id: bot.self_id,
      self_user_id: bot.self.user_id,
      self: { ...bot.self },
      bot,
      id: source.id,
      time: source.time,
      detail_type: source.detail_type,
      onebot: structuredClone(source),
      raw: JSON.stringify(source),
    }
    for (const key of ["user_id", "group_id", "message_id", "operator_id"])
      if (source[key] !== undefined) event[key] = source[key]
    const member = bot.gml.get(source.group_id)?.get(source.user_id)
    const friend = bot.fl.get(source.user_id)
    event.sender = {
      user_id: source.user_id,
      nickname: member?.nickname || friend?.nickname || source.user_id,
      card: member?.card || "",
    }
    return event
  }
}
