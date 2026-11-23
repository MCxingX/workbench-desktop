<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { ScheduleState } from '@shared/types'

const emit = defineEmits<{ (e: 'done', payload?: { start: string; end: string }): void }>()

const dataDir = ref('')
const start = ref('09:00')
const end = ref('18:00')
const useLunch = ref(true)
const lunch = ref(['12:00', '13:00'])
const mask = ref([true, true, true, true, true, false, false])
const WD = ['一', '二', '三', '四', '五', '六', '日']
const error = ref('')
const busy = ref(false)

function onEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape') void skip()
}

onMounted(async () => {
  window.addEventListener('keydown', onEsc)
  const info = await window.wb.info()
  dataDir.value = info.dataDir
  // 已经存过班表就把它读出来当默认值，别让用户看到假的 09:00
  const st = await window.wb.scheduleGet()
  const p = st.profiles.find((x) => x.id === st.activeId) ?? st.profiles[0]
  if (p) {
    start.value = p.base.start
    end.value = p.base.end
    useLunch.value = !!p.base.lunch
    if (p.base.lunch) lunch.value = [p.base.lunch.start, p.base.lunch.end]
    mask.value = [...p.mask]
  }
})

function quick(kind: 'five' | 'six' | 'all'): void {
  const base = kind === 'five' ? [1, 1, 1, 1, 1, 0, 0] : kind === 'six' ? [1, 1, 1, 1, 1, 1, 0] : [1, 1, 1, 1, 1, 1, 1]
  mask.value = base.map((v) => v === 1)
}

async function finish(): Promise<void> {
  if (end.value === start.value) {
    error.value = '上下班时间不能相同'
    return
  }
  error.value = ''
  busy.value = true
  try {
    const state: ScheduleState = await window.wb.scheduleGet()
    // 转成纯对象再交给 IPC（响应式 proxy 不能直接结构化克隆）
    const profiles = JSON.parse(JSON.stringify(state.profiles)) as ScheduleState['profiles']
    const p = profiles[0]
    p.base = { start: start.value, end: end.value, lunch: useLunch.value ? { start: lunch.value[0], end: lunch.value[1] } : null }
    p.mask = [...mask.value]
    const fresh = await window.wb.scheduleSave({ activeId: p.id, profiles })
    // 立刻回读校验：写没写进去不靠感觉
    const saved = fresh.profiles.find((x) => x.id === p.id) ?? fresh.profiles[0]
    if (!saved || saved.base.start !== start.value || saved.base.end !== end.value) {
      error.value = `保存没生效（库里是 ${saved?.base.start ?? '?'}–${saved?.base.end ?? '?'}，请重试）`
      return
    }
    await window.wb.settingsSet('onboardingDone', '1')
    emit('done', { start: saved.base.start, end: saved.base.end })
  } catch (err) {
    error.value = '保存失败：' + ((err as Error)?.message ?? '未知原因')
  } finally {
    busy.value = false
  }
}

/**
 * 跳过 ≠ 什么都没配：默认班表（09:00–18:00，午休 12:00–13:00）本来就是能用的，
 * 所以标记"已配置"，否则主界面会一直挂着"班表还没配"，让人以为每次都白填了。
 */
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onEsc)
})

async function skip(): Promise<void> {
  await window.wb.settingsSet('onboardingDone', '1')
  try {
    await window.wb.settingsSet('scheduleConfigured', '1')
  } catch {
    /* 标记失败不阻塞进入主界面 */
  }
  emit('done')
}
</script>

<template>
  <div class="ob">
    <div class="box">
      <div class="head">
        <span class="logo">W</span>
        <span class="title">先把班表填上，之后一切都自动</span>
        <span class="spacer" />
        <button class="x" title="关掉（用默认班表）" @click="skip">✕</button>
      </div>

      <div class="body">
        <p class="lead">数据全部存在本地，整库加密（AES-256-GCM），不上传、不联网。</p>
        <div class="kv"><span class="k">数据目录</span><span class="v">{{ dataDir }}</span></div>
        <p class="tip">想换位置？进入后到「数据与备份」卡片一键迁移，会校验后再切换。</p>

        <div class="row">
        <span class="k">上班</span><input type="time" v-model="start" />
        <span class="k">下班</span><input type="time" v-model="end" />
        </div>
        <div class="row">
        <span class="k">午休</span>
        <select :value="useLunch ? 'on' : 'off'" @change="useLunch = ($event.target as HTMLSelectElement).value === 'on'">
        <option value="on">有</option><option value="off">无</option>
        </select>
        <template v-if="useLunch">
        <input type="time" v-model="lunch[0]" />
        <input type="time" v-model="lunch[1]" />
        </template>
        </div>
        <div class="row">
        <span class="k">上班日</span>
        <div class="pills">
        <button v-for="(w, i) in WD" :key="w" class="pill" :class="{ on: mask[i] }" @click="mask[i] = !mask[i]">{{ w }}</button>
        </div>
        </div>
        <div class="row quick">
        <span class="k" />
        <button class="q" @click="quick('five')">双休</button>
        <button class="q" @click="quick('six')">单休</button>
        <button class="q" @click="quick('all')">全周</button>
        </div>
        <p class="tip">单双周、逐月临时调整、法定假期，都可在倒计时卡片的 ⚙ 里再补。</p>
        <p class="err" v-if="error">{{ error }}</p>
      </div>

      <div class="foot">
        <button class="ghost" @click="skip">以后再说（先用默认 09:00–18:00）</button>
        <span class="spacer" />
        <button class="go" :disabled="busy" @click="finish">{{ busy ? '正在写入…' : '保存并开始' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ob {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--bg-base) 92%, #000);
  display: grid;
  place-items: center;
  z-index: var(--z-overlay);
}

.x {
  color: var(--text-muted);
  font-size: var(--fs-body);
  padding: 0 4px;
}

.x:hover {
  color: var(--text-primary);
}

.box {
  width: min(560px, 90vw);
  background: var(--bg-elev-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.logo {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  display: grid;
  place-items: center;
  font-weight: 700;
}

.title {
  font-size: var(--fs-h2);
  font-weight: 600;
}

.body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 168px;
}

.lead {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--text-secondary);
  line-height: 1.6;
}

.kv {
  display: flex;
  gap: 8px;
  font-size: var(--fs-sm);
}

.kv .k {
  color: var(--text-muted);
}

.kv .v {
  color: var(--text-primary);
  font-family: ui-monospace, Consolas, monospace;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-body);
}

.row .k {
  flex: 0 0 60px;
  color: var(--text-secondary);
}

.quick .q {
  font-size: 12px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 10px;
}

.pills {
  display: flex;
  gap: 4px;
}

.pill {
  min-width: 28px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

.pill.on {
  color: var(--accent);
  border-color: var(--accent);
}

.tip {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

.err {
  margin: 0;
  font-size: 12px;
  color: var(--countdown-urgent);
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

.spacer {
  flex: 1;
}

.ghost {
  font-size: var(--fs-sm);
  color: var(--text-muted);
  padding: 4px 10px;
}

.go {
  background: var(--accent);
  color: #fff;
  border-radius: var(--r-sm);
  padding: 5px 16px;
  font-size: var(--fs-sm);
  font-weight: 600;
}
</style>



