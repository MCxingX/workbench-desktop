<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { TodoRow } from '@shared/types'

const list = ref<TodoRow[]>([])
const done = ref<TodoRow[]>([])
const draft = ref('')
const scope = ref<'today' | 'all'>('today')
const catFilter = ref('')
const showDone = ref(false)
const leaving = ref<Set<string>>(new Set())
const hint = ref('')
const editId = ref('')
const editText = ref('')
const dragId = ref('')

async function load(): Promise<void> {
  list.value = await window.wb.todosList(scope.value)
  if (showDone.value) done.value = await window.wb.todosDone(20)
}

async function add(): Promise<void> {
  const text = draft.value.trim()
  if (!text) return
  try {
    await window.wb.todoAdd(text, catFilter.value ? { category: catFilter.value } : undefined)
    draft.value = ''
    await load()
    hint.value = '已加入'
  } catch (err) {
    hint.value = '没存上：' + ((err as Error)?.message ?? '')
  }
  setTimeout(() => (hint.value = ''), 1400)
}

async function complete(t: TodoRow): Promise<void> {
  leaving.value.add(t.id)
  try {
    await window.wb.todoComplete(t.id)
  } catch (err) {
    leaving.value.delete(t.id)
    hint.value = '没完成：' + ((err as Error)?.message ?? '')
    setTimeout(() => (hint.value = ''), 1400)
    return
  }
  setTimeout(async () => {
    await load()
    leaving.value.delete(t.id)
  }, 200)
}

async function uncomplete(t: TodoRow): Promise<void> {
  await window.wb.todoUncomplete(t.id)
  await load()
  hint.value = '已退回待办'
  setTimeout(() => (hint.value = ''), 1400)
}

async function remove(t: TodoRow): Promise<void> {
  try {
    await window.wb.todoDelete(t.id)
    await load()
  } catch (err) {
    hint.value = '没删掉：' + ((err as Error)?.message ?? '')
    setTimeout(() => (hint.value = ''), 1400)
  }
}

async function switchScope(s: 'today' | 'all'): Promise<void> {
  scope.value = s
  await load()
}

async function toggleDone(): Promise<void> {
  showDone.value = !showDone.value
  if (showDone.value) done.value = await window.wb.todosDone(20)
}

function startEdit(t: TodoRow): void {
  editId.value = t.id
  editText.value = t.text
}

async function saveEdit(t: TodoRow): Promise<void> {
  const text = editText.value.trim()
  editId.value = ''
  if (!text || text === t.text) return
  await window.wb.todoUpdate(t.id, { text })
  await load()
  hint.value = '已改'
  setTimeout(() => (hint.value = ''), 1000)
}

/** 拖拽排序：松手即持久化 */
async function onDrop(target: TodoRow): Promise<void> {
  const from = dragId.value
  dragId.value = ''
  if (!from || from === target.id) return
  const ids = list.value.map((x) => x.id)
  const fromIdx = ids.indexOf(from)
  const toIdx = ids.indexOf(target.id)
  if (fromIdx < 0 || toIdx < 0) return
  ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0])
  list.value = ids.map((id) => list.value.find((x) => x.id === id)!)
  await window.wb.todoReorder(ids)
}

const cats = computed(() => {
  const s = new Set<string>()
  for (const t of list.value) if (t.category) s.add(t.category)
  return [...s]
})

const shown = computed(() => (catFilter.value ? list.value.filter((t) => t.category === catFilter.value) : list.value))

onMounted(load)
defineExpose({ load })
</script>

