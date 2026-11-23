<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { CalendarCell, CheckinRow, CheckinStats } from '@shared/types'

const today = ref('')
const ym = ref('')
const row = ref<CheckinRow | null>(null)
const stats = ref<CheckinStats>({ monthDone: 0, monthExpected: 0, streak: 0, yearDone: 0, missing: 0 })
const cells = ref<CalendarCell[]>([])
const msg = ref('')

const editing = ref<CalendarCell | null>(null)
const editAt = ref('')
const editNote = ref('')
const editBackfill = ref(false)

const WD = ['一', '二', '三', '四', '五', '六', '日']

function ymdNow(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

onMounted(async () => {
  today.value = ymdNow()
  ym.value = today.value.slice(0, 7)
  await refresh()
  window.wb.onCheckinChanged(() => void refresh())
  // 班表一改，应到天数/休息日/缺卡判定都要跟着变
  window.wb.onScheduleChanged(() => void refresh())
})

const shown = ref({ done: 0, expected: 0, missing: 0 })

async function refresh(): Promise<void> {
  try {
    row.value = await window.wb.checkinGet(today.value)
    stats.value = await window.wb.checkinStats()
    cells.value = await window.wb.checkinCalendar(ym.value)
    // 分子分母必须同月：原来分子跟着翻月、分母恒为本月，翻到别的月数字就没意义
    shown.value = await window.wb.checkinMonthSummary(ym.value)
  } catch (err) {
    flash('刷新失败：' + ((err as Error)?.message ?? ''))
  }
}

function flash(t: string): void {
  msg.value = t
  setTimeout(() => (msg.value = ''), 2600)
}

/** 一个按钮：点了就记，记完按钮消失 */
async function mark(): Promise<void> {
  try {
    row.value = await window.wb.checkinMark(today.value, {})
    await refresh()
    flash('已记录到岗')
  } catch (err) {
    flash('打卡失败：' + ((err as Error)?.message ?? ''))
  }
}

async function undoToday(): Promise<void> {
  await window.wb.checkinUndo(today.value)
  await refresh()
  flash('已撤销今天')
}

function openCell(c: CalendarCell): void {
  editing.value = c
  editAt.value = (c.at ?? '').slice(0, 5)
  editNote.value = c.note ?? ''
  editBackfill.value = c.backfill === true || (!c.marked && c.day !== today.value)
}

function closeCell(): void {
  editing.value = null
}

/** 保存：已有记录=改时间和备注；没有=任意日期补记 */
async function saveCell(): Promise<void> {
  const c = editing.value
  if (!c) return
  if (c.marked) {
    await window.wb.checkinUpdate(c.day, { at: editAt.value, note: editNote.value, isBackfill: editBackfill.value })
    flash(`${c.day} 已更新`)
  } else {
    await window.wb.checkinMark(c.day, { at: editAt.value || undefined, note: editNote.value, isBackfill: true })
    flash(`${c.day} 已补记`)
  }
  editing.value = null
  await refresh()
}

async function deleteCell(): Promise<void> {
  const c = editing.value
  if (!c) return
  await window.wb.checkinUndo(c.day)
  editing.value = null
  await refresh()
  flash(`${c.day} 记录已删除`)
}

function editToday(): void {
  const c = cells.value.find((x) => x.day === today.value)
  openCell(
    c ?? {
      day: today.value,
      onDuty: true,
      marked: !!row.value,
      backfill: false,
      note: row.value?.note ?? null,
      at: row.value?.marked_at ?? null,
      missing: false,
      isToday: true,
      weekday: 0,
      holiday: null
    }
  )
}


// ── 批量补卡：一个月十几个缺卡，不该一天一天点 ──
const batching = ref(false)
const batchAt = ref(localStorage.getItem('wb.batchAt') || '09:00')
const picks = ref<Record<string, boolean>>({})

const missingCells = computed(() => cells.value.filter((c) => c.missing))
const pickedDays = computed(() => missingCells.value.filter((c) => picks.value[c.day] !== false).map((c) => c.day))

function openBatch(): void {
  const p: Record<string, boolean> = {}
  for (const c of missingCells.value) p[c.day] = true
  picks.value = p
  batching.value = true
}

function togglePick(day: string): void {
  picks.value = { ...picks.value, [day]: picks.value[day] === false }
}

function pickAll(on: boolean): void {
  const p: Record<string, boolean> = {}
  for (const c of missingCells.value) p[c.day] = on
  picks.value = p
}

async function doBatch(): Promise<void> {
  const days = pickedDays.value
  if (days.length === 0) return
  try {
    localStorage.setItem('wb.batchAt', batchAt.value)
    const r = await window.wb.checkinMarkMany(days, { at: batchAt.value || undefined })
    batching.value = false
    await refresh()
    flash("已补 " + r.done + " 天" + (r.skipped ? "，跳过 " + r.skipped + " 天" : ""))
  } catch (err) {
    flash('批量补卡失败：' + ((err as Error)?.message ?? ''))
  }
}

async function shiftMonth(delta: number): Promise<void> {
  const [y, m] = ym.value.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  ym.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  cells.value = await window.wb.checkinCalendar(ym.value)
}

async function exportXlsx(): Promise<void> {
  const r = await window.wb.checkinExport(ym.value)
  flash(`已导出 ${r.rows} 行 → ${r.file.split('\\').pop()}`)
}

const leading = computed(() => {
  if (cells.value.length === 0) return 0
  return (cells.value[0].weekday + 6) % 7
})

const monthDone = computed(() => cells.value.filter((c) => c.marked).length)
const monthMissing = computed(() => cells.value.filter((c) => c.missing).length)
</script>

<template>
  <div class="ck">
    <div class="ck-today">
      <template v-if="!row">
        <button class="ck-btn" @click="mark">打卡</button>
        <span class="ck-hint">点一下就记，记完按钮消失</span>
      </template>
      <template v-else>
        <span class="ck-at">{{ (row.marked_at ?? '').slice(0, 5) }}</span>
        <span class="ck-done">已到岗{{ row.is_backfill ? '（补）' : '' }}</span>
        <button class="ck-mini" @click="editToday">改时间</button>
        <button class="ck-mini" @click="undoToday">撤销</button>
      </template>
    </div>

    <div class="ck-cal">
      <div class="ck-calhead">
        <button class="ck-nav" @click="shiftMonth(-1)">‹</button>
        <span class="ck-ym">{{ ym }}</span>
        <button class="ck-nav" @click="shiftMonth(1)">›</button>
        <span class="ck-stat">{{ shown.done }}/{{ shown.expected }}</span>
        <button class="ck-mini" @click="exportXlsx">导出</button>
      </div>
      <div class="ck-wd"><span v-for="w in WD" :key="w">{{ w }}</span></div>
      <div class="ck-grid">
        <span v-for="n in leading" :key="'p' + n" class="ck-blank" />
        <button
          v-for="c in cells"
          :key="c.day"
          class="ck-day"
          :class="{
            off: !c.onDuty,
            marked: c.marked,
            backfill: c.backfill,
            missing: c.missing,
            today: c.isToday,
            holiday: !!c.holiday
          }"
          :title="c.day + (c.holiday ? ' ' + c.holiday : '') + (c.note ? ' · ' + c.note : '')"
          @click="openCell(c)"
        >
          <span class="ck-d">{{ Number(c.day.slice(8)) }}</span>
          <span class="ck-dot" v-if="c.marked" />
        </button>
      </div>
      <div class="ck-batchbar" v-if="missingCells.length > 0">
        <span class="ck-batchtext">{{ missingCells.length }} 天缺卡</span>
        <button class="ck-mini go" @click="openBatch">批量补上</button>
      </div>
      <div class="ck-legend">
        <span><i class="lg marked" />已到岗</span>
        <span><i class="lg backfill" />补记</span>
        <span><i class="lg missing" />缺卡</span>
        <span><i class="lg off" />休息</span>
      </div>
    </div>

    <div class="ck-stats">
      <div><b>{{ stats.streak }}</b><em>连续到岗</em></div>
      <div><b>{{ stats.monthDone }}</b><em>本月到岗</em></div>
      <div><b>{{ stats.yearDone }}</b><em>本年累计</em></div>
      <div v-if="monthMissing > 0" class="warn"><b>{{ monthMissing }}</b><em>本月缺卡</em></div>
    </div>

    <div class="ck-msg" v-if="msg">{{ msg }}</div>

    <div class="ck-mask" v-if="batching" @click.self="batching = false">
      <div class="ck-pop ck-batch">
        <div class="ck-pophead">
          <b>批量补卡 · {{ ym }}</b>
          <span class="ck-mini-tag">{{ missingCells.length }} 天缺卡</span>
          <button class="ck-x" @click="batching = false">✕</button>
        </div>

        <div class="ck-batch-list">
          <button
            v-for="c in missingCells"
            :key="c.day"
            class="ck-chip"
            :class="{ on: picks[c.day] !== false }"
            :title="c.day"
            @click="togglePick(c.day)"
          >{{ Number(c.day.slice(8)) }}</button>
        </div>

        <div class="ck-batch-row">
          <button class="ck-mini" @click="pickAll(true)">全选</button>
          <button class="ck-mini" @click="pickAll(false)">清空</button>
          <span class="ck-l inline">到岗时间</span>
          <input type="time" v-model="batchAt" />
        </div>

        <div class="ck-popfoot">
          <button class="ck-mini" @click="batching = false">取消</button>
          <button class="ck-btn" :disabled="pickedDays.length === 0" @click="doBatch">
            补 {{ pickedDays.length }} 天
          </button>
        </div>
      </div>
    </div>

    <div class="ck-mask" v-if="editing" @click.self="closeCell">
      <div class="ck-pop">
        <div class="ck-pophead">
          <b>{{ editing.day }}</b>
          <span class="ck-mini-tag" v-if="editing.holiday">{{ editing.holiday }}</span>
          <span class="ck-mini-tag" v-else-if="!editing.onDuty">休息日</span>
          <button class="ck-x" @click="closeCell">✕</button>
        </div>
        <label class="ck-l">到岗时间</label>
        <input type="time" v-model="editAt" />
        <label class="ck-l">备注</label>
        <input v-model="editNote" placeholder="迟到/外出/请假…（可不填）" />
        <label class="ck-check">
          <input type="checkbox" v-model="editBackfill" /> 标记为补记
        </label>
        <div class="ck-popfoot">
          <button class="ck-mini danger" v-if="editing.marked" @click="deleteCell">删除记录</button>
          <span class="ck-sp" />
          <button class="ck-mini" @click="closeCell">取消</button>
          <button class="ck-mini go" @click="saveCell">{{ editing.marked ? '保存修改' : '补记这一天' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ck {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--fs-body);
}

.ck-today {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
}

.ck-btn {
  background: var(--accent);
  color: #fff;
  border-radius: var(--r-md);
  padding: 6px 18px;
  font-size: var(--fs-body);
  font-weight: 600;
  letter-spacing: 1px;
}

.ck-btn:hover {
  filter: brightness(1.08);
}

.ck-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.ck-at {
  font-family: ui-monospace, Consolas, monospace;
  font-size: var(--fs-h1);
  font-weight: 700;
  color: var(--accent);
}

.ck-done {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.ck-mini {
  font-size: 12px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 0 6px;
  flex: 0 0 auto;
  white-space: nowrap;
}

.ck-mini:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.ck-mini.go {
  background: var(--accent);
  color: #fff;
  border-color: transparent;
}

.ck-mini.danger:hover {
  color: var(--countdown-urgent);
  border-color: var(--countdown-urgent);
}

.ck-cal {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ck-batchbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0 0;
}

.ck-batchtext {
  font-size: var(--fs-sm);
  color: var(--countdown-urgent);
}

.ck-calhead {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-sm);
}

.ck-nav {
  color: var(--text-muted);
  padding: 0 4px;
}

.ck-nav:hover {
  color: var(--accent);
}

.ck-ym {
  font-family: ui-monospace, Consolas, monospace;
  color: var(--text-secondary);
}

.ck-stat {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-muted);
}

