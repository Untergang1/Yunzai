import { Account } from "./account.js"
import { error, id, isObject } from "./protocol.js"

const sendAction = "wechat.send_text_msg"
const unsupported = message => error(message, "UNSUPPORTED_SEGMENT")

export class WechatAIAccount extends Account {
  refresh() {
    return super.refresh({ friends: false })
  }

  async getFriendMap() {
    this.assertActive()
    throw error("wechat-ai does not provide a friend list", "UNSUPPORTED_ACTION", {
      action: "get_friend_list",
    })
  }

  async sendMessage(target, input) {
    this.assertActive()
    if (!["private", "group"].includes(target.detail_type))
      throw new TypeError("wechat-ai requires a private or group target")
    const recipient_name = id(target.detail_type === "group" ? target.group_id : target.user_id)
    // prepare only validates; encode would upload media before we could reject it.
    const segments = this.adapter.messages.prepare(input, this)
    let message = ""
    let at_user_name
    for (const segment of segments) {
      if (!segment.raw && segment.type === "text") message += segment.data.text
      else if (!segment.raw && segment.type === "mention") {
        if (target.detail_type !== "group" || at_user_name !== undefined || message.length)
          throw unsupported("wechat-ai supports one group mention before the text only")
        at_user_name = segment.data.user_id
      } else throw unsupported("wechat-ai sendMsg supports text and a leading group mention only")
    }
    if (!message.trim()) throw new TypeError("Message text cannot be blank")

    const data = await this.invoke(sendAction, {
      recipient_name,
      message,
      ...(at_user_name === undefined ? {} : { at_user_name }),
      wait_seconds: 12,
    })
    if (
      !isObject(data) ||
      !["queued", "executed"].includes(data.status) ||
      data.queued !== true ||
      data.completed !== (data.status === "executed") ||
      data.receipt !== "local_rpa_only"
    )
      throw error("Invalid wechat.send_text_msg result", "INVALID_RESPONSE", {
        action: sendAction,
      })
    return { ...data }
  }
}

export function handleWechatAIEvent(adapter, session, event) {
  if (
    session.version?.impl === "wechat-ai" &&
    event.type === "meta" &&
    event.detail_type === "wechat.event_gap"
  )
    adapter.log(
      "warn",
      `wechat-ai 事件缺口：${JSON.stringify({ reason: event.reason, dropped: event.dropped })}`,
    )
}
