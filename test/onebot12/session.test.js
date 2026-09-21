import test from "node:test"
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { botId } from "../../plugins/adapter/onebot12/protocol.js"
import { fixture, Socket, defaults, event, connect, message, self, HOLD, until } from "./helpers.js"

test("account identity and scoped action envelopes preserve string IDs", async t => {
  const { bot, Bot, ws } = await fixture(t)
  assert.equal(bot.self_id, "ob12/qq/12345")
  assert.equal(Bot.uin[0], bot.uin)
  assert.deepEqual(bot.self, self)
  assert.equal(botId({ platform: "a.b", user_id: "a:/b.1" }), "ob12/a%2Eb/a%3A%2Fb%2E1")
  const sent = await bot.pickFriend("90071992547409930000").sendMsg("hi")
  assert.equal(sent.message_id, "90071992547409931234")
  assert.deepEqual(ws.requests.at(-1).self, self)
  assert.equal(ws.requests.at(-1).params.user_id, "90071992547409930000")
  assert.ok(ws.requests.filter(r => r.action === "get_status").every(r => !("self" in r)))
  await bot.pickFriend("user").recallMsg(sent.message_id)
  assert.equal(ws.requests.at(-1).action, "delete_message")
  assert.throws(() => bot.pickFriend(90071992547409930000), /safe integer/)
})

test("multiple platforms and incremental status do not remove absent accounts", async t => {
  const { ws, Bot, session } = await fixture(t)
  const other = { platform: "telegram", user_id: self.user_id }
  ws.push(
    event("meta", "status_update", {
      status: { good: false, bots: [{ self: other, online: true }] },
    }),
  )
  assert.equal(Object.keys(Bot.bots).length, 2)
  assert.equal(Bot.bots[botId(self)].stat.good, false)
  ws.push(event("meta", "status_update", { status: { good: true, bots: [] } }))
  assert.equal(Object.keys(Bot.bots).length, 2)
  ws.push(
    event("meta", "status_update", { status: { good: true, bots: [{ self, online: false }] } }),
  )
  assert.equal(Bot.bots[botId(self)], undefined)
  assert.ok(Bot.bots[botId(other)])
  ws.terminate()
  assert.equal(session.pending.size, 0)
  assert.equal(session.accounts.size, 0)
  assert.deepEqual(Bot.uin, [])
})

test("initial status snapshot is merged with later deltas before buffered messages", async t => {
  const { ws, session, Bot } = await fixture(t, {
    start: false,
    respond: r => (r.action === "get_status" ? HOLD : defaults(r)),
  })
  ws.push(connect())
  ws.push(message())
  const other = { platform: "telegram", user_id: "other" }
  ws.push(
    event("meta", "status_update", {
      status: {
        good: true,
        bots: [
          { self, online: true },
          { self: other, online: true },
        ],
      },
    }),
  )
  ws.push(
    event("meta", "status_update", {
      status: { good: false, bots: [{ self: other, online: false }] },
    }),
  )
  let received
  Bot.on("message", e => (received = e))
  ws.response(
    ws.requests.find(r => r.action === "get_status"),
    { good: true, bots: [] },
  )
  await until(() => received)
  assert.equal(session.ready, true)
  assert.deepEqual(Object.keys(Bot.bots), [botId(self)])
  assert.equal(Bot.bots[botId(self)].stat.good, false)
  assert.equal(received.message[0].text, "hello")
})

test("first status_update can initialize when get_status fails", async t => {
  const { ws, session } = await fixture(t, {
    start: false,
    respond: r => (r.action === "get_status" ? HOLD : defaults(r)),
  })
  ws.push(connect())
  ws.push(event("meta", "status_update", { status: defaults({ action: "get_status" }) }))
  ws.response(
    ws.requests.find(r => r.action === "get_status"),
    null,
    10002,
  )
  await until(() => session.ready)
})

test("new connection owns account; old deltas, pending calls and close cannot reclaim it", async t => {
  const { adapter, ws, bot: oldBot, Bot } = await fixture(t)
  ws.respond = () => HOLD
  const pending = oldBot.sendApi("test.slow")
  const rejected = assert.rejects(pending, { code: "ACCOUNT_OFFLINE" })
  const next = new Socket()
  const session = adapter.accept(next, { headers: { "sec-websocket-protocol": "12.test" } })
  next.push(connect())
  await until(() => session.ready)
  await rejected
  const current = Bot.bots[botId(self)]
  assert.notEqual(current, oldBot)
  ws.push(event("meta", "status_update", { status: defaults({ action: "get_status" }) }))
  ws.push(message())
  assert.equal(Bot.bots[botId(self)], current)
  ws.terminate()
  assert.equal(Bot.bots[botId(self)], current)
  await assert.rejects(oldBot.sendApi("send_message"), { code: "ACCOUNT_OFFLINE" })
})

test("out of order replies, null data, errors, timeout and late responses", async t => {
  const { bot, ws, session } = await fixture(t, { config: { action_timeout: 40 } })
  ws.respond = () => HOLD
  const first = bot.sendApi("x.first")
  const second = bot.sendApi("x.second")
  const [a, b] = ws.requests.slice(-2)
  ws.response(b, [1, 2])
  ws.response(a, null)
  assert.equal((await first).data, null)
  assert.deepEqual((await second).data, [1, 2])
  const failed = bot.sendApi("x.fail")
  ws.response(ws.requests.at(-1), null, 10002)
  await assert.rejects(failed, e => e.retcode === 10002 && e.response.status === "failed")
  const late = bot.sendApi("x.timeout")
  const request = ws.requests.at(-1)
  await assert.rejects(late, { code: "TIMEOUT" })
  ws.response(request, "late")
  assert.equal(session.pending.size, 0)
  assert.equal(ws.readyState, 1)
  const bad = bot.sendApi("x.bad")
  ws.push({ echo: ws.requests.at(-1).echo, status: "ok", retcode: 0 })
  await assert.rejects(bad, { code: "INVALID_RESPONSE" })
})

