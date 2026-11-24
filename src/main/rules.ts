/**
 * 学出来的规则：落库 + 命中 + 自动学习。
 *
 * 自动学习只做两件最稳的事（不猜、不打扰）：
 *   1. 用户把待办分类改成了 X → 记住「这句话里的短语 → X」
 *   2. 用户把到期时间改成了 HH:mm → 记住「这句话里的时间短语 → HH:mm」
 * 其余靠用户在设置里手写正则 / 手加规则。
 */
import { query, run } from './store'
import {
  guessTaughtPhrase,
  isBuiltinTimeWord,
  matchRules,
  minutesOfLocal,
  normalizePhrase,
  rankRules,
  type LearnedRule,
  type RuleInput,
  type RuleKind
} from '../shared/parse/rules'

const uid = (p: string): string => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/**
 * 规整 IPC 传来的 kind：Electron 会把 JS 值序列化，边界上一定要收窄成字符串，
 * 否则 sql.js 绑定参数时会抛 "unknown type ([object Object])"。
 */
function asKind(v: unknown): RuleKind | undefined {
  return v === 'category' || v === 'time' || v === 'regex' ? v : undefined
}

export function listRules(kindRaw?: unknown): LearnedRule[] {
  const kind = asKind(kindRaw)
  const rows = kind
    ? query<LearnedRule>('SELECT * FROM learned_rules WHERE kind = ? ORDER BY manual DESC, hits DESC, created_at DESC', [kind])
    : query<LearnedRule>('SELECT * FROM learned_rules ORDER BY manual DESC, hits DESC, created_at DESC')
  return rows
}

/** 可直接喂给解析层的规则（只取启用的） */
export function activeRules(): LearnedRule[] {
  return listRules().filter((r) => r.enabled !== 0)
}

/** 新增/更新一条规则；同 kind+pattern 视为同一条（命中次数保留） */
export function saveRule(input: RuleInput): LearnedRule {
  const pattern = normalizePhrase(input.pattern)
  const value = input.value.trim()
  if (!pattern || !value) throw new Error('规则内容不能为空')
  if (input.kind === 'regex') {
    // 坏正则当场拒绝，不要存进去以后再炸
    // eslint-disable-next-line no-new
    new RegExp(pattern, 'u')
  }

  const exist = query<LearnedRule>('SELECT * FROM learned_rules WHERE kind = ? AND pattern = ?', [input.kind, pattern])[0]
  if (exist) {
    run('UPDATE learned_rules SET value = ?, manual = ?, enabled = 1 WHERE id = ?', [
      value,
      input.manual === false ? exist.manual : 1,
      exist.id
    ])
    return { ...exist, value, enabled: 1 }
  }

  const row: LearnedRule = {
    id: uid('rule'),
    kind: input.kind,
    pattern,
    value,
    hits: 0,
    manual: input.manual === false ? 0 : 1,
    enabled: 1,
    created_at: new Date().toISOString(),
    used_at: null
  }
  run(
    'INSERT INTO learned_rules (id, kind, pattern, value, hits, manual, enabled, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [row.id, row.kind, row.pattern, row.value, row.hits, row.manual, row.enabled, row.created_at, row.used_at]
  )
  return row
}

export function setRuleEnabled(id: string, enabled: boolean): void {
  run('UPDATE learned_rules SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id])
}

export function deleteRule(id: string): void {
  run('DELETE FROM learned_rules WHERE id = ?', [id])
}

function bumpRule(id: string): void {
  run('UPDATE learned_rules SET hits = hits + 1, used_at = ? WHERE id = ?', [new Date().toISOString(), id])
}

/** 解析时调用：先看学到的分类规则（命中就记一次） */
export function learnedCategory(text: string): string | null {
  const hit = matchRules('category', text, activeRules())
  if (!hit) return null
  bumpRule(hit.id)
  return hit.value
}

/** 解析时调用：学到的整句 / 时间短语（返回 HH:mm） */
export function learnedTime(text: string, phrase: string | null): string | null {
  const rules = activeRules()
  const hit = matchRules('time', phrase ?? text, rules) ?? matchRules('time', text, rules)
  if (!hit) return null
  bumpRule(hit.id)
  return hit.value
}

/** 解析时调用：用户手写正则命中的结果 */
export function learnedRegex(text: string): { text: string | null; time: string | null; category: string | null } | null {
  const rules = rankRules(activeRules().filter((r) => r.kind === 'regex'))
  for (const r of rules) {
    let re: RegExp
    try {
      re = new RegExp(r.pattern, 'u')
    } catch {
      continue
    }
    const m = re.exec(text)
    if (!m) continue
    const g = (m.groups ?? {}) as Record<string, string | undefined>
    bumpRule(r.id)
    return {
      text: g.text ?? (m[0] ? m[0].trim() : null),
      time: g.time ?? (r.value || null),
      category: g.category ?? null
    }
  }
  return null
}

/**
 * 自动学习：用户改分类时记「原文里的短语 → 分类」。
 * 只在改分类（不是清空）时学，且不覆盖内置时间词。
 */
export function learnCategoryFromEdit(originalText: string, category: string | null): void {
  if (!category) return
  const phrase = guessTaughtPhrase(originalText)
  if (!phrase || phrase.length < 2) return
  try {
    saveRule({ kind: 'category', pattern: phrase, value: category, manual: false })
  } catch {
    // 学不会不影响主流程
  }
}

/**
 * 自动学习：用户改到期时间时记「这句话里的时间短语 → 时刻」。
 * 只在用户明确改成一个具体时刻时学；内置时间词（下午/下班前）不学 —— 那些已经跟班表走了。
 */
export function learnTimeFromEdit(originalText: string, dueAt: string | null): void {
  const hm = minutesOfLocal(dueAt)
  if (!hm) return
  const phrase = guessTaughtPhrase(originalText)
  if (!phrase || isBuiltinTimeWord(phrase)) return
  try {
    saveRule({ kind: 'time', pattern: phrase, value: hm, manual: false })
  } catch {
    // 同上
  }
}

/** 统计：给设置页显示「学到多少条、命中过多少次」 */
export function ruleStats(): { total: number; manual: number; learned: number; topHits: number } {
  const rows = listRules()
  return {
    total: rows.length,
    manual: rows.filter((r) => r.manual === 1).length,
    learned: rows.filter((r) => r.manual === 0).length,
    topHits: rows.reduce((m, r) => Math.max(m, r.hits), 0)
  }
}