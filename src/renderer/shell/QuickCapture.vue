<template>
  <div class="qc">
    <span class="qc-dot" />
    <input
      ref="box"
      v-model="text"
      class="qc-in"
      :placeholder="hint"
      spellcheck="false"
      @keydown.enter.prevent="save"
      @keydown.esc.prevent="close"
    />
    <span class="qc-hint">回车保存 · Esc 关闭 · 时间自动跟班表</span>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

const text = ref('')
const box = ref<HTMLInputElement | null>(null)
const hint = '要做的事，如：下午把周报发给张总（支持 每天 / 每周三 / 每月5号 开头）'

onMounted(() => {
  box.value?.focus()
})

async function save(): Promise<void> {
  const t = text.value.trim()
  if (!t) return close()
  try {
    await window.wb.todoAdd(t)
  } catch {
    // 存失败也关窗，主窗口里还能看到提示
  }
  close()
}

function close(): void {
  window.close()
}
</script>

<style scoped>
.qc {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 100vh;
  padding: 0 16px;
  background: #0e1116;
  border: 1px solid #2a3140;
  border-radius: 10px;
}
.qc-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4f8cff;
  flex: none;
}
.qc-in {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: #e8ecf3;
  font-size: 15px;
}
.qc-in::placeholder {
  color: #5b6577;
}
.qc-hint {
  color: #5b6577;
  font-size: 12px;
  flex: none;
}
</style>
