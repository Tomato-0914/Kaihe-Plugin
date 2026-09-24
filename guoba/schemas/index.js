import { getConfig, saveConfig } from '../../model/config.js'
import config from './config.js'

/* -------------- 表单 -------------- */
export const schemas = [
  ...config
]

/* -------------- 读取配置 -------------- */
export function getConfigData () {
  const c = getConfig()
  // GSelectGroup 以字符串群号匹配选项
  return { ...c, groups: (c.groups || []).map(String) }
}

/* -------------- 写入配置（保留 config.yaml 注释） -------------- */
export function setConfigData (data, { Result }) {
  try {
    if ('groups' in data) data.groups = (data.groups || []).map(Number).filter(Boolean)
    saveConfig(data)
    return Result.ok({}, '保存成功')
  } catch (err) {
    logger.error('[群友开盒] 锅巴保存配置失败', err)
    return Result.error({}, `保存失败：${err.message}`)
  }
}
