import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { once } from "node:events"
import { WebSocket, WebSocketServer } from "ws"
import { OneBot12Adapter } from "../../plugins/adapter/onebot12/adapter.js"
import { WechatAIAccount } from "../../plugins/adapter/onebot12/wechat-ai.js"
import { upgrade } from "../../lib/ws.js"
import { Socket, HOLD, makeBot, defaults, event, message, method, until } from "./helpers.js"

const self = { platform: "wechat", user_id: "wxid_bot.001" }
const version = { impl: "wechat-ai", version: "0.1.0", onebot_version: "12" }
const actions = [
  "get_version",
  "get_status",
  "get_supported_actions",
  "get_self_info",
  "get_user_info",
  "get_group_info",
  "get_group_list",
  "get_group_member_info",
  "get_group_member_list",
  "set_group_name",
  "leave_group",
  "wechat.send_text_msg",
  "wechat.get_recent_messages",
]
const receipt = status => ({
  status,
  queued: true,
  completed: status === "executed",
  receipt: "local_rpa_only",
  dispatcher: "QueueCommandDispatcher",
  action_type: "send_text_message",
  queue_size: 0,
  ...(status === "executed" ? { result: { ok: true } } : {}),
})
function respond(request) {
  switch (request.action) {
    case "get_status":
      return { good: true, bots: [{ self, online: true }] }
    case "get_supported_actions":
      return actions
    case "wechat.send_text_msg":
      return receipt("executed")
    default:
      return defaults(request)
  }
}
async function fixture(t, options = {}) {
  const Bot = makeBot()
  const adapter = new OneBot12Adapter(Bot, { enable: true, action_timeout: 150, ...options.config })
  adapter.load()
  t.after(() => {
    for (const session of [...adapter.sessions]) session.ws.terminate()
  })
  const ws = new Socket(options.respond || respond)
  const session = adapter.accept(ws, {
    headers: { "sec-websocket-protocol": `12.${options.impl || version.impl}` },
  })
  ws.push(event("meta", "connect", { version: { ...version, impl: options.impl || version.impl } }))
  await until(() => session.ready && !session.pending.size)
  return { Bot, adapter, ws, session, bot: Object.values(Bot.bots)[0] }
}
function wrapReplies(Bot, bot, timers = []) {
  const loader = {
    dealText: text => text.trim(),
    onlyReplyAt: () => true,
    count: () => {},
    dealEvent: method("lib/plugins/loader.js", "dealEvent", {
      cfg: {
        bot: {},
        master: { [bot.self_id]: ["wxid_user"] },
        getGroup: () => ({ botAlias: [] }),
      },
      logger: { cyan: v => v, red: v => v },
      lodash: { truncate: v => v },
    }),
    reply: method("lib/plugins/loader.js", "reply", {
      Bot,
      segment: { at: qq => ({ type: "at", qq }), reply: id => ({ type: "reply", id }) },
      setTimeout: (...args) => timers.push(args),
    }),
  }
  const events = []
  Bot.on("message", e => {
    loader.dealEvent(e)
    loader.reply(e)
    events.push(e)
  })
  return events
}

test("wechat-ai selection requires both implementation and platform; refresh skips friends", async t => {
  const { bot, ws } = await fixture(t)
  assert.ok(bot instanceof WechatAIAccount)
  assert.equal(bot.self_id, "ob12/wechat/wxid_bot%2E001")
  assert.ok(!ws.requests.some(r => r.action === "get_friend_list"))
  assert.ok(ws.requests.some(r => r.action === "get_self_info"))
  assert.ok(ws.requests.some(r => r.action === "get_group_list"))
  assert.deepEqual([...bot.supportedActions], actions)
  for (const get of ["getFriendMap", "getFriendArray", "getFriendList"])
    await assert.rejects(bot[get](), { code: "UNSUPPORTED_ACTION", action: "get_friend_list" })
  const otherImpl = await fixture(t, { impl: "another" })
  assert.ok(!(otherImpl.bot instanceof WechatAIAccount))
  const otherPlatform = await fixture(t, {
    respond: request => (request.action === "get_status" ? defaults(request) : respond(request)),
  })
  assert.ok(!(otherPlatform.bot instanceof WechatAIAccount))
})

