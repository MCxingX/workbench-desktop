<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AppInfo, LockState, LogEntry, LogStats, ScheduleState, TmpDirInfo, UiState, UpdateState } from '@shared/types'
import type { ShiftProfile, WeekVariant } from '@shared/schedule/model'
import { validateProfile, variantOf, previewDays } from '@shared/schedule/resolve'
import { addDays, mondayOf, ymd } from '@shared/schedule/time'
import { encodeShare, decodeShare } from '@shared/schedule/share-link'
import RulesPanel from '../modules/settings/RulesPanel.vue'

const props = defineProps<{ open: boolean; tab?: string }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void; (e: 'theme'): void }>()

type Tab = 'schedule' | 'week' | 'lock' | 'rules' | 'data' | 'update' | 'diag' | 'about'
const tab = ref<Tab>('schedule')
const TABS: { id: Tab; label: string }[] = [
  { id: 'schedule', label: '班表与工时' },
  { id: 'week', label: '单双周 / 单双月' },
  { id: 'lock', label: '应用锁' },
  { id: 'rules', label: '规则与自学' },
  { id: 'data', label: '数据与备份' },
  { id: 'update', label: '更新' },
  { id: 'diag', label: '诊断' },
  { id: 'about', label: '关于' }
]

const WD = ['一', '二', '三', '四', '五', '六', '日']
const info = ref<AppInfo | null>(null)
const ui = ref<UiState | null>(null)
const state = ref<ScheduleState | null>(null)
const draft = ref<ShiftProfile | null>(null)
const presets = ref<ShiftProfile[]>([])
const msg = ref('')
const err = ref('')

// 锁
const lock = ref<LockState | null>(null)
const pwNew = ref('')
const pwOld = ref('')
const autoMin = ref(10)
const recoveryCode = ref('')
const recoveryHintText = ref('')
const hasRecovery = ref(false)
const resetCode = ref('')
const resetPw = ref('')

// 数据
const stats = ref<Awaited<ReturnType<typeof window.wb.storeStats>> | null>(null)
const backups = ref<{ name: string; path: string; size: number; at: string }[]>([])
const migrateTo = ref('')
const keyPwd = ref('')
// 临时目录（portable 解压目录落在系统临时目录，C 盘吃紧时可挪走）
const tmp = ref<(TmpDirInfo & { suggest: string }) | null>(null)
const tmpTo = ref('')
const tmpMsg = ref('')

async function protectKey(): Promise<void> {
  try {
    const r = await window.wb.recoveryProtectKey(keyPwd.value)
    keyPwd.value = ''
    if (r.ok) flash(r.message)
    else fail(r.message)
  } catch (e) {
    fail((e as Error).message)
  }
}

async function removePwdKey(): Promise<void> {
  try {
    const r = await window.wb.recoveryRemovePwdKey()
    flash(r.message)
  } catch (e) {
    fail((e as Error).message)
  }
}

// ── 单双月午休 ──
const monthLunchOn = computed(() => !!draft.value?.monthLunch?.enabled)
const curMonthOdd = computed(() => new Date().getMonth() % 2 === 0)

function setMonthLunch(on: boolean): void {
  if (!draft.value) return
  if (!on) {
    draft.value.monthLunch = { enabled: false, odd: null, even: null }
    return
  }
  const base = draft.value.base.lunch
  draft.value.monthLunch = {
    enabled: true,
    odd: draft.value.monthLunch?.odd ?? (base ? { ...base } : { start: '12:00', end: '13:00' }),
    even: draft.value.monthLunch?.even ?? (base ? { ...base } : { start: '12:00', end: '13:00' })
  }
}

function setMonthLunchSide(side: 'odd' | 'even', on: boolean): void {
  if (!draft.value?.monthLunch) return
  const base = draft.value.base.lunch
  draft.value.monthLunch[side] = on ? (base ? { ...base } : { start: '12:00', end: '13:00' }) : null
}

const autostartOn = ref(false)
const plugins = ref<{ id: string; name: string; moduleId: string }[]>([])
const pluginIssues = ref<{ file: string; message: string }[]>([])
const shareText = ref('')

// ── 诊断日志 ──
const logs = ref<LogEntry[]>([])
const logStat = ref<LogStats | null>(null)
const diagMsg = ref('')

function fmtBytes(n: number): string {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n > 1024) return (n / 1024).toFixed(0) + ' KB'
  return n + ' B'
}

async function loadLogs(): Promise<void> {
  logs.value = await window.wb.logRecent(160)
  logStat.value = await window.wb.logStats()
}

async function copyReport(): Promise<void> {
  try {
    const text = await window.wb.logReport()
    await navigator.clipboard.writeText(text)
    diagMsg.value = '诊断信息已复制，粘给开发者即可'
  } catch (err) {
    diagMsg.value = '复制失败：' + (err as Error).message
  }
  window.setTimeout(() => (diagMsg.value = ''), 4000)
}

async function exportDiag(): Promise<void> {
  const r = await window.wb.logExport()
  diagMsg.value = '已导出：' + r.file
  window.setTimeout(() => (diagMsg.value = ''), 6000)
}

async function openLogDir(): Promise<void> {
  await window.wb.logOpenDir()
}

async function clearDiag(): Promise<void> {
  logStat.value = await window.wb.logClear()
  diagMsg.value = '错误计数已清零（日志文件不动）'
  window.setTimeout(() => (diagMsg.value = ''), 3000)
}


// ── 在线更新 ──
const upd = ref<UpdateState | null>(null)
const updBusy = ref(false)
let offUpd: (() => void) | null = null

