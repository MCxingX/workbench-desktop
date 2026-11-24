import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireLaunchLock, cleanOldUnpackDirs, releaseLaunchLock } from '../main/single-instance'

const madeDirs: string[] = []

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  madeDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of madeDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  }
})

describe('启动器互斥锁', () => {
  it('第一次拿得到，第二次在同一个 pid 下也拿得到（同一进程不算冲突）', () => {
    const name = `selftest-${Date.now()}-a`
    const a = acquireLaunchLock(name)
    expect(a.acquired).toBe(true)
    // 同一进程重复获取：锁文件里的 pid 就是自己，判定为可回收
    const b = acquireLaunchLock(name)
    expect(b.acquired).toBe(true)
    releaseLaunchLock(b)
    releaseLaunchLock(a)
  })

  it('占用者已死（被强杀）时能回收锁，不会把应用永久锁死', () => {
    const name = `selftest-${Date.now()}-b`
    const dir = path.join(os.tmpdir(), 'workbench-launcher-locks')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${name}.lock`)
    // 造一个"上次被 taskkill /f、锁没释放"的状态：一个几乎不可能存活的 pid
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, at: '2020-01-01T00:00:00.000Z' }), 'utf8')

    const got = acquireLaunchLock(name)
    expect(got.acquired).toBe(true)
    releaseLaunchLock(got)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('活着的占用者会挡住后来者', () => {
    const name = `selftest-${Date.now()}-c`
    const dir = path.join(os.tmpdir(), 'workbench-launcher-locks')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${name}.lock`)
    // 用当前进程的 pid 冒充"另一个活着的实例"：拿锁时 holder !== process.pid 才判冲突，
    // 所以这里换成一个确定活着的其它 pid（父进程）
    const alivePid = process.ppid || 1
    fs.writeFileSync(file, JSON.stringify({ pid: alivePid, at: '2026-01-01T00:00:00.000Z' }), 'utf8')

    const got = acquireLaunchLock(name)
    expect(got.acquired).toBe(false)
    fs.rmSync(file, { force: true })
  })
})

describe('清理旧版本解压目录', () => {
  it('只删 Workbench-x.y.z 形状的目录，别的一律不碰', () => {
    const tmp = os.tmpdir()
    const old = path.join(tmp, 'Workbench-0.0.1')
    const keep = path.join(tmp, 'Workbench-9.9.9')
    const userDir = path.join(tmp, `我的资料-${Date.now()}`)
    for (const d of [old, keep, userDir]) {
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'note.txt'), 'x', 'utf8')
    }
    madeDirs.push(old, keep, userDir)

    const removed = cleanOldUnpackDirs('9.9.9')
    expect(removed).toContain(old)
    expect(fs.existsSync(old)).toBe(false)
    // 当前版本目录保留
    expect(fs.existsSync(keep)).toBe(true)
    // 名字不匹配的普通目录绝不动
    expect(fs.existsSync(userDir)).toBe(true)
  })

  it('残缺的解压目录（有 resources 但没解全）会被清掉，这正是 ENOENT package.json 的来源', () => {
    const tmp = os.tmpdir()
    const broken = path.join(tmp, 'Workbench-0.0.2')
    fs.mkdirSync(path.join(broken, 'resources'), { recursive: true })
    // 模拟"连点两下同时解压、文件互相覆盖"留下的坏 asar
    fs.writeFileSync(path.join(broken, 'resources', 'app.asar'), Buffer.from([0, 0, 0, 0]))
    madeDirs.push(broken)

    const removed = cleanOldUnpackDirs('9.9.9')
    expect(removed).toContain(broken)
    expect(fs.existsSync(broken)).toBe(false)
  })

  it('1.3.0 以前的固定名 %TEMP%\\Workbench 也会被清掉（别人机器报错的元凶）', () => {
    const tmp = os.tmpdir()
    const legacy = path.join(tmp, 'Workbench')
    // 当前测试进程不在这个目录里跑（跑在仓库目录），所以它会被视为可清理
    if (fs.existsSync(legacy)) return // 真有目录就不动它，避免影响本机
    fs.mkdirSync(path.join(legacy, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'resources', 'app.asar'), Buffer.from([0, 0, 0, 0]))
    madeDirs.push(legacy)

    const removed = cleanOldUnpackDirs('9.9.9')
    expect(removed).toContain(legacy)
    expect(fs.existsSync(legacy)).toBe(false)
  })
})