<template>
  <div class="td" data-module="todos">
    <div class="td-head">
      <input
        v-model="draft"
        class="td-input"
        placeholder="加一条…（回车即可，时间会自动识别）"
        @keydown.enter.prevent="add"
        @keydown.esc="draft = ''"
      />
      <span class="td-hint" v-if="hint">{{ hint }}</span>
    </div>

    <div class="td-chips">
      <button class="chip" :class="{ on: scope === 'today' }" @click="switchScope('today')">今天</button>
      <button class="chip" :class="{ on: scope === 'all' }" @click="switchScope('all')">全部</button>
      <button class="chip" :class="{ on: showDone }" @click="toggleDone">已完成{{ done.length ? ` ${done.length}` : '' }}</button>
      <span class="spacer" />
      <select v-if="cats.length" v-model="catFilter" class="cat">
        <option value="">全部分类</option>
        <option v-for="c in cats" :key="c" :value="c">{{ c }}</option>
      </select>
      <span class="count">{{ shown.length }} 条</span>
    </div>

    <div class="td-list">
      <div
        v-for="t in shown"
        :key="t.id"
        class="row"
        :class="{ leaving: leaving.has(t.id), dragging: dragId === t.id }"
        draggable="true"
        @dragstart="dragId = t.id"
        @dragover.prevent
        @drop.prevent="onDrop(t)"
      >
        <button class="box" @click="complete(t)" title="完成">✓</button>
        <input
          v-if="editId === t.id"
          v-model="editText"
          class="edit"
          @keydown.enter.prevent="saveEdit(t)"
          @keydown.esc="editId = ''"
          @blur="saveEdit(t)"
        />
        <span v-else class="text" @dblclick="startEdit(t)" :title="'双击修改'">{{ t.text }}</span>
        <span class="tag" v-if="t.due_at">{{ t.due_at.slice(5, 16).replace('T', ' ') }}</span>
        <span class="tag" v-if="t.category">{{ t.category }}</span>
        <button class="del" @click="remove(t)" title="删除">✕</button>
      </div>
      <div v-if="shown.length === 0" class="empty">没有待办，先去做事</div>
    </div>

    <div class="td-done" v-if="showDone">
      <div class="donehead">最近完成（点 ↩ 退回待办）</div>
      <div class="row done" v-for="t in done" :key="t.id">
        <button class="undo" @click="uncomplete(t)" title="退回待办">↩</button>
        <span class="text done-text">{{ t.text }}</span>
        <span class="tag">{{ (t.done_at ?? '').slice(5, 16).replace('T', ' ') }}</span>
      </div>
      <div v-if="done.length === 0" class="empty">还没有完成记录</div>
    </div>
  </div>
</template>

<style scoped>
.td {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
}

.td-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.td-input,
.edit {
  flex: 1;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 6px 8px;
  font-size: var(--fs-body);
  color: var(--text-primary);
}

.td-input:focus,
.edit:focus {
  border-color: var(--accent);
  outline: none;
}

.td-hint {
  font-size: 12px;
  color: var(--countdown-ok);
}

.td-chips {
  display: flex;
  align-items: center;
  gap: 4px;
}

.chip {
  font-size: 12px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
}

.chip.on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-weak);
}

.cat {
  font-size: 12px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--text-secondary);
  padding: 0 2px;
}

.spacer {
  flex: 1;
}

.count {
  font-size: 12px;
  color: var(--text-muted);
}

.td-list {
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
  transition: opacity 0.2s var(--ease);
}

.row:hover {
  background: var(--bg-hover);
}

.row.leaving {
  opacity: 0.45;
  transform: translateX(12px);
}

.row.dragging {
  opacity: 0.4;
}

.box {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1px solid var(--border-strong);
  color: transparent;
  font-size: 12px;
  flex: 0 0 auto;
}

.box:hover {
  color: var(--accent);
  border-color: var(--accent);
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

.tag {
  font-size: 12px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 5px;
  white-space: nowrap;
}

.del {
  color: var(--text-muted);
  font-size: 12px;
  opacity: 0;
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

.td-done {
  border-top: 1px dashed var(--border);
  padding-top: 4px;
  max-height: 40%;
  overflow: auto;
}

.donehead {
  font-size: 12px;
  color: var(--text-muted);
  padding: 2px 0;
}

.row.done {
  opacity: 0.75;
}

.done-text {
  text-decoration: line-through;
  color: var(--text-muted);
}

.undo {
  color: var(--text-muted);
  font-size: 12px;
}

.undo:hover {
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