test("send failure and disconnect reject immediately and release timers", async t => {
  const { bot, ws, session, adapter } = await fixture(t)
  ws.send = () => {
    throw new Error("broken")
  }
  await assert.rejects(bot.sendApi("x.send"), { code: "SEND_FAILED" })
  ws.send = () => {}
  const pending = bot.sendApi("x.pending")
  ws.terminate()
  await assert.rejects(pending, { code: "DISCONNECTED" })
  assert.equal(session.pending.size, 0)
  assert.equal(adapter.sessions.size, 0)
  assert.equal(adapter.owners.size, 0)
})

test("capability failure is unknown, optional unsupported actions do not disconnect", async t => {
  const { ws, bot } = await fixture(t)
  const n = ws.requests.length
  bot.session.capabilities = new Set(["send_message"])
  await assert.rejects(bot.pickGroup("g").getInfo(), { code: "UNSUPPORTED_ACTION" })
  assert.equal(ws.requests.length, n)
  assert.equal(ws.readyState, 1)
  await bot.sendApi("vendor.extension")
  assert.equal(ws.requests.at(-1).action, "vendor.extension")
})

test("malformed frames, wrong first event/version and buffer overflow close connection", async t => {
  for (const payload of [
    message(),
    { ...connect(), version: { impl: "test", version: "1", onebot_version: "11" } },
    {},
    null,
  ]) {
    const { ws, session } = await fixture(t, { start: false })
    ws.push(payload)
    assert.equal(session.closed, true)
  }
  const { ws, session } = await fixture(t, { start: false, respond: () => HOLD })
  ws.push(connect())
  for (let i = 0; i <= 100; i++) ws.push(message())
  assert.equal(session.closed, true)
  assert.equal(session.pending.size, 0)
  const invalid = await fixture(t, { start: false })
  invalid.ws.emit("message", Buffer.from("{"), false)
  assert.equal(invalid.session.closed, true)
})

test("missing connect/status times out; heartbeat is optional", async t => {
  const { session } = await fixture(t, { start: false, config: { action_timeout: 15 } })
  await until(() => session.closed)
  const initialized = await fixture(t, { config: { action_timeout: 15 } })
  await delay(25)
  assert.equal(initialized.session.closed, false)
})

test("connection-scoped echo cannot be resolved by a different socket", async t => {
  const { adapter, bot, ws, session } = await fixture(t)
  ws.respond = () => HOLD
  const call = bot.sendApi("vendor.pending")
  const request = ws.requests.at(-1)
  const other = new Socket(r =>
    r.action === "get_status" ? { good: true, bots: [] } : defaults(r),
  )
  const otherSession = adapter.accept(other, { headers: { "sec-websocket-protocol": "12.test" } })
  other.push(connect())
  await until(() => otherSession.ready)
  other.response(request, "wrong connection")
  assert.ok(session.pending.has(request.echo))
  ws.response(request, "correct connection")
  assert.equal((await call).data, "correct connection")
})

test("failed capability discovery remains unknown and does not block sending", async t => {
  const { ws, session, Bot } = await fixture(t, {
    start: false,
    respond: r => (r.action === "get_supported_actions" ? HOLD : defaults(r)),
  })
  ws.push(connect())
  ws.response(
    ws.requests.find(r => r.action === "get_supported_actions"),
    null,
    10002,
  )
  await until(() => session.ready)
  assert.equal(session.capabilities, null)
  await Object.values(Bot.bots)[0].pickFriend("u").sendMsg("hello")
})

test("binary frames and initialization without status are rejected and cleaned", async t => {
  const binary = await fixture(t, { start: false })
  binary.ws.emit("message", Buffer.from(JSON.stringify(connect())), true)
  assert.equal(binary.session.closed, true)
  const noStatus = await fixture(t, {
    start: false,
    config: { action_timeout: 15 },
    respond: () => HOLD,
  })
  noStatus.ws.push(connect())
  await until(() => noStatus.session.closed)
  assert.equal(noStatus.session.pending.size, 0)
})

test("old queued media and delayed account queries cannot affect replacement account", async t => {
  const { adapter, ws, Bot } = await fixture(t)
  let release
  adapter.messages.resolveFile = () => new Promise(resolve => (release = resolve))
  const events = []
  Bot.on("message", e => events.push(e))
  ws.push(message({ message: [{ type: "image", data: { file_id: "old" } }] }))
  await until(() => release)
  ws.respond = () => HOLD
  const old = Bot.bots[botId(self)]
  const query = old.getFriendMap()
  const rejected = assert.rejects(query, { code: "ACCOUNT_OFFLINE" })
  const request = ws.requests.at(-1)
  const next = new Socket()
  const session = adapter.accept(next, { headers: { "sec-websocket-protocol": "12.test" } })
  next.push(connect())
  await until(() => session.ready)
  await rejected
  ws.response(request, [{ user_id: "stale", user_name: "stale" }])
  release({ name: "old", url: "http://files.test/old" })
  await until(() => !old.session.queues.size)
  assert.equal(events.length, 0)
  assert.equal(Bot.bots[botId(self)].fl.has("stale"), false)
  // Closing the newest owner does not make a previously revoked connection eligible again.
  next.terminate()
  ws.push(event("meta", "status_update", { status: defaults({ action: "get_status" }) }))
  assert.equal(Bot.bots[botId(self)], undefined)
})
