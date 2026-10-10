import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fixture, message, event, self, until, method } from "./helpers.js"

test("private/group event replies, mentions, quoting and master configuration", async t => {
  const { Bot, bot, ws } = await fixture(t)
  const cfg = { bot: {}, master: { [bot.self_id]: ["user"] }, getGroup: () => ({ botAlias: [] }) }
  const loader = {
    dealText: text => text.trim(),
    onlyReplyAt: () => false,
    count: () => {},
    dealEvent: method("lib/plugins/loader.js", "dealEvent", {
      cfg,
      logger: { cyan: v => v, red: v => v },
      lodash: { truncate: v => v },
    }),
    reply: method("lib/plugins/loader.js", "reply", {
      Bot,
      segment: {
        at: qq => ({ type: "at", qq }),
        reply: id => ({ type: "reply", id }),
      },
    }),
  }
  const events = []
  Bot.on("message", e => {
    loader.dealEvent(e)
    loader.reply(e)
    events.push(e)
  })
  ws.push(
    message({
      detail_type: "group",
      group_id: "g",
      message: [
        { type: "mention", data: { user_id: self.user_id } },
        { type: "text", data: { text: "#help" } },
      ],
    }),
  )
  await until(() => events.length === 1)
  const group = events[0]
  assert.equal(group.atBot, true)
  assert.equal(group.isMaster, true)
  assert.equal(group.isGroup, true)
  assert.equal(group.msg, "#help")
  assert.equal(group.group.group_id, "g")
  assert.equal(group.onebot.self.user_id, self.user_id)
  assert.equal(group.member.user_id, "user")
  await group.reply("reply", true)
  assert.equal(ws.requests.at(-1).params.detail_type, "group")
  assert.deepEqual(ws.requests.at(-1).params.message[0], {
    type: "reply",
    data: { message_id: "msg" },
  })
  ws.push(message())
  await until(() => events.length === 2)
  assert.equal(events[1].isPrivate, true)
  assert.equal(events[1].sub_type, "")
  await events[1].reply("hello")
  await events[1].recall()
  assert.equal(ws.requests.at(-1).action, "delete_message")
})

test("bot's own platform user ID maps to self_id for core plugins", async t => {
  const { Bot, bot, ws } = await fixture(t)
  const events = []
  Bot.on("message", e => events.push(e))
  ws.push(
    message({
      user_id: self.user_id,
      message: [
        { type: "mention", data: { user_id: self.user_id } },
        { type: "reply", data: { message_id: "m", user_id: self.user_id } },
      ],
    }),
  )
  await until(() => events.length === 1)
  const [e] = events
  assert.equal(e.user_id, bot.self_id)
  assert.equal(e.sender.user_id, bot.self_id)
  assert.equal(e.self_user_id, self.user_id)
  assert.equal(e.message[0].qq, bot.self_id)
  assert.equal(e.message[1].user_id, bot.self_id)
  await bot.pickGroup("g").sendMsg([{ type: "at", qq: bot.self_id }, "hi"])
  assert.deepEqual(ws.requests.at(-1).params.message[0], {
    type: "mention",
    data: { user_id: self.user_id },
  })
  await bot.pickFriend(bot.self_id).sendMsg("hi")
  assert.equal(ws.requests.at(-1).params.user_id, self.user_id)
})

test("standard segments round trip, unknown segments retain structure without becoming commands", async t => {
  const { bot, adapter } = await fixture(t)
  const encoded = await adapter.messages.encode(bot, [
    "hello",
    { type: "at", qq: "all" },
    { type: "at", qq: "001" },
    { type: "record", file_id: "voice" },
    { type: "audio", file_id: "audio" },
    { type: "reply", id: "m", qq: "u" },
    { type: "location", latitude: 1, longitude: 2, title: "here", content: "address" },
    { type: "raw", data: { type: "vendor.button", data: { text: "#command" } } },
  ])
  assert.deepEqual(
    encoded.map(i => i.type),
    ["text", "mention_all", "mention", "voice", "audio", "reply", "location", "vendor.button"],
  )
  const decoded = await adapter.messages.decode(bot, encoded)
  assert.equal(decoded[3].type, "record")
  assert.equal(decoded[4].type, "audio")
  assert.equal(decoded[5].id, "m")
  assert.deepEqual(decoded.at(-1), { type: "raw", data: encoded.at(-1) })
})

