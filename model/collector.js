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
 * 拉取群最近 count 条“真人”消息（get_group_msg_history，LLOneBot / NapCat / go-cqhttp 均支持）
 * 机器人自己的消息不计数；单次返回不足时自动向前翻页，最多 10 轮
 */
export async function getHistory (e, count = 150) {
  const bot = botOf(e)
  const all = new Map()
  let human = 0
  let rounds = 0
  let seq
  while (rounds < 10 && human < count) {
    let msgs
    try {
      const r = await bot.sendApi('get_group_msg_history', {
        group_id: e.group_id,
        message_seq: seq,
        count: 100
      })
      msgs = unwrap(r, 'messages')?.messages
    } catch (err) {
      logger.warn(`[群友开盒] get_group_msg_history 失败：${err.message}`)
      break
    }
    rounds++
    if (!Array.isArray(msgs) || !msgs.length) break

    let added = 0
    let oldest
    for (const m of msgs) {
      const id = String(m.message_id ?? m.message_seq)
      if (!all.has(id)) {
        all.set(id, m)
        added++
        if (String(m.user_id ?? m.sender?.user_id) !== String(e.self_id)) human++
      }
      if (!oldest || Number(m.time) < Number(oldest.time)) oldest = m
    }
    if (!added) break
    seq = oldest.message_id ?? oldest.message_seq
  }
  logger.info(`[群友开盒] 拉取历史 ${rounds} 轮，共 ${all.size} 条，其中真人消息 ${human} 条`)
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