function fmtBps(bps: number): string {
  if (!bps) return '—'
  if (bps > 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + ' MB/s'
  return Math.round(bps / 1024) + ' KB/s'
}

async function checkUpdate(): Promise<void> {
  updBusy.value = true
  try {
    upd.value = await window.wb.updateCheck()
  } finally {
    updBusy.value = false
  }
}

async function runDownload(): Promise<void> {
  updBusy.value = true
  try {
    upd.value = await window.wb.updateDownload()
  } finally {
    updBusy.value = false
  }
}

async function runApply(): Promise<void> {
  await window.wb.updateApply()
}

onMounted(async () => {
  info.value = await window.wb.info()
  ui.value = await window.wb.uiGet()
  state.value = await window.wb.scheduleGet()
  draft.value = raw(active())
  presets.value = await window.wb.schedulePresets()
  lock.value = await window.wb.lockState()
  autoMin.value = lock.value.autoLockMinutes
  hasRecovery.value = await window.wb.lockHasRecovery()
  recoveryHintText.value = (await window.wb.lockRecoveryHint()) ?? ''
  stats.value = await window.wb.storeStats()
  backups.value = await window.wb.backupList()
  autostartOn.value = await window.wb.autostart()
  await refreshTmp()
  const pl = await window.wb.pluginsList()
  plugins.value = pl.plugins
  pluginIssues.value = pl.issues
  if (props.tab === 'week') tab.value = 'week'
  await loadLogs()
  upd.value = await window.wb.updateState()
  offUpd = window.wb.onUpdateState((s) => {
    upd.value = s
  })
})

function onEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) emit('close')
}

watch(
  () => props.tab,
  (t) => {
    if (t === 'week' || t === 'lock' || t === 'data' || t === 'schedule' || t === 'about') tab.value = t
  }
)

function raw<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function active(): ShiftProfile {
  const s = state.value!
  return s.profiles.find((p) => p.id === s.activeId) ?? s.profiles[0]
}

const issues = computed(() => (draft.value ? validateProfile(draft.value) : []))
onBeforeUnmount(() => {
  offUpd?.()
})

const canSave = computed(() => draft.value !== null && issues.value.length === 0)

function flash(text: string): void {
  msg.value = text
  err.value = ''
  setTimeout(() => (msg.value = ''), 2600)
}
function fail(text: string): void {
  err.value = text
  setTimeout(() => (err.value = ''), 4000)
}

async function saveSchedule(): Promise<void> {
  if (!draft.value || !state.value) return
  if (!canSave.value) {
    fail(issues.value[0].message)
    return
  }
  const profiles = state.value.profiles.map((p) => (p.id === draft.value!.id ? raw(draft.value!) : p))
  const fresh = await window.wb.scheduleSave({ activeId: draft.value.id, profiles })
  state.value = fresh
  draft.value = raw(active())
  flash('已保存，倒计时立即生效')
  emit('saved')
}

function cloneVariant(v: WeekVariant | null, name: string): WeekVariant {
  if (v) return raw(v)
  return { name, mask: [true, true, true, true, true, false, false], shift: raw(draft.value!.base) }
}

/** 打开单双周：自动用当前掩码/班次造 A/B 两套 */
function enableWeekCycle(): void {
  const d = draft.value!
  d.weekCycle.mode = 'alternate'
  d.weekCycle.anchorMonday = ymd(mondayOf(new Date()))
  d.weekCycle.anchorVariant = 'primary'
  d.weekCycle.primary = cloneVariant(null, 'A 周')
  d.weekCycle.secondary = cloneVariant(null, 'B 周')
}

function disableWeekCycle(): void {
  draft.value!.weekCycle.mode = 'none'
}

function quickMask(target: boolean[], kind: 'five' | 'six' | 'all'): void {
  const arr = kind === 'five' ? [1, 1, 1, 1, 1, 0, 0] : kind === 'six' ? [1, 1, 1, 1, 1, 1, 0] : [1, 1, 1, 1, 1, 1, 1]
  arr.forEach((v, i) => (target[i] = v === 1))
}

function applyPreset(id: string): void {
  const p = presets.value.find((x) => x.id === id)
  if (!p || !draft.value) return
  const keepId = draft.value.id
  const keepName = draft.value.name
  draft.value = { ...raw(p), id: keepId, name: keepName }
  flash(`已套用预设：${p.name}（记得点保存）`)
}

/** 未来 5 周各自是哪一套 —— 单双周一眼看清 */
const weekPreview = computed(() => {
  const d = draft.value
  if (!d || d.weekCycle.mode !== 'alternate') return []
  const out: { week: string; variant: string; days: string }[] = []
  let monday = mondayOf(new Date())
  for (let i = 0; i < 6; i++) {
    const ds = ymd(monday)
    const v = variantOf(d, ds)
    const days = previewDays(d, monday, 7)
    out.push({
      week: `${ds.slice(5)} 起`,
      variant: v?.variant === 'primary' ? d.weekCycle.primary?.name ?? 'A' : d.weekCycle.secondary?.name ?? 'B',
      days: days.map((x) => (x.attendance.onDuty ? '班' : '休')).join('')
    })
    monday = addDays(monday, 7)
  }
  return out
})

const thisWeekLabel = computed(() => {
  const d = draft.value
  if (!d || d.weekCycle.mode !== 'alternate') return ''
  const v = variantOf(d, ymd(new Date()))
  if (!v) return ''
  return v.variant === 'primary' ? d.weekCycle.primary?.name ?? 'A 周' : d.weekCycle.secondary?.name ?? 'B 周'
})

