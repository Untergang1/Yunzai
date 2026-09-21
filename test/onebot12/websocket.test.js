import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { once } from "node:events"
import { WebSocket, WebSocketServer } from "ws"
import { upgrade, requestLog } from "../../lib/ws.js"
import { OneBot12Adapter } from "../../plugins/adapter/onebot12/adapter.js"
import { verifyRequest } from "../../plugins/adapter/onebot12/protocol.js"
import { makeBot, defaults, connect, message, until } from "./helpers.js"

test("real reverse WS handshake, query routing, event delivery and action response", async t => {
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
  const base = `ws://127.0.0.1:${server.address().port}`
  const clients = []
  t.after(async () => {
    for (const ws of clients) ws.terminate()
    for (const ws of Bot.wss.clients) ws.terminate()
    await new Promise(resolve => Bot.wss.close(resolve))
    await new Promise(resolve => server.close(resolve))
  })
  const ws = new WebSocket(`${base}/OneBotv12?access_token=secret`, "12.test")
  clients.push(ws)
  ws.on("message", frame => {
    const request = JSON.parse(frame)
    ws.send(
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: defaults(request),
        message: "",
        echo: request.echo,
      }),
    )
  })
  await once(ws, "open")
  assert.equal(ws.protocol, "12.test")
  ws.send(JSON.stringify(connect()))
  await until(() => Bot.uin.length === 1)
  let received
  Bot.on("message", e => (received = e))
  ws.send(JSON.stringify(message()))
  await until(() => received)
  assert.equal((await received.reply("hello")).message_id, "90071992547409931234")
  assert.ok(!JSON.stringify(Bot.logs).includes("secret"))
  async function rejected(path, protocol, status, options) {
    const client = new WebSocket(`${base}${path}`, protocol, options)
    clients.push(client)
    const result = await new Promise(resolve => {
      client.on("unexpected-response", (request, response) => {
        response.resume()
        request.destroy()
        resolve(response.statusCode)
      })
      client.on("error", () => {})
    })
    assert.equal(result, status)
  }
  await rejected("/OneBotv12?access_token=wrong", "12.test", 401)
  await rejected("/OneBotv12", "11.test", 400)
  await rejected("/OneBotv12/extra", "12.test", 404)
  // Existing handlers receive the same WS object and retain sendMsg support.
  Bot.wsf.OneBotv11 = [socket => socket.sendMsg({ ok: true })]
  const old = new WebSocket(`${base}/OneBotv11?parameter=value`)
  clients.push(old)
  const frame = once(old, "message")
  await once(old, "open")
  assert.deepEqual(JSON.parse((await frame)[0]), { ok: true })
  ws.close()
  await once(ws, "close")
  await until(() => Bot.uin.length === 0)
  assert.equal(adapter.sessions.size, 0)
})

test("Bearer precedence, exact token bytes, global auth layering and redaction", () => {
  const config = { access_token: " secret " }
  const req = {
    url: "/OneBotv12?access_token=%20secret%20",
    headers: { "sec-websocket-protocol": "12.test" },
  }
  assert.equal(verifyRequest(req, config), undefined)
  req.headers.authorization = "Bearer  secret "
  assert.equal(verifyRequest(req, config), undefined)
  req.headers.authorization = "Bearer wrong"
  assert.equal(verifyRequest(req, config).statusCode, 401)
  const logged = requestLog(
    { headers: { authorization: "secret", "x-auth": "other" }, query: { access_token: "secret" } },
    ["X-Auth"],
  )
  assert.ok(!JSON.stringify(logged).includes("secret"))
  const writes = []
  const Bot = {
    serverAuth: () => false,
    wsf: { OneBotv12: [] },
    wsGuards: {
      OneBotv12: () => {
        throw new Error("must not reach")
      },
    },
  }
  upgrade(
    Bot,
    { ...req, socket: {} },
    { write: v => writes.push(v), destroy() {} },
    Buffer.alloc(0),
    [],
    () => {},
  )
  assert.match(writes[0], /401/)
})
