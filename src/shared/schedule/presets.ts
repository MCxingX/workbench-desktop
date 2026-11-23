import type { BaseShift, ShiftProfile, WeekVariant } from './model'

const MON_FRI = [true, true, true, true, true, false, false]
const MON_SAT = [true, true, true, true, true, true, false]

function shift(start: string, end: string, lunch: [string, string] | null = null): BaseShift {
  return { start, end, lunch: lunch ? { start: lunch[0], end: lunch[1] } : null }
}

function profile(patch: Partial<ShiftProfile> & { id: string; name: string }): ShiftProfile {
  return {
    base: shift('09:00', '18:00', ['12:00', '13:00']),
    mask: [...MON_FRI],
    useHolidays: true,
    weekCycle: {
      mode: 'none',
      anchorMonday: '2026-01-05',
      anchorVariant: 'primary',
      primary: null,
      secondary: null
    },
    monthOverrides: [],
    holidays: [],
    makeups: [],
    overrides: [],
    dayFlex: { enabled: false, flexMinutes: 0 },
    ...patch
  }
}

function variant(name: string, mask: boolean[], s: BaseShift): WeekVariant {
  return { name, mask, shift: s }
}

/** 10 个班表预设（对照 docs/09），全部可被用户改成任意值 */
export function builtinPresets(): ShiftProfile[] {
  return [
    profile({ id: 'p955', name: '朝九晚六 · 双休' }),
    profile({
      id: 'p956',
      name: '朝九晚六 · 单休（周日休）',
      mask: [...MON_SAT]
    }),
    profile({
      id: 'p996',
      name: '996',
      base: shift('09:00', '21:00', ['12:00', '13:00']),
      mask: [...MON_SAT]
    }),
    profile({
      id: 'p_big_small_week',
      name: '大小周（大周周六上班）',
      weekCycle: {
        mode: 'alternate',
        anchorMonday: '2026-11-02',
        anchorVariant: 'primary',
        primary: variant('大周', [...MON_SAT], shift('09:00', '18:00', ['12:00', '13:00'])),
        secondary: variant('小周', [...MON_FRI], shift('09:00', '18:00', ['12:00', '13:00']))
      }
    }),
    profile({
      id: 'p_odd_even_week',
      name: '单双周（单周六天，双周五天）',
      weekCycle: {
        mode: 'alternate',
        anchorMonday: '2026-11-02',
        anchorVariant: 'primary',
        primary: variant('单周', [...MON_SAT], shift('08:30', '18:00', ['12:00', '13:30'])),
        secondary: variant('双周', [...MON_FRI], shift('09:00', '18:00', ['12:00', '13:00']))
      }
    }),
    profile({
      id: 'p85',
      name: '早八晚五 · 双休',
      base: shift('08:00', '17:00', ['12:00', '13:00'])
    }),
    profile({
      id: 'p_afternoon',
      name: '午班 14:00–22:00',
      base: shift('14:00', '22:00', ['18:00', '19:00'])
    }),
    profile({
      id: 'p_night',
      name: '夜班 22:00–06:00（跨零点）',
      base: shift('22:00', '06:00', null)
    }),
    profile({
      id: 'p_shift_rotation',
      name: '运维轮值（两周交替，时段不同）',
      weekCycle: {
        mode: 'alternate',
        anchorMonday: '2026-11-02',
        anchorVariant: 'primary',
        primary: variant('A 班', [...MON_FRI], shift('08:00', '17:00', ['12:00', '13:00'])),
        secondary: variant('B 班', [...MON_FRI], shift('10:00', '19:00', ['12:30', '13:30']))
      }
    }),
    profile({
      id: 'p_no_lunch',
      name: '朝九晚六 · 无午休',
      base: shift('09:00', '18:00', null)
    })
  ]
}

export function baseProfile(): ShiftProfile {
  return profile({ id: 'default', name: '我的班表' })
}

export { profile as makeProfile, shift as makeShift, variant as makeVariant, MON_FRI, MON_SAT }
