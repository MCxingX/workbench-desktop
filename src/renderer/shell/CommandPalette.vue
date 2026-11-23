<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'action', id: string): void }>()

const actions = ref<{ id: string; title: string; hint: string }[]>([])
const q = ref('')
const idx = ref(0)
const input = ref<HTMLInputElement | null>(null)

const filtered = computed(() => {
  const k = q.value.trim()
  if (!k) return actions.value
  return actions.value.filter((a) => a.title.includes(k) || a.hint.includes(k) || a.id.includes(k))
})

async function load(): Promise<void> {
  actions.value = await window.wb.paletteActions()
}

function run(): void {
  const a = filtered.value[idx.value]
  if (!a) return
  q.value = ''
  emit('action', a.id)
  emit('close')
}

function move(delta: number): void {
  if (filtered.value.length === 0) return
  idx.value = (idx.value + delta + filtered.value.length) % filtered.value.length
}

watch(
  () => props.open,
  async (v) => {
    if (v) {
      await load()
      idx.value = 0
      q.value = ''
      await nextTick()
      input.value?.focus()
    }
  }
)

watch(q, () => (idx.value = 0))
onMounted(load)
</script>

<template>
  <div v-if="props.open" class="pal" @click.self="emit('close')">
    <div class="box">
      <input
        ref="input"
        v-model="q"
        class="q"
        placeholder="要做点什么…"
        @keydown.enter.prevent="run"
        @keydown.esc.prevent="emit('close')"
        @keydown.up.prevent="move(-1)"
        @keydown.down.prevent="move(1)"
      />
      <div class="list">
        <button
          v-for="(a, i) in filtered"
          :key="a.id"
          class="item"
          :class="{ on: i === idx }"
          @mouseenter="idx = i"
          @click="run"
        >
          <span class="title">{{ a.title }}</span>
          <span class="hint">{{ a.hint }}</span>
        </button>
        <div v-if="filtered.length === 0" class="none">没有匹配的动作</div>
      </div>
      <div class="foot">↑↓ 选择 · Enter 执行 · Esc 关闭</div>
    </div>
  </div>
</template>

<style scoped>
.pal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  z-index: var(--z-palette);
  backdrop-filter: blur(2px);
}

.box {
  width: min(520px, 88vw);
  background: var(--bg-elev-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.q {
  border: none;
  border-bottom: 1px solid var(--border);
  background: transparent;
  padding: 12px 14px;
  font-size: var(--fs-h2);
  color: var(--text-primary);
  outline: none;
}

.list {
  max-height: 320px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  padding: 4px;
}

.item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  text-align: left;
  padding: 7px 10px;
  border-radius: var(--r-sm);
}

.item.on {
  background: var(--bg-elev-3);
}

.title {
  font-size: var(--fs-body);
  color: var(--text-primary);
}

.hint {
  font-size: 12px;
  color: var(--text-muted);
}

.none {
  padding: 10px;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}

.foot {
  border-top: 1px solid var(--border);
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-muted);
}
</style>

