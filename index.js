import { Kaihe } from './apps/kaihe.js'
import { Update } from './apps/update.js'
import { record } from './model/recorder.js'

/**
 * 被动记录器：直接监听 Bot 事件，不受冷却 / 黑名单 / 仅@回复 等过滤影响，
 * 保证作息、发言构成、曾用名、头像变更统计完整。
 */
if (!global.__kaiheRecorder) {
  global.__kaiheRecorder = true
  Bot.on('message.group', e => { record(e) })
}

logger.mark('[群友开盒] 插件加载完成，发送 #开盒 试试')

export const apps = { Kaihe, Update }
