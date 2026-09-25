import { fromOB } from './message.js'

/** 兼容 TRSS 返回的 Proxy 与原始 {data} 结构 */
const unwrap = (r, field) => r?.[field] !== undefined ? r : r?.data

function botOf (e) {
  return e.bot || Bot[e.self_id]
}

/** 群成员信息（OneBot v11: get_group_member_info） */
export async function getMember (e, uid) {
  try {
    const r = await botOf(e).sendApi('get_group_member_info', { group_id: e.group_id, user_id: uid, no_cache: true })
    const d = unwrap(r, 'user_id')
    if (d?.user_id) return d
  } catch (err) {
    logger.debug(`[群友开盒] get_group_member_info 失败：${err.message}`)
  }
  try {
    const d = await e.group?.pickMember?.(uid)?.getInfo?.(true)
    if (d?.user_id) return d
  } catch {}
  return null
}

/**
 * 翻页锚点：各协议端对 get_group_msg_history 的 message_seq 参数理解不同
 * （NapCat / LLOneBot 认 message_id，go-cqhttp / Lagrange 认真实 seq），依次尝试并记住可用的字段
 */
const ANCHORS = ['message_id', 'message_seq', 'real_id']
let anchorField = null

/**
 * 群聊历史缓存（内存）：每群保存已翻到的消息（解析后的精简记录 + 翻页锚点），
 * 再次开盒时只补拉最新消息，不够才从缓存最早一条继续往前翻。重启后清空。
 * { list: 记录（按时间升序）, ids: Set, complete: 已翻到群聊最早的消息, used, lock }
 */
const CACHE = new Map()
const CACHE_GROUPS = 30

function cacheOf (key) {
  let c = CACHE.get(key)
  if (!c) {
    c = { list: [], ids: new Set(), complete: false, lock: Promise.resolve() }
    CACHE.set(key, c)
    if (CACHE.size > CACHE_GROUPS) {
      const lru = [...CACHE.entries()].filter(([k]) => k !== key).sort((a, b) => a[1].used - b[1].used)[0]
      if (lru) CACHE.delete(lru[0])
    }
  }
  c.used = Date.now()
  return c
}

/**
 * 获取群聊历史（get_group_msg_history，每页 100 条），返回解析后的记录（按时间升序）
 * 1. 从最新一页往回补拉，直到与缓存衔接（通常 1 页）；翻满 maxPages 仍衔接不上则丢弃旧缓存
 * 2. 缓存中群聊真人消息 < groupCount 或目标成员消息 < userCount 时，从缓存最早一条继续往前翻
 * 缓存深度上限 maxPages × 100 条（超出丢弃最旧的），因此很少发言的成员重复开盒也不会每次都翻满
 */
export function getHistory (e, opts = {}) {
  const c = cacheOf(`${e.self_id}:${e.group_id}`)
  // 同群并发开盒时排队，避免重复翻页
  const run = c.lock.then(() => fillHistory(e, c, opts))
  c.lock = run.catch(() => {})
  return run
}

