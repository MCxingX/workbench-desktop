import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import fs from 'node:fs'
import path from 'node:path'
import { getMasterKey, encryptBuffer, decryptBuffer, sha256 } from './crypto'

const DB_FILE = 'workbench.db.enc'

let SQL: SqlJsStatic | null = null
let db: Database | null = null
let key: Buffer | null = null
let dbPath = ''
let dirty = false
let persistTimer: NodeJS.Timeout | null = null
let persistCount = 0

/** schema 版本化迁移，只增不改（对照 docs/04） */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS shift_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkins (
        day TEXT PRIMARY KEY,
        marked_at TEXT,
        is_backfill INTEGER NOT NULL DEFAULT 0,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        done_at TEXT,
        created_at TEXT NOT NULL,
        due_at TEXT,
        category TEXT,
        priority INTEGER,
        source TEXT,
        note TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS ix_todos_done ON todos(done_at);
      CREATE INDEX IF NOT EXISTS ix_todos_order ON todos(sort_order);

      CREATE TABLE IF NOT EXISTS worklog (
        id TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        at TEXT NOT NULL,
        text TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'note',
        todo_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_worklog_day ON worklog(day, at);

      CREATE TABLE IF NOT EXISTS knowledge_entries (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        conclusion TEXT NOT NULL,
        scope TEXT,
        source_text TEXT,
        day TEXT,
        tags TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paste_jobs (
        id TEXT PRIMARY KEY,
        raw_text TEXT NOT NULL,
        result_json TEXT,
        accepted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT
      );
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pomodoros (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        minutes INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        todo_id TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_pomodoro_day ON pomodoros(started_at);

      CREATE TABLE IF NOT EXISTS clipboard_log (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        at TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0
      );
    `
  }
]

function resolveWasm(): string {
  const resolved = require.resolve('sql.js/dist/sql-wasm.wasm')
  return resolved.includes('app.asar') ? resolved.replace('app.asar', 'app.asar.unpacked') : resolved
}

export async function openStore(dataDir: string): Promise<void> {
  if (db) return
  SQL = await initSqlJs({ locateFile: () => resolveWasm() })
  key = getMasterKey()
  dbPath = path.join(dataDir, DB_FILE)

  if (fs.existsSync(dbPath)) {
    const payload = fs.readFileSync(dbPath)
    try {
      db = new SQL.Database(new Uint8Array(decryptBuffer(payload, key)))
    } catch (err) {
      const bak = dbPath + '.bak'
      if (fs.existsSync(bak)) {
        const backup = fs.readFileSync(bak)
        db = new SQL.Database(new Uint8Array(decryptBuffer(backup, key)))
        audit('db:fallback-bak', '主文件损坏，已回退 .bak')
      } else {
        throw new Error(`数据文件解密失败：${(err as Error).message}`)
      }
    }
  } else {
    db = new SQL.Database()
  }

  migrate()
  persistNow()
}

function migrate(): void {
  if (!db) throw new Error('数据库未打开')
  db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const rows = query<{ version: number }>('SELECT version FROM schema_migrations')
  const applied = new Set(rows.map((r) => r.version))
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    db.run('BEGIN')
    try {
      db.exec(m.sql)
      db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [m.version, new Date().toISOString()])
      db.run('COMMIT')
      audit('db:migrate', `升级到 v${m.version}`)
    } catch (err) {
      db.run('ROLLBACK')
      throw new Error(`迁移 v${m.version} 失败：${(err as Error).message}`)
    }
  }
}

export function isOpen(): boolean {
  return db !== null
}

export function dataFilePath(): string {
  return dbPath
}

export function query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
  if (!db) throw new Error('数据库未打开')
  const stmt = db.prepare(sql)
  try {
    if (params && params.length > 0) stmt.bind(params)
    const out: T[] = []
    while (stmt.step()) out.push(stmt.getAsObject() as T)
    return out
  } finally {
    stmt.free()
  }
}

export function run(sql: string, params?: unknown[]): void {
  if (!db) throw new Error('数据库未打开')
  db.run(sql, params)
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

let lastGoodBytes: Buffer | null = null
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

/** 落盘：export → 加密 → tmp → rename（保留上一版为 .bak） */
export function persistNow(): { ok: boolean; error?: string } {
  if (!db || !key || !dbPath) return { ok: false, error: '库未打开' }
  try {
    const bytes = Buffer.from(db.export())
    const payload = encryptBuffer(bytes, key)
    const tmp = dbPath + '.tmp'
    fs.writeFileSync(tmp, payload)
    // .bak 用"上一次成功落盘的字节"，绝不再读磁盘当前文件：
    // 否则主文件已损坏时会把坏文件写进 .bak，把唯一能回退的副本也毁掉
    if (lastGoodBytes) fs.writeFileSync(dbPath + '.bak', lastGoodBytes)
    fs.renameSync(tmp, dbPath)
    lastGoodBytes = payload
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
    lastGoodBytes = null
    await openStore(dataDir)
    return true
  } catch (err) {
    console.error('[store] reopen failed', (err as Error).message)
    return false
  }
}

