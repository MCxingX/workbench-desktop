import fs from 'node:fs'
import path from 'node:path'
import { decryptBuffer, keyCandidates, keyFilePath, readKeyFile } from './crypto'
import { reopenStore } from './store'
import { restoreBackup } from './backup'
import { logInfo, logWarn } from './log'
import {
  orphanStamp,
  planOrphanRenames,
  scanDataDir,
  unwrapKeyWithPassword,
  wrapKeyWithPassword,
  type DirScan
} from '../shared/db/recovery'

export interface RecoveryDiagnosis {
  scan: DirScan
  /** 能解开库的密钥文件路径；null = 现有密钥都不匹配 */
  usableKey: string | null
  /** 库文件本身能不能读（能不能被某个密钥解开） */
  canOpen: boolean
  /** 有密码保护的密钥副本，可以输密码试 */
  pwdAvailable: boolean
  message: string
}

const dbFile = (dataDir: string): string => path.join(dataDir, 'workbench.db.enc')
const pwdFile = (dataDir: string): string => path.join(dataDir, 'master.key.pwd')

/** 用一组候选密钥试解库文件，返回能解开的那把（不写盘、不改动） */
function pickWorkingKey(dataDir: string): { path: string; key: Buffer } | null {
  const file = dbFile(dataDir)
  if (!fs.existsSync(file)) return null
  const payload = fs.readFileSync(file)
  for (const c of keyCandidates(dataDir)) {
    try {
      decryptBuffer(payload, c.key)
      return c
    } catch {
      // 换下一把
    }
  }
  return null
}

/** 只读诊断：到底缺什么、还剩下什么可用 */
export function diagnose(dataDir: string): RecoveryDiagnosis {
  const scan = scanDataDir(dataDir)
  const working = pickWorkingKey(dataDir)
  const pwdAvailable = scan.keyFiles.some((k) => k.name === 'master.key.pwd' && k.passwordProtected)

  let message: string
  if (!scan.db) {
    message = '这个目录里还没有库文件，可以直接新建一个空库开始用。'
  } else if (working) {
    message = `找到了能打开的密钥：${path.basename(working.path)}。点「自动修复」即可正常打开。`
  } else if (pwdAvailable) {
    message = '现有密钥都对不上，但存在密码保护的密钥副本：输入你设置过的密码就能解开。'
  } else if (scan.backups.length > 0) {
    message = `没有可用密钥，但 backups 里有 ${scan.backups.length} 份备份（备份内含当天的密钥），可以从备份恢复。`
  } else {
    message = '没有可用密钥、也没有备份。可以「重建空库」——旧库文件会改名留档，绝不删除。'
  }

  return { scan, usableKey: working?.path ?? null, canOpen: !!working, pwdAvailable, message }
}

/** 自动修复：用找到的可用密钥写回主位置并重开库 */
export async function autoRepair(dataDir: string): Promise<{ ok: boolean; message: string }> {
  const working = pickWorkingKey(dataDir)
  if (!working) return { ok: false, message: '没有能解开这个库的密钥' }
  try {
    const primary = keyFilePath()
    if (path.resolve(working.path) !== path.resolve(primary)) {
      fs.mkdirSync(path.dirname(primary), { recursive: true })
      fs.copyFileSync(working.path, primary)
      logInfo('recovery', `已把 ${path.basename(working.path)} 写回主密钥位置`)
    }
    const ok = await reopenStore(dataDir)
    return { ok, message: ok ? '已修复并打开' : '密钥已就位，但库仍打不开' }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/** 用密码解锁：解开 master.key.pwd，写回主位置再重开 */
export async function unlockWithPassword(dataDir: string, password: string): Promise<{ ok: boolean; message: string }> {
  const file = pwdFile(dataDir)
  if (!fs.existsSync(file)) return { ok: false, message: '这个目录里没有密码保护的密钥副本' }
  const key = unwrapKeyWithPassword(fs.readFileSync(file), password)
  if (!key) return { ok: false, message: '密码不对，或者这份密钥副本已损坏' }
  try {
    decryptBuffer(fs.readFileSync(dbFile(dataDir)), key)
  } catch {
    return { ok: false, message: '密码对了，但这把密钥打不开当前的库（可能是别的机器/别的时期的副本）' }
  }
  try {
    const primary = keyFilePath()
    fs.mkdirSync(path.dirname(primary), { recursive: true })
    fs.writeFileSync(primary, key, { mode: 0o600 })
    const ok = await reopenStore(dataDir)
    return { ok, message: ok ? '已用密码解锁并打开' : '密钥已解出，但库仍打不开' }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/** 从备份恢复（备份内含当天的密钥），恢复后立刻重开 */
export async function restoreFromBackup(dataDir: string, backupFile: string): Promise<{ ok: boolean; message: string; restored: string[] }> {
  try {
    const report = restoreBackup(dataDir, backupFile)
    const ok = await reopenStore(dataDir)
    return { ok, message: ok ? '已从备份恢复并打开' : '备份已还原，但库仍打不开', restored: report.restored }
  } catch (err) {
    return { ok: false, message: (err as Error).message, restored: [] }
  }
}

/**
 * 重建空库：旧库文件改名成 *.orphan-<时间> 留档（绝不删除），再开一个新库。
 * 备份目录、附件、导出、日志一律不动。
 */
export async function resetToEmpty(dataDir: string): Promise<{ ok: boolean; message: string; kept: string[] }> {
  try {
    const stamp = orphanStamp()
    const plan = planOrphanRenames(dataDir, stamp)
    const kept: string[] = []
    for (const p of plan) {
      fs.renameSync(p.from, p.to)
      kept.push(p.to)
    }
    const ok = await reopenStore(dataDir)
    logWarn('recovery', `重建空库：留档 ${kept.length} 个文件`)
    return {
      ok,
      message: ok
        ? `已新建空库。旧文件都改名留档了（${kept.map((p) => path.basename(p)).join('、') || '无'}），没有删除任何东西。`
        : '旧文件已留档，但新库建立失败',
      kept
    }
  } catch (err) {
    return { ok: false, message: (err as Error).message, kept: [] }
  }
}

/** 用密码给当前主密钥加一道保险：以后换机器/丢 APPDATA 也能凭密码找回 */
export function enablePasswordKey(dataDir: string, password: string): { ok: boolean; message: string } {
  if (password.trim().length < 4) return { ok: false, message: '密码至少 4 位' }
  try {
    const key = readKeyFile(keyFilePath()) ?? pickWorkingKey(dataDir)?.key ?? null
    if (!key) return { ok: false, message: '读不到当前主密钥，先正常打开软件再设置' }
    fs.writeFileSync(pwdFile(dataDir), wrapKeyWithPassword(key, password), { mode: 0o600 })
    logInfo('recovery', '已生成密码保护的密钥副本 master.key.pwd')
    return { ok: true, message: '已生成密码保护的密钥副本（随数据目录一起走）' }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

export function disablePasswordKey(dataDir: string): { ok: boolean; message: string } {
  try {
    const file = pwdFile(dataDir)
    if (fs.existsSync(file)) fs.unlinkSync(file)
    return { ok: true, message: '已移除密码保护的密钥副本' }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
