/**
 * schema 迁移：幂等、可测试、失败不炸库。
 *
 * 两条铁律（这两条以前都踩过）：
 * 1. 加列前必须查列：`ALTER TABLE ... ADD COLUMN` 没有 IF NOT EXISTS，重复执行就 duplicate column。
 * 2. 登记版本必须 `INSERT OR REPLACE`：同一版本号写两次就 UNIQUE constraint。
 *
 * 这里不 import electron、不 import store，纯逻辑 + sql.js 的 exec/run 接口，
 * 所以单测里可以直接造一个 sql.js 数据库跑三种状态（新库 / 老库 / 半坏库）。
 */

export interface SqlDb {
  exec(sql: string): { columns: string[]; values: unknown[][] }[]
  run(sql: string, params?: unknown[]): unknown
}

export interface Migration {
  version: number
  /** 人话说明，写进 audit_log */
  name: string
  apply: (db: SqlDb) => void
  /** 可选迁移：失败只记日志，不让整个库打不开（纯加列这类） */
  optional?: boolean
}

/** 该表是否已有这一列 */
export function hasColumn(db: SqlDb, table: string, column: string): boolean {
  const res = db.exec(`PRAGMA table_info(${table})`)
  if (!res || res.length === 0) return false
  const idx = res[0].columns.indexOf('name')
  if (idx < 0) return false
  return res[0].values.some((row) => row[idx] === column)
}

/** v1：基础表 */
const V1 = `
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

/** v2：便签 / 番茄钟 / 剪贴板 */
const V2 = `
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

/** v4：学出来的规则表（分类/时间/正则），可编辑、可关闭、可删 */
const V4 = `
  CREATE TABLE IF NOT EXISTS learned_rules (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    pattern TEXT NOT NULL,
    value TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    manual INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_rules_kind ON learned_rules(kind, enabled);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_rules_kind_pattern ON learned_rules(kind, pattern);
`

export const MIGRATIONS: Migration[] = [
  { version: 1, name: '基础表', apply: (db) => db.exec(V1) },
  { version: 2, name: '便签与番茄钟', apply: (db) => db.exec(V2) },
  {
    version: 3,
    name: '待办循环列',
    optional: true,
    apply: (db) => {
      // 已有这一列（老库手工加过 / 坏版本跑过一半）就不再动
      if (!hasColumn(db, 'todos', 'repeat')) db.exec('ALTER TABLE todos ADD COLUMN repeat TEXT')
    }
  },
  { version: 4, name: '学出来的规则', apply: (db) => db.exec(V4) }
]

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

function readApplied(db: SqlDb): Set<number> {
  try {
    const res = db.exec('SELECT version FROM schema_migrations')
    if (!res || res.length === 0) return new Set()
    return new Set(res[0].values.map((row) => Number(row[0])))
  } catch {
    return new Set()
  }
}

export interface MigrateOptions {
  /** 每成功升级一个版本回调一次（用来写 audit_log） */
  onApplied?: (m: Migration) => void
  /** 可选迁移失败时的回调（默认 console.warn） */
  onOptionalFail?: (m: Migration, err: Error) => void
}

/**
 * 跑迁移。返回本次真正执行过的版本号。
 * 关键点：applied 集合在循环里**逐个累加**，不是开头查一次 —— 否则同一版本写两遍就 UNIQUE。
 */
export function runMigrations(db: SqlDb, opts: MigrateOptions = {}): number[] {
  db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const applied = readApplied(db)
  const done: number[] = []

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    db.run('BEGIN')
    try {
      m.apply(db)
      db.run('INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)', [m.version, new Date().toISOString()])
      db.run('COMMIT')
      applied.add(m.version)
      done.push(m.version)
      opts.onApplied?.(m)
    } catch (err) {
      try {
        db.run('ROLLBACK')
      } catch {
        // 回滚都失败说明连接本身有问题，交给上层
      }
      const e = err instanceof Error ? err : new Error(String(err))
      if (m.optional) {
        const warn = opts.onOptionalFail ?? ((mm, ee) => console.warn(`[db] 可选迁移 v${mm.version} 跳过：${ee.message}`))
        warn(m, e)
        continue
      }
      throw new Error(`迁移 v${m.version}（${m.name}）失败：${e.message}`)
    }
  }

  return done
}
