<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LayoutItem, ThemeMode, UiState, AppInfo, LockState } from '@shared/types'
import BentoGrid from './shell/BentoGrid.vue'
import LockOverlay from './shell/LockOverlay.vue'
import CommandPalette from './shell/CommandPalette.vue'
import OnboardingWizard from './shell/OnboardingWizard.vue'
import SettingsPanel from './shell/SettingsPanel.vue'
import { applyTheme, nextTheme } from './shell/theme'

const state = ref<UiState | null>(null)
const info = ref<AppInfo | null>(null)
const saving = ref(false)
const bigScreen = ref(false)
const lock = ref<LockState | null>(null)
const paletteOpen = ref(false)
const onboarding = ref(false)
const settingsOpen = ref(false)
const settingsTab = ref('schedule')
const toast = ref('')
const errorText = ref('')

function openSettings(tab = 'schedule'): void {
  settingsTab.value = tab
  settingsOpen.value = true
}
async function onSettingsSaved(): Promise<void> {
  flash('班表已更新')
}

function flash(msg: string): void {
  toast.value = msg
  window.setTimeout(() => (toast.value = ''), 2000)
}

async function runPaletteAction(id: string): Promise<void> {
  switch (id) {
    case 'checkin': {
      const d = new Date()
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const r = await window.wb.checkinMark(ds)
      flash(`已打卡 ${r.marked_at?.slice(0, 5) ?? ''}`)
      break
    }
    case 'todo':
      focusModule('todos')
      break
    case 'worklog':
      focusModule('worklog')
      break
    case 'paste':
      focusModule('pasteparse')
      break
    case 'summary': {
      const text = await window.wb.dailySummary()
      if (!text) {
        flash('今天还没有记录')
        break
      }
      await navigator.clipboard.writeText(text)
      flash('今日小结已复制')
      break
    }
    case 'backup': {
      const r = await window.wb.backupCreate()
      flash(`已备份 → ${r.file}`)
      break
    }
    case 'lock':
      await lockNow()
      break
    case 'bigscreen':
      bigScreen.value = !bigScreen.value
      await window.wb.setFullscreen(bigScreen.value)
      break
    case 'theme':
      toggleTheme()
      break
    case 'datadir':
      await window.wb.openDataDir()
      break
  }
}

function focusModule(id: string): void {
  const el = document.querySelector(`[data-module="${id}"] input, [data-module="${id}"] textarea`) as HTMLElement | null
  el?.focus()
}

let saveTimer: number | undefined
let idleTimer: number | undefined
let lastActivity = Date.now()

async function boot(): Promise<void> {
  state.value = await window.wb.uiGet()
  info.value = await window.wb.info()
  applyTheme(state.value.theme)
  window.wb.onLockChanged((s) => (lock.value = s))
  window.wb.onOpenSettings((tab) => openSettings(tab || 'week'))
  const ls = await window.wb.lockState()
  lock.value = ls.locked || !ls.enabled ? ls : await window.wb.lockNow()
  const settings = await window.wb.settingsGet()
  if (settings.onboardingDone !== '1') onboarding.value = true
  // 磁盘写不进去（权限/杀软/盘满）必须有红条，不能只写控制台
  window.wb.onPersistError((message) => {
    errorText.value = '保存到磁盘失败：' + message
  })
}

async function onOnboarded(payload?: { start: string; end: string }): Promise<void> {
  onboarding.value = false
  if (!payload) {
    flash('班表已保存')
    return
  }
  // 把"写到哪个文件"直接说出来：用户不用猜到底存没存
  try {
    const info = await window.wb.storeInfo()
    const name = info.file.split(/[\\/]/).pop() ?? '库文件'
    const at = info.mtime ? new Date(info.mtime).toLocaleTimeString('zh-CN', { hour12: false }) : ''
    flash(`班表已写入 ${name}${at ? ' · ' + at : ''}（${payload.start}–${payload.end}）`)
  } catch {
    flash(`班表已写入（${payload.start}–${payload.end}）`)
  }
}

function bumpActivity(): void {
  lastActivity = Date.now()
}

function startIdleWatch(): void {
  idleTimer = window.setInterval(() => {
    const s = lock.value
    if (!s || !s.enabled || s.locked) return
    if (!s.autoLockMinutes || s.autoLockMinutes <= 0) return
    if (Date.now() - lastActivity >= s.autoLockMinutes * 60_000) void window.wb.lockNow()
  }, 15_000)
}

function onUnhandled(e: PromiseRejectionEvent): void {
  const msg = (e.reason as Error)?.message ?? String(e.reason ?? '')
  errorText.value = '出错了：' + msg
  window.setTimeout(() => (errorText.value = ''), 5000)
}

