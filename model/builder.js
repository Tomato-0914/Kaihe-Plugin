import path from 'node:path'
import crypto from 'node:crypto'
import { ROOT, getConfig } from './config.js'
import { fromOB } from './message.js'
import { getMember, getHistory, avatarDataURI } from './collector.js'
import { getUserLog, getGroupLog, getNameHistory, trackName, checkAvatar } from './recorder.js'
import { writeStory } from './ai.js'
import {
  K, now, pad, escapeHtml, tzParts, dayNum, hourOf, fmtDate, fmtDateCN, fmtHM, fmtShort, ago, cnNum, percents
} from './utils.js'

const TPL = path.join(ROOT, 'resources', 'gazette', 'index.html')

const CATS = [
  { key: 'text', name: '文字', color: '#2b1d14', fg: '#f3e8d2' },
  { key: 'image', name: '图片', color: '#5e4230', fg: '#f3e8d2' },
  { key: 'face', name: '表情', color: '#a88560', fg: '#2b1d14' },
  { key: 'record', name: '语音', color: '#8b2a1e', fg: '#f3e8d2' },
  { key: 'other', name: '其他', color: '#cbb591', fg: '#2b1d14' }
]
const ROLE = { owner: '群主', admin: '管理员', member: '群成员' }
const RANKS = [[80, '群聊之星'], [60, '骨干成员'], [40, '活跃分子'], [20, '普通成员'], [0, '潜水员']]
const SCHEDULE = [[0, 5, '修仙党'], [5, 8, '早起鸟'], [8, 12, '上午摸鱼'], [12, 14, '午休党'], [14, 18, '下午茶'], [18, 21, '晚饭后'], [21, 24, '夜猫子']]
const HEADLINES = {
  群聊之星: '群聊顶流，一呼百应',
  骨干成员: '群聊中流砥柱，出勤率惊人',
  活跃分子: '群聊活跃分子，存在感拉满',
  普通成员: '群聊常驻成员，作风稳健',
  潜水员: '深潜多时，偶尔浮出水面'
}
const STYLE = {
  text: '惯用文字交流，言之有物。',
  image: '偏好图片交流，斗图经验丰富。',
  face: '表情包运用娴熟，情绪表达到位。',
  record: '偏爱语音沟通，声如其人。',
  other: '常分享卡片与文件，堪称群内搬运工。'
}

function defaultNote (f, dominant) {
  let s = `据本报记者调查，${f.name}（档案号：${f.uid}）`
  if (f.days === null) s += '入群时间已不可考。'
  else if (f.days === 0) s += '于今日加入本群，是一张新鲜面孔。'
  else s += `自 ${f.joinDate} 加入本群，迄今已满 ${f.days} 天。`
  s += dominant ? STYLE[dominant] : '近期发言稀少，行踪成谜。'
  if (f.days) {
    s += f.anniv === 0
      ? `值得关注的是，今天正是其入群 ${f.years} 周年纪念日。`
      : `值得关注的是，距入群周年纪念日还有 ${f.anniv} 天。`
  }
  s += `其在群内综合活跃评分为 ${f.score} 分，被评定为「${f.rank}」级别成员。`
  return s
}

/** 记者手记加粗：人名、数字、百分比、「评级」 */
function noteToHtml (note, name) {
  let h = escapeHtml(note)
  const n = escapeHtml(name)
  if (n) h = h.split(n).join(`<b>${n}</b>`)
  return h
    .replace(/(\d+)(\s*)(天|分|次|条|年)/g, '<b>$1</b>$2$3')
    .replace(/(\d+(?:\.\d+)?%)/g, '<b>$1</b>')
    .replace(/「([^」<]{1,12})」/g, '「<b>$1</b>」')
}

