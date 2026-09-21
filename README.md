# Yunzai · OneBot v12

本项目 fork 自 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)，主要工作是适配 **OneBot v12**，支持反向 WebSocket、多账号、私聊、群聊、媒体文件和标准通知。通过 [wechat-ai](https://github.com/Untergang1/wechat-ai) 可接入 **微信 4.1.13.9**。

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

后台运行使用 `pnpm start`，查看日志使用 `pnpm log`，停止使用 `pnpm stop`。

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

3. 接入微信 **4.1.13.9** 时，使用 [wechat-ai](https://github.com/Untergang1/wechat-ai) 作为协议端，按其项目说明部署、登录微信并连接上述地址。
4. 连接成功后，向机器人发送 `#设置主人`，根据日志中的验证码完成设置。

适配器默认关闭。完整配置、握手鉴权、插件接口、能力限制和排查方法见 [OneBot v12 适配器文档](docs/onebot-v12.md)。实际可用能力取决于协议端实现，依赖 QQ 专属接口的插件可能需要适配。

## 开发文档

- [OneBot v12 适配器：配置、接口与验证](docs/onebot-v12.md)
- [OneBot 12 官方文档](https://12.onebot.dev/)
- [TRSS-Yunzai 类型库](https://github.com/KaguyaJs/TRSS-Yunzai-Types)
