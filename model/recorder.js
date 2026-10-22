import crypto from 'node:crypto'
import { getConfig, groupEnabled } from './config.js'
import { fromEvent } from './message.js'
import { avatarMeta } from './collector.js'
import { K, now, fmtShort } from './utils.js'

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
    if (c.avatar?.enable) {
      checkAvatar(u, Number(c.avatar.intervalHours) || 6)
        .then(info => info.changed && notifyAvatar(e, info))
        .catch(err => logger.debug(`[群友开盒] 头像检测失败：${err.message}`))
    }
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
  } else {
    // 首次入档时间：用于“入档以来未曾改名”
    await redis.set(K.nameSince(g, u), String(now()), { NX: true })
  }
}

export async function getNameSince (g, u) {
  return Number(await redis.get(K.nameSince(g, u))) || 0
}

/**
 * 头像变更检测：优先比对 CDN 响应头 X-BCheck（上传时间戳，不受图片重新压缩影响），
 * 旧记录没有 X-BCheck 时退回比对 100px 头像的 MD5
 * 返回 { hash, bcheck, count, since, changedAt, checkedAt }；
 * 本次检测到变更时另带 changed / kind / img（新头像 base64）/ prev（旧头像 base64，可能为空）
 */
export async function checkAvatar (u, intervalHours = 6) {
  const key = K.avatar(u)
  const info = await redis.hGetAll(key) || {}
  const t = now()
  if (info.checkedAt && t - Number(info.checkedAt) < intervalHours * 3600) return info

  await redis.hSet(key, 'checkedAt', String(t)) // 先占位，避免并发重复下载
  const res = await fetch(`https://q1.qlogo.cn/g?b=qq&nk=${u}&s=100`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) return info
  const buf = Buffer.from(await res.arrayBuffer())
  const hash = crypto.createHash('md5').update(buf).digest('hex')
  const meta = avatarMeta(res.headers)

  const upd = { checkedAt: String(t), hash }
  if (meta.bcheck) upd.bcheck = meta.bcheck
  let changed = false
  if (!info.hash) {
    Object.assign(upd, { count: '0', since: String(t) })
  } else if (info.bcheck && meta.bcheck ? info.bcheck !== meta.bcheck : info.hash !== hash) {
    // 自定义头像取真实上传时间，否则取发现变化的时间
    Object.assign(upd, { count: String(Number(info.count || 0) + 1), changedAt: String(meta.ts || t) })
    changed = true
  }
  await redis.hSet(key, upd)

  // 留存现用头像，换头像通报时展示「旧 → 新」；CDN 异常返回的图不留存，免得被当成旧头像
  const img = buf.toString('base64')
  const prev = changed ? await redis.get(K.avatarImg(u)) : null
  if (meta.kind === 'custom' || meta.kind === 'system') {
    const ttl = Math.max(1, Number(getConfig().record?.keepDays) || 30) * 86400
    await redis.set(K.avatarImg(u), img, { EX: ttl })
  }
  const out = { ...info, ...upd }
  return changed ? Object.assign(out, { changed, kind: meta.kind, img, prev }) : out
}

/** 换头像通报：成员换头像后在群里发言时，往该群发送「旧头像 → 新头像」 */
async function notifyAvatar (e, info) {
  const c = getConfig()
  if (!c.avatar?.notify) return
  const list = (c.avatar.notifyGroups || []).map(String)
  if (list.length && !list.includes(String(e.group_id))) return
  // 只通报拿到了真实头像的变更；旧图与新图完全一致（重新上传同一张）也不通报
  if (info.kind !== 'custom' && info.kind !== 'system') return
  if (info.prev && crypto.createHash('md5').update(Buffer.from(info.prev, 'base64')).digest('hex') === info.hash) return

  const name = e.sender?.card || e.sender?.nickname || e.user_id
  const when = info.kind === 'custom' && Number(info.changedAt) ? `，上传于 ${fmtShort(Number(info.changedAt), c.timezone)}` : ''
  const head = `📸 头像变更通报\n「${name}」(${e.user_id}) 换了新头像${info.kind === 'system' ? '（换回了系统默认头像）' : ''}` +
    `\n入档以来第 ${info.count} 次更换${when}\n`
  const img = b64 => segment.image(`base64://${b64}`)
  const msg = info.prev ? [head, img(info.prev), ' ➜ ', img(info.img)] : [head, img(info.img)]

  const group = e.group || e.bot?.pickGroup?.(e.group_id) || Bot.pickGroup(e.group_id)
  await group.sendMsg(msg)
  logger.mark(`[群友开盒] 群 ${e.group_id} 成员 ${name}(${e.user_id}) 更换了头像，已通报`)
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
