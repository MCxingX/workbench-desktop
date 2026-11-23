import { describe, expect, it } from 'vitest'
import {
  activeShiftAt,
  computeCountdown,
  expandPieces,
  previewDays,
  resolveAttendance,
  resolveDay,
  validateProfile,
  variantOf
} from '../shared/schedule/resolve'
import {
  makeProfile,
  makeShift,
  makeVariant,
  MON_FRI,
  MON_SAT
} from '../shared/schedule/presets'
import { ymd } from '../shared/schedule/time'
import type { ShiftProfile } from '../shared/schedule/model'

/** 构造本地时间，避免时区陷阱 */
const at = (date: string, hm: string): Date => {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = hm.split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm, 0, 0)
}

const bigSmallWeek = (): ShiftProfile =>
  makeProfile({
    id: 'bs',
    name: '大小周',
    weekCycle: {
      mode: 'alternate',
      anchorMonday: '2026-11-02',
      anchorVariant: 'primary',
      primary: makeVariant('大周', [...MON_SAT], makeShift('09:00', '18:00', ['12:00', '13:00'])),
      secondary: makeVariant('小周', [...MON_FRI], makeShift('09:00', '18:00', ['12:00', '13:00']))
    }
  })

const nightProfile = (): ShiftProfile =>
  makeProfile({
    id: 'night',
    name: '夜班',
    base: makeShift('22:00', '06:00', null)
  })

// ─────────────────────────── A. 基础与校验（6） ───────────────────────────
describe('A 基础与校验', () => {
  const p = makeProfile({ id: 'std', name: '朝九晚六双休' })

  it('A1 周一判为上班', () => {
    const r = resolveAttendance(p, '2026-11-16')
    expect(r.onDuty).toBe(true)
    expect(r.source).toBe('mask')
  })

  it('A2 周五上班、周六休息', () => {
    expect(resolveAttendance(p, '2026-11-20').onDuty).toBe(true)
    expect(resolveAttendance(p, '2026-11-21').onDuty).toBe(false)
  })

  it('A3 午休越界被拒并给出中文提示', () => {
    const bad = makeProfile({ id: 'x', name: 'x', base: makeShift('09:00', '18:00', ['12:00', '19:00']) })
    const issues = validateProfile(bad)
    expect(issues.some((i) => i.field === '午休' && /超出班次/.test(i.message))).toBe(true)
  })

  it('A4 上下班时刻相同被拒', () => {
    const bad = makeProfile({ id: 'x', name: 'x', base: makeShift('09:00', '09:00', null) })
    expect(validateProfile(bad).some((i) => /时长不是零/.test(i.message))).toBe(true)
  })

  it('A5 一周七天都不上班被拒', () => {
    const bad = makeProfile({ id: 'x', name: 'x', mask: [false, false, false, false, false, false, false] })
    expect(validateProfile(bad).some((i) => /至少选一天/.test(i.message))).toBe(true)
  })

  it('A6 两周交替基准不是周一被拒（2026-11-04 是周三）', () => {
    const bad = makeProfile({
      id: 'x',
      name: 'x',
      weekCycle: {
        mode: 'alternate',
        anchorMonday: '2026-11-04',
        anchorVariant: 'primary',
        primary: makeVariant('A', [...MON_FRI], makeShift('09:00', '18:00', null)),
        secondary: makeVariant('B', [...MON_FRI], makeShift('09:00', '18:00', null))
      }
    })
    const issues = validateProfile(bad)
    expect(issues.some((i) => i.field === '基准周一' && /周三/.test(i.message))).toBe(true)
  })
})