// ── 锁 ──
async function enableLock(): Promise<void> {
  if (pwNew.value.length < 4) return fail('密码至少 4 位')
  lock.value = await window.wb.lockSetPassword(pwNew.value)
  pwNew.value = ''
  flash('已开启应用锁')
}
async function changeLock(): Promise<void> {
  try {
    lock.value = await window.wb.lockChangePassword(pwOld.value, pwNew.value)
    pwOld.value = ''
    pwNew.value = ''
    flash('已改密码')
  } catch (e) {
    fail((e as Error).message)
  }
}
async function disableLockNow(): Promise<void> {
  try {
    lock.value = await window.wb.lockDisable(pwOld.value)
    pwOld.value = ''
    flash('已关闭应用锁')
  } catch (e) {
    fail((e as Error).message)
  }
}
async function saveAuto(min: number): Promise<void> {
  autoMin.value = min
  lock.value = await window.wb.lockAutoMinutes(min)
  flash(`空闲 ${min} 分钟自动锁`)
}
async function genRecovery(): Promise<void> {
  try {
    const r = await window.wb.lockIssueRecovery(pwOld.value)
    recoveryCode.value = r.code
    hasRecovery.value = true
    pwOld.value = ''
    flash('恢复码已生成，抄下来存好')
  } catch (e) {
    fail((e as Error).message)
  }
}
async function saveHint(): Promise<void> {
  await window.wb.lockSetRecoveryHint(recoveryHintText.value)
  flash('提示已保存')
}
async function doReset(): Promise<void> {
  try {
    const r = await window.wb.lockResetByRecovery(resetCode.value, resetPw.value)
    lock.value = r.state
    recoveryCode.value = r.newCode
    resetCode.value = ''
    resetPw.value = ''
    flash('密码已重置，新恢复码已生成')
  } catch (e) {
    fail((e as Error).message)
  }
}

// ── 数据 ──
async function refreshData(): Promise<void> {
  info.value = await window.wb.info()
  stats.value = await window.wb.storeStats()
  backups.value = await window.wb.backupList()
}
async function doBackup(): Promise<void> {
  const r = await window.wb.backupCreate()
  await refreshData()
  flash(`备份完成 → ${r.file.split('\\').pop()}`)
}
async function doAutoBackup(): Promise<void> {
  const r = await window.wb.backupAutoNow()
  await refreshData()
  flash(r.created ? '已补今日自动备份' : '今天已有一份自动备份')
}
async function pickRestore(): Promise<void> {
  const f = await window.wb.backupPick()
  if (!f) return
  const r = await window.wb.backupRestore(f)
  await refreshData()
  flash(`已还原 ${r.restored.length} 个文件`)
}
async function restoreOne(p: string): Promise<void> {
  const r = await window.wb.backupRestore(p)
  await refreshData()
  flash(`已还原 ${r.restored.length} 个文件`)
}
async function doExport(): Promise<void> {
  const f = await window.wb.exportRedacted()
  flash(`打码导出 → ${String(f).split('\\').pop()}`)
}
async function doPickDir(): Promise<void> {
  const dir = await window.wb.pickDataDir()
  if (dir) migrateTo.value = dir
}

async function doMigrate(): Promise<void> {
  if (!migrateTo.value.trim()) return fail('先选目录')
  try {
    const r = await window.wb.migrateDataDir(migrateTo.value.trim())
    await refreshData()
    const info = await window.wb.info()
    flash(`已切到 ${r.to}（${r.files} 个文件，当前库：${info.dataDir === r.to ? '新目录' : '仍是旧目录'}）`)
  } catch (e) {
    fail((e as Error).message)
  }
}
async function refreshTmp(): Promise<void> {
  try {
    const t = await window.wb.tmpInfo()
    tmp.value = t
    if (!tmpTo.value && t.suggest) tmpTo.value = t.suggest
  } catch {
    /* 读不到就留空，不影响其他设置项 */
  }
}

async function doMoveTmp(): Promise<void> {
  const target = tmpTo.value.trim() || tmp.value?.suggest || ''
  if (!target) return fail('先填一个目标目录')
  try {
    const r = await window.wb.tmpMove(target)
    tmpMsg.value = r.message
    if (r.ok) {
      flash(r.needRestart ? '已改好，重启应用生效' : '已改好')
      await refreshTmp()
    } else {
      fail(r.message)
    }
  } catch (e) {
    fail((e as Error).message)
  }
}

async function doSweepTmp(): Promise<void> {
  try {
    const r = await window.wb.tmpSweep()
    tmpMsg.value = r.dirs > 0 ? `清掉 ${r.dirs} 个残留，释放约 ${r.freedMB} MB` : '没有可清的残留'
    flash(tmpMsg.value)
    await refreshTmp()
  } catch (e) {
    fail((e as Error).message)
  }
}

async function toggleAutostart(): Promise<void> {
  autostartOn.value = await window.wb.setAutostart(!autostartOn.value)
  flash(autostartOn.value ? '已设为开机自启' : '已取消开机自启')
}
async function makeSample(): Promise<void> {
  const r = await window.wb.pluginsSample()
  const pl = await window.wb.pluginsList()
  plugins.value = pl.plugins
  pluginIssues.value = pl.issues
  flash(`示例清单 → ${r.file}`)
}

function openDir(): void {
  void window.wb.openDataDir()
}
function toggleTheme(): void {
  emit('theme')
}

// 分享串
function makeShare(): void {
  if (!draft.value) return
  shareText.value = encodeShare(draft.value)
  flash('分享串已生成，可直接复制')
}
function applyShare(): void {
  const p = decodeShare(shareText.value.trim())
  if (!p) return fail('分享串无效')
  draft.value = { ...p, id: draft.value!.id, name: draft.value!.name }
  flash('已导入分享班表（记得保存）')
}
const maskOf = (v: WeekVariant | null): boolean[] => (v ? v.mask : [])
</script>