test("unsupported segments reject entire message before uploading or sending", async t => {
  const { bot, ws } = await fixture(t)
  const n = ws.requests.length
  await assert.rejects(
    bot.pickFriend("u").sendMsg([
      { type: "image", file: Buffer.from("x") },
      { type: "button", data: {} },
    ]),
    { code: "UNSUPPORTED_SEGMENT" },
  )
  await assert.rejects(bot.pickGroup("g").sendForwardMsg([]), { code: "UNSUPPORTED_SEGMENT" })
  assert.equal(ws.requests.length, n)
})

test("URL, local file, Buffer and Base64 upload use v12 file IDs", async t => {
  const { bot, ws, adapter } = await fixture(t)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ob12-media-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const filename = path.join(dir, "example.bin")
  await fs.writeFile(filename, "hello")
  for (const file of [
    "https://example.test/image.png",
    filename,
    Buffer.from("hello"),
    "base64://aGVsbG8=",
  ]) {
    await bot.pickFriend("u").sendMsg({ type: "image", file })
    assert.deepEqual(ws.requests.at(-1).params.message, [
      { type: "image", data: { file_id: "file-1" } },
    ])
    const upload = ws.requests.at(-2)
    assert.equal(upload.action, "upload_file")
    assert.notEqual(upload.params.type, "path")
  }
  adapter.config.max_file_size = 4
  await assert.rejects(bot.pickFriend("u").sendFile(filename), { code: "FILE_TOO_LARGE" })
  await assert.rejects(bot.pickFriend("u").sendFile(Buffer.alloc(5)), { code: "FILE_TOO_LARGE" })
  await assert.rejects(bot.pickFriend("u").sendFile("base64://aGVsbG8="), {
    code: "FILE_TOO_LARGE",
  })
})

test("authenticated media is downloaded with headers; unsupported URL falls back to data", async t => {
  const calls = []
  const { bot, adapter, Bot } = await fixture(t, {
    fetch: async (url, options) => {
      calls.push({ url, ...options })
      return new Response(Buffer.from("image"))
    },
  })
  bot.invoke = async (action, params) => ({
    name: "file.png",
    url: "http://files.test/private",
    headers: { Authorization: "Bearer secret" },
  })
  const media = await adapter.messages.decode(bot, [{ type: "image", data: { file_id: "f" } }])
  assert.equal(calls[0].headers.Authorization, "Bearer secret")
  assert.equal(media[0].url, "http://files.test/download")
  assert.equal(Bot.lastFile.buffer.toString(), "image")
  const types = []
  bot.invoke = async (action, params) => {
    types.push(params.type)
    if (params.type === "url") throw Object.assign(new Error("not supported"), { retcode: 10004 })
    return { name: "a.png", data: Buffer.from("data").toString("base64") }
  }
  await adapter.messages.resolveFile(bot, "f")
  assert.deepEqual(types, ["url", "data"])
  assert.equal(Bot.lastFile.buffer.toString(), "data")
})

test("failed media keeps file ID and error, and is excluded from plugin image URLs", async t => {
  const { bot, adapter, Bot } = await fixture(t)
  bot.invoke = async () => {
    throw new Error("cannot resolve")
  }
  const source = message({
    message: [
      { type: "image", data: { file_id: "missing" } },
      { type: "text", data: { text: "hello" } },
    ],
  })
  let received
  Bot.on("message", e => (received = e))
  await adapter.handleEvent(bot, source)
  assert.equal(received.message[0].file_id, "missing")
  assert.ok(received.message[0].error)
  const deal = method("lib/plugins/loader.js", "dealEvent", {
    cfg: { master: {} },
    logger: { cyan: v => v, red: v => v },
    lodash: { truncate: v => v },
  })
  deal.call({ dealText: v => v, onlyReplyAt: () => false }, received)
  assert.equal(received.img, undefined)
  assert.equal(received.msg, "hello")
})

