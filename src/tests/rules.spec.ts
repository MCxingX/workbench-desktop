import { describe, expect, it } from 'vitest'
import {
  applyRegex,
  compileRegex,
  guessTaughtPhrase,
  isBuiltinTimeWord,
  matchRules,
  minutesOfLocal,
  normalizePhrase,
  rankRules,
  type LearnedRule
} from '@shared/parse/rules'
import { parseQuickTodo } from '@shared/parse/quick'

const rule = (over: Partial<LearnedRule>): LearnedRule => ({
  id: over.id ?? 'r1',
  kind: over.kind ?? 'category',
  pattern: over.pattern ?? '',
  value: over.value ?? '',
  hits: over.hits ?? 0,
  manual: over.manual ?? 1,
  enabled: over.enabled ?? 1,
  created_at: over.created_at ?? '2026-11-01T00:00:00.000Z',
  used_at: over.used_at ?? null
})

describe('短语归一与猜测', () => {
  it('去空白与首尾标点', () => {
    expect(normalizePhrase('  报价单， ')).toBe('报价单')
    expect(normalizePhrase('把  报价单  发了')).toBe('把 报价单 发了')
  })

  it('能从整句里捞出被教的短语', () => {
    expect(guessTaughtPhrase('把报价单发给张总')).toBe('把报价单发给张总'.match(/[\u4e00-\u9fa5]{2,8}/)?.[0])
    expect(guessTaughtPhrase('报价单')).toBe('报价单')
    expect(guessTaughtPhrase('ab')).not.toBe('ab')
  })

  it('内置时间词不参与学习', () => {
    expect(isBuiltinTimeWord('下午')).toBe(true)
    expect(isBuiltinTimeWord('下班前')).toBe(true)
    expect(isBuiltinTimeWord('周三')).toBe(true)
    expect(isBuiltinTimeWord('收工前')).toBe(false)
  })

  it('从到期时间串里取出时刻', () => {
    expect(minutesOfLocal('2026-11-24T17:30:00')).toBe('17:30')
    expect(minutesOfLocal(null)).toBe(null)
    expect(minutesOfLocal('2026-11-24')).toBe(null)
  })
})

describe('规则排序与匹配', () => {
  it('手动 > 自动，命中多 > 命中少', () => {
    const auto = rule({ id: 'a', manual: 0, hits: 9 })
    const manual = rule({ id: 'm', manual: 1, hits: 0 })
    expect(rankRules([auto, manual])[0].id).toBe('m')
    const hi = rule({ id: 'h', manual: 0, hits: 9 })
    const lo = rule({ id: 'l', manual: 0, hits: 1 })
    expect(rankRules([lo, hi])[0].id).toBe('h')
  })

  it('停用的规则不参与', () => {
    const off = rule({ id: 'off', pattern: '报价单', value: '单据', enabled: 0 })
    expect(matchRules('category', '把报价单发了', [off])).toBe(null)
  })

  it('分类规则按 includes 命中', () => {
    const r = rule({ kind: 'category', pattern: '报价单', value: '单据' })
    expect(matchRules('category', '把报价单发了', [r])?.value).toBe('单据')
  })
})

describe('用户手写正则', () => {
  it('坏正则不抛异常，返回 null', () => {
    expect(compileRegex('([a-')).toBe(null)
    expect(applyRegex('([a-', '测试')).toBe(null)
  })

  it('命名组能取到时间与分类', () => {
    const hit = applyRegex('(?<time>\\d{1,2}:\\d{2})\\s*开会', '9:30 开会')
    expect(hit?.time).toBe('9:30')
    expect(hit?.text).toBe('9:30 开会')
  })

  it('没写命名组时整段命中的部分作为标题', () => {
    // applyRegex 只负责"这条正则命中了什么"，标题拼接在解析层
    expect(applyRegex('^报销', '报销差旅')?.text).toBe('报销')
    // 但真正录入时标题不会被截断（上面「学习规则只补它命中的那一面」已覆盖）
    const r = parseQuickTodo('报销差旅', new Date(2026, 10, 23, 10, 0, 0), null, { regex: [{ source: '^报销', value: '' }] })
    expect(r.text).toBe('报销差旅')
  })
})

describe('学会了就优先于内置规则', () => {
  const now = new Date(2026, 10, 23, 10, 0, 0)

  it('教过「报价单→单据」之后，录入自动带上分类', () => {
    const before = parseQuickTodo('把报价单发给张总', now, null, null)
    expect(before.category).not.toBe('单据')

    const after = parseQuickTodo('把报价单发给张总', now, null, {
      category: [{ pattern: '报价单', value: '单据' }]
    })
    expect(after.category).toBe('单据')
  })

  it('教过「收工前→17:30」之后，时间跟着学到的走', () => {
    const hint = { time: [{ pattern: '收工前', value: '17:30' }] }
    const r = parseQuickTodo('收工前把周报发了', now, { workStart: '08:30', workEnd: '18:00', lunchStart: '12:00', lunchEnd: '13:00' }, hint)
    expect(r.dueAt).not.toBe(null)
    expect(r.dueAt?.slice(11, 16)).toBe('17:30')
    // 时间短语要从标题里摘掉
    expect(r.text).not.toContain('收工前')
  })

  it('正则命中的时刻同样生效', () => {
    const r = parseQuickTodo('9:30 开会', now, null, { regex: [{ source: '(?<time>\\d{1,2}:\\d{2})\\s*开会', value: '' }] })
    expect(r.dueAt?.slice(11, 16)).toBe('09:30')
  })

  it('没教过的说法仍然走内置规则，不会退化成空', () => {
    const r = parseQuickTodo('明天下午把报价单发给张总', now, { workStart: '08:30', workEnd: '17:30', lunchStart: null, lunchEnd: null }, {
      category: [{ pattern: '报价单', value: '单据' }]
    })
    expect(r.category).toBe('单据')
    expect(r.dueAt).not.toBe(null)
  })

  it('学到的时刻已过点就顺延到明天，不把今天的过期时间写进去', () => {
    const late = new Date(2026, 10, 23, 20, 0, 0)
    const r = parseQuickTodo('收工前交表', late, null, { time: [{ pattern: '收工前', value: '17:30' }] })
    expect(r.dueAt?.slice(0, 10)).toBe('2026-11-24')
  })
})