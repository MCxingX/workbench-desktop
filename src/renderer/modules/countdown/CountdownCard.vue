<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ScheduleSettings from './ScheduleSettings.vue'
import { fmtClock, fmtHuman, useSchedule } from './useSchedule'

const { state, active, countdown, save } = useSchedule()
const showSettings = ref(false)
const configured = ref(true)
const monthDone = ref(0)
const monthExpected = ref(0)
const streak = ref(0)
const todoPending = ref(0)
const todoDone = ref(0)
const nowMs = ref(Date.now())
let tickTimer = 0

onMounted(async () => {
  const s = await window.wb.settingsGet()
  configured.value = s.scheduleConfigured === '1'
  window.wb.onScheduleChanged(() => {
    configured.value = true
  })
  // 自己走秒：Eng 只给状态，午休/下班这些"到点"提示要靠本地时钟推进
  tickTimer = window.setInterval(() => (nowMs.value = Date.now()), 1000)
  void loadStats()
  window.wb.onCheckinChanged(() => void loadStats())
})

/** 本月到岗 / 连续到岗：摆在倒计时卡底部，省得为了看一眼数字切卡片 */
async function loadStats(): Promise<void> {
  try {
    const s = await window.wb.checkinStats()
    monthDone.value = s.monthDone
    monthExpected.value = s.monthExpected
    streak.value = s.streak
    const list = await window.wb.todosList('open')
    todoPending.value = list.length
    const done = await window.wb.todosDone(50)
    todoDone.value = done.length
  } catch {
    /* 还没配班表就算不出来，保持 0 */
  }
}

onBeforeUnmount(() => {
  if (tickTimer) window.clearInterval(tickTimer)
})

const phase = computed(() => countdown.value?.phase ?? 'off')

const mainValue = computed(() => {
  const c = countdown.value
  if (!c) return '--:--:--'
  switch (c.phase) {
    case 'before':
      return fmtClock(c.untilStartSec)
    case 'working':
    case 'lunch':
      return fmtClock(c.wallRemainingSec)
    case 'overtime':
      return fmtClock(c.overtimeSec)
    case 'after':
    case 'off':
      return fmtClock(c.untilStartSec || c.tomorrowStartSec)
    default:
      return '--:--:--'
  }
})

const mainLabel = computed(() => {
  const c = countdown.value
  if (!c) return ''
  switch (c.phase) {
    case 'before':
      return '距上班'
    case 'working':
      return '距下班'
    case 'lunch':
      return '距下班（午休中）'
    case 'overtime':
      return '已加班'
    case 'after':
      return '距下次上班'
    case 'off':
      return '休息中 · 距上班'
    default:
      return ''
  }
})

/** 距午休还有多少秒；已在午休或今天没午休时返回 null */
const untilLunchSec = computed<number | null>(() => {
  const l = countdown.value?.today.lunch
  if (!l) return null
  const now = new Date(nowMs.value)
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
  const [h, m] = l.start.split(':').map(Number)
  const target = h * 3600 + m * 60
  return nowSec < target ? target - nowSec : null
})

/** 午休还剩多少秒（自己算，不依赖 1 秒一次的引擎重算） */
const lunchLeftSec = computed<number | null>(() => {
  const l = countdown.value?.today.lunch
  if (!l) return null
  const now = new Date(nowMs.value)
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
  const [h, m] = l.start.split(':').map(Number)
  const [h2, m2] = l.end.split(':').map(Number)
  const from = h * 3600 + m * 60
  const to = h2 * 3600 + m2 * 60
  if (nowSec < from || nowSec >= to) return null
  return to - nowSec
})

/** 午休时长文案：1 小时 / 1 小时 30 分 */
function lunchSpanText(from: string, to: string): string {
  const [h1, m1] = from.split(':').map(Number)
  const [h2, m2] = to.split(':').map(Number)
  const mins = h2 * 60 + m2 - (h1 * 60 + m1)
  if (mins <= 0) return ''
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return [h > 0 ? `${h} 小时` : '', m > 0 ? `${m} 分` : ''].filter(Boolean).join(' ')
}

/**
 * 次要信息：今天怎么排的（上午/午休/下午）+ 各阶段倒计时。
 * 之前只显示"今日时段 08:30–18:00"，用户看不到中午几点休、休多久。
 */
