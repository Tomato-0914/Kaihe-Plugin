import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './config.js'
import { K } from './utils.js'

/** 插件自带字体目录（模板渲染后写到 temp/html，须用绝对 file:// 地址引用） */
export const FONT_DIR_URL = pathToFileURL(path.join(ROOT, 'resources', 'fonts')).href

const FONT_FILES = {
  'KH Serif': ['NotoSerifSC-VF.ttf'],
  'KH Sans': ['NotoSansSC-VF.ttf'],
  'KH Kai': ['LXGWWenKaiLite-Medium.ttf'],
  'KH Mono': ['JetBrainsMono-400.woff2', 'JetBrainsMono-700.woff2']
}

/**
 * 主题实际用到的字体文件，用于 <link rel="preload">：预加载会推迟页面 load 事件，确保截图时字体已就绪。
 * 主题未改 body 字体时正文用 KH Serif；其余按主题样式中出现的字体名判断。
 */
export function themeFonts (css = '') {
  const used = new Set(/body\s*\{[^}]*font-family/.test(css) ? [] : ['KH Serif'])
  for (const family of Object.keys(FONT_FILES)) if (css.includes(`"${family}"`)) used.add(family)
  return [...used].flatMap(f => FONT_FILES[f])
}

/**
 * 版面主题：resources/gazette/themes/*.css，文件名即主题 id，首行注释 `/* 名称 *\/` 为显示名。
 * 主题在基础样式之后注入，可覆盖 CSS 变量，也可追加任意规则。放入新的 css 文件即可新增主题。
 */
const DIR = path.join(ROOT, 'resources', 'gazette', 'themes')

export function listThemes () {
  let files = []
  try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.css')) } catch {}
  const themes = files.map(f => {
    const value = f.slice(0, -4)
    let label = value
    try { label = fs.readFileSync(path.join(DIR, f), 'utf8').match(/^\s*\/\*\s*(.+?)\s*\*\//)?.[1] || value } catch {}
    return { label, value }
  })
  // 默认主题排最前
  return themes.sort((a, b) => (b.value === 'default') - (a.value === 'default') || a.value.localeCompare(b.value))
}

/** 读取主题样式；id 不合法或文件不存在时返回空串（即使用模板内置的默认样式） */
export function themeCss (id) {
  if (!/^[\w-]+$/.test(String(id || ''))) return ''
  try {
    return fs.readFileSync(path.join(DIR, `${id}.css`), 'utf8')
  } catch {
    logger.warn(`[群友开盒] 主题「${id}」不存在，已使用默认主题`)
    return ''
  }
}

export const THEME_MODES = [
  { label: '固定', value: 'fixed' },
  { label: '轮换', value: 'rotate' },
  { label: '随机', value: 'random' }
]

/** 参与轮换 / 随机的主题：themePool 为空时为全部主题，已不存在的主题自动忽略 */
export function themePool (c) {
  const all = listThemes().map(t => t.value)
  const pool = (c.themePool || []).map(String).filter(t => all.includes(t))
  return pool.length ? pool : all
}

/** 按 themeMode 选出本次使用的主题：fixed 固定 / rotate 顺序轮换 / random 随机（不连续重复） */
export async function pickTheme (c) {
  const mode = c.themeMode
  const pool = themePool(c)
  if (mode === 'rotate' && pool.length) {
    const n = await redis.incr(K.themeRR)
    return pool[(n - 1) % pool.length]
  }
  if (mode === 'random' && pool.length) {
    const last = await redis.get(K.themeLast)
    const cand = pool.length > 1 ? pool.filter(t => t !== last) : pool
    const pick = cand[Math.floor(Math.random() * cand.length)]
    await redis.set(K.themeLast, pick)
    return pick
  }
  return c.theme || 'default'
}

/** 按 id / 名称（可模糊）/ 列表序号查找主题 */
export function findTheme (input) {
  const list = listThemes()
  const s = String(input || '').trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return list[Number(s) - 1] || null
  // 精确 id > 名称包含 > 按顺序包含每个字（如“黑金”匹配“黑底金字”）
  const inOrder = label => { let i = 0; for (const ch of label) if (ch === s[i]) i++; return i === s.length }
  return list.find(t => t.value === s.toLowerCase()) || list.find(t => t.label.includes(s)) || list.find(t => inOrder(t.label)) || null
}