.ck-wd {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

.ck-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  /* 固定 6 行：5 周的月份不再比 6 周矮 26px，翻月时整卡不上下跳 */
  grid-template-rows: repeat(6, 24px);
  gap: 2px;
}

.ck-blank {
  height: 24px;
}

.ck-day {
  position: relative;
  height: 24px;
  border-radius: 5px;
  border: 1px solid transparent;
  background: var(--bg-elev-2);
  color: var(--text-secondary);
  font-size: 12px;
  display: grid;
  place-items: center;
}

.ck-day:hover {
  border-color: var(--border-strong);
}

.ck-day.off {
  background: transparent;
  color: var(--text-muted);
  opacity: 0.5;
}

.ck-day.marked {
  background: var(--accent-weak);
  color: var(--accent);
}

.ck-day.backfill {
  border-style: dashed;
  border-color: var(--accent);
}

/* 缺卡不再整格描红：一个月十几格红框像报错。改成淡底 + 右下角红点 */
.ck-day.missing {
  border-color: transparent;
  background: color-mix(in srgb, var(--countdown-urgent) 12%, var(--bg-elev-2));
  color: var(--text-secondary);
}

.ck-day.missing::after {
  content: '';
  position: absolute;
  right: 4px;
  bottom: 3px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--countdown-urgent);
}

