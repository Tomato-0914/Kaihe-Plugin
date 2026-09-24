import crypto from 'node:crypto'
import { getConfig, groupEnabled } from './config.js'
import { fromEvent } from './message.js'
import { K, now } from './utils.js'

const parse = list => list.map(s => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)

/** 每条群消息调用：记录发言元数据、昵称变化、头像变化 */
export async function record (e) {
  try {
    if (!e?.group_id || !e.user_id || e.user_id == e.self_id) return
    const c = getConfig()
    if (!groupEnabled(c, e.group_id)) return

    const g = e.group_id
    const u = e.user_id
    const entry = JSON.stringify(fromEvent(e))
    const ttl = Math.max(1, Number(c.record.keepDays) || 30) * 86400

    await redis.multi()
      .lPush(K.userLog(g, u), entry)
      .lTrim(K.userLog(g, u), 0, (Number(c.record.userMax) || 300) - 1)
      .expire(K.userLog(g, u), ttl)
      .lPush(K.groupLog(g), entry)
      .lTrim(K.groupLog(g), 0, (Number(c.record.groupMax) || 300) - 1)
      .expire(K.groupLog(g), ttl)
      .exec()

    await trackName(g, u, e.sender?.card || e.sender?.nickname)
    if (c.avatar?.enable) checkAvatar(u, Number(c.avatar.intervalHours) || 6).catch(() => {})
  } catch (err) {
    logger.debug(`[群友开盒] 记录失败：${err.message}`)
  }
}

/** 群名片 / 昵称变更时记入曾用名 */
export async function trackName (g, u, name) {
  if (!name) return
  const key = K.name(g, u)
  const old = await redis.get(key)
  if (old === name) return
  await redis.set(key, name)
  if (old) {
    await redis.lPush(K.names(g, u), JSON.stringify({ name: old, t: now() }))
    await redis.lTrim(K.names(g, u), 0, 19)
  }
}

/**
 * 头像变更检测：下载 100px 头像计算指纹，与上次比对
 * 返回 { hash, count, since, changedAt, checkedAt }
 */
export async function checkAvatar (u, intervalHours = 6) {
  const key = K.avatar(u)
  const info = await redis.hGetAll(key) || {}
  const t = now()
  if (info.checkedAt && t - Number(info.checkedAt) < intervalHours * 3600) return info

  await redis.hSet(key, 'checkedAt', String(t)) // 先占位，避免并发重复下载
  const res = await fetch(`https://q1.qlogo.cn/g?b=qq&nk=${u}&s=100`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) return info
  const hash = crypto.createHash('md5').update(Buffer.from(await res.arrayBuffer())).digest('hex')

  const upd = { checkedAt: String(t) }
  if (!info.hash) Object.assign(upd, { hash, count: '0', since: String(t) })
  else if (info.hash !== hash) Object.assign(upd, { hash, count: String(Number(info.count || 0) + 1), changedAt: String(t) })
  await redis.hSet(key, upd)
  return { ...info, ...upd }
}

export async function getUserLog (g, u) {
  return parse(await redis.lRange(K.userLog(g, u), 0, -1))
}

export async function getGroupLog (g, count) {
  return parse(await redis.lRange(K.groupLog(g), 0, count - 1)).reverse()
}

export async function getNameHistory (g, u) {
  return parse(await redis.lRange(K.names(g, u), 0, -1))
}
