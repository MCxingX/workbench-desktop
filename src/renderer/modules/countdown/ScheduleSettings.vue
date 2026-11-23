<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ScheduleState } from '@shared/types'
import type { PersonalOverride, ShiftProfile } from '@shared/schedule/model'
import { validateProfile } from '@shared/schedule/resolve'
import { decodeShare, encodeShare } from '@shared/schedule/share-link'

const props = defineProps<{ state: ScheduleState }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', next: ScheduleState): void }>()

const current = props.state.profiles.find((p) => p.id === props.state.activeId) ?? props.state.profiles[0]

/**
 * 深拷贝必须走 JSON：current / presets 都是 Vue 的响应式 Proxy，
 * structuredClone 遇到 Proxy 会抛 DataCloneError，组件直接挂载失败，
 * 表现就是"点齿轮没有任何反应"。
 */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

const draft = ref<ShiftProfile>(clone(current))
const presets = ref<ShiftProfile[]>([])
const tab = ref<'base' | 'week' | 'month' | 'calendar' | 'share'>('base')
const holidayText = ref('')
const importMsg = ref('')

const issues = computed(() => validateProfile(draft.value))
const WD = ['一', '二', '三', '四', '五', '六', '日']

onMounted(async () => {
  presets.value = await window.wb.schedulePresets()
})

function applyPreset(id: string): void {
  const p = presets.value.find((x) => x.id === id)
  if (!p) return
  const keepId = draft.value.id
  const keepName = draft.value.name
  draft.value = { ...clone(p), id: keepId, name: keepName }
}

function setMask(target: boolean[], preset: 'five' | 'six' | 'all'): void {
  const base = preset === 'five' ? [1, 1, 1, 1, 1, 0, 0] : preset === 'six' ? [1, 1, 1, 1, 1, 1, 0] : [1, 1, 1, 1, 1, 1, 1]
  base.forEach((v, i) => (target[i] = v === 1))
}

function toggleMask(target: boolean[], i: number): void {
  target[i] = !target[i]
}

function addMonthRow(): void {
  const ym = new Date().toISOString().slice(0, 7)
  draft.value.monthOverrides.push({ ym, shift: { start: draft.value.base.start, end: draft.value.base.end }, note: '' })
}

function addHoliday(): void {
  draft.value.holidays.push({ name: '假期', from: '2026-10-01', to: '2026-10-07' })
}

function addMakeup(): void {
  draft.value.makeups.push({ date: '2026-10-10', name: '假期' })
}

function addOverride(): void {
  const ov: PersonalOverride = {
    id: `ov-${Date.now()}`,
    dateFrom: '2026-11-20',
    dateTo: '2026-11-20',
    kind: 'off',
    note: ''
  }
  draft.value.overrides.push(ov)
}

/** 粘贴导入节假日：支持 "名称 2026-10-01 2026-10-07" 与 "2026-10-01~2026-10-07 名称" */
function importHolidays(): void {
  const lines = holidayText.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let ok = 0
  for (const line of lines) {
    const range = /(\d{4}-\d{2}-\d{2})\s*[~至到-]\s*(\d{4}-\d{2}-\d{2})/.exec(line)
    if (!range) continue
    const name = line.replace(range[0], '').replace(/[,，:：]/g, ' ').trim() || '假期'
    draft.value.holidays.push({ name, from: range[1], to: range[2] })
    ok++
  }
  importMsg.value = ok > 0 ? `导入 ${ok} 条，请核对日期` : '没识别到日期区间（示例：国庆节 2026-10-01 2026-10-07）'
  if (ok > 0) holidayText.value = ''
}

const shareText = computed(() => encodeShare(draft.value))

async function copyShare(): Promise<void> {
  await navigator.clipboard.writeText(shareText.value)
  importMsg.value = '分享串已复制到剪贴板'
}

function importShare(): void {
  const p = decodeShare(holidayText.value.trim())
  if (!p) {
    importMsg.value = '不是可识别的班表串（需要包含 s= 上班 与 e= 下班）'
    return
  }
  draft.value = { ...p, id: draft.value.id, name: p.name || draft.value.name }
  importMsg.value = '已导入该班表，可继续修改后保存'
}

const saving = ref(false)
const saveError = ref('')

async function save(): Promise<void> {
  if (issues.value.length > 0 || saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    // 关键：draft 与 props.state 里都是响应式 Proxy，直接 invoke 会 DataCloneError，
    // 之前的表现就是"点保存毫无反应"。先 JSON 深拷贝成纯对象再走 IPC。
    const next = clone({
      activeId: draft.value.id,
      profiles: props.state.profiles.map((p) => (p.id === draft.value.id ? draft.value : p))
    }) as ScheduleState
    const fresh = await window.wb.scheduleSave(next)
    emit('saved', fresh)
  } catch (err) {
    saveError.value = '保存失败：' + ((err as Error)?.message ?? '未知原因')
  } finally {
    saving.value = false
  }
}

