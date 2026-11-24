import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import fs from 'node:fs'
import path from 'node:path'
import { getMasterKey, keyFilePath, keyCandidates, encryptBuffer, decryptBuffer, sha256 } from './crypto'
import { runMigrations } from '../shared/db/migrations'

const DB_FILE = 'workbench.db.enc'

let SQL: SqlJsStatic | null = null
let db: Database | null = null
let key: Buffer | null = null
let dbPath = ''
let dirty = false
let persistTimer: NodeJS.Timeout | null = null
let persistCount = 0

function resolveWasm(): string {
  const resolved = require.resolve('sql.js/dist/sql-wasm.wasm')
  return resolved.includes('app.asar') ? resolved.replace('app.asar', 'app.asar.unpacked') : resolved
}

export async function openStore(dataDir: string): Promise<void> {
  if (db) return
  SQL = await initSqlJs({ locateFile: () => resolveWasm() })
  dbPath = path.join(dataDir, DB_FILE)

  // 密钥可能有三处：主位置（%APPDATA%）/ 数据目录 master.key / master.key.copy
  // 只要有一个能解开就用它 —— 钥匙放错地方不该等于数据打不开
  const candidates = keyCandidates(dataDir)

  if (fs.existsSync(dbPath)) {
    const payload = fs.readFileSync(dbPath)
    const bakPath = dbPath + '.bak'
    const backup = fs.existsSync(bakPath) ? fs.readFileSync(bakPath) : null

    if (candidates.length === 0) {
      throw new Error('数据文件解密失败：找不到任何主密钥（检查 %APPDATA%\\Workbench\\master.key、数据目录里的 master.key / master.key.copy）')
    }

    const lib = SQL
    const open = (buf: Buffer, k: Buffer): Database => new lib.Database(new Uint8Array(decryptBuffer(buf, k)))
    let opened: Database | null = null
    let usedPath = ''
    let usedKey: Buffer | null = null
    let fromBak = false

    for (const c of candidates) {
      try {
        opened = open(payload, c.key)
        usedPath = c.path
        usedKey = c.key
        break
      } catch {
        // 换下一个候选
      }
    }
    if (!opened && backup) {
      for (const c of candidates) {
        try {
          opened = open(backup, c.key)
          usedPath = c.path
          usedKey = c.key
          fromBak = true
          break
        } catch {
          // 换下一个候选
        }
      }
    }

    if (!opened || !usedKey) {
      throw new Error('数据文件解密失败：所有候选主密钥都不匹配（数据可能被别的机器/用户加密过，请用 backups 里的备份恢复）')
    }

    db = opened
    key = usedKey
    if (fromBak) audit('db:fallback-bak', '主文件损坏，已回退 .bak')

    // 用的是备用位置的钥匙：把它写回主位置，下次就不用再找
    const primary = keyFilePath()
    if (usedPath !== primary) {
      try {
        fs.mkdirSync(path.dirname(primary), { recursive: true })
        fs.copyFileSync(usedPath, primary)
        audit('db:key-rescued', `已用备用密钥打开，并写回 ${primary}`)
      } catch {
        // 写不进去也不影响本次打开
      }
    }
  } else {
    key = candidates[0]?.key ?? getMasterKey()
    db = new SQL.Database()
  }

  migrate()
  persistNow()
}

function migrate(): void {
  if (!db) throw new Error('数据库未打开')
  // 幂等迁移：加列前查列、登记用 INSERT OR REPLACE、可选迁移失败不炸库
  runMigrations(db, {
    onApplied: (m) => audit('db:migrate', `升级到 v${m.version}（${m.name}）`),
    onOptionalFail: (m, err) => {
      console.warn(`[db] 可选迁移 v${m.version} 跳过：${err.message}`)
      audit('db:migrate-skip', `v${m.version} ${m.name}：${err.message}`)
    }
  })
}

export function isOpen(): boolean {
  return db !== null
}

export function dataFilePath(): string {
  return dbPath
}

/**
 * sql.js 只认 string / number / null / Uint8Array。
 * IPC 传过来的 undefined、对象、布尔会直接抛 "tried to bind a value of an unknown type"，
 * 所以在绑定前统一收窄 —— 这类错误以前烧过一次，别再让它从 IPC 边界漏进来。
 */
function sanitize(params?: unknown[]): unknown[] | undefined {
  if (!params || params.length === 0) return undefined
  return params.map((v) => {
    if (v === undefined) return null
    if (v === null) return null
    if (typeof v === 'string' || typeof v === 'number') return v
    if (typeof v === 'boolean') return v ? 1 : 0
    if (v instanceof Uint8Array) return v
    if (v instanceof Buffer) return new Uint8Array(v)
    // 对象/数组：宁可存成 JSON 也不让绑定炸掉
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  })
}

