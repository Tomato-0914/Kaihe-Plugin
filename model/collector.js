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
 * 向前翻页拉取群聊历史（get_group_msg_history，每页 100 条）
 * 群聊真人消息 ≥ groupCount 且目标成员消息 ≥ userCount 时停止；最多 maxPages 页；没有更早的消息时停止
 */
export async function getHistory (e, { groupCount = 150, uid, userCount = 0, maxPages = 30 } = {}) {
  const bot = botOf(e)
  const all = new Map()
  let human = 0
  let mine = 0
  let pages = 0
  let oldest = null

  const fetchPage = async seq => {
    pages++
    const r = await bot.sendApi('get_group_msg_history', { group_id: e.group_id, message_seq: seq, count: 100 })
    const msgs = unwrap(r, 'messages')?.messages
    return Array.isArray(msgs) ? msgs : []
  }
  /** 收录一页，返回新增条数 */
  const absorb = msgs => {
    let added = 0
    for (const m of msgs) {
      const id = String(m.message_id ?? m.message_seq)
      if (all.has(id)) continue
      all.set(id, m)
      added++
      const u = String(m.user_id ?? m.sender?.user_id)
      if (u !== String(e.self_id)) human++
      if (uid && u === String(uid)) mine++
      if (!oldest || Number(m.time) < Number(oldest.time)) oldest = m
    }
    return added
  }

  try {
    absorb(await fetchPage(undefined))
    while (oldest && pages < maxPages && (human < groupCount || mine < userCount)) {
      const fields = anchorField ? [anchorField, ...ANCHORS.filter(f => f !== anchorField)] : ANCHORS
      const tried = new Set()
      let added = 0
      for (const f of fields) {
        const seq = oldest[f]
        if (seq == null || seq === '' || tried.has(String(seq))) continue
        tried.add(String(seq))
        added = absorb(await fetchPage(seq))
        if (added) {
          if (anchorField !== f) logger.debug(`[群友开盒] 翻页锚点使用 ${f}`)
          anchorField = f
          break
        }
        if (pages >= maxPages) break
      }
      if (!added) break // 没有更早的消息，或协议端不支持翻页
    }
  } catch (err) {
    logger.warn(`[群友开盒] get_group_msg_history 失败：${err.message}`)
  }
  logger.info(`[群友开盒] 拉取历史 ${pages} 页，共 ${all.size} 条，真人消息 ${human} 条${uid ? `，目标成员 ${mine} 条` : ''}`)
  return [...all.values()].sort((a, b) => a.time - b.time)
}

/** 头像转 base64，避免渲染时网络慢导致空图 */
export async function avatarDataURI (uid) {
  const url = `https://q1.qlogo.cn/g?b=qq&nk=${uid}&s=640`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return url
    const type = res.headers.get('content-type') || 'image/jpeg'
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
  } catch {
    return url
  }
}
