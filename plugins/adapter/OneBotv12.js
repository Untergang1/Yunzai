import cfg from "../../lib/config/config.js"
import { OneBot12Adapter } from "./onebot12/adapter.js"

Bot.adapter.push(new OneBot12Adapter(Bot, cfg.onebotv12))
