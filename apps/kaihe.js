import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { getConfig, groupEnabled } from '../model/config.js'
import { buildGazette } from '../model/builder.js'
import { K } from '../model/utils.js'

export class Kaihe extends plugin {
  constructor () {
    super({
      name: '群友开盒',
      dsc: '娱乐向“开盒”：用群内公开资料生成群成员人物档案日报（支持 AI 撰稿）',
      event: 'message.group',
      priority: 500,
      rule: [
        {
          reg: '^#?开盒\\s*(\\d{5,12})?\\s*$',
          fnc: 'kaihe'
        }
      ]
    })
  }

  async kaihe (e) {
    const c = getConfig()
    if (!groupEnabled(c, e.group_id)) return false

    // 目标：@的人 > 指定QQ号 > 自己
    const atSeg = (e.message || []).find(s => s.type === 'at' && String(s.qq ?? s.data?.qq) !== String(e.self_id) && (s.qq ?? s.data?.qq) !== 'all')
    const qqArg = e.msg?.match(/(\d{5,12})\s*$/)?.[1]
    const uid = Number(atSeg ? (atSeg.qq ?? atSeg.data?.qq) : qqArg || e.user_id)

    const cd = Number(c.cd) || 0
    if (cd > 0 && !e.isMaster) {
      const key = K.cd(e.group_id, e.user_id)
      if (await redis.get(key)) {
        await this.reply('本报印刷机正在冷却，请稍后再来～', true, { recallMsg: 10 })
        return true
      }
      await redis.set(key, '1', { EX: cd })
    }

    if (c.ai?.enable && c.ai.apiKey) {
      await this.reply('📰 本报记者正在调查取证，请稍候…', false, { recallMsg: 15 })
    }

    try {
      const data = await buildGazette(e, uid)
      if (!data) {
        await this.reply('档案室查无此人：该成员可能不在本群。', true)
        return true
      }
      const img = await puppeteer.screenshot('kaihe', data)
      if (!img) {
        await this.reply('排版失败，请查看控制台日志。', true)
        return true
      }
      await this.reply(img, !!c.quote)
    } catch (err) {
      logger.error('[群友开盒] 生成失败', err)
      await this.reply(`日报生成失败：${err.message}`, true)
    }
    return true
  }
}
