import path from 'node:path'
import { ROOT, getConfig } from './config.js'
import { getMemberList } from './collector.js'
import { baseCss, themeCss, themeFonts, pickTheme, FONT_DIR_URL } from './theme.js'
import { K, now, fmtDate, fmtDateCN, fmtHM } from './utils.js'

const TPL = path.join(ROOT, 'resources', 'gazette', 'rank.html')
const DAY = 86400
const ACTIVE_DAYS = 7
const MEDALS = ['冠 军', '亚 军', '季 军']

/** 逐个成员批量读 Redis（一次往返） */
async function batch (uids, add) {
  if (!uids.length) return []
  const m = redis.multi()
  for (const u of uids) add(m, u)
  return m.exec()
}

/**
 * 榜单：value 返回成员的得分（越大越靠前，null 表示不上榜），text 把得分写成文案
 * load 为需要额外读取的记录（按成员 uid 返回 Map）
 */
export const BOARDS = {
  换头大王: {
    caption: '插件入档以来观测到的头像更换次数（成员发言时检测，装得越久越准）',
    headline: (r, v) => `${r.name} 入档以来换了 ${v} 次头像，喜提「换头大王」`,
    async load (g, members) {
      const uids = members.map(m => m.user_id)
      const res = await batch(uids, (m, u) => m.hGet(K.avatar(u), 'count'))
      return new Map(uids.map((u, i) => [u, Number(res[i]) || 0]))
    },
    value: (m, data) => data.get(m.user_id) || null,
    text: v => `${v} 次`
  },
  马甲大王: {
    caption: '插件入档以来群名片（没有群名片时为昵称）的变更次数',
    headline: (r, v) => `${r.name} 入档以来改了 ${v} 次名，马甲数量全群第一`,
    async load (g, members) {
      const uids = members.map(m => m.user_id)
      const res = await batch(uids, (m, u) => m.get(K.nameCount(g, u)).lLen(K.names(g, u)))
      return new Map(uids.map((u, i) => [u, Number(res[i * 2]) || Number(res[i * 2 + 1]) || 0]))
    },
    value: (m, data) => data.get(m.user_id) || null,
    text: v => `${v} 次`
  },
  活跃大王: {
    caption: `近 ${ACTIVE_DAYS} 天在本群的发言条数（插件被动记录，装得越久越准）`,
    headline: (r, v) => `${r.name} 近 ${ACTIVE_DAYS} 天发言 ${v} 条，荣登「活跃大王」`,
    async load (g, members) {
      const since = now() - ACTIVE_DAYS * DAY
      const max = Number(getConfig().record?.userMax) || 300
      // 只查最近 7 天发过言的人；协议端不给最后发言时间时全部都查
      const uids = members.filter(m => !m.last_sent_time || m.last_sent_time >= since).map(m => m.user_id)
      const res = await batch(uids, (m, u) => m.lRange(K.userLog(g, u), 0, -1))
      const out = new Map()
      uids.forEach((u, i) => {
        const ts = (res[i] || []).map(s => { try { return JSON.parse(s).t } catch { return 0 } })
        const n = ts.filter(t => t >= since).length
        // 本地记录已存满且最早一条仍在 7 天内：实际发言比记录的多
        if (n) out.set(u, { n, more: ts.length >= max && Math.min(...ts) >= since })
      })
      return out
    },
    value: (m, data) => data.get(m.user_id)?.n || null,
    text: (v, m, data) => `${v}${data.get(m.user_id)?.more ? '+' : ''} 条`
  },
  潜水大王: {
    caption: '按最后一次发言时间排序，越久没发言越靠前',
    headline: (r, v) => v >= 1 ? `${r.name} 已潜水 ${v} 天，深海之下暂无回音` : `全员活跃，今日无人潜水`,
    value: m => {
      const last = Number(m.last_sent_time) || Number(m.join_time)
      return last ? Math.floor((now() - last) / DAY) : null
    },
    text: (v, m) => !Number(m.last_sent_time) ? '入群后未发言' : v >= 1 ? `潜水 ${v} 天` : '今日冒泡',
    sub: (m, tz) => Number(m.last_sent_time) ? `最后发言 ${fmtDate(Number(m.last_sent_time), tz)}` : ''
  },
  老资历: {
    caption: '按入群时间排序，越早入群越靠前',
    headline: (r, v) => `${r.name} 入群已满 ${v} 天，是本群资历最老的成员`,
    value: m => Number(m.join_time) ? Math.floor((now() - Number(m.join_time)) / DAY) : null,
    text: v => `${v} 天`,
    sub: (m, tz) => `${fmtDate(Number(m.join_time), tz)} 入群`
  }
}

/**
 * 生成榜单渲染数据；没有可上榜的成员时返回 null
 * @param {string[]} focus 需要单独标出排名的成员（发起人 / 被@的人），不在前列时附在榜尾
 */
export async function buildRank (e, name, focus = []) {
  const board = BOARDS[name]
  const c = getConfig()
  const tz = c.timezone || 'Asia/Shanghai'
  const g = e.group_id
  const limit = Math.max(3, Number(c.rank?.limit) || 20)

  const members = (await getMemberList(e)).filter(m => m.user_id && m.user_id != e.self_id)
  const data = board.load ? await board.load(g, members) : null
  const ranked = members
    .map(m => ({ m, v: board.value(m, data) }))
    .filter(x => x.v !== null && x.v !== undefined)
    .sort((a, b) => b.v - a.v || a.m.user_id - b.m.user_id)
  if (!ranked.length) return null

  const focusSet = new Set(focus.map(String))
  const row = ({ m, v }, i) => ({
    no: i + 1,
    uid: m.user_id,
    name: m.card || m.nickname || String(m.user_id),
    avatar: `https://q1.qlogo.cn/g?b=qq&nk=${m.user_id}&s=100`,
    value: board.text(v, m, data),
    sub: board.sub?.(m, tz) || '',
    me: focusSet.has(String(m.user_id))
  })
  const rows = ranked.slice(0, limit).map(row)
  const extra = ranked.map(row).filter((r, i) => i >= limit && r.me)

  const T = now()
  const css = themeCss(await pickTheme(c))
  return {
    tplFile: TPL,
    saveId: `${g}_${name}`,
    scale: Number(c.scale) || 1,
    baseCss: baseCss(),
    themeCss: css,
    fontDir: FONT_DIR_URL,
    fontPreload: themeFonts(css),
    // 头像直接引用 QQ 头像地址，等图片加载完再截图
    pageGotoParams: { waitUntil: ['load', 'networkidle0'] },
    issue: await redis.incr(K.issue),
    dateCN: fmtDateCN(T, tz),
    time: fmtHM(T, tz),
    title: name,
    groupName: e.group_name || e.group?.name || '本群',
    headline: board.headline(rows[0], ranked[0].v),
    podium: rows.slice(0, 3).map((r, i) => ({ ...r, medal: MEDALS[i] })),
    rows: rows.slice(3),
    extra,
    total: ranked.length,
    caption: board.caption
  }
}
