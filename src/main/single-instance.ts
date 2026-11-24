import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * portable 版的启动期保护。
 *
 * 背景（真实踩坑）：electron-builder 的 portable 启动器会先把 exe 解压到
 * %TEMP%\Workbench（改成带版本号后是 %TEMP%\Workbench-<版本>），再起真正的程序。
 * 这段解压发生在我们的代码运行之前，所以应用层的 requestSingleInstanceLock 管不到它。
 *
 * 两个由此产生的真实故障：
 *  1) 连点几下：多个启动器同时往同一个目录解压，文件互相覆盖，解出来的
 *     app.asar 是残缺的 —— 表现就是别人的机器上弹
 *     "ENOENT: no such file or directory, open '...\resources\app.asar\...\package.json'"。
 *  2) 旧版本残留：%TEMP%\Workbench 里躺着上个版本解出的文件，新 exe 复用它，
 *     版本错配照样报错。
 *
 * 修法：
 *  · 解压目录带版本号（electron-builder.yml 的 unpackDirName: Workbench-${version}），
 *    新版本永远不碰旧目录；
 *  · 这里再兜一层：启动器级别的互斥锁（%TEMP% 下的锁文件 + pid 存活判断），
 *    同一时刻只允许一个启动器解压/拉起；
 *  · 启动后清掉别的版本留下的解压目录（只删自己命名规则下的、确认没有进程在用的）。
 */

const LOCK_DIR = 'workbench-launcher-locks'

function lockDir(): string {
  return path.join(os.tmpdir(), LOCK_DIR)
}

/** 进程是否还活着（Windows 用 0 号信号，Node 在 win 上对任意 pid kill(0) 可用） */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM 说明进程存在但没权限 → 视为活着
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface LaunchLock {
  /** 拿到锁了吗（false 表示已有别的实例在跑） */
  acquired: boolean
  /** 锁文件路径，释放时要用 */
  file: string
}

/**
 * 单实例启动锁。拿到返回 acquired=true；没拿到说明已有实例在运行。
 * 用 pid 存活做回收：上次被强杀（taskkill /f、断电）留下的锁文件不会把应用永久锁死。
 */
export function acquireLaunchLock(name = 'workbench'): LaunchLock {
  const dir = lockDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 锁目录建不了也不阻塞启动 */
  }
  const file = path.join(dir, `${name}.lock`)

  for (let i = 0; i < 3; i++) {
    try {
      const fd = fs.openSync(file, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8')
      fs.closeSync(fd)
      return { acquired: true, file }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return { acquired: true, file }
      // 已有锁：看占用者是否还活着
      let holder = 0
      try {
        holder = Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid) || 0
      } catch {
        holder = 0
      }
      if (holder && holder !== process.pid && alive(holder)) {
        return { acquired: false, file }
      }
      // 占用者已死（被强杀/重启过），回收锁文件再抢一次
      try {
        fs.unlinkSync(file)
      } catch {
        /* 别人先删了 */
      }
    }
  }
  return { acquired: false, file }
}

export function releaseLaunchLock(lock: LaunchLock | null): void {
  if (!lock?.acquired) return
  try {
    const holder = Number(JSON.parse(fs.readFileSync(lock.file, 'utf8')).pid) || 0
    if (holder === process.pid) fs.unlinkSync(lock.file)
  } catch {
    /* 已经没了就算了 */
  }
}

/**
 * 清掉旧版本解压目录：只处理 %TEMP%\Workbench-<x.y.z> 这种形状的目录，
 * 且只在对应进程没在跑、也不是当前这份 exe 所在的目录时才删。
 * 当前 exe 若正好跑在解压目录里（portable 就是），跳过它自己。
 */
export function cleanOldUnpackDirs(keepVersion: string): string[] {
  const removed: string[] = []
  const tmp = os.tmpdir()
  const selfDir = path.dirname(process.execPath).toLowerCase()
  let names: string[] = []
  try {
    names = fs.readdirSync(tmp)
  } catch {
    return removed
  }

  for (const name of names) {
    // 认两种形状，别的一律不碰（避免误删用户的普通文件夹）：
    //  · Workbench-1.2.3 → 带版本号的新命名（1.3.0 起，各版本互不干扰）
    //  · Workbench       → 1.3.0 以前的固定名，正是别人机器上报 ENOENT 的元凶
    if (name !== 'Workbench' && !/^Workbench-\d+\.\d+\.\d+$/.test(name)) continue
    if (name === `Workbench-${keepVersion}`) continue
    const full = path.join(tmp, name)
    if (full.toLowerCase() === selfDir || selfDir.startsWith(full.toLowerCase() + path.sep)) continue
    let st: fs.Stats
    try {
      st = fs.statSync(full)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    // 目录里那份 exe 若正被进程占用（Windows 上运行中的 exe 无法独占打开），就跳过不删
    const exe = path.join(full, 'Workbench.exe')
    if (isFileBusy(exe)) continue
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      removed.push(full)
    } catch {
      /* 被占用就下次再删，绝不强删 */
    }
  }
  return removed
}

/**
 * 文件是否正被别的进程占用。
 * Windows 上正在运行的 exe 不允许以写方式独占打开，能打开就说明没在跑。
 * 目录不存在 → 不算忙（可以删）。
 */
function isFileBusy(file: string): boolean {
  if (!fs.existsSync(file)) return false
  try {
    const fd = fs.openSync(file, 'r+')
    fs.closeSync(fd)
    return false
  } catch {
    return true
  }
}