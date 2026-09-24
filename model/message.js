import { clip, now } from './utils.js'

const FACE_TYPES = new Set(['face', 'mface', 'bface', 'sface', 'marketface', 'market_face', 'dice', 'rps', 'emoji'])
const OTHER_TYPES = {
  video: '[视频]', file: '[文件]', json: '[卡片]', xml: '[卡片]', ark: '[卡片]',
  forward: '[聊天记录]', node: '[聊天记录]', share: '[分享]', music: '[音乐]',
  location: '[位置]', contact: '[名片]', markdown: '[消息]'
}

/** 解析 CQ 码字符串（LLOneBot 上报格式设为 string 时） */
export function parseCQ (str = '') {
  const segs = []
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g
  const unesc = s => s.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&')
  let last = 0
  let m
  while ((m = re.exec(str))) {
    if (m.index > last) segs.push({ type: 'text', text: unesc(str.slice(last, m.index)) })
    const data = {}
    for (const kv of m[2].split(',').slice(1)) {
      const i = kv.indexOf('=')
      if (i > 0) data[kv.slice(0, i)] = unesc(kv.slice(i + 1))
    }
    segs.push({ type: m[1], data })
    last = re.lastIndex
  }
  if (last < str.length) segs.push({ type: 'text', text: unesc(str.slice(last)) })
  return segs
}

/**
 * 分析消息段 → { ty: 内容类别[], at: @人数, rp: 是否回复, tx: 纯文本摘要 }
 * 兼容 TRSS 扁平格式 {type, qq} 与 OneBot 原始格式 {type, data:{qq}}
 */
export function analyze (segs, selfId) {
  if (typeof segs === 'string') segs = parseCQ(segs)
  if (!Array.isArray(segs)) segs = []
  const ty = new Set()
  let at = 0
  let rp = 0
  let tx = ''

  for (const s of segs) {
    if (!s?.type) continue
    const d = { ...(s.data || {}), ...s }
    switch (s.type) {
      case 'text': {
        const t = String(d.text ?? '')
        if (t.trim()) { ty.add('text'); tx += t }
        break
      }
      case 'image': {
        const sticker = d.sub_type == 1 || d.subType == 1 || /表情/.test(d.summary || '')
        ty.add(sticker ? 'face' : 'image')
        tx += sticker ? '[表情]' : '[图片]'
        break
      }
      case 'record':
        ty.add('record'); tx += '[语音]'
        break
      case 'at':
        if (String(d.qq) === String(selfId)) break
        at++
        tx += String(d.qq) === 'all' ? '@全体成员 ' : `@${d.name || '某人'} ` // 无名字时不写 QQ 号，避免 AI 引用进稿件
        break
      case 'reply':
        rp = 1
        break
      default:
        if (FACE_TYPES.has(s.type)) { ty.add('face'); tx += '[表情]' } else if (OTHER_TYPES[s.type]) { ty.add('other'); tx += OTHER_TYPES[s.type] }
    }
  }
  if (!ty.size && (at || rp)) ty.add('text')
  return { ty: [...ty], at, rp, tx: clip(tx, 120) }
}

/** Yunzai 事件 → 记录条目 */
export function fromEvent (e) {
  return {
    id: String(e.message_id ?? ''),
    t: Number(e.time) || now(),
    u: Number(e.user_id),
    n: clip(e.sender?.card || e.sender?.nickname || '', 20),
    ...analyze(e.message, e.self_id)
  }
}

/** OneBot 历史消息 → 记录条目 */
export function fromOB (m, selfId) {
  return {
    id: String(m.message_id ?? m.message_seq ?? ''),
    t: Number(m.time) || 0,
    u: Number(m.user_id ?? m.sender?.user_id),
    n: clip(m.sender?.card || m.sender?.nickname || '', 20),
    ...analyze(m.message ?? m.raw_message, selfId)
  }
}