test("wechat-ai text and leading group mention preserve IDs, text and local receipts", async t => {
  const { bot, ws } = await fixture(t)
  for (const status of ["queued", "executed"]) {
    ws.respond = request =>
      request.action === "wechat.send_text_msg" ? receipt(status) : respond(request)
    const result = await bot
      .pickFriend("wxid_001")
      .sendMsg(["  hello", { type: "text", text: "\n" }, 42])
    assert.deepEqual(result, receipt(status))
    assert.equal(result.message_id, undefined)
    assert.equal(result.time, undefined)
    assert.deepEqual(ws.requests.at(-1).params, {
      recipient_name: "wxid_001",
      message: "  hello\n42",
      wait_seconds: 12,
    })
    assert.deepEqual(ws.requests.at(-1).self, self)
  }
  await bot.pickGroup("001@chatroom").sendMsg([{ type: "at", qq: "wxid_member" }, "你好"])
  assert.deepEqual(ws.requests.at(-1).params, {
    recipient_name: "001@chatroom",
    message: "你好",
    at_user_name: "wxid_member",
    wait_seconds: 12,
  })
  assert.ok(!ws.requests.some(r => r.action === "send_message"))
})

test("wechat-ai validates the whole message before any action, upload or file access", async t => {
  const { bot, ws } = await fixture(t)
  const n = ws.requests.length
  for (const input of [
    ["text", { type: "reply", id: "msg" }],
    [{ type: "at", qq: "all" }, "text"],
    [{ type: "at", qq: "a" }, { type: "at", qq: "b" }, "text"],
    ["text", { type: "at", qq: "a" }],
    ["text", { type: "image", file: "/does-not-exist" }],
    [{ type: "raw", data: { type: "text", data: { text: "raw" } } }],
    [{ type: "node", data: [] }],
  ])
    await assert.rejects(bot.pickGroup("g@chatroom").sendMsg(input), {
      code: "UNSUPPORTED_SEGMENT",
    })
  await assert.rejects(bot.pickFriend("u").sendMsg([{ type: "at", qq: "a" }, "text"]), {
    code: "UNSUPPORTED_SEGMENT",
  })
  for (const input of [[], " \n", [{ type: "at", qq: "a" }]])
    await assert.rejects(bot.pickGroup("g@chatroom").sendMsg(input), TypeError)
  await assert.rejects(bot.pickFriend("u").sendFile("/does-not-exist"), {
    code: "UNSUPPORTED_SEGMENT",
  })
  await assert.rejects(bot.pickGroup("g@chatroom").sendForwardMsg([]), {
    code: "UNSUPPORTED_SEGMENT",
  })
  assert.equal(ws.requests.length, n)
})

test("wechat-ai rejects invalid successful results and preserves remote failures without retry", async t => {
  const { bot, ws } = await fixture(t)
  for (const result of [
    null,
    {},
    { message_id: "fake", time: 1 },
    receipt("dry_run"),
    { ...receipt("executed"), completed: false },
    { ...receipt("queued"), receipt: "delivered" },
  ]) {
    ws.respond = () => result
    await assert.rejects(bot.pickFriend("u").sendMsg("hello"), {
      code: "INVALID_RESPONSE",
      action: "wechat.send_text_msg",
    })
  }
  for (const retcode of [35002, 35001, 34000, 35005, 35006, 10102]) {
    ws.respond = request => {
      ws.response(request, { status: retcode === 35005 ? "timeout" : "failed" }, retcode)
      return HOLD
    }
    const n = ws.requests.length
    await assert.rejects(bot.pickFriend("u").sendMsg("hello"), err => {
      assert.equal(err.retcode, retcode)
      assert.equal(err.action, "wechat.send_text_msg")
      assert.equal(err.response.retcode, retcode)
      return true
    })
    assert.equal(ws.requests.length, n + 1)
  }
})

