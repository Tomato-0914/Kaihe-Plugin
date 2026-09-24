import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEF = path.join(ROOT, 'config', 'config_default.yaml')
const USER = path.join(ROOT, 'config', 'config.yaml')

let cache = null
let cacheMtime = 0
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

/** 读取配置（config.yaml 覆盖默认值，文件修改后自动重新加载） */
export function getConfig () {
  if (!fs.existsSync(USER)) fs.copyFileSync(DEF, USER)
  if (!synced) {
    synced = true
    syncDefaults()
  }
  const mtime = fs.statSync(USER).mtimeMs
  if (cache && mtime === cacheMtime) return cache

  const def = YAML.parse(fs.readFileSync(DEF, 'utf8')) || {}
  let user = {}
  try {
    user = YAML.parse(fs.readFileSync(USER, 'utf8')) || {}
  } catch (err) {
    logger.error(`[群友开盒] config.yaml 格式错误，已使用默认配置：${err.message}`)
  }
  cache = merge(def, user)
  cacheMtime = mtime
  return cache
}

/**
 * 写入配置（锅巴保存时调用），保留 config.yaml 的注释与格式
 * @param {Record<string, any>} data 扁平键值，如 { 'ai.apiKey': 'sk-xxx', cd: 60 }
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