/** A/B 两套的午休开关（原来只有上下班，夜班/大小周不同午休没法表达） */
function setVariantLunch(shift: { lunch: { start: string; end: string } | null }, on: boolean): void {
  shift.lunch = on ? (shift.lunch ?? { start: '12:00', end: '13:00' }) : null
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="panel" @keydown.esc="emit('close')">
      <header class="head">
        <span class="title">班表设置</span>
        <input class="name" v-model="draft.name" placeholder="方案名（可多套）" />
        <button class="x" @click="emit('close')">✕</button>
      </header>

      <nav class="tabs">
        <button v-for="t in ([['base','基础'],['week','周与交替'],['month','逐月规则'],['calendar','节假日与例外'],['share','分享导入']] as const)"
                :key="t[0]" class="tab" :class="{ on: tab === t[0] }" @click="tab = t[0]">{{ t[1] }}</button>
      </nav>

      <div class="body">
        <!-- 基础 -->
        <section v-if="tab === 'base'" class="grid">
          <label class="row"><span class="k">套用预设</span>
            <select @change="applyPreset(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
              <option value="">选择预设…</option>
              <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>
          <label class="row"><span class="k">上班</span><input type="time" v-model="draft.base.start" /></label>
          <label class="row"><span class="k">下班</span><input type="time" v-model="draft.base.end" />
            <em class="hint" v-if="draft.base.end <= draft.base.start">跨零点夜班（归属开始那天）</em>
          </label>
          <label class="row"><span class="k">午休</span>
            <select :value="draft.base.lunch ? 'on' : 'off'" @change="draft.base.lunch = ($event.target as HTMLSelectElement).value === 'on' ? { start: '12:00', end: '13:00' } : null">
              <option value="on">有</option><option value="off">无</option>
            </select>
          </label>
          <label class="row" v-if="draft.base.lunch"><span class="k">午休时段</span>
            <input type="time" v-model="draft.base.lunch.start" />
            <input type="time" v-model="draft.base.lunch.end" />
          </label>
          <label class="row"><span class="k">法定节假日</span>
            <select :value="draft.useHolidays ? 'on' : 'off'" @change="draft.useHolidays = ($event.target as HTMLSelectElement).value === 'on'">
              <option value="on">套用</option><option value="off">不套用</option>
            </select>
          </label>
          <label class="row"><span class="k">弹性打卡</span>
            <select :value="draft.dayFlex.enabled ? 'on' : 'off'" @change="draft.dayFlex.enabled = ($event.target as HTMLSelectElement).value === 'on'">
              <option value="off">关</option><option value="on">开</option>
            </select>
          </label>
          <label class="row" v-if="draft.dayFlex.enabled"><span class="k">最大浮动</span>
            <input type="number" min="0" max="180" v-model.number="draft.dayFlex.flexMinutes" /> 分钟
          </label>
        </section>

        <!-- 周 -->
        <section v-if="tab === 'week'" class="grid">
          <div class="row"><span class="k">常规周</span>
            <div class="pills">
              <button v-for="(w, i) in WD" :key="w" class="pill" :class="{ on: draft.mask[i] }" @click="toggleMask(draft.mask, i)">{{ w }}</button>
            </div>
          </div>
          <div class="row"><span class="k">快捷</span>
            <div class="pills">
              <button class="pill" @click="setMask(draft.mask, 'five')">双休</button>
              <button class="pill" @click="setMask(draft.mask, 'six')">单休</button>
              <button class="pill" @click="setMask(draft.mask, 'all')">全周</button>
            </div>
          </div>
          <label class="row"><span class="k">两周交替</span>
            <select :value="draft.weekCycle.mode" @change="draft.weekCycle.mode = ($event.target as HTMLSelectElement).value as 'none' | 'alternate'">
              <option value="none">关</option><option value="alternate">开</option>
            </select>
          </label>
          <template v-if="draft.weekCycle.mode === 'alternate'">
            <label class="row"><span class="k">基准周一</span>
              <input type="date" v-model="draft.weekCycle.anchorMonday" />
              <em class="hint">这一周用 A 套</em>
            </label>
            <label class="row"><span class="k">基准周用</span>
              <select v-model="draft.weekCycle.anchorVariant">
                <option value="primary">A 套</option><option value="secondary">B 套</option>
              </select>
            </label>
            <div class="variant" v-if="draft.weekCycle.primary && draft.weekCycle.secondary">
              <div class="vhead">A 套</div>
              <input v-model="draft.weekCycle.primary.name" placeholder="名称，如 大周/单周" />
              <div class="pills">
                <button v-for="(w, i) in WD" :key="w" class="pill" :class="{ on: draft.weekCycle.primary!.mask[i] }" @click="toggleMask(draft.weekCycle.primary!.mask, i)">{{ w }}</button>
              </div>
              <div class="inline">
                <input type="time" v-model="draft.weekCycle.primary.shift.start" />
                –
                <input type="time" v-model="draft.weekCycle.primary.shift.end" />
              </div>
              <div class="inline">
                <span class="k">午休</span>
                <select :value="draft.weekCycle.primary.shift.lunch ? 'on' : 'off'" @change="setVariantLunch(draft.weekCycle.primary!.shift, ($event.target as HTMLSelectElement).value === 'on')">
                  <option value="on">有</option><option value="off">无</option>
                </select>
                <template v-if="draft.weekCycle.primary.shift.lunch">
                  <input type="time" v-model="draft.weekCycle.primary.shift.lunch!.start" />
                  <input type="time" v-model="draft.weekCycle.primary.shift.lunch!.end" />
                </template>
              </div>
            </div>
            <div class="variant" v-if="draft.weekCycle.primary && draft.weekCycle.secondary">
              <div class="vhead">B 套</div>
              <input v-model="draft.weekCycle.secondary.name" placeholder="名称，如 小周/双周" />
              <div class="pills">
                <button v-for="(w, i) in WD" :key="w" class="pill" :class="{ on: draft.weekCycle.secondary!.mask[i] }" @click="toggleMask(draft.weekCycle.secondary!.mask, i)">{{ w }}</button>
              </div>
              <div class="inline">
                <input type="time" v-model="draft.weekCycle.secondary.shift.start" />
                –
                <input type="time" v-model="draft.weekCycle.secondary.shift.end" />
              </div>
              <div class="inline">
                <span class="k">午休</span>
                <select :value="draft.weekCycle.secondary.shift.lunch ? 'on' : 'off'" @change="setVariantLunch(draft.weekCycle.secondary!.shift, ($event.target as HTMLSelectElement).value === 'on')">
                  <option value="on">有</option><option value="off">无</option>
                </select>
                <template v-if="draft.weekCycle.secondary.shift.lunch">
                  <input type="time" v-model="draft.weekCycle.secondary.shift.lunch!.start" />
                  <input type="time" v-model="draft.weekCycle.secondary.shift.lunch!.end" />
                </template>
              </div>
            </div>
            <button v-else class="btn" @click="draft.weekCycle.primary = { name: 'A 套', mask: [...draft.mask], shift: { ...draft.base } }; draft.weekCycle.secondary = { name: 'B 套', mask: [...draft.mask], shift: { ...draft.base } }">
              从常规周复制两套
            </button>
          </template>
        </section>

        <!-- 逐月 -->
        <section v-if="tab === 'month'" class="grid">
          <p class="tip">某个月整体换时段/换周掩码。留空则继承基础档。</p>
          <div class="mtable">
            <div class="mhead"><span>月份</span><span>上班</span><span>下班</span><span>备注</span><span></span></div>
            <div class="mrow" v-for="(m, i) in draft.monthOverrides" :key="i">
              <input type="month" v-model="m.ym" />
              <input type="time" :value="m.shift?.start ?? draft.base.start" @input="m.shift = { ...(m.shift ?? {}), start: ($event.target as HTMLInputElement).value }" />
              <input type="time" :value="m.shift?.end ?? draft.base.end" @input="m.shift = { ...(m.shift ?? {}), end: ($event.target as HTMLInputElement).value }" />
              <input v-model="m.note" placeholder="备注" />
              <button class="del" @click="draft.monthOverrides.splice(i, 1)">删</button>
            </div>
          </div>
          <button class="btn" @click="addMonthRow">+ 添加月份</button>
        </section>

        <!-- 节假日 -->
        <section v-if="tab === 'calendar'" class="grid">
          <div class="hgroup">
            <div class="ghead">法定假期</div>
            <div class="hrow" v-for="(h, i) in draft.holidays" :key="i">
              <input v-model="h.name" placeholder="名称" />
              <input type="date" v-model="h.from" />
              <input type="date" v-model="h.to" />
              <button class="del" @click="draft.holidays.splice(i, 1)">删</button>
            </div>
            <button class="btn" @click="addHoliday">+ 添加假期</button>
          </div>

          <div class="hgroup">
            <div class="ghead">调休补班日</div>
            <div class="hrow" v-for="(m, i) in draft.makeups" :key="i">
              <input type="date" v-model="m.date" />
              <input v-model="m.name" placeholder="对应假期" />
              <button class="del" @click="draft.makeups.splice(i, 1)">删</button>
            </div>
            <button class="btn" @click="addMakeup">+ 添加补班日</button>
          </div>

          <div class="hgroup">
            <div class="ghead">个人例外（优先级最高）</div>
            <div class="hrow" v-for="(o, i) in draft.overrides" :key="o.id">
              <input type="date" v-model="o.dateFrom" />
              <input type="date" v-model="o.dateTo" />
              <select v-model="o.kind">
                <option value="off">请假/不上班</option>
                <option value="shift">改时段</option>
                <option value="mask">改本周安排</option>
              </select>
              <template v-if="o.kind === 'shift'">
                <input type="time" :value="o.payload?.start ?? '09:00'" @input="o.payload = { ...(o.payload ?? {}), start: ($event.target as HTMLInputElement).value }" />
                <input type="time" :value="o.payload?.end ?? '18:00'" @input="o.payload = { ...(o.payload ?? {}), end: ($event.target as HTMLInputElement).value }" />
              </template>
              <input v-model="o.note" placeholder="备注" />
              <button class="del" @click="draft.overrides.splice(i, 1)">删</button>
            </div>
            <button class="btn" @click="addOverride">+ 添加例外</button>
          </div>

          <div class="hgroup">
            <div class="ghead">粘贴导入假期</div>
            <textarea v-model="holidayText" rows="4" placeholder="每行一条：国庆节 2026-10-01 2026-10-07&#10;或：2026-10-01~2026-10-07 国庆节"></textarea>
            <button class="btn" @click="importHolidays">导入</button>
          </div>
        </section>

        <!-- 分享 -->
        <section v-if="tab === 'share'" class="grid">
          <p class="tip">分享串可发给自己/同事，导入后能还原整套规则（含月规则与节假日）。</p>
          <textarea class="share" readonly :value="shareText" rows="4" />
          <div class="inline">
            <button class="btn" @click="copyShare">复制分享串</button>
            <button class="btn" @click="importShare">从下方文本导入</button>
          </div>
          <textarea v-model="holidayText" rows="4" placeholder="把分享串粘到这里，再点『从下方文本导入』" />
        </section>
      </div>

      <footer class="foot">
        <div class="issues">
          <span v-for="(i, idx) in issues" :key="idx" class="issue">⚠ {{ i.message }}</span>
          <span v-if="importMsg" class="msg">{{ importMsg }}</span>
        </div>
        <div class="actions">
          <span class="save-error" v-if="saveError">{{ saveError }}</span>
        <button class="btn" @click="emit('close')">取消</button>
          <button class="btn primary" :disabled="issues.length > 0 || saving" @click="save">
            {{ saving ? '正在保存…' : '保存' }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-overlay);
  backdrop-filter: blur(2px);
}

