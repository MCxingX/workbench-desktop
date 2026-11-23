import { describe, expect, it } from 'vitest'
import { nextOccurrence, parseRepeatPhrase, pickDueSoon, repeatLabel } from '@shared/parse/repeat'
import { parseQuickTodo } from '@shared/parse/quick'

/** 固定"现在"：2026-11-23 周一 10:00 */
const now = new Date(2026, 10, 23, 10, 0, 0)

describe('parseRepeatPhrase', () => {
  it('每天 → daily，词从标题里拿掉', () => {
    const r = parseRepeatPhrase('每天 写工作日报')
    expect(r.repeat).toBe('daily')
    expect(r.text).toBe('写工作日报')
  })

  it('每周三 → weekly:2', () => {
    const r = parseRepeatPhrase('每周三 组会')
    expect(r.repeat).toBe('weekly:2')
    expect(r.text).toBe('组会')
  })

  it('每月5号 → monthly:5', () => {
    const r = parseRepeatPhrase('每月5号 交考勤')
    expect(r.repeat).toBe('monthly:5')
    expect(r.text).toBe('交考勤')
  })

  it('普通句子不受影响', () => {
    const r = parseRepeatPhrase('下午把周报发给张总')
    expect(r.repeat).toBe(null)
    expect(r.text).toBe('下午把周报发给张总')
  })

  it('标签是人话', () => {
    expect(repeatLabel('daily')).toBe('每个工作日')
    expect(repeatLabel('weekly:2')).toBe('每周三')
    expect(repeatLabel('monthly:5')).toBe('每月5号')
  })
})

describe('nextOccurrence', () => {
  it('daily 落到明天，时刻沿用上一条', () => {
    // 周一完成 → 周二
    expect(nextOccurrence('daily', '2026-11-23T18:00:00', now, '17:30')).toBe('2026-11-24T18:00:00')
  })

  it('daily 跳过周末：周五完成 → 下周一', () => {
    const fri = new Date(2026, 10, 27, 10, 0, 0) // 周五
    expect(nextOccurrence('daily', null, fri, '17:30')).toBe('2026-11-30T17:30:00')
  })

  it('weekly 在本周还没到的那天之前会先给本周的', () => {
    // 周一完成，每周五 → 本周五
    expect(nextOccurrence('weekly:4', null, now, '17:30')).toBe('2026-11-27T17:30:00')
  })

  it('weekly 当天已过就给下周的', () => {
    // 周一完成，每周一 → 下周一
    expect(nextOccurrence('weekly:0', null, now, '17:30')).toBe('2026-11-30T17:30:00')
  })

  it('monthly 给下个月，31 号在 2 月收紧到月末', () => {
    expect(nextOccurrence('monthly:15', '2026-11-15T09:00:00', now, '17:30')).toBe('2026-12-15T09:00:00')
    const jan = new Date(2026, 0, 31, 10, 0, 0)
    expect(nextOccurrence('monthly:31', null, jan, '17:30')).toBe('2026-02-28T17:30:00')
  })

  it('未知规则返回 null', () => {
    expect(nextOccurrence('nonsense', null, now, '17:30')).toBe(null)
  })
})

describe('pickDueSoon', () => {
  const rows = [
    { id: 'a', text: '10:05 到期', due_at: '2026-11-23T10:05:00', done_at: null },
    { id: 'b', text: '10:20 到期', due_at: '2026-11-23T10:20:00', done_at: null },
    { id: 'c', text: '已经过了', due_at: '2026-11-23T09:00:00', done_at: null },
    { id: 'd', text: '已完成', due_at: '2026-11-23T10:10:00', done_at: '2026-11-23T10:01:00' },
    { id: 'e', text: '没期限', due_at: null, done_at: null }
  ]

  it('只挑现在到 15 分钟内的未完成项', () => {
    const got = pickDueSoon(rows, now)
    expect(got.map((r) => r.id)).toEqual(['a'])
  })
})

describe('parseQuickTodo 集成循环', () => {
  it('每天开头 → repeat=daily 且标题干净', () => {
    const q = parseQuickTodo('每天 写工作日报', now, { workStart: '08:30', workEnd: '17:30', lunchStart: '12:00', lunchEnd: '13:00' })
    expect(q.repeat).toBe('daily')
    expect(q.text).toBe('写工作日报')
  })
})
