import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEF = path.join(ROOT, 'config', 'config_default.yaml')
const USER = path.join(ROOT, 'config', 'config.yaml')

let cache = null
let cacheSig = ''
let cacheText = null
let synced = false

function merge (base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v
  }
  return out
}

/**
 * 插件更新后，把默认配置里新增的键（连同注释）补进 config.yaml；
 * 用户已有的值、注释、顺序都不动。每次进程启动执行一次。
 */
function syncDefaults () {
  try {
    const userDoc = YAML.parseDocument(fs.readFileSync(USER, 'utf8'))
    const defDoc = YAML.parseDocument(fs.readFileSync(DEF, 'utf8'))
    if (userDoc.errors.length || !YAML.isMap(userDoc.contents) || !YAML.isMap(defDoc.contents)) return

    const added = []
    const walk = (user, def, prefix) => {
      for (const item of def.items) {
        const key = item.key?.value
        if (key === undefined) continue
        const cur = user.items.find(i => i.key?.value === key)
        if (!cur) {
          user.items.push(item)
          added.push(prefix + key)
        } else if (YAML.isMap(item.value) && YAML.isMap(cur.value)) {
          walk(cur.value, item.value, `${prefix}${key}.`)
        }
      }
    }
    walk(userDoc.contents, defDoc.contents, '')
    if (!added.length) return
    fs.writeFileSync(USER, userDoc.toString(), 'utf8')
    logger.mark(`[群友开盒] config.yaml 已补充新配置项：${added.join('、')}`)
  } catch (err) {
    logger.error(`[群友开盒] 合并默认配置失败：${err.message}`)
  }
}

const signature = () => {
  const st = fs.statSync(USER)
  return `${st.mtimeMs}:${st.size}`
}

/** 重新读取 config.yaml；内容没变不重复解析，格式错误时保留上一份可用配置 */
function load () {
  const sig = signature()
  const text = fs.readFileSync(USER, 'utf8')
  cacheSig = sig
  if (cache && text === cacheText) return
  const first = !cache
  cacheText = text

  const def = YAML.parse(fs.readFileSync(DEF, 'utf8')) || {}
  let user
  try {
    user = YAML.parse(text) || {}
  } catch (err) {
    logger.error(`[群友开盒] config.yaml 格式错误，${first ? '已使用默认配置' : '继续使用上一次的配置'}：${err.message}`)
    if (!first) return
    user = {}
  }
  cache = merge(def, user)
  if (!first) logger.mark('[群友开盒] config.yaml 已更新，配置已热重载')
}

/** 监听配置目录（兼容编辑器“写临时文件再改名”的保存方式），变更后立即重载 */
function watch () {
  if (global.__kaiheConfigWatcher) return
  let timer = null
  try {
    global.__kaiheConfigWatcher = fs.watch(path.dirname(USER), (event, file) => {
      if (file && file !== 'config.yaml') return
      clearTimeout(timer)
      timer = setTimeout(() => {
        try { if (fs.existsSync(USER)) load() } catch (err) { logger.error(`[群友开盒] 重载配置失败：${err.message}`) }
      }, 200)
    })
    global.__kaiheConfigWatcher.on('error', () => { global.__kaiheConfigWatcher = null })
    global.__kaiheConfigWatcher.unref?.()
  } catch (err) {
    logger.debug(`[群友开盒] 无法监听配置目录，改为读取时检查：${err.message}`)
  }
}

/** 读取配置（config.yaml 覆盖默认值；文件改动后自动热重载，无需重启） */
export function getConfig () {
  if (!fs.existsSync(USER)) fs.copyFileSync(DEF, USER)
  if (!synced) {
    synced = true
    syncDefaults()
    watch()
  }
  // 兜底：监听不可用时，按修改时间 + 大小判断是否需要重载
  if (!cache || signature() !== cacheSig) load()
  return cache
}

/**
 * 写入配置（锅巴保存时调用），保留 config.yaml 的注释与格式
 * @param {Record<string, any>} data 扁平键值，如 { 'ai.apiKey': 'sk-xxx', scale: 1.5 }
 */
export function saveConfig (data) {
  getConfig()
  const doc = YAML.parseDocument(fs.readFileSync(USER, 'utf8'))
  if (doc.errors.length) throw new Error(`config.yaml 格式错误：${doc.errors[0].message}`)

  // 嵌套对象展开成扁平键，避免整块替换丢失注释
  const flat = {}
  const flatten = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, `${prefix}${k}.`)
      else flat[prefix + k] = v
    }
  }
  flatten(data, '')

  for (const [key, value] of Object.entries(flat)) {
    const keys = key.split('.')
    const node = doc.getIn(keys, true)
    // 标量直接改值：保留行尾注释和引号风格
    if (YAML.isScalar(node) && (value === null || typeof value !== 'object')) {
      node.value = value
    } else {
      // 列表沿用原来的行内 / 多行写法，并带上原节点的注释
      const created = doc.createNode(value)
      if (YAML.isSeq(node) && YAML.isSeq(created)) created.flow = node.flow
      if (YAML.isNode(node) && YAML.isNode(created)) {
        created.comment = node.comment
        created.commentBefore = node.commentBefore
      }
      doc.setIn(keys, created)
    }
  }
  fs.writeFileSync(USER, doc.toString(), 'utf8')
}

export function groupEnabled (cfg, groupId) {
  const list = (cfg.groups || []).map(String)
  return !list.length || list.includes(String(groupId))
}
