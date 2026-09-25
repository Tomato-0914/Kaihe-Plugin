import { getConfig, saveConfig } from '../model/config.js'
import { listThemes, findTheme, themePool, THEME_MODES } from '../model/theme.js'

const MODE_WORDS = { 固定: 'fixed', 手动: 'fixed', 轮换: 'rotate', 轮询: 'rotate', 随机: 'random' }

export class Theme extends plugin {
  constructor () {
    super({
      name: '群友开盒-主题',
      dsc: '查看与切换开盒版面主题',
      event: 'message',
      priority: 500,
      rule: [
        {
          reg: '^#?开盒(主题|样式|皮肤)\\s*(.*)$',
          fnc: 'theme'
        }
      ]
    })
  }

  async theme (e) {
    const arg = e.msg.replace(/^#?开盒(主题|样式|皮肤)\s*/, '').trim()
    if (!arg) return this.reply(this.status())
    if (!e.isMaster) return this.reply('仅主人可以切换主题，发送 #开盒主题 可查看当前主题')

    // 切换模式：#开盒主题 固定 / 轮换 / 随机
    if (MODE_WORDS[arg]) {
      saveConfig({ themeMode: MODE_WORDS[arg] })
      return this.reply(`已切换为「${arg}」模式\n\n${this.status()}`)
    }
    // 指定主题：#开盒主题 黑金 / gold / 2（切换后自动改为固定模式）
    const t = findTheme(arg)
    if (!t) return this.reply(`没有找到主题「${arg}」\n\n${this.status()}`)
    saveConfig({ theme: t.value, themeMode: 'fixed' })
    return this.reply(`已切换为「${t.label}」（固定模式）`)
  }

  status () {
    const c = getConfig()
    const mode = THEME_MODES.find(m => m.value === c.themeMode) || THEME_MODES[0]
    const pool = new Set(themePool(c))
    const lines = listThemes().map((t, i) => {
      const mark = mode.value === 'fixed' ? (t.value === (c.theme || 'default') ? ' ← 当前' : '') : (pool.has(t.value) ? ' ✓' : '')
      return `${i + 1}. ${t.label}（${t.value}）${mark}`
    })
    return [
      `当前模式：${mode.label}${mode.value === 'fixed' ? '' : `（✓ 为参与${mode.label}的主题）`}`,
      ...lines,
      '',
      '切换主题：#开盒主题 名称/序号',
      '切换模式：#开盒主题 固定/轮换/随机'
    ].join('\n')
  }
}
