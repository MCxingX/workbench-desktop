import type {
  AttendanceResult,
  BaseShift,
  CountdownState,
  HM,
  Lunch,
  MonthLunch,
  Piece,
  PersonalOverride,
  ResolvedDay,
  ShiftProfile
} from './model'
import {
  addDays,
  daysBetween,
  fmtHM,
  minutesOfDay,
  mondayOf,
  nowSecondsIntoDay,
  parseHM,
  parseYmd,
  weekIndexFromAnchor,
  weekdayIndex,
  ymd
} from './time'

const DAY = 1440

export interface ValidationIssue {
  field: string
  message: string
}

/** 保存前的校验（对照 docs/07 校验规则汇总） */
export function validateProfile(p: ShiftProfile): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const checkRange = (label: string, s: HM, e: HM) => {
    let sm: number
    let em: number
    try {
      sm = parseHM(s)
      em = parseHM(e)
    } catch {
      issues.push({ field: label, message: `时间格式应为 HH:mm` })
      return
    }
    if (sm === em) issues.push({ field: label, message: `${label} 的上班和下班时刻相同，时长不是零就是 24 小时，请修正` })
  }

  checkRange('基础班次', p.base.start, p.base.end)

  if (p.base.lunch) {
    try {
      const ls = parseHM(p.base.lunch.start)
      const le = parseHM(p.base.lunch.end)
      const ss = parseHM(p.base.start)
      const ee = parseHM(p.base.end)
      if (ls >= le) issues.push({ field: '午休', message: `午休结束 ${p.base.lunch.end} 不晚于开始 ${p.base.lunch.start}` })
      const overnight = ee <= ss
      if (!overnight && (ls < ss || le > ee)) {
        issues.push({ field: '午休', message: `午休 ${p.base.lunch.start}–${p.base.lunch.end} 超出班次 ${p.base.start}–${p.base.end}` })
      }
    } catch {
      issues.push({ field: '午休', message: '午休时间格式应为 HH:mm' })
    }
  }

  if (!p.mask.some(Boolean)) issues.push({ field: '周掩码', message: '一周七天都不是工作日，请至少选一天' })

  // 单双月午休：两侧分别校验，空的一侧表示沿用基础午休
  const ml = p.monthLunch
  if (ml?.enabled) {
    const sides: [string, Lunch | null][] = [['单月午休', ml.odd ?? null], ['双月午休', ml.even ?? null]]
    for (const [label, lunch] of sides) {
      if (!lunch) continue
      try {
        const ls = parseHM(lunch.start)
        const le = parseHM(lunch.end)
        const ss = parseHM(p.base.start)
        const ee = parseHM(p.base.end)
        if (ls >= le) issues.push({ field: label, message: `${label}结束 ${lunch.end} 不晚于开始 ${lunch.start}` })
        const overnight = ee <= ss
        if (!overnight && (ls < ss || le > ee)) {
          issues.push({ field: label, message: `${label} ${lunch.start}–${lunch.end} 超出班次 ${p.base.start}–${p.base.end}` })
        }
      } catch {
        issues.push({ field: label, message: `${label}时间格式应为 HH:mm` })
      }
    }
  }

  if (p.weekCycle.mode === 'alternate') {
    if (!p.weekCycle.primary || !p.weekCycle.secondary) {
      issues.push({ field: '两周交替', message: '启用两周交替需要两套设置都填好' })
    }
    try {
      const anchor = parseYmd(p.weekCycle.anchorMonday)
      if (weekdayIndex(anchor) !== 0) {
        issues.push({
          field: '基准周一',
          message: `请填写基准那一周的周一（当前 ${p.weekCycle.anchorMonday} 是周${'一二三四五六日'[weekdayIndex(anchor)]}）`
        })
      }
    } catch {
      issues.push({ field: '基准周一', message: '基准周一格式应为 YYYY-MM-DD' })
    }
  }

  for (const mo of p.monthOverrides) {
    if (!/^\d{4}-\d{2}$/.test(mo.ym)) issues.push({ field: '月规则', message: `月份格式应为 YYYY-MM，收到 "${mo.ym}"` })
    if (mo.shift?.start && mo.shift?.end) checkRange(`${mo.ym} 时段`, mo.shift.start, mo.shift.end)
    if (mo.mask && !mo.mask.some(Boolean)) issues.push({ field: '月规则', message: `${mo.ym} 的周掩码一天都没选` })
  }

  for (const ov of p.overrides) {
    if (ov.dateTo < ov.dateFrom) issues.push({ field: '例外', message: `例外结束日 ${ov.dateTo} 早于开始日 ${ov.dateFrom}` })
  }

  return issues
}