<template>
  <div class="sp-mask" v-if="open && draft">
    <div class="sp">
      <aside class="sp-nav">
        <div class="sp-title">系统设置</div>
        <button v-for="t in TABS" :key="t.id" class="sp-tab" :class="{ on: tab === t.id }" @click="tab = t.id">
          {{ t.label }}
        </button>
        <div class="sp-spacer" />
        <button class="sp-tab home" @click="openDir">打开数据目录</button>
      </aside>

      <section class="sp-body">
        <!-- 班表与工时 -->
        <template v-if="tab === 'schedule'">
          <h3>基础班次</h3>
          <div class="row">
            <label>上班</label><input type="time" v-model="draft.base.start" />
            <label>下班</label><input type="time" v-model="draft.base.end" />
            <span class="hint">下班 ≤ 上班 视为跨零点夜班</span>
          </div>
          <div class="row">
            <label>午休</label>
            <select :value="draft.base.lunch ? 'on' : 'off'" @change="draft.base.lunch = ($event.target as HTMLSelectElement).value === 'on' ? { start: '12:00', end: '13:00' } : null">
              <option value="on">有</option><option value="off">无</option>
            </select>
            <template v-if="draft.base.lunch">
              <input type="time" v-model="draft.base.lunch.start" />
              <input type="time" v-model="draft.base.lunch.end" />
            </template>
          </div>

          <h3>常规上班日</h3>
          <div class="row">
            <div class="pills">
              <button v-for="(w, i) in WD" :key="w" class="pill" :class="{ on: draft.mask[i] }" @click="draft.mask[i] = !draft.mask[i]">{{ w }}</button>
            </div>
            <button class="mini" @click="quickMask(draft.mask, 'five')">双休</button>
            <button class="mini" @click="quickMask(draft.mask, 'six')">单休</button>
            <button class="mini" @click="quickMask(draft.mask, 'all')">全周</button>
            <span class="hint" v-if="draft.weekCycle.mode === 'alternate'">已启用单双周时，这里只在未定义的工作日兜底</span>
          </div>

          <h3>弹性打卡</h3>
          <div class="row">
            <label>允许后移</label>
            <select :value="draft.dayFlex.enabled ? 'on' : 'off'" @change="draft.dayFlex.enabled = ($event.target as HTMLSelectElement).value === 'on'">
              <option value="off">关闭</option><option value="on">开启</option>
            </select>
            <template v-if="draft.dayFlex.enabled">
              <input type="number" min="0" max="180" v-model.number="draft.dayFlex.flexMinutes" class="num" /> 分钟
            </template>
          </div>

          <h3>快速预设</h3>
          <div class="row wrap">
            <button v-for="p in presets" :key="p.id" class="mini" @click="applyPreset(p.id)">{{ p.name }}</button>
          </div>

          <h3>分享串</h3>
          <div class="row">
            <input class="wide" v-model="shareText" placeholder="把班表发给同事，或粘别人的串进来" />
            <button class="mini" @click="makeShare">生成</button>
            <button class="mini" @click="applyShare">导入</button>
          </div>
        </template>

        <!-- 单双周 / 大小周（独立页） -->
        <template v-else-if="tab === 'week'">
          <h3>单双周 / 大小周</h3>
          <div class="row">
            <label>启用</label>
            <select :value="draft.weekCycle.mode" @change="($event.target as HTMLSelectElement).value === 'alternate' ? enableWeekCycle() : disableWeekCycle()">
              <option value="none">不启用（每周一样）</option>
              <option value="alternate">启用（两周交替）</option>
            </select>
            <span class="hint" v-if="thisWeekLabel">本周：<b>{{ thisWeekLabel }}</b></span>
          </div>

          <template v-if="draft.weekCycle.mode === 'alternate' && draft.weekCycle.primary && draft.weekCycle.secondary">
            <div class="row">
              <label>基准周一</label>
              <input type="date" v-model="draft.weekCycle.anchorMonday" />
              <label>这周用</label>
              <select v-model="draft.weekCycle.anchorVariant">
                <option value="primary">A 套</option>
                <option value="secondary">B 套</option>
              </select>
              <span class="hint">从这天起每 7 天交替一次</span>
            </div>

            <div class="weekgrid">
              <div class="wk" v-for="key in (['primary', 'secondary'] as const)" :key="key">
                <div class="wk-head">
                  <input class="name" v-model="draft.weekCycle[key]!.name" />
                  <span class="hint">{{ key === 'primary' ? 'A 套' : 'B 套' }}</span>
                </div>
                <div class="row">
                  <label>上班</label><input type="time" v-model="draft.weekCycle[key]!.shift.start" />
                  <label>下班</label><input type="time" v-model="draft.weekCycle[key]!.shift.end" />
                </div>
                <div class="row">
                  <label>午休</label>
                  <select
                    :value="draft.weekCycle[key]!.shift.lunch ? 'on' : 'off'"
                    @change="draft.weekCycle[key]!.shift.lunch = ($event.target as HTMLSelectElement).value === 'on' ? { start: '12:00', end: '13:00' } : null"
                  >
                    <option value="on">有</option><option value="off">无</option>
                  </select>
                  <template v-if="draft.weekCycle[key]!.shift.lunch">
                    <input type="time" v-model="draft.weekCycle[key]!.shift.lunch!.start" />
                    <input type="time" v-model="draft.weekCycle[key]!.shift.lunch!.end" />
                  </template>
                </div>
                <div class="row">
                  <div class="pills">
                    <button
                      v-for="(w, i) in WD"
                      :key="w + key"
                      class="pill"
                      :class="{ on: maskOf(draft.weekCycle[key])[i] }"
                      @click="draft.weekCycle[key]!.mask[i] = !draft.weekCycle[key]!.mask[i]"
                    >
                      {{ w }}
                    </button>
                  </div>
                </div>
                <div class="row">
                  <button class="mini" @click="quickMask(maskOf(draft.weekCycle[key]), 'five')">双休</button>
                  <button class="mini" @click="quickMask(maskOf(draft.weekCycle[key]), 'six')">单休</button>
                  <button class="mini" @click="quickMask(maskOf(draft.weekCycle[key]), 'all')">全周</button>
                </div>
              </div>
            </div>

            <h3>未来 6 周（班/休）</h3>
            <table class="wprev">
              <tr><th>周</th><th>哪一套</th><th>一到日</th></tr>
              <tr v-for="(w, i) in weekPreview" :key="i">
                <td>{{ w.week }}</td>
                <td><b>{{ w.variant }}</b></td>
                <td class="days">{{ w.days }}</td>
              </tr>
            </table>
            <p class="tip">大小周＝A 套上 6 天、B 套上 5 天；单双周＝两套时段或上班日不同，都在这两格里配。</p>
          </template>
          <p class="tip" v-else>不启用时，全周统一按「常规上班日」判定。临时某一周特殊 → 用「班表与工时」里的法定假期/补班，或到考勤月历里单独补记。</p>

          <h3>单双月午休</h3>
          <div class="row">
            <label>启用</label>
            <select :value="monthLunchOn ? 'on' : 'off'" @change="setMonthLunch(($event.target as HTMLSelectElement).value === 'on')">
              <option value="off">不启用（每月午休一样）</option>
              <option value="on">启用（单月 / 双月各一套）</option>
            </select>
            <span class="hint" v-if="monthLunchOn">本月是 <b>{{ curMonthOdd ? '单月' : '双月' }}</b>，按 {{ curMonthOdd ? '单月' : '双月' }}那行算</span>
          </div>

          <template v-if="monthLunchOn && draft.monthLunch">
            <div class="weekgrid">
              <div class="wk" v-for="side in (['odd', 'even'] as const)" :key="side">
                <div class="wk-head">
                  <span class="name">{{ side === 'odd' ? '单月（1/3/5/7/9/11）' : '双月（2/4/6/8/10/12）' }}</span>
                </div>
                <div class="row">
                  <label>午休</label>
                  <select
                    :value="draft.monthLunch[side] ? 'on' : 'off'"
                    @change="setMonthLunchSide(side, ($event.target as HTMLSelectElement).value === 'on')"
                  >
                    <option value="on">有</option><option value="off">沿用基础午休</option>
                  </select>
                  <template v-if="draft.monthLunch[side]">
                    <input type="time" v-model="draft.monthLunch[side]!.start" />
                    <input type="time" v-model="draft.monthLunch[side]!.end" />
                  </template>
                </div>
              </div>
            </div>
            <p class="tip">只改午休，上下班时间仍用「班表与工时」里的基础时段。写「沿用基础午休」的那一侧会跟着基础走。</p>
          </template>

        </template>

        <!-- 应用锁 -->
        <template v-else-if="tab === 'lock'">
          <h3>应用锁</h3>
          <div class="row">
            <label>状态</label>
            <span class="badge" :class="{ on: lock?.enabled }">{{ lock?.enabled ? '已开启' : '未开启' }}</span>
          </div>
          <div class="row" v-if="!lock?.enabled">
            <label>设置密码</label><input type="password" v-model="pwNew" placeholder="至少 4 位" />
            <button class="mini go" @click="enableLock">开启</button>
          </div>
          <template v-else>
            <div class="row">
              <label>改密码</label>
              <input type="password" v-model="pwOld" placeholder="当前密码" />
              <input type="password" v-model="pwNew" placeholder="新密码" />
              <button class="mini" @click="changeLock">修改</button>
              <button class="mini danger" @click="disableLockNow">关闭锁</button>
            </div>
          </template>
          <h3>自动锁</h3>
          <div class="row">
            <button v-for="m in [5, 10, 30, 0]" :key="m" class="mini" :class="{ on: autoMin === m }" @click="saveAuto(m)">
              {{ m === 0 ? '不自动' : `${m} 分钟` }}
            </button>
            <span class="hint">空闲到点自动锁；Ctrl+Alt+L 随时手动锁</span>
          </div>

          <h3>恢复码（忘了密码的退路）</h3>
          <div class="row">
            <span class="hint">{{ hasRecovery ? '已生成过恢复码' : '还没生成' }}</span>
            <input type="password" v-model="pwOld" placeholder="当前密码（用于生成/重发）" />
            <button class="mini" @click="genRecovery">生成恢复码</button>
          </div>
          <div class="row" v-if="recoveryCode">
            <label>新恢复码</label><code class="code">{{ recoveryCode }}</code>
          </div>
          <div class="row">
            <label>提示语</label>
            <input v-model="recoveryHintText" placeholder="比如：写在抽屉那张纸上" class="wide" />
            <button class="mini" @click="saveHint">保存</button>
          </div>
          <div class="row">
            <label>用恢复码重置</label>
            <input v-model="resetCode" placeholder="xxxx-xxxx-xxxx-xxxx" />
            <input type="password" v-model="resetPw" placeholder="新密码" />
            <button class="mini" @click="doReset">重置</button>
          </div>
        </template>

        <!-- 规则与自学 -->
        <template v-else-if="tab === 'rules'">
          <RulesPanel />
        </template>

        <!-- 数据与备份 -->
        <template v-else-if="tab === 'data'">
          <h3>临时目录（C 盘空间）</h3>
          <div class="row">
            <code class="code">{{ tmp?.current || '读取中…' }}</code>
            <span v-if="tmp" class="badge" :class="tmp.drive.toLowerCase() === 'c:' ? 'warn' : 'ok'">
              {{ tmp.drive }} 盘
              <template v-if="tmp.freeGB !== null"> · 剩 {{ tmp.freeGB }} GB</template>
            </span>
          </div>
          <div class="row">
            <input v-model="tmpTo" :placeholder="tmp?.suggest || 'D:\\WorkbenchTemp'" class="wide" />
            <button class="mini" @click="doMoveTmp">挪到别的盘</button>
            <button class="mini" @click="doSweepTmp">清残留</button>
          </div>
          <p class="tip">
            portable 版每次双击，启动器会先把程序解压到系统临时目录（约 290MB，解压峰值约 570MB），
            跑完自动删。但进程被强制结束（任务管理器结束任务、断电）就删不掉，一次留 570MB。
            把临时目录挪到别的盘后，这套东西从此不占 C 盘，重启应用生效。
          </p>
          <p v-if="tmpMsg" class="tip strong">{{ tmpMsg }}</p>

          <h3>数据目录</h3>
          <div class="row">
            <code class="code">{{ info?.dataDir }}</code>
            <button class="mini" @click="openDir">打开</button>
          </div>
          <div class="row">
            <input v-model="migrateTo" placeholder="新的数据目录，如 H:\WorkbenchData" class="wide" />
            <button class="mini" @click="doPickDir">选择目录</button>
            <button class="mini go" @click="doMigrate">迁移并切换</button>
          </div>
          <p class="tip">
            迁移会把库、备份、附件、导出、日志、插件全部复制过去，校验通过后立刻切到新目录 ——
            不用重启，旧目录也不会再被写入（只留一张「已迁移到.txt」，删不删你决定）。
          </p>

          <h3>数据救援</h3>
          <div class="row">
            <label>密码保护密钥</label>
            <input type="password" v-model="keyPwd" placeholder="设置一个密码（至少 4 位）" />
            <button class="mini" @click="protectKey">生成密码副本</button>
            <button class="mini" @click="removePwdKey">移除</button>
          </div>
          <p class="tip">
            开启后会在数据目录里多一个 <code>master.key.pwd</code>：将来换电脑、%APPDATA% 丢了，
            只要记得这个密码就能把数据解开。它和「应用锁密码」是两件事，建议设成同一个。
          </p>
          <div class="row wrap">
            <span class="stat" v-if="stats">行数 <b>{{ stats.count }}</b> · {{ Math.round(stats.sizeBytes / 1024) }}KB</span>
            <span class="stat" v-for="(v, k) in stats?.counts ?? {}" :key="k">{{ k }}: <b>{{ v }}</b></span>
          </div>

          <h3>备份</h3>
          <div class="row">
            <button class="mini go" @click="doBackup">立即备份</button>
            <button class="mini" @click="doAutoBackup">补今日自动备份</button>
            <button class="mini" @click="pickRestore">从文件还原…</button>
            <button class="mini" @click="doExport">打码导出</button>
            <span class="hint">每天启动自动备份一份，保留 7 份</span>
          </div>
          <table class="tbl">
            <tr><th>备份</th><th>大小</th><th>时间</th><th /></tr>
            <tr v-for="b in backups" :key="b.path">
              <td>{{ b.name }}</td>
              <td>{{ Math.round(b.size / 1024) }} KB</td>
              <td>{{ b.at.slice(0, 16).replace('T', ' ') }}</td>
              <td><button class="mini" @click="restoreOne(b.path)">还原</button></td>
            </tr>
          </table>

          <h3>系统集成</h3>
          <div class="row">
            <label>开机自启</label>
            <button class="mini" :class="{ on: autostartOn }" @click="toggleAutostart">{{ autostartOn ? '已开启' : '已关闭' }}</button>
            <span class="hint">启动后最小化到托盘，不抢焦点</span>
          </div>

          <h3>插件清单</h3>
          <div class="row">
            <button class="mini" @click="makeSample">生成示例</button>
            <span class="hint">声明式，只能引用内置模块</span>
          </div>
          <div class="pl" v-for="p in plugins" :key="p.id">{{ p.name }} <em>→ {{ p.moduleId }}</em></div>
          <div class="issue" v-for="(i, idx) in pluginIssues" :key="idx">✕ {{ i.file }}：{{ i.message }}</div>
        </template>

        <template v-else-if="tab === 'diag'">
          <div class="dg">
            <div class="dg-row">
              <span class="dg-k">错误</span>
              <span class="dg-v" :class="{ bad: (logStat?.errors ?? 0) > 0 }">{{ logStat?.errors ?? 0 }} 条</span>
              <span class="dg-k">日志</span>
              <span class="dg-v mono">{{ fmtBytes(logStat?.bytes ?? 0) }}</span>
              <span class="spacer" />
              <button class="mini" @click="loadLogs">刷新</button>
              <button class="mini" @click="openLogDir">打开日志目录</button>
            </div>

            <div class="dg-row">
              <button class="mini go" @click="copyReport">复制诊断信息</button>
              <button class="mini" @click="exportDiag">导出诊断包</button>
              <button class="mini" @click="clearDiag">清零错误计数</button>
              <span class="dg-msg">{{ diagMsg }}</span>
            </div>

            <p class="dg-path mono">{{ logStat?.file }}</p>

            <div class="dg-list">
              <div class="dg-item" v-for="(l, i) in logs.slice().reverse()" :key="i" :class="l.level">
                <span class="dg-t">{{ l.at.slice(11, 19) }}</span>
                <span class="dg-s">{{ l.scope }}</span>
                <span class="dg-m">{{ l.message }}</span>
              </div>
              <div class="dg-empty" v-if="!logs.length">还没有日志</div>
            </div>

            <p class="dg-tip">
              日志放在 %APPDATA%\Workbench\logs，不跟数据目录走 —— 数据目录本身可能就是故障源。
              报错时点「复制诊断信息」发过来就行，里面只有版本、系统、路径和错误栈，没有你的待办和记录。
            </p>
          </div>
        </template>

        <template v-else-if="tab === 'update'">
          <div class="upd">
            <div class="upd-row">
              <span class="upd-k">当前版本</span>
              <span class="upd-v">v{{ info?.version }}</span>
              <span class="spacer" />
              <button class="mini go" :disabled="updBusy" @click="checkUpdate">
                {{ updBusy ? '处理中…' : '检查更新' }}
              </button>
            </div>

            <p class="upd-msg" :class="{ bad: upd?.phase === 'error' }">{{ upd?.message || '还没检查过' }}</p>

            <div class="upd-bar" v-if="upd && (upd.phase === 'downloading' || upd.phase === 'probing')">
              <div class="track"><i :style="{ width: (upd?.pct ?? 0) + '%' }" /></div>
              <span class="upd-speed">{{ upd?.pct ?? 0 }}% · {{ fmtBps(upd?.bytesPerSec ?? 0) }}</span>
            </div>

            <div class="upd-row" v-if="upd?.info">
              <span class="upd-k">最新版本</span>
              <span class="upd-v">v{{ upd.info.latest }}</span>
              <span class="upd-k">来自</span>
              <span class="upd-v">{{ upd.info.source }}</span>
              <span class="spacer" />
              <button class="mini" :disabled="updBusy || upd.phase === 'downloading'" @click="runDownload">下载更新</button>
              <button class="mini go" v-if="upd.canApply" @click="runApply">重启并安装</button>
            </div>

            <pre class="upd-notes" v-if="upd?.info?.notes">{{ upd.info.notes }}</pre>

            <div class="upd-src" v-if="upd && upd.probes.length">
              <div class="upd-src-head"><span>节点</span><span>状态</span><span>握手</span><span>速度</span></div>
              <div class="upd-src-row" v-for="p in upd.probes" :key="p.id">
                <span>{{ p.name }}</span>
                <span :class="p.ok ? 'ok' : 'bad'">{{ p.ok ? '可用' : (p.error || '失败') }}</span>
                <span>{{ p.ms }} ms</span>
                <span>{{ fmtBps(p.bps) }}</span>
              </div>
            </div>

            <p class="upd-tip">
              更新包只从 GitHub Releases 下载，会先并发探测所有节点，选握手最快、下载最稳的那个。
              想加自己的加速节点：设置项 updateSources（JSON：[{ "id", "name", "prefix" }]）。
            </p>
          </div>
        </template>

        <!-- 关于 -->
        <template v-else>
          <h3>关于</h3>
          <div class="row"><label>版本</label><span>v{{ info?.version }}</span></div>
          <div class="row"><label>平台</label><span>{{ info?.platform }} · {{ info?.isPackaged ? '已打包' : '开发模式' }}</span></div>
          <div class="row"><label>数据</label><code class="code">{{ info?.dataDir }}</code></div>
          <h3>快捷键</h3>
          <div class="keys">
            <div><kbd>Ctrl+K</kbd> 命令面板</div>
            <div><kbd>Ctrl+,</kbd> 打开系统设置</div>
            <div><kbd>Ctrl+Alt+K</kbd> 全局打卡（窗口不在前台也行）</div>
            <div><kbd>Ctrl+Alt+L</kbd> 立即锁定</div>
            <div><kbd>F</kbd> 大屏 · <kbd>Esc</kbd> 退出 · <kbd>T</kbd> 换主题</div>
            <div><kbd>Enter</kbd> 保存一行 · <kbd>Esc</kbd> 清空</div>
          </div>
          <h3>外观</h3>
          <div class="row">
            <label>主题</label>
            <button class="mini" @click="toggleTheme">切换亮/暗（当前 {{ ui?.theme }}）</button>
            <span class="hint">布局锁在网格右上角的锁图标</span>
          </div>
          <p class="tip">数据只在本机：库为 AES-256-GCM 密文，密钥由 Windows DPAPI 保管，进程不联网。</p>
        </template>

        <div class="foot">
          <span class="err" v-if="err">{{ err }}</span>
          <span class="ok" v-else-if="msg">{{ msg }}</span>
          <span class="spacer" />
          <button class="mini" @click="emit('close')">关闭</button>
          <button class="mini go" v-if="tab === 'schedule' || tab === 'week'" :disabled="!canSave" @click="saveSchedule">保存班表</button>
        </div>
        <div class="issue-list" v-if="issues.length && (tab === 'schedule' || tab === 'week')">
          <div v-for="(i, idx) in issues" :key="idx">· {{ i.message }}</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.sp-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: grid;
  place-items: center;
  z-index: calc(var(--z-overlay) - 1);
}