export async function buildGazette (e, uid) {
  const c = getConfig()
  const tz = c.timezone || 'Asia/Shanghai'
  const g = e.group_id
  const T = now()
  const groupSize = Number(c.sampleSize) || 150
  const userSize = Number(c.userSample) || 100

  const [member, history, userLog, avatar] = await Promise.all([
    getMember(e, uid),
    getHistory(e, { groupCount: groupSize, uid, userCount: userSize, maxPages: Number(c.maxPages) || 30 }),
    getUserLog(g, uid),
    avatarDataURI(uid)
  ])
  if (!member && !userLog.length) return null

  const name = member?.card || member?.nickname || userLog[0]?.n || String(uid)
  await trackName(g, uid, name)
  const [names, avatarInfo, issue] = await Promise.all([
    getNameHistory(g, uid),
    c.avatar?.enable ? checkAvatar(uid, 1).catch(() => null) : null,
    redis.incr(K.issue)
  ])

  /* ---------- 样本 ---------- */
  // 群聊样本：最近 groupSize 条真人消息（群聊占比、AI 上下文）
  const human = history.map(m => fromOB(m, e.self_id)).filter(m => m.u && m.u != e.self_id)
  let sample = human.slice(-groupSize)
  if (sample.length < 10) {
    const local = await getGroupLog(g, groupSize)
    if (local.length > sample.length) sample = local
  }
  const sampleMine = sample.filter(m => m.u == uid)
  // 本人样本：翻页取到的该成员消息 + 本地记录，去重后取最近 userSize 条（发言构成、作息）
  const merged = new Map()
  for (const m of [...userLog, ...human.filter(m => m.u == uid), ...sampleMine]) merged.set(m.id || `${m.t}:${m.tx}`, m)
  const mine = [...merged.values()].sort((a, b) => a.t - b.t).slice(-userSize)

  /* ---------- 行为统计 ---------- */
  const cnt = { text: 0, image: 0, face: 0, record: 0, other: 0 }
  let at = 0
  let reply = 0
  const hours = Array(24).fill(0)
  for (const m of mine) {
    for (const t of m.ty || []) if (t in cnt) cnt[t]++
    at += m.at || 0
    reply += m.rp ? 1 : 0
    hours[hourOf(m.t, tz)]++
  }
  const pcts = percents(CATS.map(x => cnt[x.key]))
  const comp = CATS.map((x, i) => ({ ...x, pct: pcts[i] })).filter(x => x.pct > 0)
  const dominant = CATS.map(x => x.key).filter(k => cnt[k] > 0).sort((a, b) => cnt[b] - cnt[a])[0]

  const maxH = Math.max(...hours)
  const peak = maxH > 0 ? hours.indexOf(maxH) : -1
  const hourBars = hours.map((v, h) => ({
    pct: maxH ? Math.max(8, Math.round(v / maxH * 100)) : 0,
    cls: v === 0 ? 'zero' : h === peak ? 'peak' : '',
    label: h % 6 === 0 ? pad(h) : ''
  }))
  for (const b of hourBars) if (b.cls === 'zero') b.pct = 0
  const peakRange = peak >= 0 ? `${pad(peak)}:00 ~ ${pad((peak + 1) % 24)}:00` : '暂无数据'
  const schedule = peak >= 0
    ? { label: SCHEDULE.find(([a, b]) => peak >= a && peak < b)[2], range: `峰值 ${peakRange}` }
    : { label: '神出鬼没', range: '暂无发言记录' }

  /* ---------- 基础档案 ---------- */
  const joinTs = Number(member?.join_time) || 0
  const lastTs = Math.max(Number(member?.last_sent_time) || 0, mine.at(-1)?.t || 0)
  const lvNum = parseInt(String(member?.level ?? '').replace(/\D/g, '')) || 0
  const level = lvNum ? `Lv.${lvNum}` : '—'

  let days = null
  let anniv = null
  let years = 0
  if (joinTs) {
    const today = dayNum(T, tz)
    const jp = tzParts(joinTs, tz)
    const tp = tzParts(T, tz)
    const thisYear = Date.UTC(+tp.Y, +jp.M - 1, +jp.D) / 864e5
    days = today - dayNum(joinTs, tz)
    anniv = (thisYear >= today ? thisYear : Date.UTC(+tp.Y + 1, +jp.M - 1, +jp.D) / 864e5) - today
    years = +tp.Y - +jp.Y - (thisYear > today ? 1 : 0)
  }

  /* ---------- 活跃评分（满分 100） ---------- */
  const recent7 = mine.filter(m => T - m.t < 7 * 86400).length
  const share = sample.length ? sampleMine.length / sample.length : 0
  const idle = lastTs ? T - lastTs : Infinity
  const score = Math.max(0, Math.min(100,
    Math.min(40, Math.round(Math.sqrt(recent7) * 6)) + // 近 7 天发言量
    Math.min(25, Math.round(share * 250)) + // 近期群聊占比
    (idle < 3600 ? 20 : idle < 86400 ? 16 : idle < 3 * 86400 ? 12 : idle < 7 * 86400 ? 8 : idle < 30 * 86400 ? 4 : 0) + // 新鲜度
    Math.min(15, Math.round(lvNum / 100 * 15)) // 群等级
  ))
  const rank = RANKS.find(([min]) => score >= min)[1]

  /* ---------- 荣誉 ---------- */
  const honors = []
  if (member?.role === 'owner') honors.push('本群群主')
  else if (member?.role === 'admin') honors.push('管理员')
  if (member?.title) honors.push(`头衔 · ${member.title}`)
  if (years >= 1) honors.push(`群龄${cnNum(years)}年`)
  else if (days !== null && days < 30) honors.push('新晋成员')
  if (share >= 0.15 && sampleMine.length >= 10) honors.push('话题担当')
  if (mine.length >= 10) {
    if ((cnt.image + cnt.face) / mine.length >= 0.5) honors.push('斗图达人')
    if (cnt.record >= 5) honors.push('语音主播')
    if (at >= 10) honors.push('艾特专业户')
    if (reply / mine.length >= 0.4) honors.push('捧哏担当')
  }

  /* ---------- 形象 / 曾用名 ---------- */
  let avatarHtml = '档案室尚未建立该成员的形象档案。'
  if (avatarInfo?.since) {
    avatarHtml = Number(avatarInfo.count) > 0
      ? `据档案室记录，该成员自入档以来共计变更头像 <b>${avatarInfo.count}</b> 次，最近一次档案更新于 ${fmtShort(Number(avatarInfo.changedAt), tz)}。`
      : `该成员自 ${fmtShort(Number(avatarInfo.since), tz)} 入档以来尚未变更头像，形象十分稳定。`
  }
  const nameList = names.slice(0, 3).map(n => ({ name: n.name, time: fmtShort(n.t, tz) }))

  /* ---------- 文案：AI 优先，模板兜底 ---------- */
  const facts = {
    name, uid, role: ROLE[member?.role] || '群成员', level,
    joinDate: joinTs ? fmtDate(joinTs, tz) : '未知', days, anniv, years,
    lastActive: ago(lastTs), score, rank,
    comp: comp.map(x => `${x.name}${x.pct}%`).join('、') || '无',
    mine: mine.length, reply, at, voice: cnt.record,
    peakRange, schedule: schedule.label,
    names: names.slice(0, 3).map(n => n.name),
    avatarChanges: avatarInfo?.count
  }

  let story = null
  if (c.ai?.enable && c.ai.apiKey) {
    // 缓存键带上 AI 配置指纹：改了模型 / 温度等设置后旧稿件自动失效
    const { baseURL, model, temperature, contextSize, userSize: aiUserSize } = c.ai
    const fp = crypto.createHash('md5').update(JSON.stringify([baseURL, model, temperature, contextSize, aiUserSize])).digest('hex').slice(0, 8)
    const key = `${K.ai(g, uid)}:${fp}`
    try { story = JSON.parse(await redis.get(key) || 'null') } catch {}
    if (!story) {
      try {
        story = await writeStory(c.ai, facts, mine, sample, tz)
        if (Number(c.ai.cacheMinutes) > 0) await redis.set(key, JSON.stringify(story), { EX: Number(c.ai.cacheMinutes) * 60 })
      } catch (err) {
        logger.warn(`[群友开盒] AI 撰稿失败，改用模板：${err.message}`)
      }
    }
  }
  for (const b of story?.badges || []) if (!honors.includes(b)) honors.push(b)

  return {
    tplFile: TPL,
    saveId: `${g}_${uid}`,
    scale: Number(c.scale) || 1,
    issue,
    dateCN: fmtDateCN(T, tz),
    time: fmtHM(T, tz),
    name,
    headline: story?.headline || HEADLINES[rank],
    uid,
    avatar,
    role: facts.role,
    level,
    joinDate: facts.joinDate,
    ageText: days !== null ? `${days} 天` : '未知',
    lastActive: facts.lastActive,
    score,
    rank,
    schedule,
    sampleSize: sample.length,
    mine: mine.length,
    comp,
    reply,
    at,
    voice: cnt.record,
    hours: hourBars,
    peakRange,
    noteHtml: noteToHtml(story?.note || defaultNote(facts, dominant), name),
    honors: honors.slice(0, 6),
    avatarHtml,
    names: nameList,
    namesMore: Math.max(0, names.length - nameList.length)
  }
}