/** 该日生效的月覆盖（若有） */
export function monthOverrideOf(p: ShiftProfile, dateStr: string): ShiftProfile['monthOverrides'][number] | null {
  const ym = dateStr.slice(0, 7)
  return p.monthOverrides.find((m) => m.ym === ym) ?? null
}

function patchShift(base: BaseShift, patch?: Partial<BaseShift> | null): BaseShift {
  if (!patch) return base
  return {
    start: patch.start ?? base.start,
    end: patch.end ?? base.end,
    lunch: patch.lunch === undefined ? base.lunch : patch.lunch
  }
}

/** 单双月午休的兜底读取：老数据没有这个字段就是关闭 */
export function monthLunchOf(p: ShiftProfile): MonthLunch | null {
  const ml = p.monthLunch
  if (!ml || !ml.enabled) return null
  if (!ml.odd && !ml.even) return null
  return ml
}

/** 该月生效的单双月午休（奇数月 / 偶数月） */
export function monthLunchFor(p: ShiftProfile, dateStr: string): Lunch | null {
  const ml = monthLunchOf(p)
  if (!ml) return null
  const month = Number(dateStr.slice(5, 7))
  if (!month) return null
  return month % 2 === 1 ? ml.odd : ml.even
}

/** 该日生效的班次（基础 + 月覆盖 + 两周交替变体 + 单双月午休） */
export function effectiveShift(p: ShiftProfile, dateStr: string, variantShift?: BaseShift | null): BaseShift {
  const mo = monthOverrideOf(p, dateStr)
  let shift = patchShift(variantShift ?? p.base, mo?.shift ?? null)
  // 逐月规则指名了午休就以它为准；否则再看单双月
  const overrideTouchedLunch = mo?.shift?.lunch !== undefined
  if (!overrideTouchedLunch) {
    const ml = monthLunchFor(p, dateStr)
    if (ml) shift = { ...shift, lunch: ml }
  }
  return shift
}

/** 两周交替：该周用哪一套 */
export function variantOf(
  p: ShiftProfile,
  dateStr: string
): { variant: 'primary' | 'secondary'; weekIndex: number } | null {
  if (p.weekCycle.mode !== 'alternate' || !p.weekCycle.primary || !p.weekCycle.secondary) return null
  const idx = weekIndexFromAnchor(parseYmd(dateStr), p.weekCycle.anchorMonday)
  const even = ((idx % 2) + 2) % 2 === 0
  const usePrimary = p.weekCycle.anchorVariant === 'primary' ? even : !even
  return { variant: usePrimary ? 'primary' : 'secondary', weekIndex: idx }
}

function overrideFor(p: ShiftProfile, dateStr: string): PersonalOverride | null {
  const hits = p.overrides.filter((o) => dateStr >= o.dateFrom && dateStr <= o.dateTo)
  if (hits.length === 0) return null
  // 越具体的（范围越短）优先：按区间长度降序排，pop 出来的是最短那条
  return hits.sort((a, b) => daysBetween(parseYmd(b.dateFrom), parseYmd(b.dateTo)) - daysBetween(parseYmd(a.dateFrom), parseYmd(a.dateTo))).pop()!
}

/**
 * 五层判定：⓿个人例外 > ①法定假期 > ②调休补班 > ③两周交替 > ④周掩码
 * 命中即停，返回来源与命中链。
 */
