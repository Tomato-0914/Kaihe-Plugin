import { getConfig, saveConfig } from './model/config.js'

const group = label => ({ label, component: 'SOFT_GROUP_BEGIN' })
const num = (field, label, helpMessage, props = {}) => ({
  field, label, bottomHelpMessage: helpMessage, component: 'InputNumber', componentProps: { min: 0, ...props }
})

const schemas = [
  group('基础设置'),
  {
    field: 'groups',
    label: '启用的群',
    bottomHelpMessage: '留空表示所有群均启用',
    component: 'GSelectGroup'
  },
  num('cd', '触发冷却', '同一用户两次开盒的间隔，主人不受限制', { addonAfter: '秒' }),
  { field: 'quote', label: '引用触发消息', bottomHelpMessage: '发送图片时是否引用触发消息', component: 'Switch' },
  num('scale', '渲染缩放', '1 = 760px 宽；1.5 更清晰，图片体积稍大', { min: 0.5, max: 3, step: 0.1 }),
  { field: 'timezone', label: '时区', bottomHelpMessage: '决定日期与作息统计，如 Asia/Shanghai', component: 'Input' },
  num('sampleSize', '行为分析取样', '拉取本群最近多少条消息', { min: 10, max: 1000, addonAfter: '条' }),

  group('本地记录'),
  num('record.userMax', '每人保留发言', '作息 / 构成统计用', { min: 10, addonAfter: '条' }),
  num('record.groupMax', '每群保留消息', '拉取历史失败时兜底', { min: 10, addonAfter: '条' }),
  num('record.keepDays', '保留天数', '按最后一次写入顺延', { min: 1, addonAfter: '天' }),

  group('头像追踪'),
  { field: 'avatar.enable', label: '追踪头像变更', bottomHelpMessage: '比对头像指纹，成员发言时按间隔检测', component: 'Switch' },
  num('avatar.intervalHours', '检测间隔', '', { min: 1, addonAfter: '小时' }),

  group('AI 撰稿'),
  { field: 'ai.enable', label: '启用 AI', bottomHelpMessage: '未填 API Key 或调用失败时自动使用内置模板文案', component: 'Switch' },
  {
    field: 'ai.baseURL',
    label: '接口地址',
    bottomHelpMessage: 'OpenAI 兼容接口，需包含 /v1',
    component: 'Input',
    componentProps: { placeholder: 'https://api.deepseek.com/v1' }
  },
  { field: 'ai.apiKey', label: 'API Key', component: 'InputPassword', componentProps: { placeholder: 'sk-...' } },
  {
    field: 'ai.model',
    label: '模型',
    bottomHelpMessage: '填模型 id（非显示名），如 deepseek-flash',
    component: 'Input'
  },
  num('ai.temperature', '温度', '越高越放飞', { max: 2, step: 0.1 }),
  num('ai.timeout', '请求超时', '', { min: 5, addonAfter: '秒' }),
  num('ai.contextSize', '群聊上下文', '喂给 AI 的群聊消息条数', { addonAfter: '条' }),
  num('ai.userSize', '本人发言', '喂给 AI 的本人发言条数', { addonAfter: '条' }),
  num('ai.cacheMinutes', '稿件缓存', '同一成员 AI 稿件缓存时长，0 为不缓存', { addonAfter: '分钟' })
]

/** 锅巴 v3 适配 */
export function supportGuoba () {
  return {
    pluginInfo: {
      name: 'Kaihe-Plugin',
      title: '群友开盒',
      author: '@Tomato-0914',
      authorLink: 'https://github.com/Tomato-0914',
      link: 'https://github.com/Tomato-0914/Kaihe-Plugin',
      isV3: true,
      isV2: false,
      description: '娱乐向「开盒」：用群内公开资料生成报纸风格的群成员人物档案，支持 AI 撰稿',
      icon: 'mdi:newspaper-variant-outline',
      iconColor: '#8b2a1e'
    },
    configInfo: {
      schemas,
      getConfigData () {
        const c = getConfig()
        // GSelectGroup 以字符串群号匹配选项
        return { ...c, groups: (c.groups || []).map(String) }
      },
      setConfigData (data, { Result }) {
        try {
          if ('groups' in data) data.groups = (data.groups || []).map(Number).filter(Boolean)
          saveConfig(data)
          return Result.ok({}, '保存成功')
        } catch (err) {
          logger.error('[群友开盒] 锅巴保存配置失败', err)
          return Result.error({}, `保存失败：${err.message}`)
        }
      }
    }
  }
}