// ─────────────────────────── B. 周掩码（5） ───────────────────────────
describe('B 周掩码', () => {
  it('B1 单休（周日休）：周六上班、周日休息', () => {
    const p = makeProfile({ id: 's', name: '单休', mask: [...MON_SAT] })
    expect(resolveAttendance(p, '2026-11-21').onDuty).toBe(true) // 周六
    expect(resolveAttendance(p, '2026-11-22').onDuty).toBe(false) // 周日
  })

  it('B2 全周七天都上班', () => {
    const p = makeProfile({ id: 'all', name: '全周', mask: [true, true, true, true, true, true, true] })
    expect(resolveAttendance(p, '2026-11-22').onDuty).toBe(true)
  })

  it('B3 自定义周三休息', () => {
    const p = makeProfile({ id: 'c', name: '周三休', mask: [true, true, false, true, true, false, false] })
    expect(resolveAttendance(p, '2026-11-18').onDuty).toBe(false)
    expect(resolveAttendance(p, '2026-11-19').onDuty).toBe(true)
  })

  it('B4 月覆盖掩码生效（11 月改成六天）', () => {
    const p = makeProfile({
      id: 'm',
      name: '月覆盖',
      monthOverrides: [{ ym: '2026-11', mask: [...MON_SAT] }]
    })
    expect(resolveAttendance(p, '2026-11-21').onDuty).toBe(true)
    expect(resolveAttendance(p, '2026-12-05').onDuty).toBe(false)
  })

  it('B5 月覆盖掩码优先于常规周掩码', () => {
    const p = makeProfile({
      id: 'm',
      name: '月覆盖',
      mask: [...MON_FRI],
      monthOverrides: [{ ym: '2026-11', mask: [false, false, false, false, false, false, false] }]
    })
    expect(resolveAttendance(p, '2026-11-16').onDuty).toBe(false)
    expect(resolveAttendance(p, '2026-12-14').onDuty).toBe(true)
  })
})

// ─────────────────────────── C. 两周交替（8） ───────────────────────────
describe('C 两周交替', () => {
  const p = bigSmallWeek()

  it('C1 锚点周用 primary（大周）→ 周六上班', () => {
    expect(resolveAttendance(p, '2026-11-07').onDuty).toBe(true)
  })

  it('C2 下一周用 secondary（小周）→ 周六休息', () => {
    expect(resolveAttendance(p, '2026-11-14').onDuty).toBe(false)
  })

  it('C3 再下一周回到 primary', () => {
    expect(resolveAttendance(p, '2026-11-21').onDuty).toBe(true)
  })

  it('C4 跨年周仍按锚点奇偶（2026-12-28 与锚点差 8 周 → primary）', () => {
    const v = variantOf(p, '2026-12-28')
    expect(v?.weekIndex).toBe(8)
    expect(v?.variant).toBe('primary')
  })

  it('C5 周序号计算正确（2026-11-09 → 1）', () => {
    expect(variantOf(p, '2026-11-09')?.weekIndex).toBe(1)
  })

  it('C6 anchorVariant=secondary 时奇偶反转', () => {
    const q = bigSmallWeek()
    q.weekCycle.anchorVariant = 'secondary'
    expect(variantOf(q, '2026-11-02')?.variant).toBe('secondary')
    expect(resolveAttendance(q, '2026-11-07').onDuty).toBe(false)
  })

  it('C7 两套的时段不同 → 生效时段跟着变', () => {
    const q = makeProfile({
      id: 'diff',
      name: '不同时段',
      weekCycle: {
        mode: 'alternate',
        anchorMonday: '2026-11-02',
        anchorVariant: 'primary',
        primary: makeVariant('A', [...MON_FRI], makeShift('08:00', '17:00', null)),
        secondary: makeVariant('B', [...MON_FRI], makeShift('10:00', '19:00', null))
      }
    })
    expect(resolveDay(q, '2026-11-16').shift?.start).toBe('08:00')
    expect(resolveDay(q, '2026-11-23').shift?.start).toBe('10:00')
  })

  it('C8 只填一套 → 校验报错且不进入交替判定', () => {
    const q = makeProfile({
      id: 'half',
      name: '半套',
      weekCycle: {
        mode: 'alternate',
        anchorMonday: '2026-11-02',
        anchorVariant: 'primary',
        primary: makeVariant('A', [...MON_FRI], makeShift('09:00', '18:00', null)),
        secondary: null
      }
    })
    expect(validateProfile(q).some((i) => i.field === '两周交替')).toBe(true)
    expect(variantOf(q, '2026-11-09')).toBeNull()
  })
})

