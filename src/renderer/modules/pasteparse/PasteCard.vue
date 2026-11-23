<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ParsePreview } from '@shared/types'

const raw = ref('')
const preview = ref<ParsePreview | null>(null)
const pickedTodos = ref<Set<number>>(new Set())
const pickedKnowledge = ref<Set<number>>(new Set())
const toast = ref('')
const busy = ref(false)

function flash(msg: string): void {
  toast.value = msg
  window.setTimeout(() => (toast.value = ''), 2000)
}

async function parse(): Promise<void> {
  const text = raw.value.trim()
  if (!text) return
  busy.value = true
  try {
    const r = await window.wb.pasteParse(text)
    preview.value = r
    pickedTodos.value = new Set(r.todos.map((_, i) => i))
    pickedKnowledge.value = new Set(r.knowledge.map((_, i) => i))
  } catch (err) {
    toast.value = '解析失败：' + ((err as Error)?.message ?? '')
    window.setTimeout(() => (toast.value = ''), 2000)
  } finally {
    // 不放 finally 的话，一次失败按钮就永久 disabled
    busy.value = false
  }
}

function toggle(set: Set<number>, i: number): Set<number> {
  const next = new Set(set)
  next.has(i) ? next.delete(i) : next.add(i)
  return next
}

const total = computed(() => pickedTodos.value.size + pickedKnowledge.value.size)

async function acceptAll(): Promise<void> {
  if (!preview.value) return
  const p = preview.value
  const report = await window.wb.pasteApply({
    raw: raw.value,
    todos: p.todos.filter((_, i) => pickedTodos.value.has(i)).map((t) => t.text),
    knowledge: p.knowledge.filter((_, i) => pickedKnowledge.value.has(i)),
    receipts: p.receipts.map((r) => (r.entity ? `${r.text}（${r.entity}）` : r.text))
  })
  preview.value = null
  raw.value = ''
  flash(`已加入：待办 ${report.addedTodos} · 口径 ${report.addedKnowledge} · 记录 ${report.addedWorklog}`)
}

function discard(): void {
  preview.value = null
}
</script>

<template>
  <div class="pp" data-module="pasteparse">
    <textarea
      v-model="raw"
      class="pp-input"
      rows="3"
      placeholder="把领导/同事的聊天记录整段粘进来…"
      @keydown.ctrl.enter.prevent="parse"
      @keydown.esc="raw = ''"
    />

    <div class="pp-bar">
      <button class="pp-btn" :disabled="busy || !raw.trim()" @click="parse">解析</button>
      <span class="pp-tip">Ctrl+Enter 解析</span>
      <span class="spacer" />
      <span class="pp-toast" v-if="toast">{{ toast }}</span>
    </div>

    <div v-if="preview" class="pp-panel" @keydown.enter.prevent="acceptAll" @keydown.esc.prevent="discard" tabindex="0">
      <div class="pp-row" v-for="(t, i) in preview.todos" :key="'t' + i">
        <button class="pp-check" :class="{ on: pickedTodos.has(i) }" @click="pickedTodos = toggle(pickedTodos, i)">✓</button>
        <span class="pp-text">{{ t.text }}</span>
        <span class="pp-chip" v-if="t.timeHint">{{ t.timeHint }}</span>
        <span class="pp-chip low" v-if="t.confidence === 'low'">待确认</span>
      </div>

      <div class="pp-row" v-for="(k, i) in preview.knowledge" :key="'k' + i">
        <button class="pp-check kn" :class="{ on: pickedKnowledge.has(i) }" @click="pickedKnowledge = toggle(pickedKnowledge, i)">✓</button>
        <span class="pp-text">{{ k.title }}<em class="pp-sub"> → {{ k.conclusion }}</em></span>
        <span class="pp-chip low" v-if="k.scope">{{ k.scope }}</span>
      </div>

      <div class="pp-row rec" v-for="(r, i) in preview.receipts" :key="'r' + i">
        <span class="pp-check fixed">•</span>
        <span class="pp-text">{{ r.text }}<em class="pp-sub" v-if="r.entity">（{{ r.entity }}）</em></span>
        <span class="pp-chip">回执</span>
      </div>

      <div class="pp-foot">
        <span class="pp-sum">待办 {{ pickedTodos.size }} · 口径 {{ pickedKnowledge.size }} · 回执 {{ preview.receipts.length }}（丢弃 {{ preview.dropped }}）</span>
        <span class="spacer" />
        <button class="pp-btn ghost" @click="discard">放弃 Esc</button>
        <button class="pp-btn primary" @click="acceptAll">全部加入 Enter（{{ total }}）</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pp {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
}

.pp-input {
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 6px 8px;
  font-size: var(--fs-sm);
  resize: none;
}

.pp-input:focus {
  border-color: var(--accent);
  outline: none;
}

.pp-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pp-btn {
  font-size: var(--fs-sm);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 3px 10px;
  color: var(--text-secondary);
  background: var(--bg-elev-3);
}

.pp-btn:disabled {
  opacity: 0.45;
}

.pp-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.pp-btn.ghost {
  background: transparent;
}

.pp-tip,
.pp-toast {
  font-size: 12px;
  color: var(--text-muted);
}

.pp-toast {
  color: var(--countdown-ok);
}

.spacer {
  flex: 1;
}

.pp-panel {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 2px 4px;
  background: var(--bg-elev-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
  outline: none;
}

.pp-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 4px;
  min-height: 24px;
}

.pp-check {
  width: var(--slot);
  height: var(--slot);
  border-radius: 4px;
  border: 1px solid var(--border-strong);
  color: transparent;
  font-size: 12px;
  line-height: 1;
}

.pp-check.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.pp-check.fixed {
  border: none;
  color: var(--text-muted);
}

.pp-text {
  flex: 1;
  font-size: var(--fs-sm);
  word-break: break-all;
}

.pp-sub {
  color: var(--text-muted);
  font-style: normal;
}

.pp-chip {
  font-size: 12px;
  color: var(--countdown-ok);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 6px;
}

.pp-chip.low {
  color: var(--countdown-warn);
}

.pp-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: auto;
  padding-top: 4px;
  border-top: 1px solid var(--border);
}

.pp-sum {
  font-size: 12px;
  color: var(--text-muted);
}
</style>