.sp {
  width: min(940px, 94vw);
  height: min(660px, 88vh);
  background: var(--bg-elev-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  display: flex;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
}

.sp-nav {
  width: 168px;
  border-right: 1px solid var(--border);
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--bg-elev-2);
}

.sp-title {
  font-size: var(--fs-h2);
  font-weight: 600;
  padding: 4px 10px 10px;
}

.sp-tab {
  text-align: left;
  padding: 6px 10px;
  border-radius: var(--r-sm);
  font-size: var(--fs-body);
  color: var(--text-secondary);
}

.sp-tab:hover {
  background: var(--bg-hover);
}

.sp-tab.on {
  background: var(--accent-weak);
  color: var(--accent);
}

.sp-tab.home {
  font-size: var(--fs-sm);
  color: var(--text-muted);
}

.sp-spacer {
  flex: 1;
}

.sp-body {
  flex: 1;
  padding: 14px 18px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

h3 {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--text-secondary);
  margin: 8px 0 2px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-body);
  flex-wrap: nowrap;
}

.row.wrap {
  flex-wrap: wrap;
}

label {
  color: var(--text-muted);
  font-size: var(--fs-sm);
  min-width: 52px;
}

input,
select {
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  padding: 2px 6px;
}

input.wide {
  flex: 1;
  min-width: 200px;
}