.save-error {
  margin-right: auto;
  font-size: var(--fs-sm);
  color: var(--countdown-urgent);
}

.panel {
  width: min(860px, 92vw);
  height: min(680px, 88vh);
  background: var(--bg-elev-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.title {
  font-size: var(--fs-h2);
  font-weight: 600;
}

.name {
  flex: 1;
  max-width: 260px;
}

.x {
  color: var(--text-muted);
  font-size: 15px;
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 6px 10px 0;
  border-bottom: 1px solid var(--border);
}

.tab {
  font-size: var(--fs-sm);
  color: var(--text-muted);
  padding: 6px 12px;
  border-radius: var(--r-sm) var(--r-sm) 0 0;
}

.tab.on {
  color: var(--accent);
  background: var(--bg-elev-2);
  border-bottom: 2px solid var(--accent);
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px;
}

.grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--fs-body);
}

.k {
  flex: 0 0 92px;
  color: var(--text-secondary);
}

.hint {
  color: var(--text-muted);
  font-size: 12px;
  font-style: normal;
}

.pills {
  display: flex;
  gap: 4px;
}

.pill {
  min-width: 30px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: var(--fs-sm);
  background: var(--bg-elev-2);
}

.pill.on {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}

.variant {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-md);
  background: var(--bg-elev-2);
}

.vhead {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.inline {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mtable {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mhead,
.mrow {
  display: grid;
  grid-template-columns: 130px 110px 110px 1fr 48px;
  gap: 8px;
  align-items: center;
}

.mhead {
  font-size: 12px;
  color: var(--text-muted);
}

.hgroup {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-elev-2);
}

.ghead {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.hrow {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: max-content;
  gap: 6px;
  align-items: center;
}

.del {
  font-size: 12px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 2px 6px;
}

.del:hover {
  color: var(--countdown-urgent);
  border-color: var(--countdown-urgent);
}

.btn {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  background: var(--bg-elev-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 5px 12px;
  align-self: flex-start;
}

.btn:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tip {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}

.share {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
}

textarea {
  resize: vertical;
}

.foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  min-height: 52px;
}

.issues {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.issue {
  font-size: 12px;
  color: var(--countdown-urgent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.msg {
  font-size: 12px;
  color: var(--countdown-ok);
}

.actions {
  display: flex;
  gap: 8px;
}
</style>

