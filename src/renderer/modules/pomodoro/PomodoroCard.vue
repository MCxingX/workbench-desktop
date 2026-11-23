<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const focusMin = ref(25)
const breakMin = ref(5)
const running = ref(false)
const done = ref('')
const kind = ref<'focus' | 'break'>('focus')
const left = ref(focusMin.value * 60)
const today = ref({ focus: 0, focusMinutes: 0 })
let timer: number | undefined

const label = computed(() => (kind.value === 'focus' ? '专注' : '休息'))
const mmss = computed(() => {
  const s = Math.max(0, left.value)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
})

async function load(): Promise<void> {
  today.value = await window.wb.pomodoroToday()
}

function tick(): void {
  left.value--
  if (left.value <= 0) void finish()
}

async function finish(): Promise<void> {
  running.value = false
  if (timer) window.clearInterval(timer)
  const minutes = kind.value === 'focus' ? focusMin.value : breakMin.value
  try {
    await window.wb.pomodoroRecord(kind.value, minutes)
  } catch (err) {
    done.value = '记录失败：' + ((err as Error)?.message ?? '')
    window.setTimeout(() => (done.value = ''), 4000)
    return
  }
  done.value = minutes + ' 分钟记下了'
  window.setTimeout(() => (done.value = ''), 4000)
  await load()
  left.value = (kind.value === 'focus' ? breakMin.value : focusMin.value) * 60
  kind.value = kind.value === 'focus' ? 'break' : 'focus'
}

function toggle(): void {
  running.value = !running.value
  if (running.value) {
    timer = window.setInterval(tick, 1000)
  } else if (timer) {
    window.clearInterval(timer)
  }
}

function reset(): void {
  running.value = false
  if (timer) window.clearInterval(timer)
  left.value = (kind.value === 'focus' ? focusMin.value : breakMin.value) * 60
}

onMounted(load)
onBeforeUnmount(() => timer && window.clearInterval(timer))
defineExpose({ load })
</script>

<template>
  <div class="pm" data-module="pomodoro">
    <div class="pm-head">
      <span class="pm-kind">{{ label }}</span>
      <span class="pm-today">今日 {{ today.focus }} 个 · {{ today.focusMinutes }} 分钟</span>
    </div>

    <div class="pm-clock">{{ mmss }}</div>
    <div class="pm-done" v-if="done">{{ done }}</div>

    <div class="pm-btns">
      <button class="go" @click="toggle">{{ running ? '暂停' : '开始' }}</button>
      <button class="ghost" @click="reset">重置</button>
    </div>

    <div class="pm-cfg">
      <label>专注 <input type="number" min="5" max="90" v-model.number="focusMin" @change="reset" /> 分</label>
      <label>休息 <input type="number" min="1" max="30" v-model.number="breakMin" @change="reset" /> 分</label>
    </div>
  </div>
</template>

<style scoped>
.pm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  align-items: stretch;
  justify-content: space-between;
}

.pm-head {
  display: flex;
  width: 100%;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-muted);
}

.pm-kind {
  color: var(--text-secondary);
}

.pm-clock {
  font-size: var(--fs-h0);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

.pm-btns {
  display: flex;
  gap: 6px;
}

.go {
  background: var(--accent);
  color: #fff;
  border-radius: var(--r-sm);
  padding: 4px 16px;
  font-size: var(--fs-sm);
  font-weight: 600;
}

.ghost {
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 4px 12px;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.pm-cfg {
  display: flex;
  gap: 10px;
  font-size: 12px;
  color: var(--text-muted);
}

.pm-cfg input {
  width: 42px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 4px;
  font-size: 12px;
  color: var(--text-primary);
}
.pm-done {
  font-size: 12px;
  color: var(--countdown-ok);
  text-align: center;
}
</style>



