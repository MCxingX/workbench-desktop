<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { WorklogRow } from '@shared/types'

const rows = ref<WorklogRow[]>([])
const draft = ref('')
const toast = ref('')
const day = ref('')
const days = ref<{ day: string; count: number }[]>([])
const editId = ref('')
const editText = ref('')

function ymd(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function flash(msg: string): void {
  toast.value = msg
  setTimeout(() => (toast.value = ''), 2000)
}

async function load(): Promise<void> {
  rows.value = await window.wb.worklogList(day.value || undefined)
  days.value = await window.wb.worklogDays(30)
}

async function add(): Promise<void> {
  const text = draft.value.trim()
  if (!text) return
  try {
    await window.wb.worklogAdd(text)
    draft.value = ''
    await load()
  } catch (err) {
    flash('没存上：' + ((err as Error)?.message ?? ''))
  }
}

async function remove(r: WorklogRow): Promise<void> {
  try {
    await window.wb.worklogDelete(r.id)
    await load()
  } catch (err) {
    flash('没删掉：' + ((err as Error)?.message ?? ''))
  }
}

function startEdit(r: WorklogRow): void {
  editId.value = r.id
  editText.value = r.text
}

async function saveEdit(r: WorklogRow): Promise<void> {
  const text = editText.value.trim()
  editId.value = ''
  if (!text || text === r.text) return
  await window.wb.worklogUpdate(r.id, text)
  await load()
  flash('已改')
}

async function copyWeek(): Promise<void> {
  const r = await window.wb.weekReport()
  if (!r || !r.text) {
    flash('本周还没有记录')
    return
  }
  await navigator.clipboard.writeText(r.text)
  flash('周报已复制，可直接粘贴')
}

async function copySummary(): Promise<void> {
  const text = await window.wb.dailySummary(day.value || undefined)
  if (!text) {
    flash('这天还没有记录')
    return
  }
  await navigator.clipboard.writeText(text)
  flash('小结已复制，可直接粘贴')
}

function goDay(delta: number): void {
  const base = day.value ? new Date(day.value + 'T00:00:00') : new Date()
  base.setDate(base.getDate() + delta)
  day.value = ymd(base)
  void load()
}

function backToday(): void {
  day.value = ymd()
  void load()
}

const dateLabel = computed(() => {
  const d = new Date((day.value || ymd()) + 'T00:00:00')
  const isToday = day.value === ymd()
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日${isToday ? '' : ' · 历史'}`
})

const hasHistory = computed(() => days.value.some((d) => d.day !== ymd()))

onMounted(() => {
  day.value = ymd()
  void load()
})
defineExpose({ load })
</script>

<template>
  <div class="wl" data-module="worklog">
    <div class="wl-head">
      <button class="nav" @click="goDay(-1)">‹</button>
      <span class="wl-title">{{ dateLabel }}</span>
      <button class="nav" @click="goDay(1)">›</button>
      <span class="spacer" />
      <button class="wl-copy" @click="copySummary">复制小结</button>
      <button class="wl-copy" @click="copyWeek">复制周报</button>
    </div>

    <input v-model="draft" class="wl-input" placeholder="记一句…（回车保存）" @keydown.enter.prevent="add" />

    <div class="wl-list">
      <div v-for="r in rows" :key="r.id" class="row">
        <span class="at">{{ r.at }}</span>
        <input
          v-if="editId === r.id"
          v-model="editText"
          class="edit"
          @keydown.enter.prevent="saveEdit(r)"
          @keydown.esc="editId = ''"
          @blur="saveEdit(r)"
        />
        <span v-else class="text" title="双击修改" @dblclick="startEdit(r)">{{ r.text }}</span>
        <span class="kind" v-if="r.kind && r.kind !== 'note'">{{ r.kind === 'receipt' ? '回执' : r.kind }}</span>
        <button class="del" @click="remove(r)">✕</button>
      </div>
      <div v-if="rows.length === 0" class="empty">{{ day === ymd() ? '今天还没写' : '这天没有记录' }}</div>
    </div>

    <div class="wl-foot" v-if="hasHistory">
      <span class="lb">最近</span>
      <button v-for="d in days.filter((x) => x.day !== ymd()).slice(0, 8)" :key="d.day" class="day" @click="day = d.day; load()">
        {{ d.day.slice(5) }}<em>{{ d.count }}</em>
      </button>
      <button class="day" @click="backToday">今天</button>
    </div>
    <div class="wl-toast" v-if="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.wl {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
}

.wl-head {
  display: flex;
  align-items: center;
  gap: 4px;
}

.nav {
  color: var(--text-muted);
  padding: 0 4px;
}

.nav:hover {
  color: var(--accent);
}

.wl-title {
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-secondary);
}

.spacer {
  flex: 1;
}

.wl-copy {
  font-size: 12px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--r-sm);
  padding: 1px 7px;
}

.wl-copy:hover {
  background: var(--accent-weak);
}

.wl-input,
.edit {
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 5px 8px;
  font-size: var(--fs-body);
  color: var(--text-primary);
}

.wl-input:focus,
.edit:focus {
  border-color: var(--accent);
  outline: none;
}

.wl-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  min-height: var(--list-row);
  border-radius: var(--r-sm);
}

/* 时间戳挪到行尾：整列文字左缘才能对齐（原来时间在最前，正文比别的卡右 19px） */
.row::before {
  content: '';
  flex: 0 0 var(--slot);
}

.row:hover {
  background: var(--bg-hover);
}

.at {
  font-size: 12px;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--text-muted);
  flex: 0 0 auto;
  order: 9;
  margin-left: auto;
}

.text {
  flex: 1;
  font-size: var(--fs-sm);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
}

.edit {
  flex: 1;
  font-size: var(--fs-sm);
  padding: 2px 6px;
}

.kind {
  font-size: 12px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 5px;
}

.del {
  font-size: 12px;
  color: var(--text-muted);
  opacity: 0.45;
}

.row:hover .del {
  opacity: 1;
}

.del:hover {
  color: var(--countdown-urgent);
}

.empty {
  font-size: 12px;
  color: var(--text-muted);
  padding: 6px 2px;
}

.wl-foot {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  border-top: 1px solid var(--border);
  padding-top: 4px;
}

.lb {
  font-size: 12px;
  color: var(--text-muted);
}

.day {
  font-size: 12px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 6px;
}

.day em {
  font-style: normal;
  color: var(--accent);
  margin-left: 2px;
}

.day:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.wl-toast {
  font-size: 12px;
  color: var(--accent);
}

/* 空态居���：空列表时把提示摆在卡片中间，卡片看起来才是"满的" */
.empty {
  margin: auto;
  text-align: center;
  color: var(--text-muted);
  font-size: var(--fs-sm);
}
</style>

