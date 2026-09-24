import fs from 'node:fs'
import path from 'node:path'
import { Kaihe } from './apps/kaihe.js'
import { Update } from './apps/update.js'
import { record } from './model/recorder.js'
import { ROOT, getConfig } from './model/config.js'

/**
 * 被动记录器：直接监听 Bot 事件，不受冷却 / 黑名单 / 仅@回复 等过滤影响，
 * 保证作息、发言构成、曾用名、头像变更统计完整。
 */
if (!global.__kaiheRecorder) {
  global.__kaiheRecorder = true
  Bot.on('message.group', e => { record(e) })
}

/** 版本号 + 当前提交，便于确认更新后是否已重启生效 */
function version () {
  let v = ''
  try { v = `v${JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version}` } catch {}
  try {
    const git = path.join(ROOT, '.git')
    let head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5)
      const file = path.join(git, ref)
      head = fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').trim()
        : fs.readFileSync(path.join(git, 'packed-refs'), 'utf8').split('\n').find(l => l.endsWith(` ${ref}`))?.split(' ')[0] || ''
    }
    if (head) v += ` (${head.slice(0, 7)})`
  } catch {}
  return v.trim()
}

// 启动即加载配置并开启配置热重载
getConfig()

logger.mark(`[群友开盒] ${version()} 加载完成，配置热重载已开启，发送 #开盒 试试`)

export const apps = { Kaihe, Update }
