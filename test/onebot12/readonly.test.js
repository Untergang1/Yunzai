import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { once } from "node:events"
import { WebSocket } from "ws"
import { guardSocket, failure, runProbe, READ_ACTIONS } from "../../tools/onebot12-readonly.js"
import { event, until } from "./helpers.js"

const audit = () => ({ sent: 0, blocked: 0, actions: {} })
test("live probe blocks every write, unknown action, malformed frame and media parsing before transport", () => {
  const sent = [],
    log = audit(),
    ws = { send: frame => sent.push(frame) }
  guardSocket(ws, log)
  for (const action of [
    "send_message",
    "wechat.send_text_msg",
    "set_group_name",
    "leave_group",
    "upload_file",
    "new.extension",
    "wechat.get_recent_media_messages",
  ]) {
    assert.throws(() => ws.send(JSON.stringify({ action, params: { dry_run: true } })), {
      code: "READ_ONLY_BLOCKED",
    })
  }
  for (const params of [{}, { parse_media: true }])
    assert.throws(() => ws.send(JSON.stringify({ action: "wechat.get_recent_messages", params })))
  assert.throws(() => ws.send("not json"))
  let callbackError
  ws.send(JSON.stringify({ action: "delete_message" }), err => {
    callbackError = err
  })
  assert.equal(callbackError.code, "READ_ONLY_BLOCKED")
  assert.equal(sent.length, 0)
  for (const action of READ_ACTIONS)
    ws.send(JSON.stringify({ action, params: { parse_media: false } }))
  assert.equal(sent.length, READ_ACTIONS.size)
  assert.equal(log.sent, READ_ACTIONS.size)
})

test("error evidence excludes response bodies, remote messages and unknown strings", () => {
  const value = failure({
    code: "secret",
    action: "secret",
    message: "private body",
    response: { data: "token" },
    retcode: 35001,
  })
  assert.deepEqual(value, { code: "CHECK_FAILED", retcode: 35001 })
})

async function freePort() {
  const server = net.createServer().listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test("isolated real adapter probes read data, compares events, redacts reports and releases port", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "onebot-readonly-test-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const port = await freePort()
  const controller = new AbortController()
  t.after(() => controller.abort())
  const running = runProbe({
    config: { enable: true },
    serverConfig: { port, host: "127.0.0.1" },
    directory,
    observeMs: 120,
    signal: controller.signal,
  })
  const ws = new WebSocket(`ws://127.0.0.1:${port}/OneBotv12`, "12.wechat-ai")
  ws.on("error", () => {})
  t.after(() => ws.terminate())
  const self = { platform: "wechat", user_id: "private_account_id" }
  const version = { impl: "wechat-ai", version: "test", onebot_version: "12" }
  const user = uid => ({
    user_id: uid,
    user_name: "private_name",
    user_displayname: "",
    "wechat.profile_incomplete": false,
  })
  ws.on("message", frame => {
    const q = JSON.parse(frame)
    assert.ok(READ_ACTIONS.has(q.action))
    let data = null,
      retcode = 0
    if (q.self && q.self.user_id !== self.user_id) retcode = 10102
    else
      switch (q.action) {
        case "get_version":
          data = version
          break
        case "get_supported_actions":
          data = [...READ_ACTIONS].filter(a => a !== "get_friend_list")
          break
        case "get_status":
          data = { good: true, bots: [{ self, online: true }] }
          break
        case "get_self_info":
          data = user(self.user_id)
          break
        case "get_group_list":
          data = []
          break
        case "get_user_info":
          retcode = 35001
          break
        case "wechat.get_recent_chats":
          if (q.params.limit === 101) retcode = 10003
          else data = { chats: [] }
          break
        case "get_friend_list":
          retcode = 10002
          break
        default:
          assert.fail(`Unexpected ${q.action}`)
      }
    ws.send(
      JSON.stringify({
        status: retcode ? "failed" : "ok",
        retcode,
        data,
        message: retcode ? "private_remote_error" : "",
        echo: q.echo,
      }),
    )
  })
  await once(ws, "open")
  ws.send(JSON.stringify(event("meta", "connect", { version })))
  await until(
    () => JSON.parse(fs.readFileSync(path.join(directory, "report.json"))).observation_started_at,
  )
  ws.send(JSON.stringify(event("meta", "heartbeat", { interval: 30000 })))
  for (const detail_type of ["private", "group"])
    ws.send(
      JSON.stringify(
        event("message", detail_type, {
          self,
          message_id: "private_message_id",
          user_id: "private_sender",
          group_id: "private_group",
          alt_message: "secret text",
          message: [{ type: "text", data: { text: "secret text" } }],
        }),
      ),
    )
  const report = await running
  assert.ok(
    !report.checks.some(c => ["失败", "阻塞"].includes(c.status)),
    JSON.stringify(report.checks),
  )
  assert.equal(report.observation.converted_private, 1)
  assert.equal(report.observation.converted_group, 1)
  for (const filename of ["report.json", "report.md"]) {
    const content = fs.readFileSync(path.join(directory, filename), "utf8")
    for (const secret of [
      "private_account_id",
      "private_name",
      "private_sender",
      "private_group",
      "secret text",
      "private_remote_error",
    ])
      assert.ok(!content.includes(secret))
  }
  const replacement = net.createServer().listen(port, "127.0.0.1")
  await once(replacement, "listening")
  await new Promise(resolve => replacement.close(resolve))
})

test("abort while awaiting connection writes a blocked result and frees listener", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "onebot-readonly-abort-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const port = await freePort(),
    controller = new AbortController()
  const running = runProbe({
    config: { enable: true },
    serverConfig: { port, host: "127.0.0.1" },
    directory,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 30)
  const report = await running
  assert.ok(report.checks.some(c => c.status === "阻塞"))
  const replacement = net.createServer().listen(port, "127.0.0.1")
  await once(replacement, "listening")
  await new Promise(resolve => replacement.close(resolve))
})
