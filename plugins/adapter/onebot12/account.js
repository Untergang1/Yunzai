import { error, id, isObject, META_ACTIONS } from "./protocol.js"

const userInfo = value => {
  if (!isObject(value) || typeof value.user_id !== "string")
    throw new TypeError("Invalid user info")
  return {
    ...value,
    nickname: value.user_remark || value.user_displayname || value.user_name || value.user_id,
    card: value.user_displayname || "",
  }
}
const groupInfo = value => {
  if (!isObject(value) || typeof value.group_id !== "string")
    throw new TypeError("Invalid group info")
  return { ...value }
}

export class Account {
  active = true
  fl = new Map()
  gl = new Map()
  gml = new Map()

  constructor(adapter, session, key, item) {
    Object.assign(this, {
      adapter,
      session,
      ws: session.ws,
      self_id: key,
      uin: key,
      self: { ...item.self },
    })
    this.info = { user_id: this.self.user_id, user_name: this.self.user_id }
    this.stat = { ...item, good: session.good, start_time: Date.now() / 1000 }
    this.version = { ...session.version, id: adapter.id, name: adapter.name }
  }
  // Yunzai core identifies the bot itself by self_id; the platform knows it as self.user_id.
  localId(value) {
    return value === this.self.user_id ? this.self_id : value
  }
  platformId(value) {
    value = id(value)
    return value === this.self_id ? this.self.user_id : value
  }
  get nickname() {
    return this.info.user_displayname || this.info.user_name || this.self.user_id
  }
  get supportedActions() {
    return this.session.capabilities
  }
  isActive() {
    return (
      this.active &&
      !this.session.closed &&
      this.adapter.owners.get(this.self_id) === this.session &&
      this.adapter.Bot.bots[this.self_id] === this
    )
  }
  assertActive() {
    if (!this.isActive()) throw error("OneBot account offline or replaced", "ACCOUNT_OFFLINE")
  }
  async sendApi(action, params = {}) {
    this.assertActive()
    return this.session.call(action, params, this.self)
  }
  async invoke(action, params = {}) {
    this.assertActive()
    if (!META_ACTIONS.has(action) && this.supportedActions && !this.supportedActions.has(action))
      throw error(`Unsupported action: ${action}`, "UNSUPPORTED_ACTION", { action })
    const response = await this.sendApi(action, params)
    this.assertActive()
    return response.data
  }
  async refresh({ friends = true } = {}) {
    const tasks = [
      this.invoke("get_self_info").then(info => {
        this.info = userInfo(info)
      }),
      ...(friends ? [this.getFriendMap()] : []),
      this.getGroupMap(),
    ]
    for (const result of await Promise.allSettled(tasks))
      if (result.status === "rejected" && this.isActive())
        this.adapter.log("warn", `信息加载失败：${result.reason.message}`, this.self_id)
  }
  async getFriendMap() {
    const list = await this.invoke("get_friend_list")
    if (!Array.isArray(list)) throw new TypeError("Invalid friend list")
    this.fl = new Map(
      list.map(value => {
        const info = userInfo(value)
        return [info.user_id, info]
      }),
    )
    return this.fl
  }
  async getFriendArray() {
    return [...(await this.getFriendMap()).values()]
  }
  async getFriendList() {
    return [...(await this.getFriendMap()).keys()]
  }
  async getGroupMap() {
    const list = await this.invoke("get_group_list")
    if (!Array.isArray(list)) throw new TypeError("Invalid group list")
    this.gl = new Map(
      list.map(value => {
        const info = groupInfo(value)
        return [info.group_id, info]
      }),
    )
    return this.gl
  }
  async getGroupArray() {
    return [...(await this.getGroupMap()).values()]
  }
  async getGroupList() {
    return [...(await this.getGroupMap()).keys()]
  }
  async getGroupMemberMap(group_id) {
    if (group_id !== undefined) return this.pickGroup(group_id).getMemberMap()
    for (const key of (await this.getGroupMap()).keys()) await this.pickGroup(key).getMemberMap()
    return this.gml
  }
  pickUser(user_id) {
    return this.pickFriend(user_id)
  }
  pickFriend(user_id) {
    user_id = this.platformId(user_id)
    const bot = this
    return {
      user_id,
      get info() {
        return bot.fl.get(user_id) || { user_id, nickname: user_id }
      },
      get nickname() {
        return this.info.nickname
      },
      get name() {
        return this.nickname
      },
      async getInfo() {
        const info = userInfo(await bot.invoke("get_user_info", { user_id }))
        bot.fl.set(user_id, info)
        return info
      },
      sendMsg: message => bot.sendMessage({ detail_type: "private", user_id }, message),
      sendFile: (file, name) =>
        bot.sendMessage({ detail_type: "private", user_id }, { type: "file", file, name }),
      recallMsg: message_id => bot.recallMsg(message_id),
      sendForwardMsg: async () => {
        throw error(
          "Merged forwarding is not supported; use sendApi for extensions",
          "UNSUPPORTED_SEGMENT",
        )
      },
    }
  }
  pickGroup(group_id) {
    group_id = id(group_id)
    const bot = this
    return {
      group_id,
      get info() {
        return bot.gl.get(group_id) || { group_id, group_name: group_id }
      },
      get group_name() {
        return this.info.group_name
      },
      get name() {
        return this.group_name
      },
      async getInfo() {
        const info = groupInfo(await bot.invoke("get_group_info", { group_id }))
        bot.gl.set(group_id, info)
        return info
      },
      sendMsg: message => bot.sendMessage({ detail_type: "group", group_id }, message),
      sendFile: (file, name) =>
        bot.sendMessage({ detail_type: "group", group_id }, { type: "file", file, name }),
      recallMsg: message_id => bot.recallMsg(message_id),
      sendForwardMsg: async () => {
        throw error(
          "Merged forwarding is not supported; use sendApi for extensions",
          "UNSUPPORTED_SEGMENT",
        )
      },
      pickMember: user_id => bot.pickMember(group_id, user_id),
      async getMemberMap() {
        const list = await bot.invoke("get_group_member_list", { group_id })
        if (!Array.isArray(list)) throw new TypeError("Invalid group member list")
        const map = new Map(
          list.map(value => {
            const info = userInfo(value)
            return [info.user_id, info]
          }),
        )
        bot.gml.set(group_id, map)
        return map
      },
      async getMemberArray() {
        return [...(await this.getMemberMap()).values()]
      },
      async getMemberList() {
        return [...(await this.getMemberMap()).keys()]
      },
      async setName(group_name) {
        if (typeof group_name !== "string") throw new TypeError("Group name must be a string")
        await bot.invoke("set_group_name", { group_id, group_name })
        bot.gl.set(group_id, { ...bot.gl.get(group_id), group_id, group_name })
        return true
      },
      async quit() {
        await bot.invoke("leave_group", { group_id })
        bot.gl.delete(group_id)
        bot.gml.delete(group_id)
        return true
      },
    }
  }
  pickMember(group_id, user_id) {
    group_id = id(group_id)
    user_id = this.platformId(user_id)
    const bot = this
    return {
      ...this.pickFriend(user_id),
      group_id,
      get info() {
        return (
          bot.gml.get(group_id)?.get(user_id) ||
          bot.fl.get(user_id) || { user_id, nickname: user_id }
        )
      },
      get nickname() {
        return this.info.nickname
      },
      get name() {
        return this.nickname
      },
      get card() {
        return this.info.card || ""
      },
      async getInfo() {
        const info = userInfo(await bot.invoke("get_group_member_info", { group_id, user_id }))
        if (!bot.gml.has(group_id)) bot.gml.set(group_id, new Map())
        bot.gml.get(group_id).set(user_id, info)
        return info
      },
    }
  }
  async sendMessage(target, input) {
    this.assertActive()
    const message = await this.adapter.messages.encode(this, input)
    const data = await this.invoke("send_message", { ...target, message })
    if (!isObject(data) || typeof data.message_id !== "string" || !Number.isFinite(data.time))
      throw error("Invalid send_message result", "INVALID_RESPONSE", { action: "send_message" })
    return { ...data }
  }
  async recallMsg(message_id) {
    await this.invoke("delete_message", { message_id: id(message_id) })
    return true
  }
}