export function query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
  if (!db) throw new Error('数据库未打开')
  const stmt = db.prepare(sql)
  try {
    const clean = sanitize(params)
    if (clean) stmt.bind(clean)
    const out: T[] = []
    while (stmt.step()) out.push(stmt.getAsObject() as T)
    return out
  } finally {
    stmt.free()
  }
}

export function run(sql: string, params?: unknown[]): void {
  if (!db) throw new Error('数据库未打开')
  db.run(sql, sanitize(params))
  markDirty()
}

export function exec(sql: string): void {
  if (!db) throw new Error('数据库未打开')
  db.exec(sql)
  markDirty()
}

export function transaction<T>(fn: () => T): T {
  if (!db) throw new Error('数据库未打开')
  db.run('BEGIN')
  try {
    const out = fn()
    db.run('COMMIT')
    markDirty()
    return out
  } catch (err) {
    db.run('ROLLBACK')
    throw err
  }
}

export function audit(kind: string, detail?: string): void {
  if (!db) return
  db.run('INSERT INTO audit_log (id, at, kind, detail) VALUES (?, ?, ?, ?)', [
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    new Date().toISOString(),
    kind,
    detail ?? null
  ])
  markDirty()
}

let lastPersistError: string | null = null
let persistErrorHandler: ((message: string) => void) | null = null

/** 落盘失败回调：主进程把它转成界面上的红条，用户才不会"点了没反应" */
export function onPersistError(cb: (message: string) => void): void {
  persistErrorHandler = cb
}

/** 库文件当前状态：文件在哪、多大、什么时候写的、有没有没落盘的改动 */
export function storeInfo(): { file: string; sizeBytes: number; mtime: string | null; lastError: string | null; dirty: boolean } {
  let size = 0
  let mtime: string | null = null
  try {
    if (dbPath && fs.existsSync(dbPath)) {
      const st = fs.statSync(dbPath)
      size = st.size
      mtime = st.mtime.toISOString()
    }
  } catch {
    /* 读不到就当没有 */
  }
  return { file: dbPath, sizeBytes: size, mtime, lastError: lastPersistError, dirty }
}

/** 最近一次落盘失败的原因（null = 正常） */
export function persistError(): string | null {
  return lastPersistError
}

function markDirty(): void {
  dirty = true
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    if (dirty) persistNow()
  }, 300)
}

/** 落盘：export → 加密 → 先备份上一版 → tmp → rename（保留上一版为 .bak） */
export function persistNow(): { ok: boolean; error?: string } {
  if (!db || !key || !dbPath) return { ok: false, error: '库未打开' }
  try {
    const bytes = Buffer.from(db.export())
    const payload = encryptBuffer(bytes, key)
    const tmp = dbPath + '.tmp'
    // 先把磁盘上当前这份（上一次成功落盘的库）推到 .bak：这是真正能回退的那一版。
    // 顺序不能反——先写 tmp 后备份的话，rename 已经换主文件，再备份读到的就是刚写的；
    // 主文件损坏时我们靠"上一次成功的那版"兜底，而不是靠再复制一遍坏文件。
    if (fs.existsSync(dbPath)) {
      try {
        fs.copyFileSync(dbPath, dbPath + '.bak')
      } catch {
        /* .bak 写不动不影响本次落盘 */
      }
    }
    fs.writeFileSync(tmp, payload)
    fs.renameSync(tmp, dbPath)
    dirty = false
    persistCount++
    lastPersistError = null
    return { ok: true }
  } catch (err) {
    // 磁盘满 / 目录被拔 / 杀软占用都会抛：不能让它冒泡到定时器里带走主进程
    lastPersistError = (err as Error).message
    console.error('[persist] 落盘失败：', lastPersistError)
    try {
      persistErrorHandler?.(lastPersistError + `（目标文件 ${dbPath}）`)
    } catch {
      /* 通知失败不影响主流程 */
    }
    return { ok: false, error: lastPersistError }
  }
}

export function persistStats(): { count: number; dirty: boolean; sizeBytes: number } {
  return {
    count: persistCount,
    dirty,
    sizeBytes: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0
  }
}

/** 备份用：拿到当前库的明文字节（调用方负责加密/打包） */
export function exportBytes(): Buffer {
  if (!db) throw new Error('数据库未打开')
  return Buffer.from(db.export())
}

export function hashOfDbFile(): string {
  return fs.existsSync(dbPath) ? sha256(fs.readFileSync(dbPath)) : ''
}

export function closeStore(): void {
  if (!db) return
  if (dirty) persistNow()
  db.close()
  db = null
}

/** 还原备份后必须重开：内存库不关，下一次落盘会把刚还原的文件覆盖回旧库 */
export async function reopenStore(dataDir: string): Promise<boolean> {
  try {
    closeStore()
    await openStore(dataDir)
    return true
  } catch (err) {
    console.error('[store] reopen failed', (err as Error).message)
    return false
  }
}