input.num {
  width: 64px;
}

.hint {
  font-size: 12px;
  color: var(--text-muted);
}

.pills {
  display: flex;
  gap: 3px;
}

.pill {
  min-width: 26px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: var(--fs-sm);
  padding: 1px 6px;
}

.pill.on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-weak);
}

.mini {
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 2px 8px;
  color: var(--text-secondary);
}

.mini:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.mini.on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-weak);
}

.mini.go {
  background: var(--accent);
  color: #fff;
  border-color: transparent;
  font-weight: 600;
}

.mini.danger:hover {
  color: var(--countdown-urgent);
  border-color: var(--countdown-urgent);
}

.weekgrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.wk {
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bg-elev-2);
}

.wk-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

input.name {
  flex: 1;
  font-weight: 600;
}

.wprev,
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-sm);
}

.wprev th,
.tbl th {
  text-align: left;
  color: var(--text-muted);
  font-weight: 500;
  border-bottom: 1px solid var(--border);
  padding: 3px 4px;
}

.wprev td,
.tbl td {
  padding: 3px 4px;
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
}

.days {
  font-family: ui-monospace, Consolas, monospace;
  letter-spacing: 2px;
}

.badge {
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 8px;
  color: var(--text-muted);
}

.badge.on {
  color: var(--accent);
  border-color: var(--accent);
}

