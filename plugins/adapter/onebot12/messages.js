import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { error, id, isObject } from "./protocol.js"

const media = new Set(["image", "voice", "audio", "video", "file"])
const tooLarge = () => error("File exceeds max_file_size", "FILE_TOO_LARGE")

export class Messages {
  constructor(adapter) {
    this.adapter = adapter
  }
  get limit() {
    return this.adapter.config.max_file_size
  }
  check(buffer) {
    if (buffer.length > this.limit) throw tooLarge()
    return buffer
  }
  base64(value) {
    if (typeof value !== "string") throw new TypeError("Invalid Base64 file")
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
    if ((value.length / 4) * 3 - padding > this.limit) throw tooLarge()
    // Repeated-group regexes can overflow V8's stack on valid multi-megabyte files.
    if (value.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding)))
      throw new TypeError("Invalid Base64 file")
    return this.check(Buffer.from(value, "base64"))
  }
  async upload(bot, file, name) {
    let params
    if (typeof file === "string" && /^https?:\/\//.test(file)) {
      params = {
        type: "url",
        url: file,
        name: name || path.basename(new URL(file).pathname) || "file",
      }
    } else {
      let buffer
      if (Buffer.isBuffer(file)) buffer = this.check(file)
      else if (typeof file === "string" && file.startsWith("base64://"))
        buffer = this.base64(file.slice(9))
      else if (typeof file === "string") {
        const filename = file.startsWith("file://") ? fileURLToPath(file) : file
        const handle = await fs.open(filename, "r")
        try {
          const stat = await handle.stat()
          if (!stat.isFile()) throw new TypeError("File must be a regular file")
          if (stat.size > this.limit) throw tooLarge()
          // Bound the read as well as stat: a file may grow between the two operations.
          const chunks = []
          let size = 0
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            size += chunk.length
            if (size > this.limit) throw tooLarge()
            chunks.push(chunk)
          }
          buffer = Buffer.concat(chunks)
        } finally {
          await handle.close()
        }
        name ||= path.basename(filename)
      } else throw new TypeError("Unsupported file input")
      params = { type: "data", name: name || "file", data: buffer.toString("base64") }
    }
    const result = await bot.invoke("upload_file", params)
    return id(result?.file_id)
  }

  prepare(input, bot) {
    if (!Array.isArray(input)) input = [input]
    if (!input.length) throw new TypeError("Message cannot be empty")
    return input.map(value => {
      if (typeof value === "string" || typeof value === "number")
        return { type: "text", data: { text: String(value) } }
      if (!isObject(value)) throw new TypeError("Invalid message segment")
      if (value.type === "raw") {
        if (
          !isObject(value.data) ||
          typeof value.data.type !== "string" ||
          !isObject(value.data.data)
        )
          throw new TypeError("Raw segment must contain {type, data}")
        return { raw: true, segment: structuredClone(value.data) }
      }
      const data = isObject(value.data) ? { ...value.data } : { ...value }
      delete data.type
      const type = value.type === "record" ? "voice" : value.type
      switch (type) {
        case "text":
          if (typeof data.text !== "string") throw new TypeError("Text must be a string")
          return { type, data: { text: data.text } }
        case "at":
          return data.qq === "all"
            ? { type: "mention_all", data: {} }
            : { type: "mention", data: { user_id: bot.platformId(data.qq) } }
        case "reply":
          return {
            type,
            data: {
              message_id: id(data.id),
              ...(data.qq !== undefined || data.user_id !== undefined
                ? { user_id: bot.platformId(data.user_id ?? data.qq) }
                : {}),
            },
          }
        case "location":
          if (
            !Number.isFinite(data.latitude) ||
            !Number.isFinite(data.longitude) ||
            typeof data.title !== "string" ||
            typeof data.content !== "string"
          )
            throw new TypeError("Invalid location")
          return {
            type,
            data: {
              latitude: data.latitude,
              longitude: data.longitude,
              title: data.title,
              content: data.content,
            },
          }
        default:
          if (!media.has(type))
            throw error(`Unsupported message segment: ${type}`, "UNSUPPORTED_SEGMENT")
          if (data.file_id !== undefined) return { type, data: { file_id: id(data.file_id) } }
          if (!Buffer.isBuffer(data.file) && typeof data.file !== "string")
            throw new TypeError("Media requires file or file_id")
          return { type, data: {}, upload: { file: data.file, name: data.name } }
      }
    })
  }
  async encode(bot, input) {
    const prepared = this.prepare(input, bot) // Validate every segment before any uploads/sends.
    const result = []
    for (const item of prepared) {
      if (item.raw) result.push(item.segment)
      else {
        if (item.upload)
          item.data.file_id = await this.upload(bot, item.upload.file, item.upload.name)
        result.push({ type: item.type, data: item.data })
      }
    }
    return result
  }

  async download(bot, url, headers) {
    const controller = new AbortController()
    bot.session.downloads.add(controller)
    try {
      const response = await this.adapter.fetch(url, {
        headers,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(this.adapter.config.action_timeout),
        ]),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw error(`File HTTP ${response.status}`, "FILE_DOWNLOAD_FAILED")
      }
      if (Number(response.headers.get("content-length")) > this.limit) {
        await response.body?.cancel()
        throw tooLarge()
      }
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > this.limit) throw tooLarge()
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    } finally {
      bot.session.downloads.delete(controller)
    }
  }
  async resolveFile(bot, file_id) {
    let result
    let buffer
    try {
      result = await bot.invoke("get_file", { file_id, type: "url" })
    } catch (err) {
      if (err.retcode !== 10004) throw err
      result = await bot.invoke("get_file", { file_id, type: "data" })
      buffer = this.base64(result?.data)
    }
    if (!isObject(result) || typeof result.name !== "string")
      throw new TypeError("Invalid file result")
    if (!buffer) {
      if (typeof result.url !== "string" || !/^https?:\/\//.test(result.url))
        throw new TypeError("Invalid file URL")
      if (result.headers && Object.keys(result.headers).length)
        buffer = await this.download(bot, result.url, result.headers)
      else return { name: result.name, url: result.url }
    }
    bot.assertActive()
    const url = await this.adapter.Bot.fileToUrl({ buffer, name: result.name })
    return { name: result.name, url: String(url) }
  }
  async decode(bot, segments) {
    const result = []
    for (const segment of segments) {
      const { type, data } = segment
      if (media.has(type)) {
        const item = { type: type === "voice" ? "record" : type, file_id: id(data.file_id) }
        try {
          Object.assign(item, await this.resolveFile(bot, item.file_id))
        } catch (err) {
          item.error = { code: err.code || "FILE_RESOLUTION_FAILED", message: err.message }
          this.adapter.log("warn", `媒体解析失败：${err.message}`, bot.self_id)
        }
        result.push(item)
      } else
        switch (type) {
          case "text":
            if (typeof data.text !== "string") throw new TypeError("Invalid text segment")
            result.push({ type, text: data.text })
            break
          case "mention":
            result.push({ type: "at", qq: bot.localId(id(data.user_id)) })
            break
          case "mention_all":
            result.push({ type: "at", qq: "all" })
            break
          case "reply":
            result.push({
              type,
              id: id(data.message_id),
              user_id: bot.localId(id(data.user_id)),
            })
            break
          case "location":
            result.push({ ...data, type })
            break
          default:
            result.push({ type: "raw", data: structuredClone(segment) })
        }
    }
    return result
  }
}
