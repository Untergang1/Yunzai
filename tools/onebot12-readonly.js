import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { randomUUID } from "node:crypto"
import YAML from "yaml"
import { WebSocketServer } from "ws"
import { OneBot12Adapter } from "../plugins/adapter/onebot12/adapter.js"
import { WechatAIAccount } from "../plugins/adapter/onebot12/wechat-ai.js"

// Probe-only subset of Bot.wsConnect: same auth, routing and guard order, without loading lib/bot.js.
function upgrade(bot, req, socket, head) {
  const reject = (statusCode, message) =>
    socket.end(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`)
  let url
  try {
    url = new URL(req.url, "ws://localhost")
  } catch {
    return reject(400, "Bad Request")
  }
  req.query = Object.fromEntries(url.searchParams.entries())
  if (bot.serverAuth(req) === false) return reject(401, "Unauthorized")
  const path = url.pathname.split("/")[1]
  if (!(path in bot.wsf)) return reject(404, "Not Found")
  const failure = bot.wsGuards[path]?.(req)
  if (failure) return reject(failure.statusCode, failure.message)
  bot.wss.handleUpgrade(req, socket, head, conn => {
    conn.on("close", () => bot.cleanupBotConnection(conn))
    for (const handler of bot.wsf[path]) handler(conn, req, socket, head)
  })
}

export const READ_ACTIONS = new Set([
  "get_version",
  "get_status",
  "get_supported_actions",
  "get_self_info",
  "get_user_info",
  "get_group_list",
  "get_group_info",
  "get_group_member_list",
  "get_group_member_info",
  "get_friend_list", // One deliberate unsupported read probe.
  "wechat.search_contacts",
  "wechat.get_contact_detail",
  "wechat.get_recent_chats",
  "wechat.get_recent_messages",
  "wechat.search_text_messages",
  "wechat.get_chat_summary_context",
])
const safeCodes = new Set([
  "TIMEOUT",
  "DISCONNECTED",
  "ACCOUNT_OFFLINE",
  "ACTION_FAILED",
  "UNSUPPORTED_ACTION",
  "INVALID_RESPONSE",
  "READ_ONLY_BLOCKED",
  "ERR_ASSERTION",
  "CONNECT_TIMEOUT",
  "ABORT_ERR",
  "EADDRINUSE",
])
export function failure(err) {
  return {
    code: safeCodes.has(err?.code) ? err.code : "CHECK_FAILED",
    ...(Number.isSafeInteger(err?.retcode) ? { retcode: err.retcode } : {}),
    ...(READ_ACTIONS.has(err?.action) ? { action: err.action } : {}),
  }
}
export function guardSocket(ws, audit) {
  const send = ws.send.bind(ws)
  ws.send = (frame, callback) => {
    let request
    try {
      request = JSON.parse(frame.toString())
    } catch {}
    if (
      !request ||
      !READ_ACTIONS.has(request.action) ||
      (request.action === "wechat.get_recent_messages" && request.params?.parse_media !== false)
    ) {
      audit.blocked++
      const err = Object.assign(new Error("Read-only request rejected"), {
        code: "READ_ONLY_BLOCKED",
      })
      if (callback) return callback(err)
      throw err
    }
    audit.sent++
    audit.actions[request.action] = (audit.actions[request.action] || 0) + 1
    return send(frame, callback)
  }
}
export async function waitFor(check, timeout, signal) {
  const end = Date.now() + timeout
  while (!check()) {
    signal?.throwIfAborted()
    if (Date.now() >= end)
      throw Object.assign(new Error("Connection timeout"), { code: "CONNECT_TIMEOUT" })
    await delay(50, undefined, { signal })
  }
}
export function saveReport(directory, report) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const json = path.join(directory, "report.json")
  fs.writeFileSync(`${json}.tmp`, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(`${json}.tmp`, json)
  const lines = [
    "# wechat-ai 只读联调",
    "",
    `开始：${report.started_at}`,
    "",
    "真实连接；未加载业务插件；不执行 RPA 写操作或 dry-run。",
    "",
    "| 检查 | 结果 | 耗时 ms | 脱敏证据 |",
    "| --- | --- | ---: | --- |",
    ...report.checks.map(
      c => `| ${c.name} | ${c.status} | ${c.ms ?? ""} | ${JSON.stringify(c.evidence || {})} |`,
    ),
    "",
    "## 出站审计",
    "",
    "```json",
    JSON.stringify(report.audit, null, 2),
    "```",
    "",
    "无新消息的事件类型不算通过；无缺口报告不代表没有消息丢失。接管和恢复期间不补发离线消息。",
    "恢复结果由监护进程写入 lifecycle.json 和 lifecycle.md。",
    "",
  ]
  fs.writeFileSync(path.join(directory, "report.md"), lines.join("\n"), { mode: 0o600 })
}
function minimalBot(stats) {
  const bot = new EventEmitter()
  Object.assign(bot, {
    bots: {},
    uin: [],
    wsf: Object.create(null),
    wsGuards: Object.create(null),
    makeLog(level) {
      if (["warn", "error"].includes(level)) stats.adapter_warnings++
    },
    cleanupBotConnection() {},
    // Only the adapter event boundary is exercised, not the application/plugin loader.
    em(name, event) {
      for (;;) {
        this.emit(name, event)
        const dot = name.lastIndexOf(".")
        if (dot < 0) break
        name = name.slice(0, dot)
      }
    },
  })
  return bot
}
const userShape = v => {
  for (const key of ["user_id", "user_name", "user_displayname"])
    assert.equal(typeof v[key], "string")
}
const sameFields = (actual, expected) => {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value)
}
const rowsShape = (v, id) => {
  assert.equal(v.contact.username, id)
  assert.ok(Array.isArray(v.messages) && v.messages.length <= 20)
  assert.equal(v.count, v.messages.length)
  let previous = -Infinity
  for (const row of v.messages) {
    assert.equal(typeof row.server_id, "string")
    assert.ok(Number.isFinite(row.create_time))
    assert.ok(row.create_time >= previous)
    previous = row.create_time
    if (row.text !== undefined) assert.equal(typeof row.text, "string")
  }
}
export async function runProbe({ config, serverConfig, directory, observeMs = 300000, signal }) {
  const report = {
    started_at: new Date().toISOString(),
    mode: "live-readonly",
    node: process.version,
    checks: [],
    audit: { sent: 0, blocked: 0, actions: {} },
  }
  const stats = {
    heartbeat: 0,
    private: 0,
    group: 0,
    metadata: 0,
    self: 0,
    gap: 0,
    dropped_known: 0,
    converted_private: 0,
    converted_group: 0,
    mismatches: 0,
    adapter_warnings: 0,
  }
  const checkpoint = () => saveReport(directory, report)
  const add = (name, status, evidence = {}, ms = 0) => {
    report.checks.push({ name, status, ms, evidence })
    checkpoint()
  }
  const check = async (name, task) => {
    signal?.throwIfAborted()
    const start = Date.now()
    try {
      const result = await task()
      add(name, "通过", result || {}, Date.now() - start)
      return true
    } catch (err) {
      add(
        name,
        ["DISCONNECTED", "ACCOUNT_OFFLINE"].includes(err.code) ? "阻塞" : "失败",
        failure(err),
        Date.now() - start,
      )
      return false
    }
  }
  const bot = minimalBot(stats)
  bot.wss = new WebSocketServer({ noServer: true })
  bot.serverAuth = req =>
    Object.entries(serverConfig.auth || {}).every(
      ([k, v]) => req.headers[k.toLowerCase()] === v || req.query[k] === v,
    )
  const adapter = new OneBot12Adapter(bot, { ...config, action_timeout: 60000 })
  adapter.load()
  const accept = adapter.accept.bind(adapter)
  adapter.accept = (ws, req) => {
    guardSocket(ws, report.audit)
    return accept(ws, req)
  }
  const server = http.createServer((req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on("upgrade", (req, socket, head) => {
    if (req.headers["sec-websocket-protocol"] !== "12.wechat-ai" || adapter.sessions.size) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
      return
    }
    upgrade(bot, req, socket, head)
  })
  let observing = false
  bot.on("onebot12.event", ({ event }) => {
    if (!observing) return
    if (event.type === "meta" && event.detail_type === "heartbeat") stats.heartbeat++
    if (event.type === "meta" && event.detail_type === "wechat.event_gap") {
      stats.gap++
      stats.dropped_known += Number.isSafeInteger(event.dropped) ? event.dropped : 0
    }
    if (event.type === "message") {
      const key = {
        private: "private",
        group: "group",
        "wechat.message_metadata": "metadata",
        "wechat.message_sent": "self",
      }[event.detail_type]
      if (key) stats[key]++
    }
  })
  bot.on("message", e => {
    if (!observing) return
    try {
      const raw = e.onebot
      assert.ok(["private", "group"].includes(raw.detail_type))
      for (const k of ["id", "message_id", "group_id", "time"]) assert.equal(e[k], raw[k])
      assert.equal(e.user_id, raw.user_id === raw.self.user_id ? e.self_id : raw.user_id)
      assert.deepEqual(e.self, raw.self)
      assert.equal(e.self_user_id, raw.self.user_id)
      assert.equal(e.message_type, raw.detail_type)
      assert.equal(e.raw_message, raw.alt_message)
      assert.deepEqual(
        e.message.map(s => s.text),
        raw.message.map(s => s.data.text),
      )
      stats[`converted_${raw.detail_type}`]++
    } catch {
      stats.mismatches++
    }
  })
  const closeSockets = () => {
    for (const ws of bot.wss.clients) ws.terminate()
  }
  signal?.addEventListener("abort", closeSockets, { once: true })
  checkpoint()
  try {
    server.listen(serverConfig.port, serverConfig.host || "0.0.0.0")
    await once(server, "listening", { signal })
    await waitFor(() => [...adapter.sessions].some(s => s.ready), 60000, signal)
    const session = [...adapter.sessions].find(s => s.ready)
    await waitFor(() => session.pending.size === 0, 60000, signal)
    const call = async (action, params = {}, self) =>
      (await session.call(action, params, self)).data
    let identity,
      account,
      groups = [],
      chats = []
    await check("连接与版本", async () => {
      const version = await call("get_version")
      assert.equal(version.impl, "wechat-ai")
      assert.equal(version.onebot_version, "12")
      assert.deepEqual(version, session.version)
      return { handshake_and_echo: true }
    })
    await check("能力发现", async () => {
      const actions = await call("get_supported_actions")
      assert.ok(Array.isArray(actions) && actions.every(a => typeof a === "string"))
      for (const a of READ_ACTIONS) if (a !== "get_friend_list") assert.ok(actions.includes(a))
      assert.ok(!actions.includes("get_friend_list"))
      return { count: actions.length, friend_list_unsupported: true }
    })
    await check("本地状态与账号", async () => {
      const status = await call("get_status")
      identity = status.bots.find(b => b.self.platform === "wechat")?.self
      assert.ok(identity)
      account = Object.values(bot.bots).find(b => b.self.user_id === identity.user_id)
      return {
        good: status.good,
        account_online: !!account,
        readiness: Object.fromEntries(
          ["database", "polling", "events", "rpa", "main_window"].map(k => [
            k,
            !!status.bots[0]["wechat.local_readiness"]?.[k],
          ]),
        ),
      }
    })
    if (!identity) throw Object.assign(new Error("No account"), { code: "ACCOUNT_OFFLINE" })
    const read = (action, params = {}) => call(action, params, identity)
    await check("自身资料", async () => {
      const data = await read("get_self_info")
      userShape(data)
      assert.equal(data.user_id, identity.user_id)
      if (account) sameFields(account.info, data)
      return { adapter_info_checked: !!account }
    })
    await check("群列表", async () => {
      groups = await read("get_group_list")
      assert.ok(Array.isArray(groups))
      for (const g of groups) {
        assert.equal(typeof g.group_id, "string")
        assert.equal(typeof g.group_name, "string")
      }
      if (account) assert.deepEqual(await account.getGroupArray(), groups)
      return { count: groups.length, wrapper_checked: !!account }
    })
    await check("近期会话抽样", async () => {
      const data = await read("wechat.get_recent_chats", { limit: 20 })
      assert.ok(Array.isArray(data.chats) && data.chats.length <= 20)
      chats = data.chats
      return { count: chats.length }
    })
    const selected = [
      [
        "私聊样本",
        chats.find(
          c =>
            c.contact?.username &&
            !c.contact.is_chatroom &&
            c.contact.username !== identity.user_id,
        ),
      ],
      [
        "群样本",
        chats.find(
          c => c.contact?.is_chatroom && groups.some(g => g.group_id === c.contact.username),
        ),
      ],
    ]
    for (const [label, chat] of selected) {
      if (!chat) {
        add(label, "未验证", { reason: "NO_SAMPLE_IN_RECENT_20" })
        continue
      }
      const id = chat.contact.username
      const group = chat.contact.is_chatroom
      await check(`${label}资料`, async () => {
        const detail = await read("wechat.get_contact_detail", { contact_name: id })
        assert.equal(detail.contact.username, id)
        const found = await read("wechat.search_contacts", { query: id, limit: 20 })
        assert.ok(found.contacts.some(c => c.username === id))
        const info = await read(
          group ? "get_group_info" : "get_user_info",
          group ? { group_id: id } : { user_id: id },
        )
        if (!group) userShape(info)
        if (account)
          sameFields(await (group ? account.pickGroup(id) : account.pickFriend(id)).getInfo(), info)
        return { exact_id: true, wrapper_checked: !!account }
      })
      if (group)
        await check("群样本成员", async () => {
          const members = await read("get_group_member_list", { group_id: id })
          assert.ok(Array.isArray(members))
          members.forEach(userShape)
          if (account) {
            const wrapped = await account.pickGroup(id).getMemberArray()
            assert.equal(wrapped.length, members.length)
            members.forEach((m, i) => sameFields(wrapped[i], m))
          }
          if (members.length) {
            const info = await read("get_group_member_info", {
              group_id: id,
              user_id: members[0].user_id,
            })
            sameFields(info, members[0])
            if (account)
              sameFields(await account.pickMember(id, members[0].user_id).getInfo(), info)
          }
          return {
            count: members.length,
            member_detail_checked: members.length > 0,
            wrapper_checked: !!account,
          }
        })
      let recent
      await check(`${label}历史`, async () => {
        recent = await read("wechat.get_recent_messages", {
          contact_name: id,
          limit: 20,
          include_non_text: true,
          parse_media: false,
        })
        rowsShape(recent, id)
        return {
          count: recent.count,
          text_count: recent.messages.filter(m => typeof m.text === "string").length,
        }
      })
      await check(`${label}文本搜索`, async () => {
        const sample = recent?.messages.find(
          m => typeof m.text === "string" && m.text.trim() && m.server_id !== "0",
        )
        const data = await read("wechat.search_text_messages", {
          contact_name: id,
          limit: 20,
          ...(sample
            ? { start_timestamp: sample.create_time, end_timestamp: sample.create_time }
            : {}),
        })
        rowsShape(data, id)
        if (sample)
          assert.ok(
            data.messages.some(
              m => m.server_id === sample.server_id && m.text.startsWith(sample.text),
            ),
          )
        return { count: data.count, history_cross_checked: !!sample }
      })
      await check(`${label}摘要上下文`, async () => {
        const data = await read("wechat.get_chat_summary_context", { contact_name: id, limit: 20 })
        rowsShape(data, id)
        assert.equal(typeof data.context, "string")
        for (const row of data.messages) if (row.text) assert.ok(data.context.includes(row.text))
        return { count: data.count, context_chars: data.context.length }
      })
    }
    const negative = async (name, action, params, self, retcode) =>
      check(name, async () => {
        try {
          await session.call(action, params, self)
          assert.fail()
        } catch (err) {
          assert.equal(err.retcode, retcode)
          assert.equal(err.action, action)
          assert.equal(typeof err.response.echo, "string")
        }
        return { expected_retcode: retcode }
      })
    await negative(
      "错误账号",
      "get_self_info",
      {},
      { platform: "wechat", user_id: `probe_missing_${randomUUID()}` },
      10102,
    )
    await negative(
      "不存在联系人",
      "get_user_info",
      { user_id: `probe_missing_${randomUUID()}` },
      identity,
      35001,
    )
    await negative("越界参数", "wechat.get_recent_chats", { limit: 101 }, identity, 10003)
    await negative("未实现好友列表", "get_friend_list", {}, identity, 10002)
    if (account)
      await check("微信专用账号与好友封装", async () => {
        assert.ok(account instanceof WechatAIAccount)
        await assert.rejects(account.getFriendArray(), { code: "UNSUPPORTED_ACTION" })
      })
    else add("微信适配器账号", "阻塞", { reason: "ACCOUNT_OFFLINE" })
    observing = true
    report.observation_started_at = new Date().toISOString()
    checkpoint()
    await delay(observeMs, undefined, { signal })
    await Promise.all([...session.queues.values()])
    observing = false
    for (const kind of ["private", "group"])
      add(
        `实时${kind === "private" ? "私聊" : "群聊"}`,
        stats[kind] === 0
          ? "未验证"
          : stats[kind] === stats[`converted_${kind}`] && !stats.mismatches
            ? "通过"
            : "失败",
        {
          received: stats[kind],
          converted: stats[`converted_${kind}`],
          mismatches: stats.mismatches,
        },
      )
    add(
      "实时观察与心跳",
      session.closed || !stats.heartbeat || stats.gap || stats.mismatches ? "失败" : "通过",
      stats,
      observeMs,
    )
    await check("结束状态", async () => {
      const status = await call("get_status")
      assert.ok(status.bots.some(b => b.online && b.self.user_id === identity.user_id))
      return { good: status.good, account_online: true }
    })
  } catch (err) {
    add("测试中断", "阻塞", failure(err))
  } finally {
    observing = false
    signal?.removeEventListener("abort", closeSockets)
    closeSockets()
    await new Promise(resolve => bot.wss.close(resolve))
    if (server.listening) await new Promise(resolve => server.close(resolve))
    report.finished_at = new Date().toISOString()
    report.observation = stats
    add("出站只读审计", report.audit.blocked === 0 ? "通过" : "失败", {
      requests: report.audit.sent,
      blocked: report.audit.blocked,
    })
    checkpoint()
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.argv[2]
  if (!directory) throw new Error("Usage: node tools/onebot12-readonly.js <report-directory>")
  const config = YAML.parse(fs.readFileSync("config/config/onebotv12.yaml", "utf8"))
  const serverConfig = YAML.parse(fs.readFileSync("config/config/server.yaml", "utf8"))
  if (config.enable !== true || serverConfig.https)
    throw new Error("Requires enabled adapter and plain WS")
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const deadline = setTimeout(stop, 15 * 60 * 1000)
  try {
    const report = await runProbe({ config, serverConfig, directory, signal: controller.signal })
    process.exitCode = report.checks.some(c => ["失败", "阻塞"].includes(c.status)) ? 1 : 0
  } finally {
    clearTimeout(deadline)
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }
}
