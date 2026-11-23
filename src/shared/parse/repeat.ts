/**
 * 循环待办：解析「每天/每周三/每月5号」开头的一句话，并计算下一次出现日期。
 * 纯函数，不碰数据库、不碰 electron —— 主进程与单测共用。
 */

const WEEK: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }
const WEEK_LABEL = '一二三四五六日'

/** 从句子开头识别循环规则，并把这个词从标题里拿掉 */
export function parseRepeatPhrase(raw: string): { text: string; repeat: string | null } {
  const t = raw.trim()
  let m = /^(每天|每日|每个工作日)\s*/.exec(t)
  if (m) return { text: t.slice(m[0].length).trim(), repeat: 'daily' }
  m = /^每周([一二三四五六日天])\s*/.exec(t)
  if (m) return { text: t.slice(m[0].length).trim(), repeat: 'weekly:' + WEEK[m[1]] }
  m = /^每月(\d{1,2})[号日]\s*/.exec(t)
  if (m) return { text: t.slice(m[0].length).trim(), repeat: 'monthly:' + Number(m[1]) }
  return { text: t, repeat: null }
}

/** 人话标签，待办列表里的小徽标 */
export function repeatLabel(repeat: string | null | undefined): string {
  if (!repeat) return ''
  if (repeat === 'daily') return '每个工作日'
  const wm = /^weekly:([0-6])$/.exec(repeat)
  if (wm) return '每周' + WEEK_LABEL[Number(wm[1])]
  const mo = /^monthly:(\d{1,2})$/.exec(repeat)
  if (mo) return `每月${Number(mo[1])}号`
  return repeat
}

const pad = (n: number): string => String(n).padStart(2, '0')
const localStamp = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`

/**
 * 完成一条循环待办后，下一轮应该出现在哪天几点。
 * 时刻沿用上一条的 due_at（比如一直定在 18:00），没有就落到下班时刻。
 * daily = 每个工作日（跳过周六周日）；weekly:N = 下一个周 N；monthly:D = 下个月 D 号（月末自动收紧）。
 */
export function nextOccurrence(
  repeat: string,
  prevDue: string | null,
  now: Date,
  workEnd = '18:00'
): string | null {
  const valid = prevDue && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(prevDue)
  const time = valid ? (prevDue as string).slice(11, 16) : workEnd
  const [hh, mm] = time.split(':').map(Number)
  const at = (base: Date): string => {
    const x = new Date(base)
    x.setHours(hh, mm, 0, 0)
    return localStamp(x)
  }

  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  if (repeat === 'daily') {
    do {
      d.setDate(d.getDate() + 1)
    } while (d.getDay() === 0 || d.getDay() === 6)
    return at(d)
  }

  const wm = /^weekly:([0-6])$/.exec(repeat)
  if (wm) {
    const target = Number(wm[1])
    const cur = (d.getDay() + 6) % 7
    let delta = target - cur
    if (delta <= 0) delta += 7
    d.setDate(d.getDate() + delta)
    return at(d)
  }

  const mo = /^monthly:(\d{1,2})$/.exec(repeat)
  if (mo) {
    const day = Math.min(31, Number(mo[1]))
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
    next.setDate(Math.min(day, last))
    return at(next)
  }

  return null
}

/** 到期前 15 分钟内、还没完成、还没过期的待办 —— 只提醒将来的，过期不补弹 */
export function pickDueSoon(
  rows: { id: string; text: string; due_at: string | null; done_at: string | null }[],
  now: Date
): { id: string; text: string; due_at: string }[] {
  const from = now.getTime()
  const to = from + 15 * 60_000
  return rows
    .filter((r) => !r.done_at && r.due_at)
    .map((r) => ({ id: r.id, text: r.text, due_at: r.due_at as string }))
    .filter((r) => {
      const t = new Date(r.due_at).getTime()
      return t > from && t <= to
    })
}
