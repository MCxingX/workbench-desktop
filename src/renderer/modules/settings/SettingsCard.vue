<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AppInfo, LockState } from '@shared/types'

defineOptions({ name: 'SettingsCard' })

const info = ref<AppInfo | null>(null)
const stats = ref<{ sizeBytes: number; counts: Record<string, number>; file: string } | null>(null)
const db = ref<{ file: string; sizeBytes: number; mtime: string | null; lastError: string | null; dirty: boolean } | null>(null)
const target = ref('')
const busy = ref(false)
const msg = ref('')

const lockState = ref<LockState | null>(null)
const pwNew = ref('')
const pwOld = ref('')
const autoMin = ref(10)
const plugins = ref<{ id: string; name: string; moduleId: string }[]>([])
const pluginIssues = ref<{ file: string; message: string }[]>([])

async function makeSample(): Promise<void> {
  const r = await window.wb.pluginsSample()
  flash(`示例清单已生成 → ${r.file}`)
  await refresh()
}

function flash(text: string): void {
  msg.value = text
  window.setTimeout(() => (msg.value = ''), 3000)
}

async function refresh(): Promise<void> {
  info.value = await window.wb.info()
  stats.value = await window.wb.storeStats()
  db.value = await window.wb.storeInfo()
  lockState.value = await window.wb.lockState()
  autoMin.value = lockState.value.autoLockMinutes
  const pl = await window.wb.pluginsList()
  plugins.value = pl.plugins
  pluginIssues.value = pl.issues
}

async function enableLock(): Promise<void> {
  if (pwNew.value.length < 4) {
    flash('密码至少 4 位')
    return
  }
  try {
    lockState.value = await window.wb.lockSetPassword(pwNew.value)
    pwNew.value = ''
    flash('应用锁已开启，下次启动需要密码')
  } catch (e) {
    flash((e as Error).message)
  }
}

async function changeLockPw(): Promise<void> {
  try {
    lockState.value = await window.wb.lockChangePassword(pwOld.value, pwNew.value)
    pwOld.value = ''
    pwNew.value = ''
    flash('密码已更新')
  } catch (e) {
    flash((e as Error).message)
  }
}

async function disableLockPw(): Promise<void> {
  try {
    lockState.value = await window.wb.lockDisable(pwOld.value)
    pwOld.value = ''
    flash('应用锁已关闭')
  } catch (e) {
    flash((e as Error).message)
  }
}

async function applyAuto(): Promise<void> {
  lockState.value = await window.wb.lockAutoMinutes(autoMin.value)
  flash(autoMin.value === 0 ? '已关闭自动锁' : `离开 ${autoMin.value} 分钟后自动锁`)
}

async function backup(): Promise<void> {
  busy.value = true
  try {
    const r = await window.wb.backupCreate()
    flash(`已备份 → ${r.file}`)
  } finally {
    busy.value = false
  }
  await refresh()
}

async function restore(): Promise<void> {
  const file = await window.wb.backupPick()
  if (!file) return
  busy.value = true
  try {
    const r = await window.wb.backupRestore(file)
    flash(`已还原 ${r.restored.length} 个文件（原文件备份到 ${r.preRestoreDir}），重启后生效`)
  } finally {
    busy.value = false
  }
}

async function exportRedacted(): Promise<void> {
  const r = await window.wb.exportRedacted()
  flash(`已导出打码数据 → ${r.file}`)
}

async function migrate(): Promise<void> {
  const dir = target.value.trim()
  if (!dir) return
  busy.value = true
  try {
    const r = await window.wb.migrateDataDir(dir)
    flash(`已迁移到 ${r.to}（${r.files} 个文件，校验通过），重启后生效`)
  } catch (e) {
    flash((e as Error).message)
  } finally {
    busy.value = false
  }
}

function openDir(): void {
  void window.wb.openDataDir()
}

onMounted(refresh)
defineExpose({ refresh })
</script>

