<template>
  <div class="rc">
    <header class="rc-head">
      <span class="rc-dot" />
      <h1>数据救援</h1>
      <span class="rc-sub">你的数据没有被删除，这里只做"能打开就正常打开"</span>
    </header>

    <p class="rc-msg">{{ message }}</p>

    <div class="rc-grid" v-if="diag">
      <div class="rc-k">数据目录</div>
      <div class="rc-v">{{ diag.scan.dataDir }}</div>
      <div class="rc-k">库文件</div>
      <div class="rc-v">{{ diag.scan.db ? Math.round(diag.scan.db.size / 1024) + ' KB' : '不存在' }}</div>
      <div class="rc-k">密钥副本</div>
      <div class="rc-v">{{ keyList }}</div>
      <div class="rc-k">备份</div>
      <div class="rc-v">{{ diag.scan.backups.length }} 份{{ diag.scan.backups.length ? '（最新 ' + diag.scan.backups[0].mtime.slice(0, 16).replace('T', ' ') + '）' : '' }}</div>
    </div>

    <div class="rc-actions">
      <button class="btn primary" :disabled="!diag?.usableKey || busy" @click="autoFix">自动修复</button>
      <button class="btn" :disabled="!diag?.pwdAvailable || busy" @click="showPwd = !showPwd">密码解锁</button>
      <button class="btn" :disabled="!diag?.scan.backups.length || busy" @click="showBak = !showBak">从备份恢复</button>
      <button class="btn danger" :disabled="busy" @click="reset">重建空库（留档）</button>
      <button class="btn" :disabled="busy" @click="openDir">打开数据目录</button>
    </div>

    <div class="rc-form" v-if="showPwd">
      <input v-model="password" type="password" placeholder="输入你设置过的密码" @keydown.enter="unlock" />
      <button class="btn primary" :disabled="busy || !password" @click="unlock">解锁</button>
    </div>

    <div class="rc-list" v-if="showBak && diag">
      <button class="rc-item" v-for="b in diag.scan.backups" :key="b.path" :disabled="busy" @click="restore(b.path)">
        <span>{{ b.name }}</span>
        <span class="rc-meta">{{ Math.round(b.size / 1024) }} KB · {{ b.mtime.slice(0, 16).replace('T', ' ') }}</span>
      </button>
    </div>

    <p class="rc-result" :class="{ bad: !ok }" v-if="result">{{ result }}</p>

    <footer class="rc-foot">
      <p class="rc-warn">「重建空库」只会把旧库改名成 <code>*.orphan-时间</code> 留档，不会删除任何文件；备份、附件、导出、日志都不动。</p>
      <div class="rc-foot-btns">
        <button class="btn" @click="openDir">打开数据目录</button>
        <button class="btn primary" :disabled="busy || !opened" @click="finish">继续使用</button>
        <button class="btn" :disabled="busy || opened" @click="quit">退出</button>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

interface Diag {
  scan: {
    dataDir: string
    db: { path: string; size: number } | null
    dbBak: { path: string; size: number } | null
    keyFiles: { name: string; path: string; size: number; passwordProtected: boolean }[]
    backups: { name: string; path: string; size: number; mtime: string }[]
  }
  usableKey: string | null
  canOpen: boolean
  pwdAvailable: boolean
  message: string
}

const diag = ref<Diag | null>(null)
const message = ref('正在检查数据目录…')
const result = ref('')
const ok = ref(true)
const busy = ref(false)
const showPwd = ref(false)
const showBak = ref(false)
const password = ref('')
const opened = ref(false)

const keyList = computed(() => {
  const ks = diag.value?.scan.keyFiles ?? []
  if (ks.length === 0) return '没有找到任何密钥文件'
  return ks.map((k) => k.name + (k.passwordProtected ? '（受密码保护）' : '')).join('、')
})

async function refresh(): Promise<void> {
  diag.value = await window.wb.recoveryDiagnose()
  message.value = diag.value.message
}

function note(text: string, good = true): void {
  result.value = text
  ok.value = good
}

async function autoFix(): Promise<void> {
  busy.value = true
  try {
    const r = await window.wb.recoveryAutoFix()
    note(r.message, r.ok)
    if (r.ok) opened.value = true
    await refresh()
  } finally {
    busy.value = false
  }
}

async function unlock(): Promise<void> {
  busy.value = true
  try {
    const r = await window.wb.recoveryUnlock(password.value)
    note(r.message, r.ok)
    if (r.ok) {
      opened.value = true
      password.value = ''
      showPwd.value = false
    }
    await refresh()
  } finally {
    busy.value = false
  }
}

async function restore(file: string): Promise<void> {
  busy.value = true
  try {
    const r = await window.wb.recoveryRestore(file)
    note(r.message + (r.restored.length ? '（还原：' + r.restored.join('、') + '）' : ''), r.ok)
    if (r.ok) opened.value = true
    await refresh()
  } finally {
    busy.value = false
  }
}

async function reset(): Promise<void> {
  busy.value = true
  try {
    const r = await window.wb.recoveryReset()
    note(r.message, r.ok)
    if (r.ok) opened.value = true
    await refresh()
  } finally {
    busy.value = false
  }
}

function openDir(): void {
  void window.wb.recoveryOpenDir()
}

async function finish(): Promise<void> {
  await window.wb.recoveryFinish('retry')
}

async function quit(): Promise<void> {
  await window.wb.recoveryFinish('quit')
}

onMounted(refresh)
</script>

<style scoped>
.rc {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100vh;
  padding: 18px 20px;
  background: #0e1116;
  color: #e8ecf3;
  font-size: 13px;
  overflow: auto;
}
.rc-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.rc-head h1 {
  font-size: 16px;
  margin: 0;
}
.rc-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #ffb020;
}
.rc-sub {
  color: #7b8798;
  font-size: 12px;
}
.rc-msg {
  margin: 0;
  padding: 10px 12px;
  background: #161b24;
  border: 1px solid #242c3a;
  border-radius: 8px;
  line-height: 1.6;
}
.rc-grid {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 6px 10px;
  padding: 10px 12px;
  background: #121721;
  border: 1px solid #222a37;
  border-radius: 8px;
}
.rc-k {
  color: #7b8798;
}
.rc-v {
  word-break: break-all;
}
.rc-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.btn {
  padding: 6px 12px;
  border-radius: 7px;
  border: 1px solid #2b3444;
  background: #1a2029;
  color: #d7dee9;
  cursor: pointer;
  font-size: 12.5px;
}
.btn:hover:not(:disabled) {
  border-color: #3b475c;
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn.primary {
  background: #2358d6;
  border-color: #2358d6;
  color: #fff;
}
.btn.danger {
  border-color: #6b2a2a;
  color: #ffb4b4;
}
.rc-form {
  display: flex;
  gap: 8px;
}
.rc-form input {
  flex: 1;
  padding: 7px 10px;
  border-radius: 7px;
  border: 1px solid #2b3444;
  background: #12171f;
  color: #e8ecf3;
}
.rc-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 150px;
  overflow: auto;
}
.rc-item {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 7px;
  border: 1px solid #242c3a;
  background: #141a23;
  color: #d7dee9;
  cursor: pointer;
  font-size: 12.5px;
}
.rc-meta {
  color: #7b8798;
}
.rc-result {
  margin: 0;
  color: #7ee0a0;
  font-size: 12.5px;
}
.rc-result.bad {
  color: #ff9d9d;
}
.rc-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rc-warn {
  margin: 0;
  color: #7b8798;
  font-size: 11.5px;
  line-height: 1.6;
}
.rc-warn code {
  color: #b9c4d4;
}
.rc-foot-btns {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
