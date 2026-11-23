/**
 * 班表模型（对照 docs/03 工作制规则引擎 v1.1）
 * 一切数值均由用户填写，代码里没有任何"默认作息"假设。
 */

/** 0=周一 … 6=周日 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** "HH:mm" */
export type HM = string

export interface Lunch {
  start: HM
  end: HM
}

/** 基础班次：下班 ≤ 上班 视为跨零点夜班，归属开始那一天 */
export interface BaseShift {
  start: HM
  end: HM
  lunch: Lunch | null
}

export interface WeekVariant {
  /** 展示用名称，如 "单周"/"双周"/"大周"/"小周" */
  name: string
  /** 7 个工作日标志，索引 0=周一 */
  mask: boolean[]
  shift: BaseShift
}

export type WeekCycleMode = 'none' | 'alternate'

export interface WeekCycle {
  mode: WeekCycleMode
  /** 基准那一周的周一，YYYY-MM-DD */
  anchorMonday: string
  /** 基准周使用哪一套：'primary' = A 套，'secondary' = B 套 */
  anchorVariant: 'primary' | 'secondary'
  primary: WeekVariant | null
  secondary: WeekVariant | null
}

/** 逐月覆盖：某个月整体换时段 / 换掩码 */
export interface MonthOverride {
  /** YYYY-MM */
  ym: string
  shift?: Partial<BaseShift> | null
  mask?: boolean[] | null
  note?: string
}

export interface HolidaySpan {
  name: string
  /** YYYY-MM-DD */
  from: string
  to: string
}

export interface MakeupWorkday {
  date: string
  /** 对应哪个假期，如 "国庆节" */
  name: string
}

/** 个人例外：优先级最高 */
export interface PersonalOverride {
  id: string
  /** YYYY-MM-DD */
  dateFrom: string
  dateTo: string
  kind: 'off' | 'shift' | 'mask'
  /** off 时为空；shift 时 {start,end}；mask 时 {days:boolean[]} */
  payload?: { start?: HM; end?: HM; days?: boolean[] } | null
  note?: string
}

/** 弹性打卡：允许上班时刻整体后移，最大浮动 flexMinutes */
export interface DayFlex {
  enabled: boolean
  flexMinutes: number
}

export interface ShiftProfile {
  id: string
  name: string
  base: BaseShift
  /** 常规周掩码（未启用两周交替时使用） */
  mask: boolean[]
  useHolidays: boolean
  weekCycle: WeekCycle
  monthOverrides: MonthOverride[]
  holidays: HolidaySpan[]
  makeups: MakeupWorkday[]
  overrides: PersonalOverride[]
  dayFlex: DayFlex
}

/** 五层判定来源 */
export type AttendanceSource = 'override' | 'holiday' | 'makeup' | 'cycle' | 'mask'

export interface AttendanceResult {
  /** 是否上班 */
  onDuty: boolean
  source: AttendanceSource
  /** 人话说明，用于界面"命中链" */
  reason: string
  /** 附带说明，如"这天本来是补班日" */
  extras: string[]
}

/** 时间片段：从当天 00:00 起的分钟数，end 可 > 1440 表示跨零点 */
export interface Piece {
  from: number
  to: number
}

export interface ResolvedDay {
  date: string
  attendance: AttendanceResult
  /** 该日"本班次"的上班片段（可能跨零点，end 可 > 1440） */
  pieces: Piece[]
  /** 生效的班次（用于展示"今天 09:00–18:00"） */
  shift: BaseShift | null
  /** 午休（若当天有效） */
  lunch: Lunch | null
  /** 规则来源说明 */
  trail: string[]
}

export type CountdownPhase = 'off' | 'before' | 'working' | 'lunch' | 'after' | 'overtime'

export interface CountdownState {
  phase: CountdownPhase
  /** 距离今日上班还有多少秒（before） */
  untilStartSec: number
  /** 距离今天下班还有多少秒（working/lunch，按壁钟） */
  wallRemainingSec: number
  /** 今天净工作时长还剩多少秒（已扣午休） */
  netRemainingSec: number
  /** 午休剩余秒（lunch） */
  lunchRemainingSec: number
  /** 已加班秒数（overtime） */
  overtimeSec: number
  /** 明天上班倒计时（after） */
  tomorrowStartSec: number
  /** 今日班次与判定 */
  today: ResolvedDay
  /** 人话 */
  label: string
}
