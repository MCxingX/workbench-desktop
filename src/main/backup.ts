import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { keyFilePath, redact, sha256 } from './crypto'
import { exportBytes, persistNow, query } from './store'

const MAGIC = Buffer.from('WBK1')
const VERSION = 1

export interface BackupManifest {
  appVersion: string
  createdAt: string
  files: { name: string; size: number; sha256: string }[]
  note?: string
}

interface ContainerFile {
  name: string
  bytes: Buffer
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function collect(dataDir: string): ContainerFile[] {
  persistNow()
  const out: ContainerFile[] = []
  const dbFile = path.join(dataDir, 'workbench.db.enc')
  if (fs.existsSync(dbFile)) out.push({ name: 'workbench.db.enc', bytes: fs.readFileSync(dbFile) })
  const ui = path.join(dataDir, 'ui.json')
  if (fs.existsSync(ui)) out.push({ name: 'ui.json', bytes: fs.readFileSync(ui) })
  // 主密钥不在数据目录里（在 %APPDATA%\Workbench），不一起打包的话换机后备份解不开
  const keyFile = keyFilePath()
  if (fs.existsSync(keyFile)) out.push({ name: 'master.key', bytes: fs.readFileSync(keyFile) })
  return out
}

/** 生成备份容器（保持加密，不含明文数据库） */
export function createBackup(dataDir: string, targetFile: string, appVersion: string, note?: string): BackupManifest {
  const files = collect(dataDir)
  const manifest: BackupManifest = {
    appVersion,
    createdAt: new Date().toISOString(),
    files: files.map((f) => ({ name: f.name, size: f.bytes.length, sha256: sha256(f.bytes) })),
    note
  }

  const chunks: Buffer[] = [MAGIC, Buffer.from([VERSION]), u16(files.length)]
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    chunks.push(u16(nameBuf.length), nameBuf, u32(f.bytes.length), f.bytes)
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8')
  chunks.push(u32(manifestBuf.length), manifestBuf)

  fs.mkdirSync(path.dirname(targetFile), { recursive: true })
  fs.writeFileSync(targetFile, Buffer.concat(chunks))
  return manifest
}

export interface RestoreReport {
  manifest: BackupManifest
  restored: string[]
  preRestoreDir: string
}

/** 还原：先把现有文件挪到 pre-restore 目录，再写入备份内容 */
export function restoreBackup(dataDir: string, file: string): RestoreReport {
  const buf = fs.readFileSync(file)
  if (buf.length < 8 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('不是有效的备份文件（文件头不对）')
  const version = buf[4]
  if (version !== VERSION) throw new Error(`备份版本 ${version} 不受支持`)

  let off = 5
  const count = buf.readUInt16LE(off)
  off += 2
  const files: ContainerFile[] = []
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(off)
    off += 2
    const name = buf.subarray(off, off + nameLen).toString('utf8')
    off += nameLen
    const len = buf.readUInt32LE(off)
    off += 4
    files.push({ name, bytes: buf.subarray(off, off + len) })
    off += len
  }
  const manifestLen = buf.readUInt32LE(off)
  off += 4
  const manifest = JSON.parse(buf.subarray(off, off + manifestLen).toString('utf8')) as BackupManifest

  // 只允许还原这两个文件；名字要么在白名单里，要么直接拒绝（防路径穿越写启动项）
  const ALLOWED = new Set(['workbench.db.enc', 'ui.json', 'master.key'])
  for (const f of files) {
    if (!ALLOWED.has(f.name) || f.name !== path.basename(f.name)) {
      throw new Error(`备份里有不允许的文件名：${f.name}`)
    }
    const expect = manifest.files.find((m) => m.name === f.name)
    if (!expect) throw new Error(`备份清单里缺少 ${f.name}，拒绝还原`)
    if (expect.sha256 !== sha256(f.bytes)) throw new Error(`备份内 ${f.name} 校验失败，文件可能损坏`)
  }
  if (files.length === 0) throw new Error('备份里没有可还原的文件')

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const preDir = path.join(dataDir, `pre-restore-${stamp}`)
  fs.mkdirSync(preDir, { recursive: true })
  const restored: string[] = []
  for (const f of files) {
    const target = path.join(dataDir, f.name)
    if (path.dirname(path.resolve(target)) !== path.resolve(dataDir)) throw new Error('非法的还原路径')
    if (fs.existsSync(target)) fs.copyFileSync(target, path.join(preDir, f.name))
    fs.writeFileSync(target, f.bytes)
    restored.push(f.name)
  }

  return { manifest, restored, preRestoreDir: preDir }
}

/** 打码导出：明文 JSON，但把密钥/令牌/手机号/邮箱遮掉 */
export function exportRedacted(dataDir: string, targetFile: string): { rows: number; tables: string[] } {
  const tables = ['shift_profiles', 'todos', 'worklog', 'checkins', 'knowledge_entries', 'settings']
  const dump: Record<string, unknown[]> = {}
  let rows = 0
  for (const t of tables) {
    try {
      const data = query<Record<string, unknown>>(`SELECT * FROM ${t}`)
      dump[t] = data.map((r) => {
        const masked: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(r)) {
          masked[k] = typeof v === 'string' ? redact(v) : v
        }
        return masked
      })
      rows += data.length
    } catch {
      dump[t] = []
    }
  }
  fs.mkdirSync(path.dirname(targetFile), { recursive: true })
  fs.writeFileSync(targetFile, JSON.stringify({ exportedAt: new Date().toISOString(), tables: dump }, null, 2), 'utf8')
  return { rows, tables: Object.keys(dump) }
}

