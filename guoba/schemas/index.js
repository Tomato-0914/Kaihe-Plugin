import { getConfig, saveConfig } from '../../model/config.js'
import { listModels } from '../../model/ai.js'
import config, { modelOptions } from './config.js'

/* -------------- 表单 -------------- */
export const schemas = [
  ...config
]

/* -------------- 模型候选 -------------- */
// 锅巴前端只在加载页面时读取表单，按钮无法直接刷新下拉，因此尽量提前取好：
// 启动时、打开配置页时、保存了新的接口地址 / API Key 后，都在后台获取一次
async function refreshModels (baseURL, apiKey) {
  const list = await listModels(baseURL, apiKey)
  modelOptions.splice(0, modelOptions.length, ...list.map(id => ({ value: id })))
  return list
}

function prefetchModels () {
  const { baseURL, apiKey } = getConfig().ai || {}
  if (!baseURL || !apiKey) return
  refreshModels(baseURL, apiKey).catch(err => logger.debug(`[群友开盒] 预取模型列表失败：${err.message}`))
}

// 锅巴启动加载插件时即预取，首次打开配置页就能在下拉中选择
try { prefetchModels() } catch {}

/* -------------- 读取配置 -------------- */
export function getConfigData () {
  const c = getConfig()
  if (!modelOptions.length) prefetchModels()
  // GSelectGroup 以字符串群号匹配选项
  return { ...c, groups: (c.groups || []).map(String) }
}

/* -------------- 写入配置（保留 config.yaml 注释） -------------- */
export function setConfigData (data, { Result }) {
  try {
    // 以 _ 开头的是按钮等非配置项
    for (const key of Object.keys(data)) if (key.startsWith('_')) delete data[key]
    if ('groups' in data) data.groups = (data.groups || []).map(Number).filter(Boolean)
    const old = getConfig().ai || {}
    saveConfig(data)
    const now = getConfig().ai || {}
    // 换了接口或 Key：旧候选作废，重新获取
    if (now.baseURL !== old.baseURL || now.apiKey !== old.apiKey) {
      modelOptions.length = 0
      prefetchModels()
    }
    return Result.ok({}, '保存成功')
  } catch (err) {
    logger.error('[群友开盒] 锅巴保存配置失败', err)
    return Result.error(`保存失败：${err.message}`)
  }
}

/* -------------- 按钮动作（GButtons） -------------- */
export const actions = {
  /** 获取可用模型：参数为表单中当前填写（未保存也可）的接口地址与 API Key */
  async fetchModels ([baseURL, apiKey] = [], { Result }) {
    const c = getConfig()
    baseURL = baseURL || c.ai?.baseURL
    apiKey = apiKey || c.ai?.apiKey
    if (!baseURL || !apiKey) return Result.error('请先填写接口地址和 API Key')
    try {
      const list = await refreshModels(baseURL, apiKey)
      if (!list.length) return Result.error('接口未返回任何模型，请手动填写模型 id')
      const shown = list.slice(0, 20).join('、') + (list.length > 20 ? ' 等' : '')
      return Result.ok({}, `获取到 ${list.length} 个模型：${shown}。按 F5 刷新页面后即可在「模型」下拉中选择`)
    } catch (err) {
      return Result.error(`获取失败：${err.message}`)
    }
  }
}
