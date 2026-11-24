import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { sweepNsisLeftovers } from './single-instance'

/**
 * 临时目录管理。
 *
 * 为什么要管这个：portable 版每次双击都是
 *   ① NSIS 解压器把 app-64.7z（约 286MB）解到 `%TEMP%\nsXXXX.tmp`（配合 7z-out 峰值约 572MB）
 *   ② 拷到 `%TEMP%\Workbench-<版本>`（约 286MB）
 *   ③ 程序跑完，NSIS 删 ①，portable 删 ②
 *
 * ②③ 由我们的代码兜底（见 single-instance.ts），但 ① 在应用代码之前发生、由 NSIS 负责。
 * 一旦进程被强杀（任务管理器结束任务 / 断电 / 测试脚本 Stop-Process -Force），① 就留下来了。
 * 实测某台机器上这样攒了 35 个、12.72GB，直接把 C 盘从 19.6GB 挤到 6.8GB。
 *
 * 所以最有效的办法是把「系统临时目录」本身挪到别的盘 —— NSIS 的 $PLUGINSDIR 跟着走，
 * C 盘从此不再增长。这只影响当前用户（HKCU\Environment），不需要管理员权限。
 */

export interface TmpDirInfo {
  /** 当前系统临时目录（os.tmpdir 实际解析出来的） */
  current: string
  /** 当前临时目录所在盘符，如 "C:" */
  drive: string
  /** 是否是应用建议的位置（别的盘下的 WorkbenchTemp） */
  isMoved: boolean
  /** 所在盘的剩余空间（GB，拿不到为 null） */
  freeGB: number | null
}

function driveOf(p: string): string {
  const m = /^([A-Za-z]):/.exec(p)
  return m ? m[1].toUpperCase() + ':' : ''
}

/** 某个盘还剩多少 GB（Windows 用 fs.statfsSync，Node 18.15+ 支持） */
function freeGBOf(drive: string): number | null {
  try {
    const st = (fs as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } }).statfsSync
    if (!st) return null
    const s = st(drive + '\\')
    return Number(((s.bavail * s.bsize) / 1024 ** 3).toFixed(1))
  } catch {
    return null
  }
}

export function tmpDirInfo(): TmpDirInfo {
  const current = os.tmpdir()
  const drive = driveOf(current)
  const free = drive ? freeGBOf(drive) : null
  return {
    current,
    drive,
    isMoved: !/^C:$/i.test(drive) && /WorkbenchTemp$/i.test(current.replace(/[\\/]+$/, '')),
    freeGB: free
  }
}

/** 建议的新临时目录：优先选剩余空间最大的非 C 盘 */
export function suggestTmpDir(): string {
  const candidates: string[] = []
  for (const letter of ['D', 'E', 'F', 'G', 'H']) {
    const root = `${letter}:\\`
    try {
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue
      candidates.push(root)
    } catch {
      continue
    }
  }
  let best = candidates[0] || 'D:\\'
  let bestFree = -1
  for (const c of candidates) {
    const f = freeGBOf(driveOf(c)) ?? -1
    if (f > bestFree) {
      bestFree = f
      best = c
    }
  }
  return path.join(best, 'WorkbenchTemp')
}

export interface TmpMoveResult {
  ok: boolean
  from: string
  to: string
  /** 搬过去多少个文件 */
  files: number
  /** 是否需要重启才生效 */
  needRestart: boolean
  message: string
}

/**
 * 把系统临时目录挪到指定位置。
 *
 * 做三件事：
 *  1. 建目标目录、把现有临时文件尽量搬过去（搬不动的——正被占用的——跳过，不报错）
 *  2. 写当前用户的 TEMP / TMP 环境变量（HKCU\Environment，无需管理员）
 *  3. 广播 WM_SETTINGCHANGE，让新开的进程立刻用上新值
 *
 * 不删旧的 C 盘临时目录：里面可能有别的软件正在用的文件，而且挪完本来就不再往里写。
 */
export function moveTmpDir(target: string): TmpMoveResult {
  const from = os.tmpdir()
  const to = path.resolve(target)
  const result: TmpMoveResult = { ok: false, from, to, files: 0, needRestart: true, message: '' }

  if (!/^[A-Za-z]:\\/.test(to)) {
    result.message = '目标要写成绝对路径，例如 D:\\WorkbenchTemp'
    return result
  }
  const drive = driveOf(to)
  if (!drive || drive.toUpperCase() === 'C:') {
    result.message = '这本来就是 C 盘的问题，换到别的盘才有效果（D / E / F…）'
    return result
  }
  if (to.toLowerCase() === from.toLowerCase()) {
    result.message = '和目标一样，不用搬'
    return result
  }
  try {
    if (!fs.existsSync(drive + '\\')) {
      result.message = `${drive} 盘不存在，换个盘符再试`
      return result
    }
  } catch {
    result.message = `${drive} 盘读不到，换个盘符再试`
    return result
  }

  try {
    fs.mkdirSync(to, { recursive: true })
  } catch (err) {
    result.message = `目标目录建不出来：${(err as Error).message}`
    return result
  }

  // ① 搬现有文件：逐个搬，占用的跳过。不做删除，只做复制（原文件留在原处，用户可自行清）
  let moved = 0
  try {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, e.name)
      const dst = path.join(to, e.name)
      try {
        if (fs.existsSync(dst)) continue
        if (e.isDirectory()) {
          fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false })
        } else {
          fs.copyFileSync(src, dst)
        }
        moved += 1
      } catch {
        /* 占用 / 没权限 → 跳过，不中断 */
      }
    }
  } catch {
    /* 源目录读不了也不影响变量写入 */
  }
  result.files = moved

  // ② 写当前用户环境变量（不碰系统级，不需要管理员）
  const set = spawnSync('reg', ['add', 'HKCU\\Environment', '/v', 'TEMP', '/t', 'REG_EXPAND_SZ', '/d', to, '/f'], {
    windowsHide: true,
    encoding: 'utf8'
  })
  const set2 = spawnSync('reg', ['add', 'HKCU\\Environment', '/v', 'TMP', '/t', 'REG_EXPAND_SZ', '/d', to, '/f'], {
    windowsHide: true,
    encoding: 'utf8'
  })
  if (set.status !== 0 || set2.status !== 0) {
    result.message = `写环境变量失败：${(set.stderr || set2.stderr || '').trim() || '未知原因'}`
    return result
  }

  // ③ 广播设置变更，新进程立刻生效（不用注销）
  try {
    const ps = [
      '$sig = "[DllImport(\\"user32.dll\\", SetLastError=true, CharSet=CharSet.Auto)]',
      'public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);"',
      '$t = Add-Type -MemberDefinition $sig -Name W -Namespace S -PassThru',
      '$r = [UIntPtr]::Zero',
      '$t::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$r) | Out-Null'
    ].join('\n')
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, encoding: 'utf8' })
  } catch {
    /* 广播失败不影响 reg 已写入，重启后照样生效 */
  }

  result.ok = true
  result.needRestart = true
  result.message = `已把临时目录指到 ${to}（搬了 ${moved} 项）。重启应用后 portable 就解压到新位置，C 盘不再增长。`
  return result
}

/** 立即清理当前临时目录里的 NSIS 残留（供设置页一键用） */
export function sweepNow(): { dirs: number; freedMB: number } {
  const r = sweepNsisLeftovers(0)
  return { dirs: r.dirs, freedMB: Math.round(r.bytes / 1024 / 1024) }
}