// ─────────────────────────── D. 月规则（6） ───────────────────────────
describe('D 月规则逐月设置', () => {
  it('D1 11 月 12:00 下班、12 月 11:30 下班', () => {
    const p = makeProfile({
      id: 'mo',
      name: '逐月',
      monthOverrides: [
        { ym: '2026-11', shift: { end: '12:00' } },
        { ym: '2026-12', shift: { end: '11:30' } }
      ]
    })
    expect(resolveDay(p, '2026-11-10').shift?.end).toBe('12:00')
    expect(resolveDay(p, '2026-12-10').shift?.end).toBe('11:30')
  })

  it('D2 只改午休，其余继承基础档', () => {
    const p = makeProfile({
      id: 'mo',
      name: '逐月',
      monthOverrides: [{ ym: '2026-11', shift: { lunch: { start: '12:00', end: '14:00' } } }]
    })
    const d = resolveDay(p, '2026-11-10')
    expect(d.shift?.start).toBe('09:00')
    expect(d.shift?.end).toBe('18:00')
    expect(d.shift?.lunch?.end).toBe('14:00')
  })

  it('D3 月覆盖备注进入命中链', () => {
    const p = makeProfile({
      id: 'mo',
      name: '逐月',
      monthOverrides: [{ ym: '2026-11', shift: { end: '12:00' }, note: '领导口头：11 点走' }]
    })
    expect(resolveDay(p, '2026-11-10').trail.join('|')).toContain('领导口头')
  })

  it('D4 未配置的月份沿用基础档', () => {
    const p = makeProfile({ id: 'mo', name: '逐月', monthOverrides: [{ ym: '2026-11', shift: { end: '12:00' } }] })
    expect(resolveDay(p, '2027-01-05').shift?.end).toBe('18:00')
  })

  it('D5 月覆盖可与两周交替叠加（掩码以月为准）', () => {
    const p = bigSmallWeek()
    p.monthOverrides = [{ ym: '2026-11', mask: [...MON_FRI] }]
    expect(resolveAttendance(p, '2026-11-07').onDuty).toBe(false)
  })

  it('D6 月覆盖的下班时刻参与倒计时', () => {
    const p = makeProfile({
      id: 'mo',
      name: '逐月',
      monthOverrides: [{ ym: '2026-11', shift: { end: '12:00' } }]
    })
    // 2026-11-10 是周二，10:00 → 距下班 2 小时
    const st = computeCountdown(p, at('2026-11-10', '10:00'))
    expect(st.phase).toBe('working')
    expect(st.wallRemainingSec).toBe(7200)
  })
})

// ─────────────────────────── E. 五层判定（8） ───────────────────────────
describe('E 五层判定顺序', () => {
  const base = () =>
    makeProfile({
      id: 'layers',
      name: '五层',
      holidays: [{ name: '国庆节', from: '2026-10-01', to: '2026-10-07' }],
      makeups: [{ date: '2026-10-10', name: '国庆节' }],
      overrides: []
    })

  it('E1 个人例外 off 优先于法定假', () => {
    const p = base()
    p.overrides = [{ id: 'o1', dateFrom: '2026-10-02', dateTo: '2026-10-02', kind: 'off', note: '请假' }]
    const r = resolveAttendance(p, '2026-10-02')
    expect(r.source).toBe('override')
    expect(r.onDuty).toBe(false)
  })

  it('E2 个人例外 off 优先于补班日', () => {
    const p = base()
    p.overrides = [{ id: 'o2', dateFrom: '2026-10-10', dateTo: '2026-10-10', kind: 'off', note: '补班日请假' }]
    const r = resolveAttendance(p, '2026-10-10')
    expect(r.source).toBe('override')
    expect(r.onDuty).toBe(false)
  })

  it('E3 假期被标为补班 → 按补班算（上班）', () => {
    const p = base()
    p.makeups = [{ date: '2026-10-03', name: '国庆节' }]
    const r = resolveAttendance(p, '2026-10-03')
    expect(r.source).toBe('makeup')
    expect(r.onDuty).toBe(true)
  })

  it('E4 补班日按上班判定', () => {
    const r = resolveAttendance(base(), '2026-10-10')
    expect(r.onDuty).toBe(true)
    expect(r.source).toBe('makeup')
  })

  it('E5 补班日会说明"本来是休息日"', () => {
    const r = resolveAttendance(base(), '2026-10-10')
    expect(r.extras.join('|')).toContain('本来是休息日')
  })

  it('E6 两周交替来源标记为 cycle', () => {
    expect(resolveAttendance(bigSmallWeek(), '2026-11-07').source).toBe('cycle')
  })

  it('E7 普通工作日来源标记为 mask', () => {
    expect(resolveAttendance(base(), '2026-11-17').source).toBe('mask')
  })

  it('E8 个人例外 shift 改时段并被 resolveDay 采用', () => {
    const p = base()
    p.overrides = [
      { id: 'o3', dateFrom: '2026-11-18', dateTo: '2026-11-18', kind: 'shift', payload: { start: '10:00', end: '19:00' } }
    ]
    const d = resolveDay(p, '2026-11-18')
    expect(d.shift?.start).toBe('10:00')
    expect(d.shift?.end).toBe('19:00')
    expect(d.attendance.source).toBe('override')
  })
})

