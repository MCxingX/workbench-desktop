import { describe, expect, it } from 'vitest'
import { parseQuickTodo } from '@shared/parse/quick'

/** 固定一个"今天"，避免跑测试时结果随日期变 */
const now = new Date(2026, 10, 23, 10, 0, 0) // 2026-11-23 周一 10:00

const anchors = { workStart: '08:30', workEnd: '17:30', lunchStart: '12:00', lunchEnd: '13:00' }

const hm = (iso: string | null): string => (iso ? iso.slice(11, 16) : '')
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : '')

describe('parseQuickTodo 时间锚点', () => {
  it('下午 = 下班时间（跟着班表走，不是写死 18:00）', () => {
    const q = parseQuickTodo('下午把周报发给张总', now, anchors)
    expect(day(q.dueAt)).toBe('2026-11-23')
    expect(hm(q.dueAt)).toBe('17:30')
  })

  it('下班前、今天都落在下班时刻', () => {
    expect(hm(parseQuickTodo('下班前交报表', now, anchors).dueAt)).toBe('17:30')
    expect(hm(parseQuickTodo('今天整理文档', now, anchors).dueAt)).toBe('17:30')
  })

  it('上午 = 午休开始，中午 = 午休开始', () => {
    expect(hm(parseQuickTodo('上午回邮件', now, anchors).dueAt)).toBe('12:00')
    expect(hm(parseQuickTodo('中午问下进度', now, anchors).dueAt)).toBe('12:00')
  })

  it('上班后 = 上班时刻', () => {
    expect(hm(parseQuickTodo('上班后先看告警', now, anchors).dueAt)).toBe('08:30')
  })

  it('明天 / 后天 = 那天的上班时刻', () => {
    const t = parseQuickTodo('明天对齐接口', now, anchors)
    expect(day(t.dueAt)).toBe('2026-11-24')
    expect(hm(t.dueAt)).toBe('08:30')
    expect(day(parseQuickTodo('后天复盘', now, anchors).dueAt)).toBe('2026-11-25')
  })

  it('没给班表时退回内置默认（09:00–18:00）', () => {
    expect(hm(parseQuickTodo('下午发周报', now).dueAt)).toBe('18:00')
    expect(hm(parseQuickTodo('明天发周报', now).dueAt)).toBe('09:00')
  })

  it('明确写了时刻就听用户的', () => {
    const q = parseQuickTodo('14:30开评审会', now, anchors)
    expect(hm(q.dueAt)).toBe('14:30')
  })

  it('标题里不留时间词', () => {
    expect(parseQuickTodo('下午把周报发给张总', now, anchors).text).toBe('把周报发给张总')
  })
})