/* 临时目录落盘位置：C 盘红、其他盘绿 —— 一眼看出要不要挪 */
.badge.warn {
  color: #e8a15c;
  border-color: #e8a15c;
}

.badge.ok {
  color: #5fbf8a;
  border-color: #5fbf8a;
}

.tip.strong {
  color: var(--text-primary);
}

.code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 1px 6px;
  color: var(--text-primary);
  user-select: all;
}

.stat {
  font-size: 12px;
  color: var(--text-muted);
}

.pl {
  font-size: 12px;
  color: var(--text-secondary);
}

.pl em {
  color: var(--text-muted);
  font-style: normal;
}

.issue {
  font-size: 12px;
  color: var(--countdown-urgent);
}

.keys {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

kbd {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 4px;
  margin-right: 4px;
  color: var(--text-primary);
}

.tip {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

.dg {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dg-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-sm);
}

.dg-k {
  color: var(--text-muted);
}

.dg-v {
  color: var(--text-primary);
  font-family: ui-monospace, Consolas, monospace;
}

.dg-v.bad {
  color: var(--countdown-urgent);
}

.dg-msg {
  font-size: 12px;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dg-path {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
  word-break: break-all;
}

.dg-list {
  height: 250px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-elev-1);
  padding: 4px 6px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.55;
}

.dg-item {
  display: flex;
  gap: 8px;
  padding: 1px 0;
  border-bottom: 1px solid transparent;
}

.dg-item.error .dg-m {
  color: var(--countdown-urgent);
}

.dg-item.warn .dg-m {
  color: var(--countdown-warn);
}

.dg-item .dg-t {
  color: var(--text-muted);
  flex: 0 0 auto;
}

.dg-item .dg-s {
  color: var(--accent);
  flex: 0 0 auto;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dg-item .dg-m {
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

.dg-empty {
  color: var(--text-muted);
  padding: 8px;
}

.dg-tip {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
  margin: 0;
}

.upd {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.upd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-sm);
}

.upd-k {
  color: var(--text-muted);
}

.upd-v {
  color: var(--text-primary);
  font-family: ui-monospace, Consolas, monospace;
}

.upd-msg {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  margin: 0;
}

.upd-msg.bad {
  color: var(--countdown-urgent);
}

.upd-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.upd-bar .track {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--bg-elev-3);
  overflow: hidden;
}

.upd-bar .track i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 160ms linear;
}

