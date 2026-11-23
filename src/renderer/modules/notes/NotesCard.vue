<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { NoteRow } from '@shared/types'

const rows = ref<NoteRow[]>([])
const draft = ref('')
const editing = ref<string | null>(null)
const editText = ref('')
const hint = ref('')

async function load(): Promise<void> {
  rows.value = await window.wb.notesList()
}

async function add(): Promise<void> {
  const t = draft.value.trim()
  if (!t) return
  draft.value = ''
  await window.wb.notesAdd(t)
  await load()
}

function startEdit(r: NoteRow): void {
  editing.value = r.id
  editText.value = r.text
}

async function saveEdit(r: NoteRow): Promise<void> {
  const t = editText.value.trim()
  try {
    if (t && t !== r.text) await window.wb.notesUpdate(r.id, { text: t })
  } catch (err) {
    hint.value = '没存上：' + ((err as Error)?.message ?? '')
    window.setTimeout(() => (hint.value = ''), 1400)
    return
  }
  editing.value = null
  await load()
}

async function togglePin(r: NoteRow): Promise<void> {
  await window.wb.notesUpdate(r.id, { pinned: r.pinned ? 0 : 1 })
  await load()
}

async function remove(r: NoteRow): Promise<void> {
  await window.wb.notesDelete(r.id)
  await load()
}

onMounted(load)
defineExpose({ load })
</script>

<template>
  <div class="nt" data-module="notes">
    <div class="nt-hint" v-if="hint">{{ hint }}</div>
    <input v-model="draft" class="nt-input" placeholder="闪记一句…（回车存）" @keydown.enter.prevent="add" />
    <div class="nt-list">
      <div v-for="r in rows" :key="r.id" class="row" :class="{ pinned: r.pinned }">
        <button class="pin" :class="{ on: r.pinned }" @click="togglePin(r)">★</button>
        <input v-if="editing === r.id" v-model="editText" class="edit" @keydown.enter="saveEdit(r)" @keydown.esc="editing = null" @blur="saveEdit(r)" />
        <span v-else class="text" title="双击修改" @dblclick="startEdit(r)">{{ r.text }}</span>
        <button class="del" @click="remove(r)">✕</button>
      </div>
      <div v-if="rows.length === 0" class="empty">双击可改，★ 置顶</div>
    </div>
  </div>
</template>

<style scoped>
.nt {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
}

.nt-input {
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 5px 8px;
  font-size: var(--fs-sm);
}

.nt-input:focus {
  border-color: var(--accent);
  outline: none;
}

.nt-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  min-height: var(--list-row);
  border-radius: var(--r-sm);
}

.row:hover {
  background: var(--bg-elev-2);
}

.pin {
  font-size: 12px;
  color: var(--text-muted);
  width: var(--slot);
  text-align: center;
  flex: 0 0 var(--slot);
}

.pin.on {
  color: var(--countdown-warn);
}

.text {
  flex: 1;
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row.pinned .text {
  color: var(--text-primary);
}

.edit {
  flex: 1;
  background: var(--bg-elev-3);
  border: 1px solid var(--accent);
  border-radius: var(--r-sm);
  padding: 1px 4px;
  font-size: var(--fs-sm);
  color: var(--text-primary);
}

.del {
  opacity: 0.45;
  font-size: 12px;
  color: var(--text-muted);
}

.row:hover .del {
  opacity: 1;
}

.empty {
  font-size: 12px;
  color: var(--text-muted);
}
.nt-hint {
  font-size: 12px;
  color: var(--countdown-urgent);
}

/* 空态居���：空列表时把提示摆在卡片中间，卡片看起来才是"满的" */
.empty {
  margin: auto;
  text-align: center;
  color: var(--text-muted);
  font-size: var(--fs-sm);
}
</style>


