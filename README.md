# Yunzai · OneBot v12

本项目 fork 自 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)，主要工作是适配 **OneBot v12**，支持反向 WebSocket、多账号、私聊、群聊、媒体文件和标准通知。通过 [wechat-ai](https://github.com/Untergang1/wechat-ai) 可接入 **微信 4.1.13.9**，专用模块支持私聊/群聊文本收发、单成员 @ 和资料查询；微信媒体、引用和撤回不在当前封装范围内。

上游功能介绍及其他协议的使用方法请参阅 [原项目](https://github.com/TimeRainStarSky/Yunzai)。

## 快速安装

准备 [Node.js](https://nodejs.org) ≥23.11、[Git](https://git-scm.com) 和运行中的 [Valkey](https://valkey.io) / Redis；需要图片渲染时安装 Chrome / Chromium。

```sh
git clone --depth 1 https://github.com/Untergang1/Yunzai.git
cd Yunzai
npm install -g pnpm
pnpm install
node .
```

首次启动会生成 `config/config/` 下的配置文件。Redis 默认连接 `127.0.0.1:6379`，可在 `config/config/redis.yaml` 中修改。

## 接入 OneBot v12 / 微信

1. 修改 `config/config/onebotv12.yaml`，启用适配器并设置与协议端一致的令牌：

   ```yaml
   enable: true
   access_token: "替换为与协议端一致的令牌"
   ```

2. 重启 Yunzai，在协议端配置反向 WebSocket 地址：

   ```text
   ws://localhost:2536/OneBotv12
   ```

   协议端与 Yunzai 不在同一主机或位于不同容器时，将 `localhost` 替换为协议端可访问的 Yunzai 地址。端口默认是 `2536`，可在 `config/config/server.yaml` 中修改。

3. 接入微信 **4.1.13.9** 时，使用 [wechat-ai](https://github.com/Untergang1/wechat-ai) 作为协议端，按其项目说明部署、登录微信并准备数据库凭据。在其运行配置中开启 `onebot.enabled: true`，反向 WebSocket 连接上述地址。只接收和查询时保持 `onebot.write_enabled: false`；需要发送消息时再开启写权限。Docker 中的 `localhost` 指容器自身；Yunzai 在宿主机时，可使用协议端 Compose 配置提供的 `host.docker.internal`。Yunzai 自动识别微信专用模块，无需新配置或迁移账号键。
4. 账号上线后，向机器人私聊发送 `#设置主人`，根据日志中的验证码完成设置。

微信回复返回入队或本地 RPA 执行结果，没有微信消息 ID 或送达回执。群内收到的 @ 目前只保留为文本；启用“仅响应 @”限制时，请使用配置的机器人前缀，或将该群的 `onlyReplyAt` 设为 `0`。具体用法见 [wechat-ai 专用适配](docs/onebot-v12.md#wechat-ai-专用适配)。

适配器默认关闭。完整配置、握手鉴权、插件接口、能力限制和排查方法见 [OneBot v12 适配器文档](docs/onebot-v12.md)；真实读取验收可使用[只读联调入口](docs/onebot-v12.md#真实微信只读联调)。实际可用能力取决于协议端实现，依赖 QQ 专属接口的插件可能需要适配。

## 日常使用

### 运行与日志

在项目根目录执行：

| 命令 | 用途 |
| --- | --- |
| `node .` | 前台运行，Ctrl+C 停止 |
| `pnpm start` | 后台运行 |
| `pnpm restart` | 重启后台进程 |
| `pnpm stop` | 停止后台进程 |
| `pnpm log` | 查看后台日志 |

错误日志保存在 `logs/error.log`，按日期保存的指令日志在 `logs/command.*.log`。需要更详细的控制台日志时，将 `config/config/bot.yaml` 的 `log_level` 改为 `debug`。

### 配置与主人设置

修改 `config/config/` 中的现有配置项，不要用示例覆盖整份文件。`config/default_config/` 是默认模板。

`bot.yaml` 的 `file_watch` 默认为 `true`，群配置和访问控制保存后约 5 秒生效。关闭监听后需重启；修改适配器、服务监听或启动时注册的任务配置也需重启，修改 `file_watch` 本身同样需重启。

向机器人私聊发送 `#设置主人`，查看运行日志中的验证码，再在同一会话中发送验证码。也可手工在 `other.yaml` 的 `master` 列表中追加 `"机器人账号键:用户ID"`，例如 `"ob12/wechat/wxid_bot:wxid_owner"`；保留已有条目并替换为实际 ID。账号键格式见 [账号和插件接口](docs/onebot-v12.md#账号和插件接口)。

### 启用或禁用功能

在 `config/config/group.yaml` 配置：

```yaml
default:
  enable: []
  disable:
    - 添加消息
```

- `enable` 为空时不限制；非空时只允许列表中的功能响应。
- `disable` 禁用列表中的功能，**优先于 `enable`**；同一功能同时出现在两个列表中仍禁用。
- 填写插件代码中的 `name`，不是 `plugins/` 下的目录名，例如“添加消息”“设置主人”“进程管理”。设置白名单时，也要包含需要保留的管理功能。

这些配置只过滤事件响应，插件仍会加载、执行初始化和定时任务；目前没有统一的插件目录加载开关。

配置覆盖顺序为：`default` → `机器人账号键:default` → `群ID` → `机器人账号键:群ID`。后面的同名字段覆盖前面的，列表整体替换、不合并；`default` 和机器人默认设置也用于私聊。

### 关闭主动推送和关键词自动回复

在 `group.yaml` 的现有 `default.disable` 列表中追加：

| 功能名称 | 自动行为 |
| --- | --- |
| `欢迎新人` | 成员入群时发送欢迎消息 |
| `退群通知` | 成员退群时发送提示 |
| `invite` | 自动同意群邀请，并向邀请人发送提示；禁用后也停止自动同意 |
| `notice` | 被拉入人数较少的群时发送提示并自动退群；禁用后也停止自动退群 |
| `添加消息` | 聊天内容匹配已保存的关键词时自动回复；禁用后也停止词条添加、删除和列表指令，已保存词条保留 |

检查单账号和单群设置中的 `disable` 列表：它们会覆盖默认列表，需追加相同名称，或删除该字段以继承默认禁用项。

自动更新和账号上线推送不受上述功能禁用列表控制。这两类自动通知均发给主人私聊，不向群发送；只限制群聊自动消息时可以保留。在 `bot.yaml` 中，`update_time` 是自动更新间隔（分钟），`online_msg_exp` 是上线推送冷却时间（分钟），两者默认均为 `1440`。若也要关闭主人私聊通知，将这两项设为 `0`，并清空 `update_cron`。若配置了自动进程管理，也将 `restart_time` 设为 `0`，清空 `restart_cron`、`stop_cron` 和 `start_cron`；这些任务会产生重启、开关机提示。修改任务配置后需重启，以重新注册定时任务。

“复读”需先由主人发送 `#复读` 才进入复读会话；“进程管理”的手动指令及其重启完成回复仍可保留。“禁止私聊”在 `other.yaml` 的 `disablePrivate: true` 时会自动回复限制提示，当前默认关闭。“autoFriend”自动同意好友请求，但自身不发送聊天消息。

### 群聊响应与冷却

在 `group.yaml` 中按需修改默认设置，或添加单群设置，例如：

```yaml
"123@chatroom":
  onlyReplyAt: 1
  botAlias:
    - 云崽
  groupCD: 500
  singleCD: 2000
```

将示例群 ID 换成实际值；未填写的字段继承前面的设置。

| 配置 | 含义 |
| --- | --- |
| `onlyReplyAt: 0` | 不要求 @ 或前缀，默认值 |
| `onlyReplyAt: 1` | 只响应 @机器人或带 `botAlias` 前缀的消息 |
| `onlyReplyAt: 2` | 与模式 1 相同，但主人不受此项限制 |
| `botAlias` | 消息开头的机器人前缀，例如 `云崽#重启` |
| `groupCD` | 群内指令冷却，默认 500 毫秒，`0` 关闭此项冷却 |
| `singleCD` | 群内个人指令冷却，默认 2000 毫秒，`0` 关闭此项冷却 |

使用模式 1 或 2 时保留 `botAlias` 配置；未配置前缀时，当前实现不启用该响应限制。微信收到的 @ 目前仅保留为文本，请使用前缀触发，或设置 `onlyReplyAt: 0`。

### 访问控制

在 `config/config/other.yaml` 设置：

- `blackUser` / `blackGroup`：忽略指定用户 / 群。
- `whiteUser` / `whiteGroup`：非空时只允许指定用户 / 群；黑名单优先，群消息还需通过用户名单检查。主人也受黑白名单限制。
- `disablePrivate: true`：限制普通用户私聊，仅放行内置的 cookie、抽卡记录等内容及 `disableAdopt` 配置的通行字符串；主人不受此项限制。`false` 恢复普通私聊指令。

微信名单使用原始用户、群 ID，例如 `wxid_user`、`123@chatroom`，不是昵称或机器人账号键；纯数字 ID 按当前代码的匹配方式填写为 YAML 数字。

### 更新与管理指令

以下指令由主人向机器人发送，也受功能开关、黑白名单和群聊响应限制影响：

| 指令 | 用途 |
| --- | --- |
| `#重启` | 重启 Yunzai 进程 |
| `#关机` / `#开机` | 暂停 / 恢复插件事件响应，进程和定时任务继续运行 |
| `#停止` | 停止进程，之后需在终端重新启动 |
| `#更新` | 更新主程序 |
| `#更新插件目录名` | 更新指定的 Git 插件仓库 |
| `#全部更新` | 更新主程序及 Git 插件仓库 |

更新从当前分支的远程仓库拉取；主程序更新会先还原 `package.json` 和 `pnpm-workspace.yaml` 的未提交改动，成功更新后会尝试重启。维护本地改动时应在终端手工处理更新。`#强制更新` 会重置目标仓库的本地改动，不作为日常更新方式。

`bot.yaml` 的 `update_time` 默认是 `1440`，即每 1440 分钟自动检查并更新主程序和 Git 插件仓库；设为 `0` 可关闭该间隔任务。另行配置的 `update_cron` 定时更新需单独清空。修改后重启，禁用“更新”功能的事件响应不会停止自动更新。

### 消息不响应时

依次检查运行日志中的账号连接、`enable` / `disable`、黑白名单、@或前缀限制、指令冷却，最后检查协议端是否支持回复所需能力；微信发送还需开启 `onebot.write_enabled`。

依赖引用、合并转发、图片或群管理的命令受协议端能力限制。例如当前微信上的 `#设置主人` 引用回复、主人版 `#状态` 合并转发回复可能失败，不能仅凭未收到回复判断操作未执行；请核对日志或配置文件，主人也可按上文手工配置。详细限制和连接排错见 [OneBot v12 适配器文档](docs/onebot-v12.md)。

## 开发文档

- [OneBot v12 适配器：配置、接口与验证](docs/onebot-v12.md)
- [OneBot 12 官方文档](https://12.onebot.dev/)
- [TRSS-Yunzai 类型库](https://github.com/KaguyaJs/TRSS-Yunzai-Types)
