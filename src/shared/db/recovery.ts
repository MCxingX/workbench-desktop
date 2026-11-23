/**
 * 数据救援：密钥密码保护 + 目录体检 + 重建空库时的留档计划。
 *
 * 三条硬规矩（对应"绝不丢数据"）：
 * 1. 任何"重建"都只是**改名留档**，绝不 unlink 用户的库文件。
 * 2. 密码不能凭空解密 —— 只有用户主动开启"密码保护密钥"后，才存在可用密码解开的密钥副本。
 * 3. 体检只读文件，不改任何东西。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PWD_MAGIC = Buffer.from('WBKP')
const VERSION = 1
const KEY_BYTES = 32

/** 用密码包裹主密钥：scrypt 派生 KEK，AES-256-GCM 加密 */
export function wrapKeyWithPassword(key: Buffer, password: string): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('主密钥长度不对')
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const kek = crypto.scryptSync(password, salt, KEY_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv)
  const body = Buffer.concat([cipher.update(key), cipher.final()])
  return Buffer.concat([PWD_MAGIC, Buffer.from([VERSION]), salt, iv, cipher.getAuthTag(), body])
}

/** 密码解出主密钥；密码错返回 null（不抛） */
export function unwrapKeyWithPassword(blob: Buffer, password: string): Buffer | null {
  try {
    if (blob.length < 4 + 1 + 16 + 12 + 16) return null
    if (!blob.subarray(0, 4).equals(PWD_MAGIC)) return null
    const ver = blob[4]
    if (ver !== VERSION) return null
    let off = 5
    const salt = blob.subarray(off, (off += 16))
    const iv = blob.subarray(off, (off += 12))
    const tag = blob.subarray(off, (off += 16))
    const body = blob.subarray(off)
    const kek = crypto.scryptSync(password, salt, KEY_BYTES)
    const d = crypto.createDecipheriv('aes-256-gcm', kek, iv)
    d.setAuthTag(tag)
    const key = Buffer.concat([d.update(body), d.final()])
    return key.length === KEY_BYTES ? key : null
  } catch {
    return null
  }
}

export function isPasswordKeyBlob(blob: Buffer): boolean {
  return blob.length > 33 && blob.subarray(0, 4).equals(PWD_MAGIC)
}

export interface DirScan {
  dataDir: string
  db: { path: string; size: number } | null
  dbBak: { path: string; size: number } | null
  keyFiles: { name: string; path: string; size: number; passwordProtected: boolean }[]
  backups: { name: string; path: string; size: number; mtime: string }[]
}

/** 只读体检：库文件、备份文件、各种密钥副本各是什么状态 */
export function scanDataDir(dataDir: string): DirScan {
  const stat = (p: string): { path: string; size: number } | null => {
    try {
      const s = fs.statSync(p)
      return s.isFile() ? { path: p, size: s.size } : null
    } catch {
      return null
    }
  }

  const keyNames = ['master.key', 'master.key.copy', 'master.key.pwd']
  const keyFiles: DirScan['keyFiles'] = []
  for (const name of keyNames) {
    const p = path.join(dataDir, name)
    const s = stat(p)
    if (!s) continue
    let passwordProtected = false
    try {
      passwordProtected = isPasswordKeyBlob(fs.readFileSync(p))
    } catch {
      passwordProtected = false
    }
    keyFiles.push({ name, path: p, size: s.size, passwordProtected })
  }

  const backupsDir = path.join(dataDir, 'backups')
  let backups: DirScan['backups'] = []
  try {
    backups = fs
      .readdirSync(backupsDir)
      .filter((f) => f.endsWith('.wbk') || f.endsWith('.wbak') || f.endsWith('.zip') || f.endsWith('.bak'))
      .map((name) => {
        const p = path.join(backupsDir, name)
        const s = fs.statSync(p)
        return { name, path: p, size: s.size, mtime: s.mtime.toISOString() }
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
  } catch {
    backups = []
  }

  return {
    dataDir,
    db: stat(path.join(dataDir, 'workbench.db.enc')),
    dbBak: stat(path.join(dataDir, 'workbench.db.enc.bak')),
    keyFiles,
    backups
  }
}

/**
 * 重建空库前的留档计划：把现在的库文件改名成 *.orphan-<时间>。
 * 只返回计划，不执行 —— 执行在 main 层，方便测试与预览"到底会留住什么"。
 */
export function planOrphanRenames(dataDir: string, stamp: string, extra: string[] = []): { from: string; to: string }[] {
  const names = ['workbench.db.enc', 'workbench.db.enc.bak', ...extra]
  const out: { from: string; to: string }[] = []
  for (const name of names) {
    const from = path.join(dataDir, name)
    if (!fs.existsSync(from)) continue
    out.push({ from, to: `${from}.orphan-${stamp}` })
  }
  return out
}

/** 时间戳：用于留档后缀，文本安全 */
export function orphanStamp(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}