<template>
  <div class="st" data-module="settings">
    <div class="st-head">
      <span class="st-title">数据</span>
      <span class="st-ver">v{{ info?.version }}</span>
    </div>

    <div class="st-path" :title="info?.dataDir">{{ info?.dataDir }}</div>

    <div class="st-file" v-if="db">
      <span class="k">库文件</span>
      <span class="v">{{ db.file.split(/[\\/]/).pop() }} · {{ (db.sizeBytes / 1024).toFixed(0) }} KB</span>
      <span class="k">最近写入</span>
      <span class="v">{{ db.mtime ? new Date(db.mtime).toLocaleString("zh-CN", { hour12: false }) : "—" }}</span>
      <span class="err" v-if="db.lastError">写入失败：{{ db.lastError }}</span>
      <span class="warn" v-else-if="db.dirty">还有改动没落盘</span>
    </div>

    <div class="st-btns">
      <button @click="openDir">打开目录</button>
      <button :disabled="busy" @click="backup">立即备份</button>
      <button :disabled="busy" @click="restore">从备份还原</button>
      <button :disabled="busy" @click="exportRedacted">导出打码数据</button>
    </div>

    <div class="st-migrate">
      <input v-model="target" placeholder="迁移到新目录，例如 D:\WorkbenchData2" />
      <button :disabled="busy || !target.trim()" @click="migrate">迁移</button>
    </div>

    <div class="st-stats" v-if="stats">
      <span>库 {{ (stats.sizeBytes / 1024).toFixed(0) }} KB</span>
      <span>待办 {{ stats.counts.todos ?? 0 }}</span>
      <span>记录 {{ stats.counts.worklog ?? 0 }}</span>
      <span>口径 {{ stats.counts.knowledge_entries ?? 0 }}</span>
      <span>到岗 {{ stats.counts.checkins ?? 0 }}</span>
    </div>

    <div class="st-lock">
      <div class="st-lockhead">
        <span class="st-label">应用锁</span>
        <span class="st-state" :class="{ on: lockState?.enabled }">{{ lockState?.enabled ? '已开启' : '未开启' }}</span>
      </div>
      <template v-if="!lockState?.enabled">
        <div class="st-inline">
          <input v-model="pwNew" type="password" placeholder="设置密码（≥4 位）" />
          <button @click="enableLock">开启</button>
        </div>
      </template>
      <template v-else>
        <div class="st-inline">
          <select v-model.number="autoMin" @change="applyAuto">
            <option :value="0">不自动锁</option>
            <option :value="5">离开 5 分钟锁</option>
            <option :value="10">离开 10 分钟锁</option>
            <option :value="30">离开 30 分钟锁</option>
          </select>
        </div>
        <div class="st-inline">
          <input v-model="pwOld" type="password" placeholder="原密码" />
          <input v-model="pwNew" type="password" placeholder="新密码" />
          <button @click="changeLockPw">改密码</button>
          <button @click="disableLockPw">关闭锁</button>
        </div>
      </template>
    </div>

    <div class="st-plugins">
      <div class="st-lockhead">
        <span class="st-label">插件清单</span>
        <button class="mini" @click="makeSample">生成示例</button>
      </div>
      <div class="st-pl" v-for="p in plugins" :key="p.id">{{ p.name }} <em>→ {{ p.moduleId }}</em></div>
      <div class="st-issue" v-for="(i, idx) in pluginIssues" :key="idx">✕ {{ i.file }}：{{ i.message }}</div>
      <div class="st-pl none" v-if="plugins.length === 0 && pluginIssues.length === 0">没有插件（声明式，只能引用内置模块）</div>
    </div>

    <details class="st-about">
      <summary>快捷键与说明</summary>
      <div class="kv"><kbd>Ctrl+K</kbd> 命令面板</div>
      <div class="kv"><kbd>Ctrl+Alt+L</kbd> 立即锁定</div>
      <div class="kv"><kbd>F</kbd> 大屏 / <kbd>Esc</kbd> 退出 / <kbd>T</kbd> 主题</div>
      <div class="kv"><kbd>Enter</kbd> 保存一行 · <kbd>Esc</kbd> 清空</div>
      <div class="kv note">本地优先：不联网、不上传；库为 AES-256-GCM 密文；备份在 backups\。</div>
    </details>

    <div class="st-msg" v-if="msg">{{ msg }}</div>
  </div>
</template>

<style scoped>
.st {
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
}

.st-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.st-title {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.st-ver {
  font-size: 12px;
  color: var(--text-muted);
}

.st-file {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 8px;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.st-file .k {
  color: var(--text-muted);
}

.st-file .err {
  grid-column: 1 / -1;
  color: var(--countdown-urgent);
}

.st-file .warn {
  grid-column: 1 / -1;
  color: var(--countdown-warn);
}

.st-path {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.st-btns button,
.st-migrate button {
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-elev-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 3px 8px;
}

.st-btns button:hover,
.st-migrate button:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.st-btns button:disabled,
.st-migrate button:disabled {
  opacity: 0.45;
}

.st-migrate {
  display: flex;
  gap: 4px;
}

.st-migrate input {
  flex: 1;
  min-width: 0;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 3px 6px;
  font-size: 12px;
}

.st-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.st-msg {
  font-size: 12px;
  color: var(--countdown-ok);
  line-height: 1.4;
  word-break: break-all;
}

.st-lock {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--border);
  padding-top: 5px;
}

.st-lockhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.st-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.st-state {
  font-size: 12px;
  color: var(--text-muted);
}

.st-state.on {
  color: var(--countdown-ok);
}

.st-inline {
  display: flex;
  gap: 4px;
}

.st-inline input,
.st-inline select {
  flex: 1;
  min-width: 0;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 3px 6px;
  font-size: 12px;
  color: var(--text-primary);
}

.st-inline button {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-elev-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 3px 8px;
}

.st-inline button:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.st-plugins {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-top: 1px solid var(--border);
  padding-top: 5px;
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

.st-pl {
  font-size: 12px;
  color: var(--text-secondary);
}

.st-pl em {
  color: var(--text-muted);
  font-style: normal;
}

.st-pl.none {
  color: var(--text-muted);
}

.st-issue {
  font-size: 12px;
  color: var(--countdown-urgent);
  word-break: break-all;
}

.st-about {
  border-top: 1px solid var(--border);
  padding-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.st-about summary {
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 12px;
}

.st-about .kv {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}

.st-about .kv.note {
  color: var(--text-muted);
  line-height: 1.4;
}

kbd {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 3px;
  color: var(--text-secondary);
}
</style>