test("file download enforces byte limits and disconnect aborts in-flight fetch", async t => {
  const { bot, adapter, ws, session } = await fixture(t, {
    config: { max_file_size: 3 },
    fetch: async () => new Response("1234"),
  })
  await assert.rejects(adapter.messages.download(bot, "http://files.test", {}), {
    code: "FILE_TOO_LARGE",
  })
  adapter.fetch = (url, { signal }) =>
    new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    )
  const download = adapter.messages.download(bot, "http://files.test", {})
  ws.terminate()
  await assert.rejects(download)
  assert.equal(session.downloads.size, 0)
})

test("valid Base64 at the default 10 MiB boundary decodes without regex stack overflow", async t => {
  const { adapter } = await fixture(t)
  const buffer = Buffer.alloc(10485760, 1)
  assert.equal(adapter.messages.base64(buffer.toString("base64")).length, buffer.length)
  assert.throws(() => adapter.messages.base64("a!aa"), /Invalid Base64/)
  assert.throws(() => adapter.messages.base64("a==="), /Invalid Base64/)
})

test("legacy adapters retain original self ID mention behavior", () => {
  const deal = method("lib/plugins/loader.js", "dealEvent", {
    cfg: { master: {} },
    logger: { cyan: v => v, red: v => v },
    lodash: { truncate: v => v },
  })
  const event = {
    self_id: 123,
    user_id: 456,
    message_type: "private",
    message: [{ type: "at", qq: "123" }],
    raw_message: "@",
  }
  deal.call({ onlyReplyAt: () => false }, event)
  assert.equal(event.atBot, true)
})

test("queries and standard notices update caches; unsupported events only use raw stream", async t => {
  const { bot, Bot, ws } = await fixture(t)
  assert.equal((await bot.pickFriend("u").getInfo()).nickname, "Display")
  assert.equal((await bot.pickGroup("g").getInfo()).group_name, "Group")
  await bot.pickGroup("g").pickMember("u").getInfo()
  assert.equal(bot.gml.get("g").get("u").card, "Display")
  const notices = []
  const raw = []
  Bot.on("notice", e => notices.push(e))
  Bot.on("onebot12.event", e => raw.push(e))
  for (const detail_type of [
    "friend_increase",
    "friend_decrease",
    "private_message_delete",
    "group_member_increase",
    "group_member_decrease",
    "group_message_delete",
  ])
    ws.push(
      event("notice", detail_type, {
        user_id: "u",
        group_id: "g",
        operator_id: "operator",
        message_id: "m",
        sub_type: "vendor.reason",
      }),
    )
  await until(() => notices.length === 6)
  assert.equal(notices[0].notice_type, "friend")
  assert.equal(notices[2].sub_type, "recall")
  assert.equal(notices[3].onebot.sub_type, "vendor.reason")
  assert.equal(bot.gml.has("g"), false)
  ws.push(event("request", "vendor.request"))
  ws.push(message({ detail_type: "channel", guild_id: "guild", channel_id: "channel" }))
  await until(() => raw.length === 8)
  assert.equal(notices.length, 6)
  await bot.pickGroup("g").setName("new")
  assert.equal(bot.gl.get("g").group_name, "new")
  await bot.pickGroup("g").quit()
  assert.equal(bot.gl.has("g"), false)
})

test("account queues preserve order while action responses and other accounts progress", async t => {
  const { bot, adapter, ws, Bot } = await fixture(t)
  const order = []
  let release
  adapter.messages.resolveFile = () =>
    new Promise(resolve => (release = () => resolve({ name: "f", url: "http://files.test" })))
  Bot.on("message", e => order.push(e.message_id))
  ws.push(message({ message_id: "first", message: [{ type: "image", data: { file_id: "f" } }] }))
  ws.push(message({ message_id: "second" }))
  await until(() => release)
  await bot.sendApi("get_version")
  assert.deepEqual(order, [])
  release()
  await until(() => order.length === 2)
  assert.deepEqual(order, ["first", "second"])
})
