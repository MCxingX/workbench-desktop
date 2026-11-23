/**
 * 规则学习层：内置规则不动，用户教的东西存在库里，优先级更高。
 *
 * 三类规则：
 *   category —— 识别到的短语 → 分类（用户改分类时自动记，也可手写）
 *   time     —— 时间短语 → 具体时刻（用户改到期时间时自动记）
 *   regex    —— 用户手写的正则，命中后用 ?<time>/<?category> 命名组或整体作为提示
 *
 * 优先级：learned(strength 高者优先) > 内置。同分按命中次数与最后使用时间。
 */
import type { HM } from '../schedule/model'

export type RuleKind = 'category' | 'time' | 'regex'

export interface LearnedRule {
  id: string
  kind: RuleKind
  /** 触发短语（category/time）或正则源码（regex） */
  pattern: string
  /** category → 分类名；time → HH:mm；regex → 说明文本 */
  value: string
  /** 命中次数，越大越可信 */
  hits: number
  /** 用户手动添加 = 1，自动学习 = 0 */
  manual: number
  enabled: number
  created_at: string
  used_at: string | null
}

export interface RuleInput {
  kind: RuleKind
  pattern: string
  value: string
  manual?: boolean
}

/** 短语归一：去空白、去标点尾部，避免"张总 "和"张总"算两条 */
export function normalizePhrase(raw: string): string {
  return raw
    .trim()
    .replace(/^[\s，,。.、；;：:！!？?]+/, '')
    .replace(/[\s，,。.、；;：:！!？?]+$/, '')
    .replace(/\s{2,}/g, ' ')
}

/**
 * 从一句话里猜"用户到底在教哪个短语"：
 * 取去掉时间词/动作词后的最短有意义片段（2-8 字），太短太长都不学。
 */
export function guessTaughtPhrase(input: string, keywords: string[] = []): string | null {
  const text = normalizePhrase(input)
  if (!text) return null
  for (const k of keywords) {
    if (k && text.includes(k) && k.length >= 2 && k.length <= 8) return k
  }
  // 取最后一个贯通短语：中英文混排时取中文字符串
  const zh = /[\u4e00-\u9fa5]{2,8}/.exec(text)
  return zh ? zh[0] : null
}

/** 内置时间词：学习的时间短语必须不是这些，否则会覆盖用户已知说法 */
export const BUILTIN_TIME_WORDS = new Set([
  '今天', '明天', '后天', '本周', '下周', '月底', '下月初',
  '下班前', '上班后', '中午', '上午', '下午', '晚上', '马上', '等下', '一会儿'
])

export function isBuiltinTimeWord(phrase: string): boolean {
  const p = normalizePhrase(phrase)
  if (BUILTIN_TIME_WORDS.has(p)) return true
  // 周X / 下周X 也算内置
  return /^(下周|周)(一|二|三|四|五|六|日|天)$/.test(p)
}

/** 学习时间短语时给的默认值：用用户当时填的 due 的时刻 */
export function minutesOfLocal(iso: string | null | undefined): HM | null {
  if (!iso) return null
  const m = /T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return null
  return `${m[1]}:${m[2]}`
}

export interface RegexRule {
  source: string
  /** 编译好的正则；坏正则直接跳过，不影响其它规则 */
  re: RegExp
}

/** 编译用户正则：支持 (?<time>…)、(?<category>…)、(?<text>…) 命名组 */
export function compileRegex(source: string): RegexRule | null {
  try {
    const re = new RegExp(source, 'u')
    return { source, re }
  } catch {
    return null
  }
}

export interface RegexHit {
  text: string | null
  time: string | null
  category: string | null
}

export function applyRegex(source: string, input: string): RegexHit | null {
  const compiled = compileRegex(source)
  if (!compiled) return null
  const m = compiled.re.exec(input)
  if (!m) return null
  const g = (m.groups ?? {}) as Record<string, string | undefined>
  return {
    text: g.text ?? (m[0] ? m[0].trim() : null),
    time: g.time ?? null,
    category: g.category ?? null
  }
}

/** 打分：手动 > 自动；命中多 > 命中少；近期用过 > 很久没用 */
export function rankRules(rules: LearnedRule[]): LearnedRule[] {
  return [...rules]
    .filter((r) => r.enabled !== 0)
    .sort((a, b) => {
      if (b.manual !== a.manual) return b.manual - a.manual
      if (b.hits !== a.hits) return b.hits - a.hits
      const ta = a.used_at ?? a.created_at
      const tb = b.used_at ?? b.created_at
      return ta < tb ? 1 : ta > tb ? -1 : 0
    })
}

/** 从一堆候选里挑命中当前文本的（category/time 用 includes，regex 用 test） */
export function matchRules(kind: RuleKind, text: string, rules: LearnedRule[]): LearnedRule | null {
  const pool = rankRules(rules.filter((r) => r.kind === kind))
  for (const r of pool) {
    if (kind === 'regex') {
      if (applyRegex(r.pattern, text)) return r
    } else if (text.includes(r.pattern)) {
      return r
    }
  }
  return null
}