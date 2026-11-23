import type { HM } from './model'

const MIN = 60_000

export function parseHM(hm: HM): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) throw new Error(`时间格式应为 HH:mm，收到 "${hm}"`)
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) throw new Error(`时间越界 "${hm}"`)
  return h * 60 + mi
}

export function fmtHM(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440
  const h = Math.floor(m / 60)
  const mi = m % 60
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}

/** YYYY-MM-DD（本地时区，绝不用 toISOString 以免时区偏移） */
export function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseYmd(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (!m) throw new Error(`日期格式应为 YYYY-MM-DD，收到 "${s}"`)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() + n)
  return x
}

/** 0=周一 … 6=周日 */
export function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7
}

export function mondayOf(d: Date): Date {
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  return addDays(base, -weekdayIndex(base))
}

export function daysBetween(a: Date, b: Date): number {
  const ms = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const me = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((me - ms) / 86_400_000)
}

/** 从锚点周一算起的周序号（可为负），用于两周交替的奇偶判定 */
export function weekIndexFromAnchor(date: Date, anchorMonday: string): number {
  const anchor = mondayOf(parseYmd(anchorMonday))
  return Math.floor(daysBetween(anchor, mondayOf(date)) / 7)
}

/** 当天已过分钟数（含秒的小数部分） */
export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / MIN
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function nowSecondsIntoDay(d: Date): number {
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000
}

export function inRange(dateStr: string, from: string, to: string): boolean {
  return dateStr >= from && dateStr <= to
}
