<script setup lang="ts">
import { onMounted, ref } from 'vue'

const props = defineProps<{ enabled: boolean; locked: boolean }>()
const emit = defineEmits<{ (e: 'unlocked'): void }>()

const pw = ref('')
const error = ref('')
const waitLeft = ref(0)
const input = ref<HTMLInputElement | null>(null)

async function submit(): Promise<void> {
  if (!pw.value) return
  const r = await window.wb.unlock(pw.value)
  if (r.ok) {
    pw.value = ''
    error.value = ''
    emit('unlocked')
    return
  }
  if (r.retryAfterMs > 0) {
    waitLeft.value = Math.ceil(r.retryAfterMs / 1000)
    error.value = `错太多次了，${waitLeft.value} 秒后再试`
    const t = window.setInterval(() => {
      waitLeft.value--
      if (waitLeft.value <= 0) {
        window.clearInterval(t)
        error.value = ''
      }
    }, 1000)
  } else {
    error.value = `密码不对（第 ${r.state.failures} 次）`
  }
  pw.value = ''
  input.value?.focus()
}

onMounted(() => input.value?.focus())
</script>

<template>
  <div class="lock" v-if="props.locked">
    <div class="box">
      <div class="logo">W</div>
      <div class="title">工作台已锁定</div>
      <input
        ref="input"
        v-model="pw"
        type="password"
        class="pw"
        placeholder="输入密码解锁"
        @keydown.enter.prevent="submit"
      />
      <button class="go" :disabled="waitLeft > 0" @click="submit">解锁</button>
      <div class="err" v-if="error">{{ error }}</div>
      <div class="tip">Ctrl+Alt+L 可随时锁定</div>
    </div>
  </div>
</template>

<style scoped>
.lock {
  position: fixed;
  inset: 0;
  z-index: var(--z-lock);
  background: color-mix(in srgb, var(--bg-app) 96%, #000);
  backdrop-filter: blur(10px);
  display: grid;
  place-items: center;
}

.box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: 280px;
}

.logo {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  font-size: 22px;
  display: grid;
  place-items: center;
}

.title {
  font-size: var(--fs-h2);
  color: var(--text-primary);
}

.pw {
  width: 100%;
  text-align: center;
  background: var(--bg-elev-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  padding: 8px;
  font-size: var(--fs-body);
}

.pw:focus {
  border-color: var(--accent);
  outline: none;
}

.go {
  width: 100%;
  background: var(--accent);
  color: #fff;
  border-radius: var(--r-md);
  padding: 7px;
  font-size: var(--fs-body);
  font-weight: 600;
}

.go:disabled {
  opacity: 0.5;
}

.err {
  font-size: 12px;
  color: var(--countdown-urgent);
}

.tip {
  font-size: 12px;
  color: var(--text-muted);
}
</style>