export function resolveAttendance(p: ShiftProfile, dateStr: string): AttendanceResult {
  const extras: string[] = []
  const wd = weekdayIndex(parseYmd(dateStr))
  const mo = monthOverrideOf(p, dateStr)
  const moMask = mo?.mask ?? null

  // ⓿ 个人例外
  const ov = overrideFor(p, dateStr)
  if (ov) {
    if (ov.kind === 'off') {
      return { onDuty: false, source: 'override', reason: `个人例外：${ov.note || '休息'}`, extras }
    }
    if (ov.kind === 'mask') {
      const on = !!ov.payload?.days?.[wd]
      return { onDuty: on, source: 'override', reason: `个人例外：按例外周安排（${on ? '上班' : '休息'}）`, extras }
    }
    // shift：今天改成自定义时段，视为上班
    return { onDuty: true, source: 'override', reason: `个人例外：改时段 ${ov.payload?.start ?? ''}–${ov.payload?.end ?? ''}`.trim(), extras }
  }

  // ① 法定假期
  if (p.useHolidays) {
    const hol = p.holidays.find((h) => dateStr >= h.from && dateStr <= h.to)
    if (hol) {
      const idx = daysBetween(parseYmd(hol.from), parseYmd(dateStr)) + 1
      const total = daysBetween(parseYmd(hol.from), parseYmd(hol.to)) + 1
      const makeup = p.makeups.find((m) => m.date === dateStr)
      if (makeup) extras.push(`这天本来是${hol.name}假期，但被列为补班日`)
      else return { onDuty: false, source: 'holiday', reason: `法定假期：${hol.name} 第 ${idx} 天 / 共 ${total} 天`, extras }
    }
  }

  // ② 调休补班
  const mk = p.makeups.find((m) => m.date === dateStr)
  if (mk) {
    const fallbackMask = moMask ?? maskForDate(p, dateStr)
    if (!fallbackMask[wd]) extras.push(`这天本来是休息日，因${mk.name}调休补班`)
    return { onDuty: true, source: 'makeup', reason: `调休补班：${mk.name}`, extras }
  }

  // ③ 两周交替
  const v = variantOf(p, dateStr)
  if (v) {
    const mask = moMask ?? (v.variant === 'primary' ? p.weekCycle.primary!.mask : p.weekCycle.secondary!.mask)
    const on = !!mask[wd]
    return {
      onDuty: on,
      source: 'cycle',
      reason: `两周交替：${v.variant === 'primary' ? p.weekCycle.primary!.name : p.weekCycle.secondary!.name}（第 ${v.weekIndex} 周）`,
      extras
    }
  }

  // ④ 周掩码
  const mask = moMask ?? p.mask
  const on = !!mask[wd]
  return {
    onDuty: on,
    source: 'mask',
    reason: on ? `常规工作日（${'一二三四五六日'[wd]}）` : `常规休息日（${'一二三四五六日'[wd]}）`,
    extras
  }
}

function maskForDate(p: ShiftProfile, dateStr: string): boolean[] {
  const v = variantOf(p, dateStr)
  if (v) {
    return v.variant === 'primary' ? p.weekCycle.primary!.mask : p.weekCycle.secondary!.mask
  }
  return p.mask
}

/** 把班次展开成"从当天 00:00 起的工作片段"（已扣除午休；跨零点自动拆两段） */
export function expandPieces(shift: BaseShift): { work: Piece[]; span: Piece[] } {
  const s = parseHM(shift.start)
  const e = parseHM(shift.end)
  const span: Piece[] = e > s ? [{ from: s, to: e }] : [{ from: s, to: DAY }, { from: DAY, to: e + DAY }]

  let work = span.map((x) => ({ ...x }))
  if (shift.lunch) {
    const ls = parseHM(shift.lunch.start)
    const le = parseHM(shift.lunch.end)
    const next: Piece[] = []
    for (const piece of work) {
      if (ls < piece.from || le > piece.to || ls >= le) {
        next.push(piece)
        continue
      }
      if (ls > piece.from) next.push({ from: piece.from, to: ls })
      if (le < piece.to) next.push({ from: le, to: piece.to })
    }
    work = next
  }
  return { work, span }
}

