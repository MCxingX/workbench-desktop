import { classifyCategory, findTime, isUrgent } from './parser'

export interface QuickTodo {
  /** 去掉时间词后的干净标题 */
  text: string
  /** 识别到的时间提示（人话），未识别则 null */
  timeHint: string | null
  /** 今日该时刻的 ISO 时间，可直接写 due_at */
  dueAt: string | null
  category: string | null
  priority: number
}

const TIME_PHRASE = /(今天|明天|后天|本周|下周[一二三四五六日天]?|周[一二三四五六日天]|月底|下月初|下班前|上班后|中午|上午|下午|晚上|马上|等下|一会儿|\d{1,2}[:：]\d{2}(前)?)/

/** 单行快速录入：不弹表单，只做"顺手识别" */
export function parseQuickTodo(input: string, now = new Date()): QuickTodo {
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
    dueAt: resolveDue(m?.[1] ?? null, now),
    category: classifyCategory(raw),
    priority: isUrgent(raw) ? 2 : 0
  }
}

function resolveDue(phrase: string | null, now: Date): string | null {
  if (!phrase) return null
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  // 必须存本地时间串：库里其它地方都按"本地 yyyy-mm-dd"前缀比日期，
  // 用 toISOString() 会让 UTC+8 的今天到期项整体漂 8 小时、甚至错一天
  const local = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`
  }
  const at = (h: number, mi = 0) => {
    const d = new Date(day)
    d.setHours(h, mi, 0, 0)
    return local(d)
  }
  if (phrase === '今天' || phrase === '中午' || phrase === '上午' || phrase === '下午' || phrase === '晚上' || phrase === '下班前' || phrase === '上班后' || phrase === '马上' || phrase === '等下' || phrase === '一会儿') {
    const t = findTime(phrase)
    return at(t && t.minutes >= 0 ? Math.floor(t.minutes / 60) : 18)
  }
  if (phrase === '明天') return at(9)
  if (phrase === '后天') {
    const d = new Date(day)
    d.setDate(d.getDate() + 2)
    d.setHours(9, 0, 0, 0)
    return local(d)
  }
  if (phrase === '本周') return at(18)
  if (/^\d{1,2}[:：]\d{2}/.test(phrase)) {
    const [h, mi] = phrase.split(/[:：]/)
    return at(Number(h), Number(mi.slice(0, 2)))
  }
  return null
}