const secondary = computed(() => {
  const c = countdown.value
  if (!c) return []
  const rows: { k: string; v: string }[] = []
  const shift = c.today.shift
  const lunch = c.today.lunch

  if (shift && lunch) {
    rows.push({ k: '上午', v: `${shift.start}–${lunch.start}` })
    rows.push({ k: '午休', v: `${lunch.start}–${lunch.end} · ${lunchSpanText(lunch.start, lunch.end)}`.replace(' · ', ' ') })
    rows.push({ k: '下午', v: `${lunch.end}–${shift.end}` })
  } else if (shift) {
    rows.push({ k: '今日时段', v: `${shift.start}–${shift.end}` })
  }

  if (c.phase === 'working' || c.phase === 'lunch') {
    rows.push({ k: '净工作剩余', v: fmtHuman(c.netRemainingSec) })
  }
  const ul = untilLunchSec.value
  if (c.phase === 'working' && ul !== null && ul > 0) {
    rows.push({ k: '距午休', v: fmtClock(ul) })
  }
  const ll = lunchLeftSec.value
  if (c.phase === 'lunch' && ll !== null) {
    rows.push({ k: '午休剩余', v: fmtClock(ll) })
  }
  if (c.phase === 'before') rows.push({ k: '净工作时长', v: fmtHuman(c.netRemainingSec) })
  if (c.phase === 'overtime') rows.push({ k: '今日应下班', v: shift?.end ?? '—' })
  if (c.phase === 'after' || c.phase === 'off') rows.push({ k: '下次上班', v: fmtHuman(c.tomorrowStartSec) })
  if (monthExpected.value > 0) rows.push({ k: '本月到岗', v: monthDone.value + '/' + monthExpected.value })
  if (streak.value > 0) rows.push({ k: '连续到岗', v: streak.value + ' 天' })
  rows.push({ k: '今日待办', v: todoPending.value + ' 条待做 · ' + todoDone.value + ' 条已完成' })
  return rows
})

/** 今日时间轴：上午 / 午休 / 下午 三段按时长分配宽度，并标出此刻在哪 */
const timeline = computed(() => {
  const c = countdown.value
  const shift = c?.today.shift
  if (!c || !shift) return null
  const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))
  const start = toMin(shift.start)
  let end = toMin(shift.end)
  if (end <= start) end += 24 * 60
  const lunch = c.today.lunch
  const segs: { k: string; kind: string; min: number }[] = []
  if (lunch) {
    const ls = toMin(lunch.start)
    const le = toMin(lunch.end)
    segs.push({ k: '上午', kind: 'work', min: Math.max(1, ls - start) })
    segs.push({ k: '午休', kind: 'lunch', min: Math.max(1, le - ls) })
    segs.push({ k: '下午', kind: 'work', min: Math.max(1, end - le) })
  } else {
    segs.push({ k: '工作', kind: 'work', min: Math.max(1, end - start) })
  }
  const now = new Date(nowMs.value)
  let nowMin = now.getHours() * 60 + now.getMinutes()
  if (nowMin < start) nowMin += 24 * 60
  const pct = ((nowMin - start) / (end - start)) * 100
  return { segs, pct: Math.max(0, Math.min(100, pct)) }
})
/** 今日进度：按净工作（已扣午休）算，跨零点班次自动 +24h */
const progress = computed(() => {
  const c = countdown.value
  const shift = c?.today.shift
  if (!c || !shift) return null
  const [sh, sm] = shift.start.split(':').map(Number)
  const [eh, em] = shift.end.split(':').map(Number)
  let total = eh * 60 + em - (sh * 60 + sm)
  if (total <= 0) total += 24 * 60
  const lunch = c.today.lunch
  if (lunch) {
    const [lh, lm] = lunch.start.split(':').map(Number)
    const [lh2, lm2] = lunch.end.split(':').map(Number)
    total -= lh2 * 60 + lm2 - (lh * 60 + lm)
  }
  if (total <= 0) return null
  const done = Math.max(0, Math.min(total, total - c.netRemainingSec / 60))
  return { pct: Math.round((done / total) * 100), doneMin: Math.round(done), totalMin: Math.round(total) }
})

function hoursText(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return [h > 0 ? h + ' 小时' : '', m > 0 ? m + ' 分' : ''].filter(Boolean).join(' ') || '0 分'
}

const trail = computed(() => countdown.value?.today.trail.join(' · ') ?? '')

async function onSaved(next: Parameters<typeof save>[0]): Promise<void> {
  await save(next)
  configured.value = true
  showSettings.value = false
}
</script>