.upd-speed {
  font-size: 12px;
  color: var(--text-muted);
  min-width: 110px;
  text-align: right;
}

.upd-notes {
  margin: 0;
  padding: 8px 10px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-size: 12px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  max-height: 120px;
  overflow: auto;
}

.upd-src {
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  overflow: hidden;
  font-size: 12px;
}

.upd-src-head,
.upd-src-row {
  display: grid;
  grid-template-columns: 1.2fr 1.6fr 0.7fr 1fr;
  gap: 6px;
  padding: 4px 8px;
}

.upd-src-head {
  color: var(--text-muted);
  background: var(--bg-elev-2);
}

.upd-src-row + .upd-src-row {
  border-top: 1px solid var(--border);
}

.upd-src .ok {
  color: var(--countdown-ok);
}

.upd-src .bad {
  color: var(--countdown-urgent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upd-tip {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
  margin: 0;
}

.foot {
  position: sticky;
  bottom: 0;
  background: var(--bg-elev-1);
  z-index: 2;
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.spacer {
  flex: 1;
}

.ok {
  font-size: 12px;
  color: var(--accent);
}

.err {
  font-size: 12px;
  color: var(--countdown-urgent);
}

.issue-list {
  font-size: 12px;
  color: var(--countdown-urgent);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
</style>





