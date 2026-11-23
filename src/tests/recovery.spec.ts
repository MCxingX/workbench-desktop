import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isPasswordKeyBlob,
  orphanStamp,
  planOrphanRenames,
  scanDataDir,
  unwrapKeyWithPassword,
  wrapKeyWithPassword
} from '@shared/db/recovery'

const tmpDirs: string[] = []
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rec-'))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('密码保护主密钥', () => {
  const key = crypto.randomBytes(32)

  it('包裹后能原样解开', () => {
    const blob = wrapKeyWithPassword(key, '我的密码123')
    expect(isPasswordKeyBlob(blob)).toBe(true)
    expect(unwrapKeyWithPassword(blob, '我的密码123')?.equals(key)).toBe(true)
  })

  it('密码错解不开，且不抛异常', () => {
    const blob = wrapKeyWithPassword(key, 'right')
    expect(unwrapKeyWithPassword(blob, 'wrong')).toBe(null)
  })

  it('被改过的密文解不开（GCM 防篡改）', () => {
    const blob = wrapKeyWithPassword(key, 'right')
    const tampered = Buffer.from(blob)
    tampered[tampered.length - 1] ^= 0xff
    expect(unwrapKeyWithPassword(tampered, 'right')).toBe(null)
  })

  it('不是本格式的数据直接拒绝', () => {
    expect(unwrapKeyWithPassword(Buffer.from('random bytes here .....................'), 'x')).toBe(null)
    expect(isPasswordKeyBlob(Buffer.from('WBDB1234'))).toBe(false)
  })
})

describe('scanDataDir', () => {
  it('能认出库、备份、三种密钥副本', () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, 'workbench.db.enc'), Buffer.alloc(2048))
    fs.writeFileSync(path.join(d, 'workbench.db.enc.bak'), Buffer.alloc(1024))
    fs.writeFileSync(path.join(d, 'master.key'), crypto.randomBytes(75))
    fs.writeFileSync(path.join(d, 'master.key.copy'), crypto.randomBytes(75))
    fs.writeFileSync(path.join(d, 'master.key.pwd'), wrapKeyWithPassword(crypto.randomBytes(32), 'pw'))
    fs.mkdirSync(path.join(d, 'backups'))
    fs.writeFileSync(path.join(d, 'backups', 'auto-2026-11-23.wbk'), Buffer.alloc(512))

    const s = scanDataDir(d)
    expect(s.db?.size).toBe(2048)
    expect(s.dbBak?.size).toBe(1024)
    expect(s.keyFiles.map((k) => k.name).sort()).toEqual(['master.key', 'master.key.copy', 'master.key.pwd'])
    expect(s.keyFiles.find((k) => k.name === 'master.key.pwd')?.passwordProtected).toBe(true)
    expect(s.keyFiles.find((k) => k.name === 'master.key')?.passwordProtected).toBe(false)
    expect(s.backups.length).toBe(1)
  })

  it('空目录不报错，全返回 null/空', () => {
    const s = scanDataDir(tmp())
    expect(s.db).toBe(null)
    expect(s.keyFiles).toEqual([])
    expect(s.backups).toEqual([])
  })
})

describe('重建空库的留档计划', () => {
  it('只列存在的文件，改名带时间戳，绝不删除', () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, 'workbench.db.enc'), 'x')
    const plan = planOrphanRenames(d, orphanStamp(new Date(2026, 10, 23, 15, 30, 5)))
    expect(plan.length).toBe(1)
    expect(plan[0].to.endsWith('.orphan-20261123-153005')).toBe(true)
    expect(fs.existsSync(plan[0].from)).toBe(true) // 只出计划，不动文件
  })

  it('文件不存在时计划为空', () => {
    expect(planOrphanRenames(tmp(), '20260101-000000').length).toBe(0)
  })
})
