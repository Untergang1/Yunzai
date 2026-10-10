# Fork 维护

本仓库跟随上游 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)（远程名 `upstream`）。目标是让 fork 以新增文件为主，对上游文件只保留少量、位置固定的改动，使合并上游时冲突最少。

## 原则

- 新功能放在上游没有的文件中：`plugins/adapter/onebot12/`、`plugins/adapter/OneBotv12.js`、`lib/redact.js`、`config/default_config/onebotv12.yaml`、`docs/`、`test/onebot12/`、`tools/`。
- 协议差异在适配器内转换成 Yunzai 已有约定，不修改核心插件去迁就适配器。例如机器人本人的平台 ID 由适配器换成 `self_id`，见 [账号和插件接口](onebot-v12.md#账号和插件接口)。
- 必须改动上游文件时，只加最小挂钩；与本 fork 无关的通用修复单独提交，适合时向上游提 PR，被上游合并后即可删去。
- README 只在顶部保留 fork 说明块，其余保持上游原文；fork 文档写在 `docs/`。

## 对上游文件的改动

每次合并后核对此表，新增或删除改动时同步更新。

| 文件                           | 改动                                                                                     | 性质                |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ------------------- |
| `README.md`                    | 顶部 fork 说明块                                                                         | fork 入口           |
| `lib/bot.js`                   | 引入 `lib/redact.js`；`serverAuth`/`wsConnect` 日志脱敏；`wsGuards` 字段及升级前守卫调用 | OneBot v12 鉴权挂钩 |
| `lib/plugins/loader.js`        | `image` 段缺少 `url` 时不加入 `e.img`                                                    | 通用修复，可提上游  |
| `plugins/system/quit.js`       | 主人 ID 同时按字符串和数字匹配群成员                                                     | 通用修复，可提上游  |
| `plugins/adapter/OneBotv11.js` | 请求超时不再断开连接，改由心跳判断；cookies/csrf 后台限时获取并重试                      | 通用修复，可提上游  |
| `package.json`                 | `test:onebot12`、`probe:wechat-readonly` 脚本                                            | fork 入口           |
| `.gitignore`                   | 联调报告和 Python 缓存目录                                                               | fork 入口           |

列出当前实际差异：

```sh
git diff --stat upstream/main...main -- $(git ls-tree -r --name-only upstream/main)
```

## 合并上游

```sh
git config rerere.enabled true   # 记住冲突解决方式，只需设置一次
git fetch upstream
git merge upstream/main
npm run test:onebot12
```

尽量小步、频繁地合并。出现冲突时，优先保留上游写法，再把本 fork 的挂钩重新加回去；若冲突落在上表之外，说明出现了新的侵入式改动，应考虑移回 fork 自有文件。合并后检查上表与实际差异是否一致。

## 开发参考

- [OneBot 12 官方文档](https://12.onebot.dev/)
- [TRSS-Yunzai 类型库](https://github.com/KaguyaJs/TRSS-Yunzai-Types)
