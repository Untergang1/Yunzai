import { randomUUID } from "node:crypto"
import {
  botId,
  error,
  isObject,
  META_ACTIONS,
  validateEvent,
  validateResponse,
  validateStatus,
} from "./protocol.js"

export class Session {
  pending = new Map()
  accounts = new Map()
  revoked = new Set()
  updates = []
  buffered = []
  queues = new Map()
  downloads = new Set()
  ready = false
  closed = false
  capabilities = null

  constructor(adapter, ws, req, sequence) {
    Object.assign(this, { adapter, ws, req, sequence })
    this.timer = setTimeout(
      () => this.fail("Waiting for meta.connect timed out"),
      adapter.config.action_timeout,
    )
    ws.on("message", (data, binary) => this.receive(data, binary))
    ws.once("close", () => this.dispose())
    ws.on("error", () => this.dispose())
  }

  call(action, params = {}, self) {
    if (this.closed || this.ws.readyState !== 1)
      return Promise.reject(error("OneBot connection closed", "DISCONNECTED", { action }))
    if (typeof action !== "string" || !action || !isObject(params))
      return Promise.reject(error("Invalid action or params", "INVALID_ACTION", { action }))
    const request = { action, params, echo: randomUUID() }
    if (!META_ACTIONS.has(action) && self) request.self = self
    return new Promise((resolve, reject) => {
      const finish = (err, response) => {
        const pending = this.pending.get(request.echo)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(request.echo)
        if (err) reject(err)
        else resolve(response)
      }
      const timer = setTimeout(
        () => finish(error("OneBot action timed out", "TIMEOUT", { action })),
        this.adapter.config.action_timeout,
      )
      this.pending.set(request.echo, { timer, finish, self, action })
      try {
        this.ws.send(JSON.stringify(request), err => {
          if (err) finish(error("OneBot send failed", "SEND_FAILED", { action, cause: err }))
        })
      } catch (cause) {
        finish(error("OneBot send failed", "SEND_FAILED", { action, cause }))
      }
    })
  }

  receive(frame, binary = false) {
    if (this.closed) return
    try {
      if (binary) throw new Error("Only JSON text frames are supported")
      const data = JSON.parse(frame.toString())
      if (isObject(data) && Object.hasOwn(data, "echo") && !Object.hasOwn(data, "type")) {
        const pending = this.pending.get(data.echo)
        if (!pending) return // Late, duplicate or unrelated response.
        if (!validateResponse(data)) {
          pending.finish(
            error("Invalid OneBot response", "INVALID_RESPONSE", { action: pending.action }),
          )
        } else if (data.status !== "ok" || data.retcode !== 0) {
          pending.finish(
            error(data.message || "OneBot action failed", "ACTION_FAILED", {
              action: pending.action,
              retcode: data.retcode,
              response: data,
            }),
          )
        } else pending.finish(null, data)
        return
      }
      if (!validateEvent(data)) throw new Error("Invalid OneBot event")
      if (!this.version) {
        if (data.type !== "meta" || data.detail_type !== "connect")
          throw new Error("First event must be meta.connect")
        const version = data.version
        if (
          !isObject(version) ||
          version.onebot_version !== "12" ||
          typeof version.version !== "string" ||
          `12.${version.impl}` !== this.req.headers["sec-websocket-protocol"]
        )
          throw new Error("OneBot version/subprotocol mismatch")
        this.version = { ...version }
        clearTimeout(this.timer)
        this.adapter.raw(this, data)
        this.initialize()
        return
      }
      if (data.type === "meta") {
        if (data.detail_type === "connect") throw new Error("Duplicate meta.connect")
        if (data.detail_type === "status_update") {
          if (!validateStatus(data.status)) throw new Error("Invalid status_update")
          if (this.ready) this.applyStatus(data.status)
          else {
            if (this.updates.length >= 100)
              throw new Error("Too many initialization status updates")
            this.updates.push(data.status)
          }
        } else if (data.detail_type === "heartbeat") {
          if (!Number.isSafeInteger(data.interval) || data.interval <= 0)
            throw new Error("Invalid heartbeat")
          this.lastHeartbeat = data.time
        }
        this.adapter.raw(this, data)
        return
      }
      if (!this.ready) {
        if (this.buffered.length >= 100) throw new Error("Initialization event buffer exceeded")
        this.buffered.push(data)
      } else this.dispatch(data)
    } catch (cause) {
      this.fail(cause.message)
    }
  }

