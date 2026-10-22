import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { getConfig, groupEnabled } from '../model/config.js'
import { buildRank, BOARDS } from '../model/rank.js'

const NAMES = Object.keys(BOARDS)

export class Rank extends plugin {
  constructor () {
    super({
      name: '群友开盒-排行榜',
      dsc: '换头大王 / 马甲大王 / 活跃大王 / 潜水大王 / 老资历',
      event: 'message.group',
      priority: 500,
      rule: [
        {
          reg: `^#?(${NAMES.join('|')})$`,
          fnc: 'rank'
        },
        {
          reg: '^#?开盒排行榜?$',
          fnc: 'menu'
        }
      ]
    })
  }

  async rank (e) {
    const c = getConfig()
    if (!groupEnabled(c, e.group_id)) return false
    const name = e.msg.replace(/^#/, '').trim()

    // 发起人与被@的人：不在前列时附在榜尾显示排名
    const ats = (e.message || []).filter(s => s.type === 'at').map(s => s.qq ?? s.data?.qq).filter(q => q && q !== 'all' && String(q) !== String(e.self_id))
    try {
      const data = await buildRank(e, name, ats.length ? ats : [e.user_id])
      if (!data) {
        await this.reply(`「${name}」暂无数据：插件被动记录群友动态，装得越久越准，过段时间再来看看吧`, true)
        return true
      }
      const img = await puppeteer.screenshot('kaihe-rank', data)
      if (!img) {
        await this.reply('榜单渲染失败，请查看控制台日志。', true)
        return true
      }
      await this.reply(img, !!c.quote)
    } catch (err) {
      logger.error('[群友开盒] 排行榜生成失败', err)
      await this.reply(`排行榜生成失败：${err.message}`, true)
    }
    return true
  }

  async menu (e) {
    if (!groupEnabled(getConfig(), e.group_id)) return false
    await this.reply(['📊 群友开盒 · 排行榜', ...NAMES.map(n => `#${n}　${BOARDS[n].caption}`)].join('\n'))
    return true
  }
}
