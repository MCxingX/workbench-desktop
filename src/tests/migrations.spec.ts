import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { LATEST_VERSION, MIGRATIONS, hasColumn, runMigrations, type SqlDb } from '@shared/db/migrations'

const require = createRequire(import.meta.url)

/** sql.js 在这个工程里没有 .d.ts，这里只用结构化的最小接口，避免类型依赖 */
interface SqlJsLike {
  Database: new (data?: Uint8Array) => SqlDb
}
let SQL: SqlJsLike

beforeAll(async () => {
  const init = require('sql.js') as (cfg: { locateFile: () => string }) => Promise<SqlJsLike>
  SQL = await init({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
})

const fresh = (): SqlDb => new SQL.Database()

const versions = (d: SqlDb): number[] => {
  const res = d.exec('SELECT version FROM schema_migrations ORDER BY version')
  return res.length ? res[0].values.map((row) => Number(row[0])) : []
}

/** 全部版本号，从迁移表里取，避免每次加版本都要改测试 */
const ALL = MIGRATIONS.map((m) => m.version).sort((a, b) => a - b)

describe('runMigrations', () => {
  it('新库一次跑完，三个版本都登记，repeat 列存在', () => {
    const d = fresh()
    const done = runMigrations(d)
    expect(done).toEqual(ALL)
    expect(versions(d)).toEqual(ALL)
    expect(hasColumn(d, 'todos', 'repeat')).toBe(true)
    expect(LATEST_VERSION).toBe(ALL.length)
  })

  it('v1 本身不带 repeat 列（加列只在 v3，避免重复 ALTER）', () => {
    const d = fresh()
    MIGRATIONS[0].apply(d)
    expect(hasColumn(d, 'todos', 'repeat')).toBe(false)
  })

  it('再跑一次什么都不做（幂等）', () => {
    const d = fresh()
    runMigrations(d)
    expect(runMigrations(d)).toEqual([])
    expect(versions(d)).toEqual(ALL)
  })

  it('老库（只有 v1/v2、没有 repeat 列）只补 v3', () => {
    const d = fresh()
    MIGRATIONS[0].apply(d)
    MIGRATIONS[1].apply(d)
    d.run('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    d.run("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 'x')")
    d.run("INSERT INTO schema_migrations (version, applied_at) VALUES (2, 'x')")

    expect(runMigrations(d)).toEqual([3, ...ALL.slice(3)])
    expect(hasColumn(d, 'todos', 'repeat')).toBe(true)
    expect(versions(d)).toEqual(ALL)
  })

  it('半坏库：repeat 列已存在但版本没登记 → 跳过 ALTER、补登记、不抛错', () => {
    const d = fresh()
    MIGRATIONS[0].apply(d)
    MIGRATIONS[1].apply(d)
    // 模拟"坏版本跑了一半"：列加了，但 v3 没写进 schema_migrations
    d.run('ALTER TABLE todos ADD COLUMN repeat TEXT')
    d.run('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    d.run("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 'x')")
    d.run("INSERT INTO schema_migrations (version, applied_at) VALUES (2, 'x')")

    expect(() => runMigrations(d)).not.toThrow()
    expect(runMigrations(d)).toEqual([])
    expect(versions(d)).toEqual(ALL)
  })

  it('版本登记丢了也不会撞 UNIQUE（INSERT OR REPLACE）', () => {
    const d = fresh()
    runMigrations(d)
    d.run('DELETE FROM schema_migrations WHERE version = 3')
    expect(() => runMigrations(d)).not.toThrow()
    expect(versions(d)).toEqual(ALL)
  })

  it('可选迁移失败不炸库（表都没了就 ALTER 不了）', () => {
    const d = fresh()
    MIGRATIONS[0].apply(d)
    MIGRATIONS[1].apply(d)
    d.run('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    d.run("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 'x')")
    d.run("INSERT INTO schema_migrations (version, applied_at) VALUES (2, 'x')")
    d.run('DROP TABLE todos')

    const warns: string[] = []
    expect(() => runMigrations(d, { onOptionalFail: (m, e) => warns.push(`v${m.version}:${e.message}`) })).not.toThrow()
    expect(warns.length).toBe(1)
    expect(warns[0].startsWith('v3:')).toBe(true)
    // 失败的版本（v3 可选）不登记，但它不阻塞打开，后面的迁移照常跑
    expect(versions(d)).not.toContain(3)
    expect(versions(d)).toContain(1)
    expect(versions(d)).toContain(2)
  })

  it('onApplied 按顺序回调，写审计用', () => {
    const d = fresh()
    const seen: number[] = []
    runMigrations(d, { onApplied: (m) => seen.push(m.version) })
    expect(seen).toEqual(ALL)
  })
})
