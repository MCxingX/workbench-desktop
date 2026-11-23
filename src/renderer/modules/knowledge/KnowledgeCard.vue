<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { KnowledgeRow } from '@shared/types'

const rows = ref<KnowledgeRow[]>([])
const q = ref('')
const draft = ref('')
const openId = ref<string | null>(null)
const scopes = ref<string[]>([])
const scopeFilter = ref('')
const editId = ref('')
const editConclusion = ref('')
const hint = ref('')
const editTitle = ref('')

async function load(): Promise<void> {
  const all = await window.wb.knowledgeList(q.value)
  rows.value = scopeFilter.value ? all.filter((k) => k.scope === scopeFilter.value) : all
  scopes.value = await window.wb.knowledgeScopes()
}

async function add(): Promise<void> {
  const text = draft.value.trim()
  if (!text) return
  const m = /^(.{2,40}?)(?:\s*(?:→|->|｜|\|)\s*)(.+)$/s.exec(text)
  try {
    await window.wb.knowledgeAdd(
      m
        ? { title: m[1].trim(), conclusion: m[2].trim(), scope: scopeFilter.value || null }
        : { title: text.slice(0, 18), conclusion: text, scope: scopeFilter.value || null }
    )
    draft.value = ''
    await load()
  } catch (err) {
    hint.value = '没存上：' + ((err as Error)?.message ?? '')
    window.setTimeout(() => (hint.value = ''), 1400)
  }
}

async function remove(k: KnowledgeRow): Promise<void> {
  try {
    await window.wb.knowledgeDelete(k.id)
  } catch (err) {
    hint.value = '没删掉：' + ((err as Error)?.message ?? '')
    window.setTimeout(() => (hint.value = ''), 1400)
    return
  }
  await load()
}

function startEdit(k: KnowledgeRow): void {
  editId.value = k.id
  editTitle.value = k.title
  editConclusion.value = k.conclusion
}

async function saveEdit(k: KnowledgeRow): Promise<void> {
  const title = editTitle.value.trim()
  const conclusion = editConclusion.value.trim()
  // 先判空再退出：原来先清 editId，删光文字点保存会"编辑框消失但内容没变"
  if (!title && !conclusion) return
  editId.value = ''
  await window.wb.knowledgeUpdate(k.id, { title: title || k.title, conclusion: conclusion || k.conclusion })
  await load()
}

/** 把这条的适用范围定为当前筛选值（用于快速归类） */
async function setScope(k: KnowledgeRow): Promise<void> {
  const next = scopeFilter.value || ''
  await window.wb.knowledgeUpdate(k.id, { scope: next || null })
  await load()
}

onMounted(load)
defineExpose({ load })
</script>

<template>
  <div class="kn" data-module="knowledge">
    <div class="kn-hint" v-if="hint">{{ hint }}</div>
    <div class="kn-head">
      <input v-model="q" class="kn-search" placeholder="搜口径…" @input="load" />
      <select v-if="scopes.length" v-model="scopeFilter" class="kn-scope" @change="load">
        <option value="">全部范围</option>
        <option v-for="s in scopes" :key="s" :value="s">{{ s }}</option>
      </select>
    </div>
    <input v-model="draft" class="kn-input" placeholder="问 → 答，或直接一句结论（回车保存）" @keydown.enter.prevent="add" />

    <div class="kn-list">
      <div v-for="k in rows" :key="k.id" class="item" @click="openId = openId === k.id ? null : k.id">
        <div class="t">
          <template v-if="editId === k.id">
            <input v-model="editTitle" class="ed-title" @click.stop />
            <button class="mini" @click.stop="saveEdit(k)">保存</button>
            <button class="mini" @click.stop="editId = ''">取消</button>
          </template>
          <template v-else>
            <span class="title" title="双击修改" @dblclick.stop="startEdit(k)">{{ k.title }}</span>
            <span class="chip" v-if="k.scope">{{ k.scope }}</span>
            <span class="chip scope-btn" v-if="scopeFilter" @click.stop="setScope(k)" title="归到当前范围">↳</span>
            <button class="del" @click.stop="remove(k)">✕</button>
          </template>
        </div>
        <div class="c" v-if="editId === k.id">
          <textarea v-model="editConclusion" rows="3" class="ed-body" @click.stop />
        </div>
        <div class="c" v-else-if="openId === k.id || q">{{ k.conclusion }}</div>
      </div>
      <div v-if="rows.length === 0" class="empty">还没有沉淀口径</div>
    </div>
  </div>
</template>

<style scoped>
.kn {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
}

.kn-head {
  display: flex;
  gap: 4px;
}

.kn-search,
.kn-input,
.ed-title,
.ed-body {
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 5px 8px;
  font-size: var(--fs-sm);
  color: var(--text-primary);
}

.kn-search {
  flex: 1;
}

.kn-search:focus,
.kn-input:focus,
.ed-title:focus,
.ed-body:focus {
  border-color: var(--accent);
  outline: none;
}

.kn-scope {
  font-size: 12px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--text-secondary);
  max-width: 96px;
}

.kn-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

/* 去掉"卡中卡"：五张列表卡里只有它每行带边框，视觉上像嵌了个小程序 */
.item {
  border: none;
  border-radius: var(--r-sm);
  padding: 3px 6px;
  min-height: var(--list-row);
  cursor: pointer;
  background: transparent;
}

.item:hover {
  background: var(--bg-hover);
}

.t {
  display: flex;
  align-items: center;
  gap: 4px;
}

.title {
  flex: 1;
  font-size: var(--fs-sm);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ed-title {
  flex: 1;
  font-size: var(--fs-sm);
  padding: 2px 6px;
}

.chip {
  font-size: 12px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 5px;
}

.scope-btn {
  cursor: pointer;
  color: var(--accent);
  border-color: var(--accent);
}

.mini {
  font-size: 12px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 0 6px;
}

.mini:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.del {
  font-size: 12px;
  color: var(--text-muted);
}

.del:hover {
  color: var(--countdown-urgent);
}

.c {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  white-space: pre-wrap;
}

.ed-body {
  width: 100%;
  font-size: 12px;
  resize: vertical;
}

.empty {
  font-size: 12px;
  color: var(--text-muted);
  padding: 6px 2px;
}
.kn-hint {
  font-size: 12px;
  color: var(--countdown-urgent);
  padding: 2px 0;
}

/* 空态居���：空列表时把提示摆在卡片中间，卡片看起来才是"满的" */
.empty {
  margin: auto;
  text-align: center;
  color: var(--text-muted);
  font-size: var(--fs-sm);
}
</style>