test("wechat-ai capability discovery, timeouts, offline and takeover never resend", async t => {
  const { bot, ws, session, adapter } = await fixture(t, { config: { action_timeout: 30 } })
  session.capabilities = new Set()
  const n = ws.requests.length
  await assert.rejects(bot.pickFriend("u").sendMsg("hello"), { code: "UNSUPPORTED_ACTION" })
  assert.equal(ws.requests.length, n)
  session.capabilities = null
  await bot.pickFriend("u").sendMsg("capabilities unknown")
  ws.respond = () => HOLD
  await assert.rejects(bot.pickFriend("u").sendMsg("timeout"), { code: "TIMEOUT" })
  const before = ws.requests.length
  const pending = bot.pickFriend("u").sendMsg("in flight")
  const rejected = assert.rejects(pending, { code: "ACCOUNT_OFFLINE" })
  const replacement = new Socket(respond)
  const newer = adapter.accept(replacement, {
    headers: { "sec-websocket-protocol": "12.wechat-ai" },
  })
  replacement.push(event("meta", "connect", { version }))
  await rejected
  await until(() => newer.ready && !newer.pending.size)
  assert.equal(ws.requests.length, before + 1)
  assert.ok(!replacement.requests.some(r => r.action === "wechat.send_text_msg"))
  await assert.rejects(bot.pickFriend("u").sendMsg("stale"), { code: "ACCOUNT_OFFLINE" })
  const current = [...newer.accounts.values()][0]
  replacement.respond = () => HOLD
  const disconnected = assert.rejects(current.pickFriend("u").sendMsg("disconnect"), {
    code: "DISCONNECTED",
  })
  replacement.terminate()
  await disconnected
  assert.equal(newer.pending.size, 0)
})

test("wechat-ai plugin replies preserve local results, reject quotes and never schedule recall", async t => {
  const { Bot, bot, ws } = await fixture(t)
  const timers = []
  const events = wrapReplies(Bot, bot, timers)
  for (const detail_type of ["private", "group"]) {
    ws.push(
      message({
        self,
        user_id: "wxid_user",
        detail_type,
        ...(detail_type === "group" ? { group_id: "g@chatroom" } : {}),
      }),
    )
    await until(() => events.length === (detail_type === "private" ? 1 : 2))
    const e = events.at(-1)
    assert.equal(e.isMaster, true)
    assert.deepEqual(await e.reply("text", false, { recallMsg: 10 }), receipt("executed"))
    const n = ws.requests.length
    assert.equal((await e.reply("quoted", true)).error[0].code, "UNSUPPORTED_SEGMENT")
    assert.equal(ws.requests.length, n)
    if (detail_type === "group") {
      await e.reply("hello", false, { at: true })
      assert.equal(ws.requests.at(-1).params.at_user_name, "wxid_user")
    }
  }
  assert.equal(timers.length, 0)
})

test("wechat-ai extension events stay raw; gap logs do not replay; @ text stays text", async t => {
  const { Bot, bot, ws } = await fixture(t)
  const messages = wrapReplies(Bot, bot)
  const raw = []
  Bot.on("onebot12.event", e => raw.push(e))
  const n = ws.requests.length
  for (const detail of ["wechat.message_metadata", "wechat.message_sent"])
    ws.push(
      event("message", detail, {
        self,
        message_id: null,
        sender_id: null,
        conversation_id: "g@chatroom",
        text: "#command",
        reasons: ["unsupported_message_content"],
      }),
    )
  ws.push(event("meta", "wechat.event_gap", { reason: "buffer_overflow", dropped: 3 }))
  await until(() => raw.length === 3)
  assert.equal(messages.length, 0)
  assert.equal(ws.requests.length, n)
  assert.ok(Bot.logs.some(log => String(log[1]).includes('"dropped":3')))
  ws.push(
    message({
      self,
      detail_type: "group",
      group_id: "g@chatroom",
      message: [{ type: "text", data: { text: "@Bot #help" } }],
    }),
  )
  await until(() => messages.length === 1)
  assert.equal(messages[0].atBot, undefined)
  assert.equal(messages[0].msg, "@Bot #help")
  assert.equal(messages[0].onebot.self.platform, "wechat")
})

