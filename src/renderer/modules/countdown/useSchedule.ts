import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ScheduleState } from '@shared/types'
import type { ShiftProfile } from '@shared/schedule/model'
import { computeCountdown } from '@shared/schedule/resolve'

/** 班表状态 + 每秒重算的倒计时（主进程与渲染进程共用同一份引擎代码） */
export function useSchedule() {
  const state = ref<ScheduleState | null>(null)
  const nowMs = ref(Date.now())
  let timer: number | undefined

  const active = computed<ShiftProfile | null>(() => {
    const s = state.value
    if (!s || s.profiles.length === 0) return null
    return s.profiles.find((p) => p.id === s.activeId) ?? s.profiles[0]
  })

  const countdown = computed(() => (active.value ? computeCountdown(active.value, new Date(nowMs.value)) : null))

  async function load(): Promise<void> {
    state.value = await window.wb.scheduleGet()
  }

  /** 保存后拿主进程回读的结果（保证界面 = 库里的真实值） */
  async function save(next: ScheduleState): Promise<void> {
    state.value = await window.wb.scheduleSave(next)
  }

  let offSchedule: (() => void) | null = null

  onMounted(() => {
    void load()
    // 任何地方（向导 / 系统设置 / 别的卡片）改了班表，这里立即跟上
    window.wb.onScheduleChanged((s) => {
      state.value = s
    })
    timer = window.setInterval(() => {
      nowMs.value = Date.now()
    }, 1000)
  })

  onBeforeUnmount(() => {
    if (timer) window.clearInterval(timer)
  })

  return { state, active, countdown, load, save, nowMs }
}

/** 秒 → "3:12:45" */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** 秒 → "3 小时 12 分" */
export function fmtHuman(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h === 0) return `${m} 分钟`
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