/** 解析某个自然日（可带 now 以处理弹性打卡） */
export function resolveDay(p: ShiftProfile, dateStr: string, now?: Date): ResolvedDay {
  const attendance = resolveAttendance(p, dateStr)
  const trail: string[] = [attendance.reason, ...attendance.extras]
  if (!attendance.onDuty) {
    return { date: dateStr, attendance, pieces: [], shift: null, lunch: null, trail }
  }

  const v = variantOf(p, dateStr)
  const variantShift = v
    ? v.variant === 'primary'
      ? p.weekCycle.primary!.shift
      : p.weekCycle.secondary!.shift
    : null
  const mo = monthOverrideOf(p, dateStr)
  let shift = effectiveShift(p, dateStr, variantShift)
  const ov = overrideFor(p, dateStr)
  if (ov?.kind === 'shift' && ov.payload?.start && ov.payload?.end) {
    shift = { start: ov.payload.start, end: ov.payload.end, lunch: shift.lunch }
    trail.push(`例外时段 ${shift.start}–${shift.end}`)
  }

  // 弹性打卡：仅在"今天"且班次不跨零点时整体后移，最多 flexMinutes
  if (now && p.dayFlex.enabled && ymd(now) === dateStr && shift.end > shift.start) {
    const nowMin = minutesOfDay(now)
    const s = parseHM(shift.start)
    const limit = s + Math.max(0, p.dayFlex.flexMinutes)
    if (nowMin > s && nowMin <= limit) {
      const delta = Math.round(nowMin - s)
      shift = {
        start: fmtHM(s + delta),
        end: fmtHM(parseHM(shift.end) + delta),
        lunch: shift.lunch
      }
      trail.push(`弹性打卡：整体后移 ${delta} 分钟`)
    }
  }

  if (mo?.note) trail.push(mo.note)
  const { work } = expandPieces(shift)
  return { date: dateStr, attendance, pieces: work, shift, lunch: shift.lunch, trail }
}

/**
 * 当前时刻落在哪个班次里（含昨天的跨零点班次）。
 * 返回：所在日的班次、当天相对分钟数（已加 1440 偏移则 > 1440）
 */
export function activeShiftAt(
  p: ShiftProfile,
  now: Date
): { day: ResolvedDay; minute: number } | null {
  const todayStr = ymd(now)
  const today = resolveDay(p, todayStr, now)
  const nowMin = minutesOfDay(now)

  if (today.shift) {
    const s = parseHM(today.shift.start)
    const e = parseHM(today.shift.end)
    const overnight = e <= s
    const endAbs = overnight ? e + DAY : e
    if (nowMin >= s && nowMin < endAbs) return { day: today, minute: nowMin }
  }

  // 昨天跨零点
  const yStr = ymd(addDays(now, -1))
  const y = resolveDay(p, yStr)
  if (y.shift) {
    const ys = parseHM(y.shift.start)
    const ye = parseHM(y.shift.end)
    if (ye <= ys) {
      const endAbs = ye + DAY
      const minute = nowMin + DAY
      if (minute >= ys && minute < endAbs) return { day: y, minute }
    }
  }
  return null
}

/** 下一个上班时刻（用于 after 阶段倒计时） */
export function nextStartAfter(p: ShiftProfile, now: Date, lookaheadDays = 90): { date: string; start: number } | null {
  for (let i = 0; i <= lookaheadDays; i++) {
    const d = addDays(now, i)
    const ds = ymd(d)
    const day = resolveDay(p, ds)
    if (!day.shift) continue
    const s = parseHM(day.shift.start)
    if (i === 0 && minutesOfDay(now) >= s) {
      // 今天已过上班时刻：只有在跨零点且仍在班内时才算"还没上班"
      continue
    }
    return { date: ds, start: s }
  }
  return null
}

function sumPieces(pieces: Piece[], fromMin: number, toMin: number): number {
  let total = 0
  for (const piece of pieces) {
    const a = Math.max(piece.from, fromMin)
    const b = Math.min(piece.to, toMin)
    if (b > a) total += b - a
  }
  return total
}

/**
 * 倒计时状态机。
 * 口径：壁钟倒计时 = 到下班时刻；净工作时长 = 剩余工作片段之和（已扣午休）。
 */