.ck-day.today {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
  font-weight: 700;
}

.ck-day.holiday {
  color: var(--countdown-warn, #d8a04a);
}

.ck-dot {
  position: absolute;
  bottom: 2px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
}

.ck-legend {
  display: flex;
  gap: 10px;
  font-size: 12px;
  color: var(--text-muted);
}

.lg {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 2px;
  margin-right: 3px;
  vertical-align: middle;
}

.lg.marked {
  background: var(--accent);
}

.lg.backfill {
  border: 1px dashed var(--accent);
}

.lg.missing {
  border: 1px solid var(--countdown-urgent);
}

.lg.off {
  background: var(--bg-elev-2);
  opacity: 0.5;
}

.ck-stats {
  display: flex;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 5px;
}

.ck-stats div {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  /* 等宽：数字位数变化不再推动列位 */
  flex: 1;
  min-width: 0;
}

.ck-stats b {
  font-size: var(--fs-h2);
  color: var(--text-primary);
}

.ck-stats em {
  font-size: 12px;
  font-style: normal;
  color: var(--text-muted);
}

.ck-stats .warn b {
  color: var(--countdown-urgent);
}

.ck-batch {
  width: 320px;
}

.ck-batch-list {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
  max-height: 132px;
  overflow: auto;
}

.ck-chip {
  height: 26px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

.ck-chip.on {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--accent);
}

.ck-batch-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ck-l.inline {
  margin: 0 0 0 auto;
}

.ck-popfoot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.ck-msg {
  font-size: 12px;
  color: var(--accent);
}

.ck-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: grid;
  place-items: center;
  z-index: var(--z-overlay);
}

.ck-pop {
  width: 280px;
  background: var(--bg-elev-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}

.ck-pophead {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-body);
}

.ck-mini-tag {
  font-size: 12px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 6px;
}

.ck-x {
  margin-left: auto;
  color: var(--text-muted);
}

.ck-l {
  font-size: 12px;
  color: var(--text-muted);
}

.ck-pop input[type='time'],
.ck-pop input:not([type]) {
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  padding: 3px 6px;
}

.ck-check {
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
}

.ck-popfoot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.ck-sp {
  flex: 1;
}
</style>