test("wechat-ai queries preserve extension fields and group management never adds confirmation", async t => {
  const { bot, ws } = await fixture(t)
  ws.respond = request => {
    if (["get_user_info", "get_group_member_info"].includes(request.action))
      return { ...defaults(request), user_displayname: "", "wechat.displayname_available": false }
    if (["leave_group", "set_group_name"].includes(request.action)) {
      ws.response(request, null, 35003)
      return HOLD
    }
    if (request.action === "wechat.get_recent_messages") return { messages: [], count: 0 }
    return respond(request)
  }
  assert.equal((await bot.pickFriend("wxid_u").getInfo())["wechat.displayname_available"], false)
  assert.equal((await bot.pickMember("g@chatroom", "wxid_u").getInfo()).card, "")
  assert.equal((await bot.pickGroup("g@chatroom").getInfo()).group_id, "g@chatroom")
  for (const run of [
    () => bot.pickGroup("g@chatroom").setName("name"),
    () => bot.pickGroup("g@chatroom").quit(),
  ]) {
    await assert.rejects(run(), { retcode: 35003 })
    assert.equal(ws.requests.at(-1).params["wechat.confirm"], undefined)
  }
  const response = await bot.sendApi("wechat.get_recent_messages", { contact_name: "wxid_u" })
  assert.deepEqual(response.data, { messages: [], count: 0 })
})

test("wechat-ai reverse WebSocket authenticates, routes text and reconnects without replay", async t => {
  const Bot = makeBot()
  Bot.wss = new WebSocketServer({ noServer: true })
  Bot.serverAuth = () => undefined
  const adapter = new OneBot12Adapter(Bot, {
    enable: true,
    access_token: "secret",
    action_timeout: 500,
  })
  adapter.load()
  const server = http.createServer()
  server.on("upgrade", (req, socket, head) =>
    upgrade(Bot, req, socket, head, [], Bot.makeLog.bind(Bot)),
  )
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const clients = []
  t.after(async () => {
    for (const ws of clients) ws.terminate()
    for (const session of [...adapter.sessions]) session.ws.terminate()
    await new Promise(resolve => Bot.wss.close(resolve))
    await new Promise(resolve => server.close(resolve))
  })
  const requests = []
  async function connectPeer() {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/OneBotv12`, "12.wechat-ai", {
      headers: { Authorization: "Bearer secret" },
    })
    clients.push(ws)
    ws.on("message", frame => {
      const request = JSON.parse(frame)
      requests.push(request)
      ws.send(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: respond(request),
          message: "",
          echo: request.echo,
        }),
      )
    })
    await once(ws, "open")
    ws.send(JSON.stringify(event("meta", "connect", { version })))
    ws.send(
      JSON.stringify(event("meta", "status_update", { status: respond({ action: "get_status" }) })),
    )
    return ws
  }
  const ws = await connectPeer()
  await until(() => Bot.uin.length === 1)
  const old = Object.values(Bot.bots)[0]
  const events = wrapReplies(Bot, old)
  ws.send(JSON.stringify(message({ self, user_id: "wxid_user" })))
  await until(() => events.length === 1)
  assert.deepEqual(await events[0].reply("hello"), receipt("executed"))
  assert.equal(requests.filter(r => r.action === "wechat.send_text_msg").length, 1)
  await connectPeer()
  await until(() => Object.values(Bot.bots)[0] !== old)
  assert.ok(Object.values(Bot.bots)[0] instanceof WechatAIAccount)
  ws.close()
  await once(ws, "close")
  assert.equal(Bot.uin.length, 1)
  assert.equal(requests.filter(r => r.action === "wechat.send_text_msg").length, 1)
  assert.ok(!JSON.stringify(Bot.logs).includes("secret"))
})
