<template>
  <div class="rules">
    <div class="rules-head">
      <h3>它会自己学，也能你手教</h3>
      <span class="stat">{{ stats.manual }} 条手写 · {{ stats.learned }} 条自学 · 最高命中 {{ stats.topHits }} 次</span>
    </div>

    <p class="tip">
      改待办的分类或到期时间时，它会顺手记住「什么词该归到哪」和「什么说法指几点」。
      学到的规则排在内置规则前面，所以教一次就够。下面可以自己加、关掉、删掉。
    </p>

    <div class="rules-add">
      <select v-model="form.kind">
        <option value="category">分类</option>
        <option value="time">时间</option>
        <option value="regex">正则</option>
      </select>
      <input v-model="form.pattern" :placeholder="patternPh" />
      <input v-model="form.value" :placeholder="valuePh" />
      <button class="mini" @click="save">加进去</button>
    </div>

    <div class="rules-try">
      <input v-model="tryText" placeholder="试一句：明天下午把报价单发给张总" @keydown.enter="tryIt" />
      <button class="mini" @click="tryIt">试一下</button>
      <span class="try-out" v-if="tryOut">{{ tryOut }}</span>
    </div>

    <div class="rules-list">
      <div class="rules-row" v-for="r in rules" :key="r.id">
        <span class="rk">{{ kindLabel(r.kind) }}</span>
        <code class="rp">{{ r.pattern }}</code>
        <span class="ra">→</span>
        <span class="rv">{{ r.value }}</span>
        <span class="rh" :title="'命中 ' + r.hits + ' 次'">{{ r.hits }}</span>
        <button class="mini" @click="toggle(r)">{{ r.enabled ? '停用' : '启用' }}</button>
        <button class="mini danger" @click="del(r)">删</button>
      </div>
      <p class="tip" v-if="rules.length === 0">还没有规则。改几次待办的分类/时间，它就自己攒起来了。</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

interface Rule {
  id: string
  kind: 'category' | 'time' | 'regex'
  pattern: string
  value: string
  hits: number
  manual: number
  enabled: number
}

const rules = ref<Rule[]>([])
const stats = ref({ total: 0, manual: 0, learned: 0, topHits: 0 })
const tryText = ref('')
const tryOut = ref('')
const form = ref<{ kind: Rule['kind']; pattern: string; value: string }>({ kind: 'category', pattern: '', value: '' })

const patternPh = computed(() => {
  if (form.value.kind === 'category') return '词/短语，如：报价单'
  if (form.value.kind === 'time') return '说法，如：收工前'
  return '正则，如：(?<time>\\d{1,2}:\\d{2}) 开会'
})
const valuePh = computed(() => {
  if (form.value.kind === 'category') return '归到哪类，如：单据'
  if (form.value.kind === 'time') return '几点，如：17:30'
  return '默认时间，如：09:30'
})

const kindLabel = (k: Rule['kind']): string => (k === 'category' ? '分类' : k === 'time' ? '时间' : '正则')

async function load(): Promise<void> {
  rules.value = (await window.wb.rulesList()) as Rule[]
  stats.value = await window.wb.rulesStats()
}

async function save(): Promise<void> {
  if (!form.value.pattern.trim() || !form.value.value.trim()) return
  try {
    await window.wb.rulesSave({ kind: form.value.kind, pattern: form.value.pattern, value: form.value.value })
    form.value.pattern = ''
    form.value.value = ''
    await load()
  } catch (e) {
    tryOut.value = '没加成：' + (e as Error).message
  }
}

async function toggle(r: Rule): Promise<void> {
  await window.wb.rulesToggle(r.id, r.enabled === 0)
  await load()
}

async function del(r: Rule): Promise<void> {
  await window.wb.rulesDelete(r.id)
  await load()
}

async function tryIt(): Promise<void> {
  if (!tryText.value.trim()) return
  const r = await window.wb.rulesTry(tryText.value)
  const parts = [`标题「${r.text}」`]
  if (r.category) parts.push(`分类 ${r.category}`)
  if (r.dueAt) parts.push(`到期 ${r.dueAt.replace('T', ' ').slice(0, 16)}`)
  if (r.timeHint) parts.push(`时间词 ${r.timeHint}`)
  if (r.repeat) parts.push(`循环 ${r.repeat}`)
  tryOut.value = parts.join(' · ')
}

onMounted(load)
</script>

<style scoped>
.rules {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rules-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.rules-head h3 {
  margin: 0;
  font-size: 13.5px;
}
.stat {
  color: #7b8798;
  font-size: 11.5px;
}
.tip {
  margin: 0;
  color: #7b8798;
  font-size: 11.5px;
  line-height: 1.7;
}
.rules-add,
.rules-try {
  display: flex;
  gap: 6px;
  align-items: center;
}
.rules-add select,
.rules-add input,
.rules-try input {
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid #2b3444;
  background: #12171f;
  color: #e8ecf3;
  font-size: 12px;
}
.rules-add input,
.rules-try input {
  flex: 1;
  min-width: 90px;
}
.rules-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow: auto;
}
.rules-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  background: #141a23;
  font-size: 12px;
}
.rk {
  color: #7b8798;
  min-width: 30px;
}
.rp {
  color: #9ecbff;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ra {
  color: #55607a;
}
.rv {
  color: #8fe3a8;
}
.rh {
  margin-left: auto;
  color: #6b7688;
  font-size: 11px;
}
.mini {
  padding: 3px 7px;
  font-size: 11.5px;
  border-radius: 5px;
  border: 1px solid #2b3444;
  background: #1a2029;
  color: #d7dee9;
  cursor: pointer;
}
.mini.danger {
  color: #ffb4b4;
  border-color: #5a2a2a;
}
.try-out {
  color: #8fe3a8;
  font-size: 11.5px;
}
</style>