/** 迁移数据目录：复制 → 校验 → 返回新路径（bootstrap 由调用方改写，失败可回滚） */
export function copyDataDir(from: string, to: string): { files: number; verified: boolean } {
  fs.mkdirSync(to, { recursive: true })
  let files = 0
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) {
      const sub = copyDataDir(src, dst)
      files += sub.files
      continue
    }
    fs.copyFileSync(src, dst)
    files++
  }
  // 校验：逐文件大小一致 + 数据库文件哈希一致
  let verified = true
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (!fs.existsSync(dst) || fs.statSync(src).size !== fs.statSync(dst).size) {
      verified = false
      break
    }
    if (entry.name.endsWith('.db.enc') && sha256(fs.readFileSync(src)) !== sha256(fs.readFileSync(dst))) {
      verified = false
      break
    }
  }
  return { files, verified }
}

/** 供冒烟/自检用：库里有多少行 */
export function tableCounts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of ['shift_profiles', 'todos', 'worklog', 'checkins', 'knowledge_entries', 'audit_log']) {
    try {
      out[t] = query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`)[0].c
    } catch {
      out[t] = -1
    }
  }
  return out
}

export interface BackupFile {
  name: string
  path: string
  size: number
  at: string
}

export function listBackups(dataDir: string): BackupFile[] {
  const dir = path.join(dataDir, 'backups')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.wbk'))
    .map((f) => {
      const p = path.join(dir, f)
      const st = fs.statSync(p)
      return { name: f, path: p, size: st.size, at: st.mtime.toISOString() }
    })
    .sort((a, b) => b.at.localeCompare(a.at))
}

/** 每日自动备份：当天已有就跳过；超过 keep 份删最旧 */
export function autoBackup(
  dataDir: string,
  appVersion: string,
  keep = 7
): { created: boolean; file?: string; pruned: number } {
  const dir = path.join(dataDir, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const target = path.join(dir, `auto-${stamp}.wbk`)

  let created = false
  if (!fs.existsSync(target)) {
    createBackup(dataDir, target, appVersion, '每日自动备份')
    created = true
  }

  const files = listBackups(dataDir).filter((f) => f.name.startsWith('auto-'))
  let pruned = 0
  for (const f of files.slice(keep)) {
    fs.unlinkSync(f.path)
    pruned++
  }
  return { created, file: created ? target : undefined, pruned }
}

export { exportBytes }