export function computeCountdown(p: ShiftProfile, now: Date): CountdownState {
  const todayStr = ymd(now)
  const today = resolveDay(p, todayStr, now)
  const nowMin = minutesOfDay(now)
  const nowSec = nowSecondsIntoDay(now)

  const base: CountdownState = {
    phase: 'off',
    untilStartSec: 0,
    wallRemainingSec: 0,
    netRemainingSec: 0,
    lunchRemainingSec: 0,
    overtimeSec: 0,
    tomorrowStartSec: 0,
    today,
    label: today.attendance.reason
  }

  // 优先看在岗状态（含昨天跨零点的班次）
  const active = activeShiftAt(p, now)
  let day = active?.day ?? today
  let minute = active?.minute ?? nowMin

  // 夜班刚过下班点（今天不上班，但昨天的跨零点班次还没"结算"）→ 允许累计加班
  if (!active && !today.shift) {
    const yDay = resolveDay(p, ymd(addDays(now, -1)))
    if (yDay.shift) {
      const ys = parseHM(yDay.shift.start)
      const ye = parseHM(yDay.shift.end)
      if (ye <= ys && nowMin < ys) {
        day = yDay
        minute = nowMin + DAY
      }
    }
  }

  if (!day.shift) {
    const next = nextStartAfter(p, now)
    if (next) {
      const diffDays = daysBetween(parseYmd(todayStr), parseYmd(next.date))
      const secs = Math.max(0, Math.round(diffDays * 86_400 + next.start * 60 - nowSec))
      return { ...base, phase: 'off', untilStartSec: secs, tomorrowStartSec: secs }
    }
    return base
  }

  const shift = day.shift
  const s = parseHM(shift.start)
  const e = parseHM(shift.end)
  const endAbs = e <= s ? e + DAY : e
  const { work } = expandPieces(shift)
  const secondOfShiftDay = minute * 60

  // 上班前
  if (minute < s) {
    const untilStart = Math.max(0, Math.round(s * 60 - secondOfShiftDay))
    return {
      ...base,
      phase: 'before',
      untilStartSec: untilStart,
      wallRemainingSec: Math.max(0, Math.round(endAbs * 60 - secondOfShiftDay)),
      netRemainingSec: Math.round(sumPieces(work, 0, endAbs) * 60)
    }
  }

  // 午休中
  if (shift.lunch) {
    const ls = parseHM(shift.lunch.start)
    const le = parseHM(shift.lunch.end)
    if (minute >= ls && minute < le) {
      return {
        ...base,
        phase: 'lunch',
        lunchRemainingSec: Math.max(0, Math.round(le * 60 - secondOfShiftDay)),
        wallRemainingSec: Math.max(0, Math.round(endAbs * 60 - secondOfShiftDay)),
        netRemainingSec: Math.round(sumPieces(work, minute, endAbs) * 60)
      }
    }
  }

  // 班内
  if (minute < endAbs) {
    return {
      ...base,
      phase: 'working',
      wallRemainingSec: Math.max(0, Math.round(endAbs * 60 - secondOfShiftDay)),
      netRemainingSec: Math.round(sumPieces(work, minute, endAbs) * 60)
    }
  }

  // 已下班（加班累计，最多 24 小时）
  const overtime = Math.min(86_400, Math.max(0, Math.round((minute - endAbs) * 60)))
  const next = nextStartAfter(p, now)
  let tomorrow = 0
  if (next) {
    const diffDays = daysBetween(parseYmd(todayStr), parseYmd(next.date))
    tomorrow = Math.max(0, Math.round(diffDays * 86_400 + next.start * 60 - nowSec))
  }
  return { ...base, phase: overtime > 0 ? 'overtime' : 'after', overtimeSec: overtime, tomorrowStartSec: tomorrow }
}

/** 未来 N 天的班表预览 */
export function previewDays(p: ShiftProfile, from: Date, days: number): ResolvedDay[] {
  const out: ResolvedDay[] = []
  for (let i = 0; i < days; i++) out.push(resolveDay(p, ymd(addDays(from, i))))
  return out
}

export { mondayOf }
