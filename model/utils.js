/** Redis 键 */
export const K = {
  userLog: (g, u) => `kaihe:log:${g}:${u}`,
  groupLog: g => `kaihe:grp:${g}`,
  name: (g, u) => `kaihe:name:${g}:${u}`,
  names: (g, u) => `kaihe:names:${g}:${u}`,
  nameSince: (g, u) => `kaihe:namesince:${g}:${u}`,
  avatar: u => `kaihe:avatar:${u}`,
  ai: (g, u) => `kaihe:ai:${g}:${u}`,
  cd: (g, u) => `kaihe:cd:${g}:${u}`,
  issue: 'kaihe:issue',
  hist: key => `kaihe:hist:${key}`,
  histDone: key => `kaihe:histdone:${key}`,
  themeRR: 'kaihe:theme:rr',
  themeLast: 'kaihe:theme:last'
}

export const now = () => Math.floor(Date.now() / 1000)
export const pad = n => String(n).padStart(2, '0')

export function clip (s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  const arr = [...s]
  return arr.length > n ? arr.slice(0, n).join('') + '…' : s
}

export function escapeHtml (s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/* ---------------- 时间（按配置时区） ---------------- */
const fmtCache = new Map()
function formatter (tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }))
  }
  return fmtCache.get(tz)
}

/** 秒级时间戳 → { Y, M, D, h, m }（字符串，已补零） */
export function tzParts (ts, tz) {
  const o = {}
  for (const p of formatter(tz).formatToParts(new Date(ts * 1000))) o[p.type] = p.value
  return { Y: o.year, M: o.month, D: o.day, h: o.hour, m: o.minute }
}

/** 时区内的“第几天”，用于计算自然日差 */
export function dayNum (ts, tz) {
  const p = tzParts(ts, tz)
  return Date.UTC(+p.Y, +p.M - 1, +p.D) / 864e5
}

export const hourOf = (ts, tz) => Number(tzParts(ts, tz).h)
export const fmtDate = (ts, tz) => { const p = tzParts(ts, tz); return `${p.Y}-${p.M}-${p.D}` }
export const fmtDateCN = (ts, tz) => { const p = tzParts(ts, tz); return `${p.Y}年${p.M}月${p.D}日` }
export const fmtHM = (ts, tz) => { const p = tzParts(ts, tz); return `${p.h}:${p.m}` }
export const fmtShort = (ts, tz) => { const p = tzParts(ts, tz); return `${p.Y.slice(2)}/${p.M}/${p.D} ${p.h}:${p.m}` }

export function ago (ts) {
  if (!ts) return '未知'
  const d = now() - ts
  if (d < 120) return '刚刚发言'
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`
  if (d < 30 * 86400) return `${Math.floor(d / 86400)} 天前`
  return `${Math.floor(d / 2592000)} 个月前`
}

const CN = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十']
export const cnNum = n => CN[n] ?? String(n)

/** 最大余数法：保证百分比加起来正好 100 */
export function percents (counts) {
  const total = counts.reduce((a, b) => a + b, 0)
  if (!total) return counts.map(() => 0)
  const raw = counts.map(c => c / total * 100)
  const out = raw.map(Math.floor)
  let rest = 100 - out.reduce((a, b) => a + b, 0)
  raw.map((v, i) => [v - Math.floor(v), i])
    .sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => { if (rest > 0 && counts[i] > 0) { out[i]++; rest-- } })
  return out
}
