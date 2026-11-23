import { classifyCategory, findTime, isUrgent } from './parser'
import type { HM } from '../schedule/model'

export interface QuickTodo {
  /** 去掉时间词后的干净标题 */
  text: string
  /** 识别到的时间提示（人话），未识别则 null */
  timeHint: string | null
  /** 今日该时刻的本地时间串，可直接写 due_at */
  dueAt: string | null
  category: string | null
  priority: number
}

/**
 * 班表给的时刻锚点。
 * 有它，"下午"就是你的下班时间，"上午"就是午休开始 —— 不再是写死的 18:00。
 */
export interface TimeAnchors {
  workStart: HM
  workEnd: HM
  lunchStart: HM | null
  lunchEnd: HM | null
}

const TIME_PHRASE = /(今天|明天|后天|本周|下周[一二三四五六日天]?|周[一二三四五六日天]|月底|下月初|下班前|上班后|中午|上午|下午|晚上|马上|等下|一会儿|\d{1,2}[:：]\d{2}(前)?)/

const DEFAULT_ANCHORS: TimeAnchors = { workStart: '09:00', workEnd: '18:00', lunchStart: '12:00', lunchEnd: '13:00' }

function toMinutes(hm: string | null | undefined): number | null {
  if (!hm) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 单行快速录入：不弹表单，只做"顺手识别" */
export function parseQuickTodo(input: string, now = new Date(), anchors?: TimeAnchors | null): QuickTodo {
  const raw = input.trim()
  const m = TIME_PHRASE.exec(raw)
  const timeHint = findTime(raw)?.label ?? (m ? m[1] : null)

  let text = raw
  if (m) text = raw.replace(m[0], '').replace(/\s{2,}/g, ' ').trim()
  text = text.replace(/^(记得|麻烦|帮我|你去|你把)\s*/, '').trim()
  if (text.length === 0) text = raw

  return {
    text,
    timeHint,
    dueAt: resolveDue(m?.[1] ?? null, now, anchors ?? null),
    category: classifyCategory(raw),
    priority: isUrgent(raw) ? 2 : 0
  }
}

function resolveDue(phrase: string | null, now: Date, anchors: TimeAnchors | null): string | null {
  if (!phrase) return null
  const a = anchors ?? DEFAULT_ANCHORS
  const start = toMinutes(a.workStart) ?? 9 * 60
  const end = toMinutes(a.workEnd) ?? 18 * 60
  const lunchStart = toMinutes(a.lunchStart) ?? 12 * 60
  const lunchEnd = toMinutes(a.lunchEnd) ?? 13 * 60

  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  // 必须存本地时间串：库里其它地方都按"本地 yyyy-mm-dd"前缀比日期，
  // 用 toISOString() 会让 UTC+8 的今天到期项整体漂 8 小时、甚至错一天
  const local = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`
  }
  const atMinutes = (total: number, offsetDays = 0) => {
    const d = new Date(day)
    d.setDate(d.getDate() + offsetDays)
    const clamped = Math.max(0, Math.min(23 * 60 + 59, total))
    d.setHours(Math.floor(clamped / 60), clamped % 60, 0, 0)
    return local(d)
  }

  // 明确写了时刻：以用户写的为准
  if (/^\d{1,2}[:：]\d{2}/.test(phrase)) {
    const [h, mi] = phrase.split(/[:：]/)
    return atMinutes(Number(h) * 60 + Number(mi.slice(0, 2)))
  }

  const afterWork = Math.min(end + 120, 23 * 60 + 30)

  switch (phrase) {
    // ── 一天之内的相对说法：全部锚到班表 ──
    case '上班后':
      return atMinutes(start)
    case '上午':
      // 上午段结束 = 午休开始；没配午休就上班后 4 小时
      return atMinutes(a.lunchStart ? lunchStart : Math.min(start + 240, end))
    case '中午':
      return atMinutes(lunchStart)
    case '下午':
      // 下午干完 = 下班
      return atMinutes(end)
    case '下班前':
      return atMinutes(end)
    case '晚上':
      return atMinutes(afterWork)
    case '今天':
      return atMinutes(end)
    case '马上':
      return atMinutes(now.getHours() * 60 + now.getMinutes() + 10)
    case '等下':
      return atMinutes(now.getHours() * 60 + now.getMinutes() + 30)
    case '一会儿':
      return atMinutes(now.getHours() * 60 + now.getMinutes() + 60)
    // ── 跨天 ──
    case '明天':
      return atMinutes(start, 1)
    case '后天':
      return atMinutes(start, 2)
    case '本周':
      return atMinutes(end, (5 - ((now.getDay() + 6) % 7) + 7) % 7)
    case '月底': {
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      const diff = last.getDate() - now.getDate()
      return atMinutes(end, diff)
    }
    case '下月初':
      return atMinutes(start, new Date(now.getFullYear(), now.getMonth() + 1, 1).getDate() - now.getDate() + 0)
    default:
      break
  }

  // 周一到周日
  const wd = /^(下周|周)([一二三四五六日天])$/.exec(phrase)
  if (wd) {
    const map: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }
    const target = map[wd[2]]
    const today = (now.getDay() + 6) % 7
    let delta = target - today
    if (delta <= 0) delta += 7
    if (wd[1] === '下周') delta = target - today > 0 ? target - today + 7 : target - today + 7
    return atMinutes(start, delta)
  }

  // 兜底：只给了个模糊时间提示，就按"今天下班前"
  const t = findTime(phrase)
  if (t) return atMinutes(t.minutes)
  return null
}