// ─────────────────────────── F. 法定假与补班（6） ───────────────────────────
describe('F 法定假与补班', () => {
  it('F1 假期第 N 天文案正确', () => {
    const p = makeProfile({
      id: 'hol',
      name: '假',
      holidays: [{ name: '国庆节', from: '2026-10-01', to: '2026-10-07' }]
    })
    expect(resolveAttendance(p, '2026-10-03').reason).toContain('第 3 天')
    expect(resolveAttendance(p, '2026-10-03').reason).toContain('共 7 天')
  })

  it('F2 useHolidays=false 时忽略假期', () => {
    const p = makeProfile({
      id: 'hol',
      name: '假',
      useHolidays: false,
      holidays: [{ name: '国庆节', from: '2026-10-01', to: '2026-10-07' }]
    })
    // 2026-10-01 是周四，掩码内 → 上班
    expect(resolveAttendance(p, '2026-10-01').onDuty).toBe(true)
  })

  it('F3 未公布年度不推算：库里没 2027 数据就不产生假期', () => {
    const p = makeProfile({ id: 'hol', name: '假' })
    expect(resolveAttendance(p, '2027-01-01').source).toBe('mask')
  })

  it('F4 假期区间含首尾端点', () => {
    const p = makeProfile({
      id: 'hol',
      name: '假',
      holidays: [{ name: '国庆节', from: '2026-10-01', to: '2026-10-07' }]
    })
    expect(resolveAttendance(p, '2026-10-01').onDuty).toBe(false)
    expect(resolveAttendance(p, '2026-10-07').onDuty).toBe(false)
    expect(resolveAttendance(p, '2026-10-08').onDuty).toBe(true)
  })

  it('F5 跨月假期区间正常', () => {
    const p = makeProfile({
      id: 'hol',
      name: '假',
      holidays: [{ name: '元旦', from: '2026-12-30', to: '2027-01-02' }]
    })
    expect(resolveAttendance(p, '2026-12-31').onDuty).toBe(false)
    expect(resolveAttendance(p, '2027-01-02').onDuty).toBe(false)
  })

  it('F6 周六补班判为上班', () => {
    const p = makeProfile({ id: 'mk', name: '补班', makeups: [{ date: '2026-11-21', name: '国庆节' }] })
    expect(resolveAttendance(p, '2026-11-21').onDuty).toBe(true)
  })
})

// ─────────────────────────── G. 夜班跨零点（6） ───────────────────────────
describe('G 夜班跨零点', () => {
  const p = nightProfile()

  it('G1 22:00–06:00 展开成两段共 8 小时', () => {
    const { work } = expandPieces(makeShift('22:00', '06:00', null))
    expect(work).toHaveLength(2)
    const total = work.reduce((s, x) => s + (x.to - x.from), 0)
    expect(total).toBe(480)
  })

  it('G2 凌晨 2 点归属前一天', () => {
    const a = activeShiftAt(p, at('2026-11-21', '02:00'))
    expect(a?.day.date).toBe('2026-11-20')
    expect(a?.minute).toBe(1560)
  })

  it('G3 凌晨 2 点倒计时：距下班 4 小时，状态 working', () => {
    const st = computeCountdown(p, at('2026-11-21', '02:00'))
    expect(st.phase).toBe('working')
    expect(st.wallRemainingSec).toBe(4 * 3600)
  })

  it('G4 当晚 22:30 距下班 7.5 小时', () => {
    const st = computeCountdown(p, at('2026-11-20', '22:30'))
    expect(st.phase).toBe('working')
    expect(st.wallRemainingSec).toBe(7.5 * 3600)
  })

  it('G5 白天 12:00 处于"还没到上班"（距 22:00 还有 10 小时）', () => {
    const st = computeCountdown(p, at('2026-11-20', '12:00'))
    expect(st.phase).toBe('before')
    expect(st.untilStartSec).toBe(10 * 3600)
  })

  it('G6 夜班下班后 07:00 计加班 1 小时', () => {
    const st = computeCountdown(p, at('2026-11-21', '07:00'))
    expect(st.phase).toBe('overtime')
    expect(st.overtimeSec).toBe(3600)
  })
})