onMounted(() => {
  void boot()
  startIdleWatch()
  window.addEventListener('keydown', onKey)
  window.addEventListener('unhandledrejection', onUnhandled)
  window.addEventListener('mousemove', bumpActivity, { passive: true })
  window.addEventListener('mousedown', bumpActivity, { passive: true })
  window.addEventListener('wheel', bumpActivity, { passive: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('mousemove', bumpActivity)
  window.removeEventListener('mousedown', bumpActivity)
  window.removeEventListener('wheel', bumpActivity)
  if (idleTimer) window.clearInterval(idleTimer)
})

/** 大屏模式：F 进入 / Esc 退出 / T 切主题 / Ctrl+Alt+L 锁定 / Ctrl+K 命令面板 */
async function onKey(e: KeyboardEvent): Promise<void> {
  // 锁定状态：除了"锁屏自己"的按键，一律不放行
  if (lock.value?.locked) return
  if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault()
    paletteOpen.value = !paletteOpen.value
    return
  }
  if (e.ctrlKey && e.key === ',') {
    e.preventDefault()
    openSettings('schedule')
    return
  }
  if (e.altKey && e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
    e.preventDefault()
    lock.value = await window.wb.lockNow()
    return
  }
  const tag = (e.target as HTMLElement | null)?.tagName
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
  if (typing || lock.value?.locked) return

  if (e.key === 'f' || e.key === 'F') {
    bigScreen.value = !bigScreen.value
    await window.wb.setFullscreen(bigScreen.value)
  } else if (e.key === 'Escape' && bigScreen.value) {
    bigScreen.value = false
    await window.wb.setFullscreen(false)
  } else if (e.key === 't' || e.key === 'T') {
    toggleTheme()
  }
}

function persist(): void {
  if (!state.value) return
  saving.value = true
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    if (!state.value) return
    await window.wb.uiSave(JSON.parse(JSON.stringify(state.value)))
    saving.value = false
  }, 200)
}

function toggleTheme(): void {
  if (!state.value) return
  const next: ThemeMode = nextTheme(state.value.theme)
  state.value.theme = next
  applyTheme(next)
  persist()
}

function onLayout(next: LayoutItem[]): void {
  if (!state.value) return
  state.value.layout = next
  persist()
}

function toggleLock(): void {
  if (!state.value) return
  state.value.layoutLocked = !state.value.layoutLocked
  persist()
}

function hideToTray(): void {
  void window.wb.hideWindow()
}

async function lockNow(): Promise<void> {
  lock.value = await window.wb.lockNow()
}

async function onUnlocked(): Promise<void> {
  lock.value = await window.wb.lockState()
  bumpActivity()
}

watch(
  () => state.value?.theme,
  (t) => {
    if (t) applyTheme(t)
  }
)
</script>

<template>
  <div class="app" :data-big="bigScreen">
    <header class="topbar" v-show="!bigScreen">
      <div class="brand">
        <span class="logo">W</span>
        <span class="title">工作台</span>
        <span class="ver" v-if="info">v{{ info.version }}</span>
      </div>
      <div class="actions">
        <span class="save-hint" :data-saving="saving">已保存</span>
        <button class="btn" @click="openSettings('schedule')" title="Ctrl+,">系统设置</button>
        <button class="btn" :class="{ on: state?.layoutLocked }" @click="toggleLock">
          {{ state?.layoutLocked ? '布局已锁' : '锁定布局' }}
        </button>
        <button class="btn" @click="toggleTheme">
          {{ state?.theme === 'dark' ? '暗色' : '亮色' }}
        </button>
        <button class="btn" v-if="lock?.enabled" @click="lockNow" title="Ctrl+Alt+L">锁定</button>
        <button class="btn" @click="hideToTray">隐藏到托盘</button>
      </div>
    </header>

    <main class="content">
      <BentoGrid
        v-if="state"
        :layout="state.layout"
        :locked="state.layoutLocked"
        @update:layout="onLayout"
      />
    </main>

    <div class="big-hint" v-if="bigScreen">F / Esc 退出大屏 · T 切主题 · Ctrl+K 命令面板</div>

    <transition name="fade">
      <div class="toast" v-if="toast">{{ toast }}</div>
      <div class="toast toast-err" v-if="errorText">{{ errorText }}</div>
    </transition>

    <CommandPalette :open="paletteOpen" @close="paletteOpen = false" @action="runPaletteAction" />
    <SettingsPanel
      :open="settingsOpen"
      :tab="settingsTab"
      @close="settingsOpen = false"
      @saved="onSettingsSaved"
      @theme="toggleTheme"
    />
    <OnboardingWizard v-if="onboarding" @done="onOnboarded" />
    <LockOverlay :enabled="!!lock?.enabled" :locked="!!lock?.locked" @unlocked="onUnlocked" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev-1);
  flex: 0 0 auto;
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  font-size: 13px;
}

.title {
  font-size: var(--fs-h1);
  font-weight: 600;
}

.ver {
  font-size: var(--fs-sm);
  color: var(--text-muted);
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.save-hint {
  font-size: 12px;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity var(--motion-base);
}

.save-hint[data-saving='true'] {
  opacity: 1;
}

.btn {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 4px 10px;
}

.btn:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.btn.on {
  border-color: var(--accent);
  color: var(--accent);
}

.content {
  flex: 1;
  min-height: 0;
}

.app[data-big='true'] .content {
  padding: 0;
}

.big-hint {
  position: fixed;
  right: 12px;
  bottom: 10px;
  font-size: 12px;
  color: var(--text-muted);
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 10px;
  z-index: var(--z-toast);
  opacity: 0.75;
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  background: var(--bg-elev-3);
  border: 1px solid var(--border-strong);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  padding: 6px 14px;
  border-radius: 999px;
  z-index: var(--z-toast);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--motion-base);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.toast-err {
  bottom: 44px;
  color: var(--countdown-urgent);
  border-color: var(--countdown-urgent);
}
</style>



