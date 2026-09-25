import { listThemes, THEME_MODES } from '../../model/theme.js'

/** 模型候选项，由「获取可用模型」按钮原地更新；锅巴每次拉取插件列表都会读取到最新内容 */
export const modelOptions = []

const group = label => ({ label, component: 'SOFT_GROUP_BEGIN' })
const num = (field, label, helpMessage, props = {}) => ({
  field, label, bottomHelpMessage: helpMessage, component: 'InputNumber', componentProps: { min: 0, ...props }
})

export default [
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
  {
    field: 'themeMode',
    label: '主题切换',
    bottomHelpMessage: '固定：始终使用下方的版面主题；轮换：按顺序依次使用；随机：每次随机（不连续重复）',
    component: 'Select',
    componentProps: { options: THEME_MODES }
  },
  {
    field: 'theme',
    label: '版面主题',
    bottomHelpMessage: '固定模式下使用的主题；在 resources/gazette/themes/ 放入 css 文件即可新增主题',
    component: 'Select',
    componentProps: { options: listThemes() }
  },
  {
    field: 'themePool',
    label: '轮换 / 随机范围',
    bottomHelpMessage: '留空表示全部主题',
    component: 'Select',
    componentProps: { options: listThemes(), mode: 'multiple', allowClear: true }
  },
  { field: 'timezone', label: '时区', bottomHelpMessage: '决定日期与作息统计，如 Asia/Shanghai', component: 'Input' },
  num('sampleSize', '群聊取样', '本群最近多少条消息，用于群聊占比与 AI 上下文', { min: 10, max: 1000, addonAfter: '条' }),
  num('userSample', '本人取样', '向前翻页直到取到该成员最近多少条消息，用于发言构成与作息', { min: 10, max: 1000, addonAfter: '条' }),
  num('maxPages', '翻页上限', '每页 100 条；成员很少发言时最多翻这么多页', { min: 1, max: 200, addonAfter: '页' }),

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
    bottomHelpMessage: '填模型 id（非显示名），可手动输入，也可在下拉中选择',
    component: 'AutoComplete',
    // 不按输入过滤：已填了模型时也能看到全部候选
    componentProps: { options: modelOptions, filterOption: false, allowClear: true, placeholder: 'deepseek-flash' }
  },
  {
    field: '_fetchModels',
    label: '模型列表',
    bottomHelpMessage: '已保存 API Key 时会自动获取；更换接口或 Key 后可点此按当前填写的内容获取（无需先保存），获取后按 F5 刷新页面即可在「模型」下拉中选择',
    component: 'GButtons',
    componentProps: {
      buttons: [{ label: '获取可用模型', type: 'primary', action: 'fetchModels', args: ['#{ai.baseURL}', '#{ai.apiKey}'] }]
    }
  },
  num('ai.temperature', '温度', '越高越放飞', { max: 2, step: 0.1 }),
  num('ai.timeout', '请求超时', '', { min: 5, addonAfter: '秒' }),
  num('ai.contextSize', '群聊上下文', '喂给 AI 的群聊消息条数', { addonAfter: '条' }),
  num('ai.userSize', '本人发言', '喂给 AI 的本人发言条数', { addonAfter: '条' }),
  num('ai.cacheMinutes', '稿件缓存', '同一成员 AI 稿件缓存时长，0 为不缓存', { addonAfter: '分钟' })
]