// ─────────────────────────── H. 倒计时状态机（9） ───────────────────────────
describe('H 倒计时状态机', () => {
  const p = makeProfile({ id: 'std', name: '朝九晚六双休' })

  it('H1 08:00 上班前：距上班 1 小时', () => {
    const st = computeCountdown(p, at('2026-11-20', '08:00'))
    expect(st.phase).toBe('before')
    expect(st.untilStartSec).toBe(3600)
  })

  it('H2 12:30 午休中：午休剩 30 分钟', () => {
    const st = computeCountdown(p, at('2026-11-20', '12:30'))
    expect(st.phase).toBe('lunch')
    expect(st.lunchRemainingSec).toBe(1800)
  })

  it('H3 12:30 净工作剩余 5 小时（13:00–18:00）', () => {
    const st = computeCountdown(p, at('2026-11-20', '12:30'))
    expect(st.netRemainingSec).toBe(5 * 3600)
  })

  it('H4 15:00 工作中共 3 小时', () => {
    const st = computeCountdown(p, at('2026-11-20', '15:00'))
    expect(st.phase).toBe('working')
    expect(st.wallRemainingSec).toBe(3 * 3600)
    expect(st.netRemainingSec).toBe(3 * 3600)
  })

  it('H5 18:00 整点算已下班（after）', () => {
    const st = computeCountdown(p, at('2026-11-20', '18:00'))
    expect(st.phase).toBe('after')
    expect(st.overtimeSec).toBe(0)
  })

  it('H6 周五 18:00 距下周一上班 63 小时', () => {
    const st = computeCountdown(p, at('2026-11-20', '18:00'))
    expect(st.tomorrowStartSec).toBe(63 * 3600)
  })

  it('H7 19:00 加班 1 小时', () => {
    const st = computeCountdown(p, at('2026-11-20', '19:00'))
    expect(st.phase).toBe('overtime')
    expect(st.overtimeSec).toBe(3600)
  })

  it('H8 周六 12:00 休息：距周一上班 45 小时', () => {
    const st = computeCountdown(p, at('2026-11-21', '12:00'))
    expect(st.phase).toBe('off')
    expect(st.untilStartSec).toBe(45 * 3600)
  })

  it('H9 无午休档 15:00 净剩 3 小时', () => {
    const q = makeProfile({ id: 'nl', name: '无午休', base: makeShift('09:00', '18:00', null) })
    expect(computeCountdown(q, at('2026-11-20', '15:00')).netRemainingSec).toBe(3 * 3600)
  })
})

// ─────────────────────────── I. 弹性打卡与预览（3） ───────────────────────────
describe('I 弹性打卡与未来预览', () => {
  it('I1 弹性 60 分钟：09:20 到达 → 上班 09:20、下班 18:20', () => {
    const p = makeProfile({ id: 'fx', name: '弹性', dayFlex: { enabled: true, flexMinutes: 60 } })
    const d = resolveDay(p, '2026-11-20', at('2026-11-20', '09:20'))
    expect(d.shift?.start).toBe('09:20')
    expect(d.shift?.end).toBe('18:20')
    expect(d.trail.join('|')).toContain('弹性打卡')
  })

  it('I2 超过弹性窗口不改时段（09:40 到达、窗口 30 分钟）', () => {
    const p = makeProfile({ id: 'fx', name: '弹性', dayFlex: { enabled: true, flexMinutes: 30 } })
    const d = resolveDay(p, '2026-11-20', at('2026-11-20', '09:40'))
    expect(d.shift?.start).toBe('09:00')
  })

  it('I3 未来 30 天预览长度与周末判定正确', () => {
    const p = makeProfile({ id: 'std', name: '朝九晚六双休' })
    const days = previewDays(p, new Date(2026, 10, 16), 30)
    expect(days).toHaveLength(30)
    expect(days[0].date).toBe('2026-11-16')
    expect(days.filter((d) => d.attendance.onDuty)).toHaveLength(22)
    expect(ymd(new Date(2026, 10, 16))).toBe('2026-11-16')
  })
})
