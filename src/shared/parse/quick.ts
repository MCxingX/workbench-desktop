import { classifyCategory, findTime, isUrgent } from './parser'
import { parseRepeatPhrase } from './repeat'
import type { HM } from '../schedule/model'
import type { LearnedRule } from './rules'

export interface QuickTodo {
  /** 去掉时间词后的干净标题 */
  text: string
  /** 识别到的时间提示（人话），未识别则 null */
  timeHint: string | null
  /** 今日该时刻的本地时间串，可直接写 due_at */
  dueAt: string | null
  category: string | null
  priority: number
  /** 循环规则：daily / weekly:N / monthly:D，null = 一次性 */
  repeat: string | null
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

/**
 * 学到的规则（可选）。解析层只认数据、不认数据库，
 * 所以由主进程读好再传进来 —— 这样单测里可以随便造规则。
 */
export interface RulesHint {
  /** 命中过的最优先：短语 → 分类 */
  category?: { pattern: string; value: string }[]
  /** 短语 → HH:mm */
  time?: { pattern: string; value: string }[]
  /** 用户手写正则：命中后用命名组或整段匹配 */
  regex?: { source: string; value: string }[]
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
export function parseQuickTodo(input: string, now = new Date(), anchors?: TimeAnchors | null, hint?: RulesHint | null): QuickTodo {
  const raw0 = input.trim()
  // 循环词（每天/每周三/每月5号）在最前面，先摘掉再走时间解析
  const rep = parseRepeatPhrase(raw0)
  const raw = rep.text || raw0

  // 学到的规则只补它命中的那一面，没命中的继续走内置规则 ——
  // 只教过分类，不该把时间解析一起吃掉
  const learned = matchLearned(raw, now, hint)

  // ── 时间：学到的具体规则 > 内置时间词 ──
  const m = TIME_PHRASE.exec(raw)
  const builtinPhrase = m?.[1] ?? null
  const learnedTime = learned?.time ?? null
  const dueAt = learnedTime ? learnedTime.dueAt : resolveDue(builtinPhrase, now, anchors ?? null)
  const timeHint = learnedTime ? learnedTime.label : (findTime(raw)?.label ?? builtinPhrase)

  // ── 标题：摘掉时间词（学到的用命中片段，内置的用正则）──
  let text = learned?.text ?? raw
  if (learnedTime) {
    text = text.replace(learnedTime.matched, '').replace(/\s{2,}/g, ' ').trim()
  } else if (m) {
    text = text.replace(m[0], '').replace(/\s{2,}/g, ' ').trim()
  }
  text = text.replace(/^(记得|麻烦|帮我|你去|你把)\s*/, '').trim()
  if (text.length === 0) text = raw

  return {
    text,
    timeHint,
    dueAt,
    category: learned?.category ?? classifyCategory(raw),
    priority: isUrgent(raw) ? 2 : 0,
    repeat: rep.repeat
  }
}

interface LearnedHit {
  text: string | null
  category: string | null
  time: { matched: string; label: string; dueAt: string } | null
}

/** 本地时间串（跟库里口径一致：yyyy-mm-ddTHH:mm:00） */
function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`
}

/** HH:mm 落成"今天这个时刻"（已过就顺延到明天，跟人的直觉一致） */
function dueAtFromHM(hm: string, now: Date): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!m) return localStamp(d)
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return localStamp(d)
}

/**
 * 三类学到的东西一起判：正则 > 时间 > 分类（正则最具体）。
 * 只返回命中的部分；全没命中就交给内置规则。
 */
function matchLearned(raw: string, now: Date, hint?: RulesHint | null): LearnedHit | null {
  if (!hint) return null
  let text: string | null = null
  let category: string | null = null
  let time: LearnedHit['time'] = null

  for (const r of hint.regex ?? []) {
    let re: RegExp
    try {
      re = new RegExp(r.source, 'u')
    } catch {
      continue
    }
    const m = re.exec(raw)
    if (!m) continue
    const g = (m.groups ?? {}) as Record<string, string | undefined>
    // 没写命名组就别拿命中片段当标题（^报销 会只剩「报销」），保留原句由时间词去摘
    if (g.text) text = g.text.trim()
    if (g.category) category = g.category
    const t = g.time ?? r.value
    if (t && /^\d{1,2}:\d{2}$/.test(t)) {
      time = { matched: g.time ?? m[0], label: t, dueAt: dueAtFromHM(t, now) }
    }
    break
  }

  if (!time) {
    for (const r of hint.time ?? []) {
      if (!r.pattern || !/^\d{1,2}:\d{2}$/.test(r.value)) continue
      if (!raw.includes(r.pattern)) continue
      time = { matched: r.pattern, label: r.value, dueAt: dueAtFromHM(r.value, now) }
      break
    }
  }

  if (!category) {
    for (const r of hint.category ?? []) {
      if (r.pattern && raw.includes(r.pattern)) {
        category = r.value
        break
      }
    }
  }

  if (!text && !category && !time) return null
  return { text, category, time }
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
