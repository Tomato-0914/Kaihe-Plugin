import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import common from '../../../lib/common/common.js'
import { ROOT } from '../model/config.js'

/** 不经过 shell 调用 git，避免 Windows cmd 对 % 等字符的转义问题 */
const git = (...args) => new Promise(resolve => {
  execFile('git', args, { cwd: ROOT, windowsHide: true, timeout: 120000 }, (error, stdout, stderr) => {
    resolve({ error, stdout: String(stdout).trim(), stderr: String(stderr).trim() })
  })
})

let updating = false

export class Update extends plugin {
  constructor () {
    super({
      name: '群友开盒-更新',
      dsc: '从 GitHub 拉取群友开盒插件更新并重启',
      event: 'message',
      priority: 100,
      rule: [
        {
          reg: '^#?开盒(强制)?更新$',
          fnc: 'update'
        }
      ]
    })
  }

  async update (e) {
    if (!e.isMaster) return false
    if (updating) {
      await this.reply('已有更新任务在进行中，请稍候…')
      return true
    }
    if (!fs.existsSync(path.join(ROOT, '.git'))) {
      await this.reply('群友开盒不是通过 git clone 安装的，无法自动更新，请参考 README 重新安装。')
      return true
    }

    updating = true
    try {
      const force = /强制/.test(e.msg)
      const oldHead = await this.head()
      await this.reply(`正在${force ? '强制' : ''}更新群友开盒…`)

      // 强制更新：丢弃本地对已跟踪文件的修改（config/config.yaml 不受 git 管理，不会被覆盖）
      const dirty = force && !!(await git('status', '--porcelain', '--untracked-files=no')).stdout
      const ret = force ? await this.forceSync() : await git('pull', '--ff-only')
      if (ret.error) {
        const detail = ret.stderr || ret.error.message
        logger.error('[群友开盒] 更新失败', detail)
        // 去掉 "From <远端地址>" 和分支变动行，避免在群里暴露服务器路径
        const brief = detail.split('\n').filter(l => !/^From |->/.test(l.trim())).join('\n').trim()
        await this.reply(`更新失败：\n${brief.slice(0, 500)}${force ? '' : '\n\n可尝试 #开盒强制更新'}`)
        return true
      }

      const newHead = await this.head()
      const time = (await git('log', '-1', '--date=format:%Y-%m-%d %H:%M', '--pretty=%cd')).stdout || '未知'
      if (oldHead === newHead) {
        if (!dirty) {
          await this.reply(`群友开盒已是最新版本\n最后更新：${time}`)
          return true
        }
        // 版本没变但本地改动被丢弃，运行中的仍是改动后的代码，需要重启
        await this.reply(`已丢弃本地对插件代码的改动，恢复为最新版本\n最后更新：${time}`)
        await this.restart()
        return true
      }

      const log = (await git('log', `${oldHead}..${newHead}`, '-n', '20', '--date=format:%m-%d %H:%M', '--pretty=[%cd] %s')).stdout
      await this.sendLog([
        `群友开盒更新成功\n${oldHead.slice(0, 7)} → ${newHead.slice(0, 7)}\n最后更新：${time}`,
        `更新日志：\n${log || '（无）'}`
      ])
      await this.restart()
    } catch (err) {
      logger.error('[群友开盒] 更新异常', err)
      await this.reply(`更新出错：${err.message}`)
    } finally {
      updating = false
    }
    return true
  }

  /**
   * 强制与远端对齐：先 fetch 再直接 reset 到远端分支（不经过 rebase，未跟踪的同名文件也会被覆盖）。
   * 没有上游分支（如 detached HEAD）时，退回远端默认分支并修复跟踪关系。
   */
  async forceSync () {
    let ret = await git('fetch', '--all')
    if (ret.error) return ret
    if (!(await git('rev-parse', '--symbolic-full-name', '@{u}')).error) return git('reset', '--hard', '@{u}')

    let remoteHead = await git('rev-parse', '--abbrev-ref', 'origin/HEAD')
    if (remoteHead.error) {
      await git('remote', 'set-head', 'origin', '--auto')
      remoteHead = await git('rev-parse', '--abbrev-ref', 'origin/HEAD')
      if (remoteHead.error) return remoteHead
    }
    const ref = remoteHead.stdout // 如 origin/main
    const branch = ref.replace(/^origin\//, '')
    ret = await git('checkout', '-f', '-B', branch, ref)
    if (!ret.error) ret = await git('branch', `--set-upstream-to=${ref}`, branch)
    return ret
  }

  async head () {
    return (await git('rev-parse', 'HEAD')).stdout
  }

  /** 群聊用合并转发，失败或私聊时降级为纯文本 */
  async sendLog (msgs) {
    try {
      await this.reply(await common.makeForwardMsg(this.e, msgs, '群友开盒更新日志'))
    } catch {
      await this.reply(msgs.join('\n\n'))
    }
  }

  /** 交给框架自带的重启流程（兼容 PM2 与前台运行），失败则提示手动重启 */
  async restart () {
    try {
      const { Restart } = await import('../../other/restart.js')
      await new Restart(this.e).restart()
    } catch (err) {
      logger.error('[群友开盒] 自动重启失败', err)
      await this.reply('自动重启失败，请发送 #重启 使更新生效。')
    }
  }
}
