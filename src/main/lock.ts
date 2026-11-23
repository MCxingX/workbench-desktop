import { scryptHash, randomSalt } from './crypto'
import { query, run, audit } from './store'

const SALT = 'lockSalt'
const HASH = 'lockHash'
const ENABLED = 'lockEnabled'
const AUTO_MIN = 'autoLockMinutes'
const RECOVERY_HASH = 'lockRecoveryHash'
const FAILURES = 'lockFailures'
const LOCK_AT = 'lockAt'
export const MAX_ATTEMPTS_BEFORE_DELAY = 5

function get(key: string): string | null {
  const rows = query<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
  return rows.length > 0 ? rows[0].value : null
}

function put(key: string, value: string): void {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
}

export interface LockState {
  enabled: boolean
  autoLockMinutes: number
  /** 本次会话是否处于锁定 */
  locked: boolean
  /** 连续失败次数（成功后清零） */
  failures: number
}

let locked = false
let failures = 0
let lockAt = 0
let loaded = false

/**
 * 失败次数/冷却时刻从库里惰性读取。
 * 绝不能在模块顶层读：lock 模块在 openStore() 之前就被 import 了，
 * 顶层 query() 会抛"数据库未打开"，整个应用起不来。
 */
function ensureLoaded(): void {
  if (loaded) return
  try {
    failures = Number(get(FAILURES) ?? '0') || 0
    lockAt = Number(get(LOCK_AT) ?? '0') || 0
    loaded = true
  } catch {
    loaded = false
  }
}

export function lockState(): LockState {
  ensureLoaded()
  return {
    enabled: get(ENABLED) === '1',
    autoLockMinutes: Number(get(AUTO_MIN) ?? '10'),
    locked,
    failures
  }
}

/** 开锁屏：密码只存 scrypt 派生值，明文不落盘 */
export function setPassword(password: string): LockState {
  if (password.length < 4) throw new Error('密码至少 4 位')
  const salt = randomSalt()
  put(SALT, salt.toString('hex'))
  put(HASH, scryptHash(password, salt))
  put(ENABLED, '1')
  // 换密码就作废旧恢复码，否则上一把钥匙永远能开这把锁
  put(RECOVERY_HASH, '')
  locked = false
  failures = 0
  loaded = true
  put(FAILURES, '0')
  audit('lock:set')
  return lockState()
}

export function changePassword(oldPw: string, newPw: string): LockState {
  if (!verify(oldPw)) throw new Error('原密码不对')
  return setPassword(newPw)
}

export function disableLock(password: string): LockState {
  if (!verify(password)) throw new Error('密码不对，无法关闭')
  put(ENABLED, '0')
  put(HASH, '')
  put(SALT, '')
  put(RECOVERY_HASH, '')
  locked = false
  failures = 0
  put(FAILURES, '0')
  audit('lock:disable')
  return lockState()
}

export function setAutoLockMinutes(min: number): LockState {
  put(AUTO_MIN, String(Math.max(0, Math.min(120, Math.round(min)))))
  return lockState()
}

function verify(password: string): boolean {
  const saltHex = get(SALT)
  const hash = get(HASH)
  if (!saltHex || !hash) return false
  return scryptHash(password, Buffer.from(saltHex, 'hex')) === hash
}

export function lockNow(): LockState {
  if (get(ENABLED) !== '1') return lockState()
  ensureLoaded()
  locked = true
  // 不重置 lockAt：原来的写法一开一锁就能把 30s 冷却清零
  audit('lock:lock')
  return lockState()
}

/** 解锁：失败累计到阈值后强制等待，防止穷举 */
export function unlock(password: string): { ok: boolean; state: LockState; retryAfterMs: number } {
  ensureLoaded()
  if (!locked) return { ok: true, state: lockState(), retryAfterMs: 0 }
  const wait = failures >= MAX_ATTEMPTS_BEFORE_DELAY ? Math.max(0, 30_000 - (Date.now() - lockAt)) : 0
  if (wait > 0) return { ok: false, state: lockState(), retryAfterMs: wait }

  if (verify(password)) {
    locked = false
    failures = 0
    put(FAILURES, '0')
    audit('lock:unlock')
    return { ok: true, state: lockState(), retryAfterMs: 0 }
  }
  failures++
  lockAt = Date.now()
  // 落库：杀进程重启后冷却和失败次数不能凭空清零
  put(FAILURES, String(failures))
  put(LOCK_AT, String(lockAt))
  audit('lock:fail', `failures=${failures}`)
  return { ok: false, state: lockState(), retryAfterMs: failures >= MAX_ATTEMPTS_BEFORE_DELAY ? 30_000 : 0 }
}

export function resetFailures(): void {
  failures = 0
}

// ── 恢复码：忘记密码时用它重置，避免被彻底锁在门外 ──

const RECOVERY_HINT = 'lockRecoveryHint'

function randomCode(): string {
  const raw = randomSalt().toString('hex').toUpperCase()
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`
}

/** 生成一次性恢复码（明文只在本次返回，库里只存 scrypt 派生值） */
export function issueRecoveryCode(password: string): { code: string } {
  if (!verify(password)) throw new Error('密码不对')
  const code = randomCode()
  const salt = randomSalt()
  put(RECOVERY_HASH, `${salt.toString('hex')}:${scryptHash(code, salt)}`)
  audit('lock:recovery-issued')
  return { code }
}

export function hasRecoveryCode(): boolean {
  return (get(RECOVERY_HASH) ?? '').length > 0
}

export function recoveryHint(): string | null {
  return get(RECOVERY_HINT)
}

export function setRecoveryHint(text: string): void {
  put(RECOVERY_HINT, text.slice(0, 60))
}

/** 用恢复码重置密码；成功后恢复码立即换新 */
export function resetByRecovery(code: string, newPassword: string): { state: LockState; newCode: string } {
  const stored = get(RECOVERY_HASH)
  if (!stored) throw new Error('还没有生成过恢复码')
  const [saltHex, hash] = stored.split(':')
  if (!saltHex || !hash) throw new Error('恢复码已损坏')
  if (scryptHash(code.trim().toUpperCase(), Buffer.from(saltHex, 'hex')) !== hash) {
    audit('lock:recovery-fail')
    throw new Error('恢复码不对')
  }
  const state = setPassword(newPassword)
  const fresh = issueRecoveryCode(newPassword)
  audit('lock:recovery-used')
  return { state, newCode: fresh.code }
}


