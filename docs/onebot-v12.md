# OneBot v12 适配器

本适配器对接支持 OneBot v12 **反向 WebSocket** 的协议端，提供私聊、群聊、多账号、媒体文件与标准通知。入口为 `/OneBotv12`，默认关闭。

协议依据为 [OneBot 12 候选标准](https://12.onebot.dev/)，核对日期：2026-09-21。验收使用模拟协议端，尚未针对特定实际协议端完成联调。

## 配置与启动

按照 [README](../README.md) 安装依赖，使用 Node.js ≥23.11。首次启动会将默认配置复制到 `config/config/onebotv12.yaml`，也可以提前从 `config/default_config/onebotv12.yaml` 复制。

```yaml
enable: true
access_token: "替换为与协议端一致的令牌"
action_timeout: 60000
max_file_size: 10485760
```

| 配置             | 含义                                                      |
| ---------------- | --------------------------------------------------------- |
| `enable`         | 是否注册适配器入口，默认 `false`                          |
| `access_token`   | 适配器令牌，默认空字符串，不裁剪首尾空白                  |
| `action_timeout` | 动作超时及等待连接事件的时间，毫秒，默认 60000            |
| `max_file_size`  | 本地读取、下载和 Base64 解码的大小上限，字节，默认 10 MiB |

两个数值配置必须是 1～2147483647 的整数。配置更改后重启 Yunzai。默认端口为 2536，服务器地址、端口和 TLS 沿用 `server.yaml`。

在协议端选择反向 WebSocket，填写：

```text
ws://localhost:2536/OneBotv12
```

协议端使用 `Sec-WebSocket-Protocol: 12.<impl>` 和 `Authorization: Bearer <令牌>`；无法设置 Authorization 时使用 `/OneBotv12?access_token=<URL编码后的令牌>`。存在 Authorization 时以请求头为准，错误的请求头不会回退到 query。空令牌关闭适配器层鉴权。

服务器全局 `server.auth` 独立生效，两层校验都必须通过。例如全局配置了 `Authorization: Bearer ...` 时，应在两侧使用一致的请求头；只传 `access_token` query 不能满足全局 Authorization 配置。握手失败返回 HTTP 401，子协议错误返回 400，路径错误返回 404。协议端负责断线重连。

连接日志隐藏 Authorization、Cookie、access_token 和服务器配置的鉴权字段。v12 WebSocket 数据帧只记录长度，避免记录文件数据。

## 账号和插件接口

机器人键固定为 `ob12/<platform>/<user_id>`，两个部分分别使用百分号编码，点号也编码。例如 QQ 账号 `12345` 的键是 `ob12/qq/12345`。

| 字段                                  | 内容                                         |
| ------------------------------------- | -------------------------------------------- |
| `Bot.bots[key]`、`Bot[key]`           | 当前在线账号对象                             |
| `Bot.uin`                             | 在线账号键集合                               |
| `bot.uin`、`bot.self_id`、`e.self_id` | 带命名空间的账号键                           |
| `bot.self`、`e.self`                  | 协议原始 `{ platform, user_id }`             |
| `e.self_user_id`                      | 机器人在平台上的原始用户 ID                  |
| `e.onebot`                            | 原始业务事件及扩展字段，不受内部字段映射影响 |
| `bot.supportedActions`                | 当前连接支持的动作 Set；`null` 表示能力未知  |

用户、群、消息和文件 ID 保留为字符串。调用封装接口时也可使用安全整数，超出 JavaScript 安全整数范围的 ID 必须使用字符串。

```js
const bot = Bot["ob12/qq/12345"]
await bot.pickFriend("67890").sendMsg("你好")
await bot.pickGroup("001234").sendMsg([segment.at("67890"), "你好"])
await e.reply("收到", true) // 引用原消息
```

主人配置中的键同样使用新账号键，例如 `master: ["ob12/qq/12345:67890"]`。现有 `#设置主人` 流程直接生成这种格式。内置 @机器人及机器人本人判断使用原始 `self_user_id`。第三方插件如假设 `self_id` 是 QQ 数字账号，需要自行适配。

发送到指定平台时必须选择具体 `Bot[key]`，或显式使用 `Bot.sendFriendMsg(key, user_id, message)` / `Bot.sendGroupMsg(key, group_id, message)`。全局 `Bot.pickFriend(id)` / `Bot.pickGroup(id)` 仍沿用已有的跨适配器查找和数值转换逻辑，不适用于跨平台同号或超长 ID 的精确路由。

### 已封装动作

| 插件接口                                          | v12 动作                           |
| ------------------------------------------------- | ---------------------------------- |
| 好友/群 `.sendMsg()`、`.sendFile()`               | `send_message`，文件先上传         |
| 好友/群/账号 `.recallMsg(message_id)`             | `delete_message`                   |
| 好友 `.getInfo()`                                 | `get_user_info`                    |
| 账号 `.getFriendArray/List/Map()`                 | `get_friend_list`                  |
| 群 `.getInfo()`、账号 `.getGroupArray/List/Map()` | `get_group_info`、`get_group_list` |
| 群 `.getMemberArray/List/Map()`                   | `get_group_member_list`            |
| 成员 `.getInfo()`                                 | `get_group_member_info`            |
| 群 `.setName(name)`、`.quit()`                    | `set_group_name`、`leave_group`    |

`pickUser` 等价于 `pickFriend`，可用于非好友私聊；`pickMember(group_id, user_id)` 与 `pickGroup(group_id).pickMember(user_id)` 等价。列表接口中 Array 返回信息对象数组，List 返回 ID 数组，Map 返回以字符串 ID 为键的 Map。`getGroupMemberMap(group_id)` 查询单群，省略参数时显式查询所有群成员。`fl/gl/gml` 是账号独立缓存；上线异步加载自身、好友与群信息，成员信息按需加载。

`sendMsg` 返回包含 `message_id`、`time` 的结果，撤回、改群名和退群成功返回 `true`。标准未定义的管理员角色、头像和历史消息查询不伪造，也没有通用的 `getMsg/getReply` 能力。

### 原始动作与错误

```js
const response = await bot.sendApi("get_user_info", { user_id: "67890" })
console.log(response.data)
await bot.sendApi("vendor.custom_action", { value: 1 })
await e.reply(segment.raw({ type: "vendor.custom_segment", data: { value: 1 } }))
```

`sendApi(action, params = {})` 返回完整 `{ status, retcode, data, message, echo }`，非元动作的顶层 `self` 由账号自动附加。失败抛出 Error，远端动作失败带 `action`、`retcode`、`response`；本地错误通过 `code` 区分 `TIMEOUT`、`DISCONNECTED`、`ACCOUNT_OFFLINE`、`UNSUPPORTED_ACTION`、`INVALID_RESPONSE` 等。失败与超时不自动重发。

标准封装根据 `get_supported_actions` 检查能力，发现失败时记录“能力未知”，调用以实际响应为准。原始 `sendApi` 可显式调用扩展动作，不受封装能力检查限制。扩展入口不提供实现专属转换。

## 消息与事件

支持 `text`、`at`（含 all）、`reply`、`image`、`record`、`audio`、`video`、`file`、`location`。`record` 对应 v12 的 `voice`；`audio` 与 `location` 可用 `segment.custom(type, data)` 构造。引用发送者可省略。媒体段也可显式传入当前协议端有效的 `file_id`。

发送整条消息前检查所有段。按钮、合并转发、JSON/XML 等未封装段明确报 `UNSUPPORTED_SEGMENT`，不自动转文本或拆分消息；`sendForwardMsg` 同样拒绝。现有插件的 `e.reply()` 包装器会记录发送错误并返回 `{ error: [...] }`。依赖合并转发的内置或第三方命令也受此限制。

接收未知消息段保留为 `{ type: "raw", data: 原始段 }`，不作为命令文本解析。

| v12 事件                                | Yunzai 事件                       |
| --------------------------------------- | --------------------------------- |
| `message.private` / `message.group`     | 同名事件，非空原始子类型继续附加  |
| `notice.friend_increase/decrease`       | `notice.friend.increase/decrease` |
| `notice.private_message_delete`         | `notice.friend.recall`            |
| `notice.group_member_increase/decrease` | `notice.group.increase/decrease`  |
| `notice.group_message_delete`           | `notice.group.recall`             |

通知的原始子类型保存在 `e.onebot.sub_type`。好友增减使对应缓存失效，群成员增减使该群成员缓存失效。私聊不假设为好友会话，不补 v11 的 `friend/normal` 子类型。

可订阅 `Bot.on("onebot12.event", ({ event, bot, self_id, version }) => ...)` 获取原始事件副本。元事件和账号未知的事件可能没有 `bot/self_id`。频道、扩展请求、未知通知只进入该入口；已被接管连接上的旧账号业务事件会被忽略。异步监听者需自行捕获异常。

### 媒体与文件

- HTTP(S) URL 通过 `upload_file(type: "url")` 交给协议端；本地路径、Buffer、`base64://` 通过 `type: "data"` 上传，不假定双方共享文件系统。
- 接收媒体通过 `get_file(type: "url")` 解析。需请求头的 URL 由 Yunzai 带头下载，再使用现有临时文件服务；明确返回 10004 时尝试 `type: "data"`。
- 临时 URL 沿用 `server.url`、文件过期与访问次数配置。读取临时 URL 的客户端必须能访问该地址。
- 本地读取、下载和 Base64 解码受 `max_file_size` 限制。直接交给协议端的 URL 上传受协议端限制；不支持自动分片。
- 图片解析成功后才加入 `e.img`。解析失败仍保留消息、`file_id` 和段内 `error`，文本命令可继续处理。
- 不跨连接缓存文件 ID 或 URL，不读取协议端远程路径。更底层的文件与扩展能力可通过 `sendApi` 显式使用。

## 连接行为与实现边界

入口文件负责注册，`plugins/adapter/onebot12/` 内分别管理连接、账号、协议校验和消息/文件转换。公共 WebSocket 升级逻辑位于 `lib/ws.js`，`Bot.wsGuards[path](req)` 可返回 `{ statusCode, message }` 拒绝升级，或返回 undefined 放行；全局鉴权先执行。

连接首事件必须为 `meta.connect`，版本须与握手子协议一致。初始化查询状态和能力，将状态快照与期间收到的增量合并后发布账号。初始状态查询失败但已收到完整首次 `status_update` 时使用该事件初始化。后续状态增量未提及的账号保持原状，`good` 与账号 `online` 分开记录。

初始化期间最多缓存 100 条业务事件和 100 条状态更新，超限或无法获得初始状态时关闭连接。合法心跳只记录最近时间，不要求启用心跳。非法帧、基本字段缺失、重复 connect、版本错误关闭连接；具体业务转换失败记录错误并跳过该业务事件。

同一账号由更新的有效连接接管，旧请求立即失败，旧连接后续状态无法夺回账号。离线/断线移除在线对象，触发 `offline.<账号键>`；上线触发 `connect.<账号键>`。异步查询、消息转换和旧连接关闭不能覆盖新账号对象。

动作响应直接匹配当前连接的 echo；每个账号的业务转换顺序执行，不同账号互不等待。断线拒绝待处理动作、终止进行中的媒体下载并清理连接状态。

首版没有封装：正向 WebSocket、HTTP、Webhook、MessagePack、Guild/Channel、文件分片、禁言踢人、请求审批、历史消息及特定协议端扩展。不保证依赖 QQ/ICQQ 专属接口或数字账号假设的插件直接可用。

## 验证与排查

```sh
node --test test/onebot12/*.test.js
# 或 npm run test:onebot12
```

测试通过本地 HTTP/WebSocket 模拟协议端与受控会话覆盖握手、双层鉴权、字符串 ID、多账号、状态增量、连接接管、动作匹配、超时/清理、插件回复与主人识别、媒体和通知。框架事件准备及插件回复处理使用实际源码方法隔离测试，不启动 Redis、浏览器或真实聊天账号。

| 现象                       | 检查项                                                                |
| -------------------------- | --------------------------------------------------------------------- |
| 404                        | 适配器是否启用并重启；路径是否为 `/OneBotv12`                         |
| 400                        | 子协议是否为 `12.<impl>`，而不是 v11 或多个子协议                     |
| 401                        | 适配器令牌和 `server.auth` 是否均满足；Authorization 是否覆盖了 query |
| 建连后马上断开             | 首事件、版本、JSON 文本帧和基本字段是否合法                           |
| 连接存在但账号未上线       | `get_status` / 首次 `status_update` 中是否有 `online: true` 的账号    |
| UNSUPPORTED_ACTION / 10002 | 协议端未实现该动作                                                    |
| 图片没有 URL               | 协议端文件能力、远端下载响应或文件大小限制；检查段内 error            |
| 超时                       | 协议端是否按原字符串返回 echo；不会自动重发可能已执行的动作           |

协议参考：[Connect](https://12.onebot.dev/connect/)、[反向 WebSocket](https://12.onebot.dev/connect/communication/websocket-reverse/)、[元事件](https://12.onebot.dev/interface/meta/events/)、[动作请求](https://12.onebot.dev/connect/data-protocol/action-request/)、[动作响应](https://12.onebot.dev/connect/data-protocol/action-response/)、[消息段](https://12.onebot.dev/interface/message/segments/)、[文件](https://12.onebot.dev/interface/file/actions/)、[扩展规则](https://12.onebot.dev/interface/rules/)。