  async initialize() {
    // Responses are handled directly, never on a business-event queue.
    this.call("get_supported_actions")
      .then(response => {
        if (
          !Array.isArray(response.data) ||
          !response.data.every(action => typeof action === "string")
        )
          throw new Error("Invalid supported action list")
        if (!this.closed) this.capabilities = new Set(response.data)
      })
      .catch(err => {
        if (!this.closed) this.adapter.log("warn", `能力未知：${err.message}`)
      })
    try {
      let snapshot
      try {
        snapshot = (await this.call("get_status")).data
        if (!validateStatus(snapshot)) throw new Error("Invalid get_status response")
      } catch (err) {
        if (!this.updates.length) throw err
        snapshot = this.updates.shift() // The first status_update is a full snapshot.
      }
      if (this.closed) return
      // Merge before publishing accounts, avoiding transient online/offline notifications.
      const bots = new Map(snapshot.bots.map(bot => [botId(bot.self), bot]))
      let good = snapshot.good
      for (const update of this.updates) {
        good = update.good
        for (const bot of update.bots) bots.set(botId(bot.self), bot)
      }
      this.updates = []
      this.ready = true
      this.applyStatus({ good, bots: [...bots.values()] })
      for (const event of this.buffered) this.dispatch(event)
      this.buffered = []
    } catch (err) {
      if (!this.closed) this.fail(`Initialization failed: ${err.message}`)
    }
  }

  applyStatus(status) {
    this.good = status.good
    for (const item of status.bots) this.adapter.updateAccount(this, item)
    for (const bot of this.accounts.values()) bot.stat.good = this.good
  }

  dispatch(event) {
    const key = botId(event.self)
    const bot = this.accounts.get(key)
    if (this.revoked.has(key)) return
    if (!bot?.active || this.adapter.owners.get(key) !== this) {
      this.adapter.raw(this, event)
      return
    }
    this.adapter.raw(this, event, bot)
    const previous = this.queues.get(key) || Promise.resolve()
    const task = previous
      .then(async () => {
        if (bot.isActive()) await this.adapter.handleEvent(bot, event)
      })
      .catch(err => this.adapter.log("warn", `事件处理失败：${err.message}`, key))
    this.queues.set(key, task)
    task.finally(() => {
      if (this.queues.get(key) === task) this.queues.delete(key)
    })
  }

  rejectAccount(key) {
    for (const pending of this.pending.values())
      if (pending.self && botId(pending.self) === key)
        pending.finish(
          error("OneBot account offline or replaced", "ACCOUNT_OFFLINE", {
            action: pending.action,
          }),
        )
  }

  fail(reason) {
    this.adapter.log("warn", reason)
    this.dispose()
    // terminate avoids keeping a failed peer/close handshake alive indefinitely.
    this.ws.terminate()
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    for (const controller of this.downloads) controller.abort()
    this.downloads.clear()
    for (const pending of this.pending.values())
      pending.finish(error("OneBot connection closed", "DISCONNECTED", { action: pending.action }))
    for (const [key, bot] of this.accounts) this.adapter.removeAccount(this, key, bot)
    for (const [key, owner] of this.adapter.owners)
      if (owner === this) this.adapter.owners.delete(key)
    this.accounts.clear()
    this.queues.clear()
    this.updates = []
    this.buffered = []
    this.adapter.sessions.delete(this)
  }
}