<template>
  <div class="cd" :data-phase="phase">
    <div class="cd-top">
      <span class="cd-profile">{{ active?.name ?? '未配置班表' }}</span>
      <button class="cd-gear" @click="showSettings = true" title="班表设置">⚙</button>
    </div>

    <div class="cd-display">{{ mainValue }}</div>
    <div class="cd-label">{{ mainLabel }}</div>

    <div class="cd-bar" v-if="progress">
      <div class="cd-bar-fill" :style="{ width: progress.pct + '%' }" />
      <span class="cd-bar-text">今日 {{ progress.pct }}% · 已净干 {{ hoursText(progress.doneMin) }} / {{ hoursText(progress.totalMin) }}</span>
    </div>

    <div class="cd-timeline" v-if="timeline">
      <div
        v-for="s in timeline.segs"
        :key="s.k"
        class="cd-seg"
        :class="s.kind"
        :style="{ flexGrow: s.min }"
      >{{ s.k }}</div>
      <span class="cd-now" :style="{ left: timeline.pct + '%' }" />
    </div>

    <div class="cd-rows">
      <div v-for="r in secondary" :key="r.k" class="cd-row">
        <span class="k">{{ r.k }}</span>
        <span class="v">{{ r.v }}</span>
      </div>
    </div>

    <div class="cd-trail" :title="trail">{{ trail }}</div>
    <div class="cd-unset" v-if="!configured">班表还没配 · 按 <kbd>Ctrl+,</kbd> 或点 ⚙ 填一下上下班时间</div>

    <ScheduleSettings
      v-if="showSettings && state"
      :state="state"
      @close="showSettings = false"
      @saved="onSaved"
    />
  </div>
</template>

<style scoped>
.cd {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
  position: relative;
}

.cd-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.cd-profile {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.cd-gear {
  font-size: var(--fs-sm);
  color: var(--text-muted);
  padding: 0 4px;
  border-radius: var(--r-sm);
}

.cd-gear:hover {
  color: var(--text-primary);
  background: var(--bg-elev-3);
}

.cd-display {
  font-size: var(--fs-display);
  font-weight: 650;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  color: var(--text-primary);
  transition: color var(--motion-base);
}

.cd[data-phase='working'] .cd-display {
  color: var(--countdown-ok);
}

.cd[data-phase='lunch'] .cd-display {
  color: var(--countdown-warn);
}

.cd[data-phase='overtime'] .cd-display {
  color: var(--countdown-overtime);
}

.cd[data-phase='off'] .cd-display {
  color: var(--countdown-rest);
}

.cd-timeline {
  position: relative;
  display: flex;
  height: 22px;
  border-radius: 6px;
  overflow: hidden;
  margin-top: 10px;
  border: 1px solid var(--border);
}

.cd-seg {
  display: grid;
  place-items: center;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  overflow: hidden;
  white-space: nowrap;
}

.cd-seg.work {
  background: color-mix(in srgb, var(--countdown-ok) 12%, transparent);
}

.cd-seg.lunch {
  background: color-mix(in srgb, var(--countdown-warn) 18%, transparent);
}

.cd-now {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--accent);
}

.cd-bar {
  position: relative;
  height: 26px;
  border-radius: 999px;
  background: var(--bg-elev-3);
  overflow: hidden;
  margin: 2px 0 4px;
}

.cd-bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: color-mix(in srgb, var(--countdown-ok) 55%, transparent);
  transition: width 600ms var(--ease);
}

.cd-bar-text {
  position: relative;
  display: grid;
  place-items: center;
  height: 100%;
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.cd-label {
  font-size: var(--fs-sm);
  color: var(--text-muted);
}

.cd-rows {
  display: flex;
  flex-wrap: wrap;
  /* 每项宽度跟着内容走，不会被列宽拉开成"上午……09:00" */
  gap: 6px 20px;
  margin-top: 10px;
}

.cd-row {
  display: flex;
  gap: 6px;
  font-size: var(--fs-sm);
  min-width: 0;
}

.cd-row .v {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cd-row .k {
  color: var(--text-muted);
}

.cd-row .v {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.cd-trail {
  margin-top: auto;
  padding-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cd-unset {
  font-size: 12px;
  color: var(--countdown-warn, #d8a04a);
  padding: 2px 0;
}

kbd {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 3px;
}
</style>










