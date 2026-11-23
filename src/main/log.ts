import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 隐藏日志：出问题的时候不用猜。
 *
 * 位置固定在 %APPDATA%\Workbench\logs，**不跟数据目录走** —— 数据目录本身经常
 * 就是故障源（盘掉了、权限没了、路径写错），日志放在它里面等于跟着一起丢。
 *
 * 同时往数据目录 logs\ 抄一份，方便用户在那个文件夹里就找到。
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  at: string
  level: LogLevel
  scope: string
  message: string
}

const MAX_BYTES = 2 * 1024 * 1024
const KEEP_DAYS = 7
const RING = 300

let ring: LogEntry[] = []
let errorCount = 0
let logDirOverride: string | null = null
let echoDir: string | null = null

export function fixedLogDir(): string {
  return logDirOverride ?? path.join(app.getPath('appData'), 'Workbench', 'logs')
}

/** 数据目录变化时用来同步那份副本 */
export function setEchoDir(dir: string | null): void {
  echoDir = dir
}

function logFileFor(d: Date): string {
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return path.join(fixedLogDir(), `app-${ymd}.log`)
}

function write(level: LogLevel, scope: string, message: string): void {
  const entry: LogEntry = { at: new Date().toISOString(), level, scope, message }
  ring.push(entry)
  if (ring.length > RING) ring = ring.slice(-RING)
  if (level === 'error') errorCount++

  const line = `${entry.at} [${level.toUpperCase().padEnd(5)}] ${scope} :: ${message}\n`
  const targets = [fixedLogDir()]
  if (echoDir) targets.push(path.join(echoDir, 'logs'))

  for (const dir of targets) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const file = logFileFor(new Date())
      const target = dir === fixedLogDir() ? file : path.join(dir, path.basename(file))
      const size = fs.existsSync(target) ? fs.statSync(target).size : 0
      if (size > MAX_BYTES) {
        fs.writeFileSync(target, `${entry.at} [INFO ] log :: 超过 2MB，已截断旧内容\n`, 'utf8')
      }
      fs.appendFileSync(target, line, 'utf8')
    } catch {
      /* 日志写不进去也不能影响主流程 */
    }
  }

  if (level === 'error') console.error(`[${scope}] ${message}`)
}

export function logInfo(scope: string, message: string): void {
  write('info', scope, message)
}

export function logWarn(scope: string, message: string): void {
  write('warn', scope, message)
}

export function logError(scope: string, err: unknown): void {
  write('error', scope, formatError(err))
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.message}${err.stack ? '\n' + err.stack : ''}`
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export function recentLogs(limit = 120): LogEntry[] {
  return ring.slice(-limit)
}

export function logStats(): { dir: string; file: string; bytes: number; errors: number; entries: number } {
  const file = logFileFor(new Date())
  let bytes = 0
  try {
    if (fs.existsSync(file)) bytes = fs.statSync(file).size
  } catch {
    bytes = 0
  }
  return { dir: fixedLogDir(), file, bytes, errors: errorCount, entries: ring.length }
}

/** 清掉 7 天前的日志，避免无限长 */
export function pruneLogs(): void {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000
  try {
    for (const name of fs.readdirSync(fixedLogDir())) {
      if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue
      const full = path.join(fixedLogDir(), name)
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true })
    }
  } catch {
    /* 目录还不存在就没什么可清 */
  }
}

export interface DiagContext {
  dataDir: string
  dataDirSource: string
  masterKeyOk: boolean
  storeError: string | null
  extra?: Record<string, string>
}

/**
 * 诊断文本：用户直接复制发过来就能定位问题。
 * 不含任何业务数据（待办、口径、打卡都不在里面），只有环境与错误。
 */
export function buildReport(ctx: DiagContext): string {
  const stats = logStats()
  const lines: string[] = []
  lines.push('===== Workbench 诊断信息 =====')
  lines.push(`版本        : ${app.getVersion()}`)
  lines.push(`打包        : ${app.isPackaged ? '是' : '否（开发模式）'}`)
  lines.push(`系统        : ${process.platform} ${process.arch} / Electron ${process.versions.electron} / Node ${process.versions.node}`)
  lines.push(`系统版本    : ${process.getSystemVersion?.() ?? 'n/a'}`)
  lines.push(`语言/时区   : ${app.getLocale()} / ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
  lines.push(`数据目录    : ${ctx.dataDir}`)
  lines.push(`目录来源    : ${ctx.dataDirSource}`)
  lines.push(`主密钥      : ${ctx.masterKeyOk ? '可读取' : '不可读取（可能导致库无法解密）'}`)
  lines.push(`库错误      : ${ctx.storeError ?? '无'}`)
  lines.push(`日志文件    : ${stats.file}`)
  lines.push(`日志大小    : ${stats.bytes} B / 错误 ${stats.errors} 条`)
  if (ctx.extra) {
    for (const [k, v] of Object.entries(ctx.extra)) lines.push(`${k.padEnd(12)}: ${v}`)
  }
  lines.push('')
  lines.push('----- 最近日志（含错误堆栈）-----')
  for (const e of ring.slice(-80)) {
    lines.push(`${e.at} [${e.level.toUpperCase()}] ${e.scope} :: ${e.message}`)
  }
  lines.push('===== 结束 =====')
  return lines.join('\n')
}

/** 导出成 txt 到指定目录（默认数据目录 exports），返回文件路径 */
export function exportReport(ctx: DiagContext, targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = path.join(targetDir, `诊断-${stamp}.txt`)
  fs.writeFileSync(file, buildReport(ctx), 'utf8')
  return file
}

/** 冒烟时把日志写到隔离目录，别污染真实日志 */
export function setLogDirForTest(dir: string): void {
  logDirOverride = dir
}

export function resetErrorCount(): void {
  errorCount = 0
}
