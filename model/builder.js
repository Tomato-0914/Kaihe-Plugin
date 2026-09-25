import path from 'node:path'
import crypto from 'node:crypto'
import { ROOT, getConfig } from './config.js'
import { getMember, getHistory, getAvatar } from './collector.js'
import { getUserLog, getGroupLog, getNameHistory, getNameSince, trackName, checkAvatar } from './recorder.js'
import { writeStory } from './ai.js'
import { themeCss, themeFonts, pickTheme, FONT_DIR_URL } from './theme.js'
import {
  K, now, pad, escapeHtml, tzParts, dayNum, hourOf, fmtDate, fmtDateCN, fmtHM, fmtShort, ago, cnNum, percents
} from './utils.js'

const TPL = path.join(ROOT, 'resources', 'gazette', 'index.html')

// 发言构成类别（颜色由主题的 --c-* 变量决定）
const CATS = [
  { key: 'text', name: '文字' },
  { key: 'image', name: '图片' },
  { key: 'face', name: '表情' },
  { key: 'record', name: '语音' },
  { key: 'other', name: '其他' }
]
const ROLE = { owner: '群主', admin: '管理员', member: '群成员' }
/** 老号的头像上传时间普遍集中在 2019-04-15，疑为 CDN 迁移时间，早于此的只能说明“至少从那时起” */
const AVATAR_MIGRATED = Date.UTC(2019, 3, 16) / 1000
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
    getAvatar(uid)
  ])
  if (!member && !userLog.length) return null

  const name = member?.card || member?.nickname || userLog[0]?.n || String(uid)
  await trackName(g, uid, name)
  const [names, nameSince, avatarInfo, issue] = await Promise.all([
    getNameHistory(g, uid),
    getNameSince(g, uid),
    c.avatar?.enable ? checkAvatar(uid, 1).catch(() => null) : null,
    redis.incr(K.issue)
  ])

  /* ---------- 样本 ---------- */
  // 群聊样本：最近 groupSize 条真人消息（群聊占比、AI 上下文）
  const human = history.filter(m => m.u && m.u != e.self_id)
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
  // 发言频率（40）：近 7 天日均发言，对数曲线，日均 100 条满分；
  // 本人样本被 userSize 截断时（最早一条也在 7 天内），按样本实际覆盖的天数（至少 1 天）计算
  const week = 7 * 86400
  const span = mine.length >= userSize && mine.length ? Math.min(week, Math.max(86400, T - mine[0].t)) : week
  const inSpan = mine.filter(m => T - m.t < span).length
  const perDay = inSpan / (span / 86400)
  const sSpeak = 40 * Math.min(1, Math.log1p(perDay) / Math.log1p(100))
  // 群聊占比（25）：相对群内平均水平，达到平均的 4 倍满分
  const share = sample.length ? sampleMine.length / sample.length : 0
  const speakers = new Set(sample.map(m => m.u)).size || 1
  const sShare = 25 * Math.min(1, share * speakers / 4)
  // 新鲜度（20）：距最后发言平滑衰减（1 小时 ≈ 20，1 天 ≈ 12，3 天 ≈ 4）
  const idle = lastTs ? Math.max(0, T - lastTs) : Infinity
  const sFresh = 20 * Math.exp(-idle / (2 * 86400))
  // 群等级（15）
  const sLevel = 15 * Math.min(1, lvNum / 100)
  const score = Math.max(0, Math.min(100, Math.round(sSpeak + sShare + sFresh + sLevel)))
  const rank = RANKS.find(([min]) => score >= min)[1]
  logger.info(`[群友开盒] ${uid} 活跃评分 ${score}：发言 ${sSpeak.toFixed(1)}/40（日均 ${perDay.toFixed(1)} 条）` +
    ` + 占比 ${sShare.toFixed(1)}/25（${(share * 100).toFixed(1)}%，${speakers} 人发言）` +
    ` + 新鲜 ${sFresh.toFixed(1)}/20 + 等级 ${sLevel.toFixed(1)}/15（原始 level=${JSON.stringify(member?.level)}）`)

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
  // 现用头像：自定义头像可从 CDN 取到上传时间；2019-04-16 之前的时间多为 CDN 迁移时间，只能说明“至少从那时起”
  let avatarSet = '未知'
  const parts = []
  if (avatar.kind === 'custom' && avatar.ts) {
    const used = dayNum(T, tz) - dayNum(avatar.ts, tz)
    if (avatar.ts < AVATAR_MIGRATED) {
      avatarSet = `至少自 ${fmtDate(avatar.ts, tz)} 起沿用至今`
      parts.push(`据档案室调取，该成员现用头像至少自 <b>${fmtDate(avatar.ts, tz)}</b> 起沿用至今，形象历久弥新。`)
    } else if (used <= 0) {
      avatarSet = '今日刚刚更换'
      parts.push(`据档案室调取，该成员于今日 ${fmtHM(avatar.ts, tz)} 刚刚更换头像，新形象正在热映。`)
    } else {
      avatarSet = `${fmtDate(avatar.ts, tz)} 上传，已沿用 ${used} 天`
      parts.push(`据档案室调取，该成员现用头像上传于 ${fmtShort(avatar.ts, tz)}，已沿用 <span class="nw"><b>${used}</b> 天</span>。`)
    }
  } else if (avatar.kind === 'system') {
    avatarSet = '系统默认头像'
    parts.push('据档案室调取，该成员使用系统默认头像，走的是朴素路线。')
  }
  // 插件入档后自行观测到的更换次数
  if (avatarInfo?.since) {
    if (Number(avatarInfo.count) > 0) parts.push(`自入档以来共观测到更换头像 <span class="nw"><b>${avatarInfo.count}</b> 次</span>。`)
    else if (!parts.length) parts.push(`该成员自 ${fmtShort(Number(avatarInfo.since), tz)} 入档以来尚未变更头像，形象十分稳定。`)
  }
  const avatarHtml = parts.join('') || '档案室尚未建立该成员的形象档案。'
  const nameList = names.slice(0, 3).map(n => ({ name: n.name, time: fmtShort(n.t, tz) }))

  // 现用名启用时间：协议端不提供改名时间，取插件记录到上一个名字停用的时间（成员改名后下次发言时记录）
  let nameSet = '未知'
  let nameHtml = ''
  const nameEsc = escapeHtml(name)
  if (names.length) {
    const ts = names[0].t
    const used = dayNum(T, tz) - dayNum(ts, tz)
    nameSet = used <= 0 ? '今日刚刚改名' : `${fmtDate(ts, tz)} 起启用，已使用 ${used} 天`
    nameHtml = used <= 0
      ? `据档案室记录，现用名「<b>${nameEsc}</b>」于今日 ${fmtHM(ts, tz)} 登记启用，墨迹未干。`
      : `据档案室记录，现用名「<b>${nameEsc}</b>」于 ${fmtShort(ts, tz)} 登记启用，已使用 <span class="nw"><b>${used}</b> 天</span>。`
  } else if (nameSince && dayNum(T, tz) > dayNum(nameSince, tz)) {
    nameSet = `${fmtDate(nameSince, tz)} 入档以来未改名`
    nameHtml = `该成员自 ${fmtShort(nameSince, tz)} 入档以来一直使用「<b>${nameEsc}</b>」，从未改名。`
  }

  /* ---------- 文案：AI 优先，模板兜底 ---------- */
  const facts = {
    name, uid, role: ROLE[member?.role] || '群成员', level,
    joinDate: joinTs ? fmtDate(joinTs, tz) : '未知', days, anniv, years,
    lastActive: ago(lastTs), score, rank,
    comp: comp.map(x => `${x.name}${x.pct}%`).join('、') || '无',
    mine: mine.length, reply, at, voice: cnt.record,
    peakRange, schedule: schedule.label,
    names: names.slice(0, 3).map(n => n.name),
    avatarChanges: avatarInfo?.count,
    avatarSet,
    nameSet
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

  const css = themeCss(await pickTheme(c))
  return {
    tplFile: TPL,
    saveId: `${g}_${uid}`,
    scale: Number(c.scale) || 1,
    themeCss: css,
    fontDir: FONT_DIR_URL,
    fontPreload: themeFonts(css),
    // 等页面 load（含预加载字体）且网络空闲后再截图，避免字体未就绪时出现回退字体或空白
    pageGotoParams: { waitUntil: ['load', 'networkidle0'] },
    issue,
    dateCN: fmtDateCN(T, tz),
    time: fmtHM(T, tz),
    name,
    headline: story?.headline || HEADLINES[rank],
    uid,
    avatar: avatar.src,
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
    namesMore: Math.max(0, names.length - nameList.length),
    nameHtml
  }
}