async function fillHistory (e, c, { groupCount = 150, uid, userCount = 0, maxPages = 30 } = {}) {
  const bot = botOf(e)
  const depth = Math.max(1, maxPages) * 100
  let reused = 0 // 本次复用的缓存条数（断档时为 0）
  let pages = 0

  const fetchPage = async seq => {
    pages++
    const r = await bot.sendApi('get_group_msg_history', { group_id: e.group_id, message_seq: seq, count: 100 })
    const msgs = unwrap(r, 'messages')?.messages
    return Array.isArray(msgs) ? msgs : []
  }
  const toRecord = m => ({ ...fromOB(m, e.self_id), a: { message_id: m.message_id, message_seq: m.message_seq, real_id: m.real_id } })
  /** 以 rec 为锚点取更早的一页：依次尝试各锚点字段，返回原始消息（无更早消息时为空） */
  const fetchOlder = async (rec, isKnown) => {
    const fields = anchorField ? [anchorField, ...ANCHORS.filter(f => f !== anchorField)] : ANCHORS
    const tried = new Set()
    for (const f of fields) {
      const seq = rec.a?.[f]
      if (seq == null || seq === '' || tried.has(String(seq))) continue
      tried.add(String(seq))
      const msgs = await fetchPage(seq)
      if (msgs.some(m => !isKnown(toRecord(m).id))) {
        if (anchorField !== f) logger.debug(`[群友开盒] 翻页锚点使用 ${f}`)
        anchorField = f
        return msgs
      }
      if (pages >= maxPages) break
    }
    return []
  }

  try {
    /* ---------- 1. 补拉最新消息，与缓存衔接 ---------- */
    const fresh = new Map()
    let joined = !c.list.length
    const addFresh = msgs => {
      let added = 0
      for (const m of msgs) {
        const r = toRecord(m)
        if (c.ids.has(r.id)) joined = true
        else if (!fresh.has(r.id)) { fresh.set(r.id, r); added++ }
      }
      return added
    }
    addFresh(await fetchPage(undefined))
    while (!joined && fresh.size && pages < maxPages) {
      const oldest = [...fresh.values()].reduce((a, b) => (b.t < a.t ? b : a))
      if (!addFresh(await fetchOlder(oldest, id => fresh.has(id) || c.ids.has(id)))) break
    }
    if (!joined) { // 与旧缓存之间断档：旧缓存作废，以本次拉到的为准
      c.list = []
      c.ids.clear()
      c.complete = false
    }
    reused = c.list.length
    for (const r of fresh.values()) { c.list.push(r); c.ids.add(r.id) }
    c.list.sort((a, b) => a.t - b.t)

    /* ---------- 2. 缓存不够时继续往前翻 ---------- */
    const isHuman = r => r.u && r.u != e.self_id
    let human = c.list.filter(isHuman).length
    let mine = uid ? c.list.filter(r => r.u == uid).length : 0
    while (!c.complete && c.list.length && c.list.length < depth && pages < maxPages && (human < groupCount || mine < userCount)) {
      const older = (await fetchOlder(c.list[0], id => c.ids.has(id))).map(toRecord).filter(r => !c.ids.has(r.id))
      if (!older.length) { c.complete = true; break } // 已到群聊最早的消息，或协议端不支持翻页
      for (const r of older) {
        c.ids.add(r.id)
        if (isHuman(r)) human++
        if (uid && r.u == uid) mine++
      }
      c.list.unshift(...older.sort((a, b) => a.t - b.t))
    }

    /* ---------- 3. 截断到深度上限（保留最新） ---------- */
    if (c.list.length > depth) {
      for (const r of c.list.splice(0, c.list.length - depth)) c.ids.delete(r.id)
      c.complete = false
      reused = Math.min(reused, c.list.length)
    }
  } catch (err) {
    logger.warn(`[群友开盒] get_group_msg_history 失败：${err.message}`)
  }

  const human = c.list.filter(r => r.u && r.u != e.self_id).length
  const mine = uid ? c.list.filter(r => r.u == uid).length : 0
  logger.info(`[群友开盒] 拉取历史 ${pages} 页（复用缓存 ${reused} 条），共 ${c.list.length} 条，` +
    `真人消息 ${human} 条${uid ? `，目标成员 ${mine} 条` : ''}${c.complete ? '，已到群聊最早记录' : ''}`)
  return c.list.slice()
}

/**
 * 解析 QQ 头像 CDN 响应头
 * X-Info：real data = 自定义头像；real-sysimg-* = 系统默认头像；notexist = 无头像
 * X-BCheck：「上传时间戳_类型」，自定义头像的时间即现用头像的上传时间（系统头像的时间不可靠）
 */
export function avatarMeta (headers) {
  const info = headers.get('x-info') || ''
  const bcheck = headers.get('x-bcheck') || ''
  const kind = info === 'real data' ? 'custom' : info.startsWith('real-sysimg') ? 'system' : info.startsWith('notexist') ? 'none' : 'unknown'
  const ts = kind === 'custom' ? Number(bcheck.split('_')[0]) || 0 : 0
  return { kind, ts, bcheck }
}

/** 获取头像：转 base64 避免渲染时网络慢导致空图，并附带头像类型与上传时间 */
export async function getAvatar (uid) {
  const url = `https://q1.qlogo.cn/g?b=qq&nk=${uid}&s=640`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return { src: url, kind: 'unknown', ts: 0 }
    const type = res.headers.get('content-type') || 'image/jpeg'
    const src = `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
    return { src, ...avatarMeta(res.headers) }
  } catch {
    return { src: url, kind: 'unknown', ts: 0 }
  }
}
