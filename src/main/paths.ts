import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface Bootstrap {
  dataDir: string
  version: number
  keyRef: string
  lastOpenedAt: string
}

export interface DataDirResolution {
  /** 实际使用的数据目录 */
  dir: string
  /** 目录不可用时的说明（null = 一切正常） */
  warn: string | null
}

const BOOTSTRAP_FILE = 'bootstrap.json'

/** C 盘只留这一个几百字节的引导文件 */
export function bootstrapPath(): string {
  return path.join(app.getPath('appData'), 'Workbench', BOOTSTRAP_FILE)
}

/** 默认数据目录：优先 D 盘（避免占用 C 盘），否则退回文档目录 */
export function defaultDataDir(): string {
  if (process.platform === 'win32') {
    if (fs.existsSync('D:\\')) return 'D:\\WorkbenchData'
  }
  return path.join(app.getPath('documents'), 'WorkbenchData')
}

export function readBootstrap(): Bootstrap | null {
  try {
    const raw = fs.readFileSync(bootstrapPath(), 'utf8')
    const parsed = JSON.parse(raw) as Bootstrap
    if (!parsed || typeof parsed.dataDir !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function writeBootstrap(b: Bootstrap): void {
  const p = bootstrapPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(b, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

export function ensureDataDir(dir: string): void {
  for (const sub of ['', 'backups', 'exports', 'logs', 'plugins', 'attachments']) {
    fs.mkdirSync(sub ? path.join(dir, sub) : dir, { recursive: true })
  }
}

/**
 * 解析数据目录。
 *
 * 铁律：**已经记录过的目录永不改指向**。
 * 以前这里是"目录不可用就换默认目录并重写引导文件"——只要 D 盘（移动硬盘 / 拔掉的盘 /
 * 权限被收走的目录）偶然不可用一次，指针就被永久改成新目录，用户看到的就是"每次启动
 * 都是空的、又要重新配"。宁可这次打不开，也不能把指针漂走。
 */
export function resolveDataDirInfo(): DataDirResolution {
  // 测试/冒烟专用：WB_DATA_DIR 指向临时目录时，完全不读也不写真实数据目录与引导文件
  const override = process.env.WB_DATA_DIR?.trim()
  if (override) {
    ensureDataDir(override)
    return { dir: override, warn: null }
  }

  const existing = readBootstrap()
  if (existing) {
    try {
      ensureDataDir(existing.dataDir)
      return { dir: existing.dataDir, warn: null }
    } catch (err) {
      // 只更新"最后打开时间"，目录一栏保持原样
      try {
        writeBootstrap({ ...existing, lastOpenedAt: new Date().toISOString() })
      } catch {
        /* 引导文件本身写不了也不影响本次启动 */
      }
      return {
        dir: existing.dataDir,
        warn: `数据目录 ${existing.dataDir} 暂时打不开：${(err as Error).message}`
      }
    }
  }

  const dir = defaultDataDir()
  ensureDataDir(dir)
  writeBootstrap({
    dataDir: dir,
    version: 1,
    keyRef: 'workbench/master-key-v1',
    lastOpenedAt: new Date().toISOString()
  })
  return { dir, warn: null }
}

export function resolveDataDir(): string {
  return resolveDataDirInfo().dir
}
