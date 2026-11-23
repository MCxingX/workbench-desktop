import { app, safeStorage } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MAGIC = Buffer.from('WBDB')
const VERSION = 1
const KEY_BYTES = 32

/**
 * 密钥位置。测试（WB_DATA_DIR）时跟着隔离目录走，绝不碰用户真实密钥。
 */
export function keyFilePath(): string {
  const override = process.env.WB_DATA_DIR?.trim()
  if (override) return path.join(override, 'master.key')
  return path.join(app.getPath('appData'), 'Workbench', 'master.key')
}

/**
 * 主密钥：随机 32 字节，由系统钥匙串（Windows DPAPI / macOS Keychain）包裹后落盘。
 * 密码不参与派生 —— 忘记密码也不会丢数据（用恢复密钥或重置应用锁）。
 */
export function getMasterKey(): Buffer {
  const file = keyFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })

  if (fs.existsSync(file)) {
    const wrapped = fs.readFileSync(file)
    // 兼容两种历史形态：DPAPI 包裹过的 base64，或（当年钥匙串不可用时）裸 32 字节
    if (wrapped.length === KEY_BYTES) return wrapped
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return Buffer.from(safeStorage.decryptString(wrapped), 'base64')
      }
      return wrapped
    } catch {
      throw new Error('主密钥无法解密：系统钥匙串环境已变化，请用备份恢复数据')
    }
  }

  const key = crypto.randomBytes(KEY_BYTES)
  const payload = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(key.toString('base64'))
    : key
  fs.writeFileSync(file, payload, { mode: 0o600 })
  return key
}

/** AES-256-GCM 加密：magic(4) + version(1) + iv(12) + tag(16) + ciphertext */
export function encryptBuffer(plain: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, tag, body])
}

export function decryptBuffer(payload: Buffer, key: Buffer): Buffer {
  if (payload.length < 4 + 1 + 12 + 16) throw new Error('文件太短，不是有效的数据文件')
  if (!payload.subarray(0, 4).equals(MAGIC)) throw new Error('文件头不匹配，不是工作台数据文件')
  const version = payload[4]
  if (version !== VERSION) throw new Error(`数据文件版本 ${version} 不受支持`)
  const iv = payload.subarray(5, 17)
  const tag = payload.subarray(17, 33)
  const body = payload.subarray(33)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function scryptHash(password: string, salt: Buffer): string {
  // N=32768,r=8 需要 ~33MB，必须放宽 maxmem，否则 OpenSSL 直接 MEMORY_LIMIT_EXCEEDED
  return crypto.scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }).toString('hex')
}

export function randomSalt(): Buffer {
  return crypto.randomBytes(16)
}

/** 打码：把明显的密钥/令牌/手机号遮掉，用于"打码导出" */
export function redact(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED_KEY]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,})/g, '[REDACTED_TOKEN]')
    .replace(/\b(1[3-9]\d{9})\b/g, (m) => m.slice(0, 3) + '****' + m.slice(7))
    .replace(/\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (m, u: string, d: string) => {
      const keep = u.slice(0, 2)
      return `${keep}***@${d}`
    })
}
