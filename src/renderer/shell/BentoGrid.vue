<script setup lang="ts">
import { computed, ref } from 'vue'
import type { LayoutItem } from '@shared/types'
import { LAYOUT_MIN_H } from '@shared/types'
import { MIN_WIDTH } from '@shared/layout'
import { moduleMap } from '../modules/registry'

const props = defineProps<{ layout: LayoutItem[]; locked: boolean }>()
const emit = defineEmits<{ (e: 'update:layout', value: LayoutItem[]): void }>()

const dragId = ref<string | null>(null)
const dragOverId = ref<string | null>(null)

const items = computed(() =>
  props.layout
    .filter((l) => l.visible && moduleMap.has(l.moduleId))
    .slice()
    .sort((a, b) => a.order - b.order)
)

function commit(next: LayoutItem[]): void {
  emit(
    'update:layout',
    next.map((l, i) => ({ ...l, order: i }))
  )
}

function onDragStart(e: DragEvent, id: string): void {
  if (props.locked) return
  dragId.value = id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
}

function onDragOver(e: DragEvent, id: string): void {
  if (props.locked || !dragId.value || dragId.value === id) return
  e.preventDefault()
  dragOverId.value = id
}

function onDrop(e: DragEvent, targetId: string): void {
  e.preventDefault()
  const from = dragId.value
  dragId.value = null
  dragOverId.value = null
  if (props.locked || !from || from === targetId) return

  const list = items.value.map((l) => ({ ...l }))
  const fromIdx = list.findIndex((l) => l.moduleId === from)
  const toIdx = list.findIndex((l) => l.moduleId === targetId)
  if (fromIdx < 0 || toIdx < 0) return
  const [moved] = list.splice(fromIdx, 1)
  list.splice(toIdx, 0, moved)
  commit(list)
}

function onDragEnd(): void {
  dragId.value = null
  dragOverId.value = null
}

function resize(id: string, dw: number, dh: number): void {
  if (props.locked) return
  const list = items.value.map((l) => ({ ...l }))
  const item = list.find((l) => l.moduleId === id)
  if (!item) return
  // 用共享的最小尺寸兜底：否则能把倒计时压到 1 行，56px 计时器直接被切
  const minW = MIN_WIDTH[id] ?? 2
  const minH = LAYOUT_MIN_H[id] ?? 1
  item.w = Math.min(12, Math.max(minW, item.w + dw))
  item.h = Math.min(6, Math.max(minH, item.h + dh))
  commit(list)
}

function cardStyle(l: LayoutItem): Record<string, string> {
  return {
    gridColumn: `span ${Math.min(12, Math.max(2, l.w))}`,
    gridRow: `span ${Math.min(6, Math.max(1, l.h))}`
  }
}
</script>

<template>
  <div class="bento" data-bento>
    <article
      v-for="item in items"
      :key="item.moduleId"
      data-card
      :data-module="item.moduleId"
      class="card"
      :class="{ dragging: dragId === item.moduleId, over: dragOverId === item.moduleId }"
      :style="cardStyle(item)"
      @dragover="onDragOver($event, item.moduleId)"
      @drop="onDrop($event, item.moduleId)"
    >
      <header
        class="card-head"
        :class="{ grab: !locked }"
        :draggable="!locked"
        @dragstart="onDragStart($event, item.moduleId)"
        @dragend="onDragEnd"
      >
        <span class="grip" aria-hidden="true">⠿</span>
        <span class="card-name">{{ moduleMap.get(item.moduleId)?.name }}</span>
        <span class="spacer" />
        <template v-if="!locked">
          <button class="mini" :title="'减宽'" @click="resize(item.moduleId, -2, 0)">↔−</button>
          <button class="mini" :title="'加宽'" @click="resize(item.moduleId, 2, 0)">↔+</button>
          <button class="mini" :title="'减高'" @click="resize(item.moduleId, 0, -1)">↕−</button>
          <button class="mini" :title="'加高'" @click="resize(item.moduleId, 0, 1)">↕+</button>
        </template>
      </header>
      <div class="card-body">
        <component
          :is="moduleMap.get(item.moduleId)!.component"
          v-bind="moduleMap.get(item.moduleId)!.props"
        />
      </div>
    </article>
  </div>
</template>

<style scoped>
.bento {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  grid-auto-rows: var(--row-h);
  /* dense：拖拽/缩放留下的空洞自动回填，避免"每行都差一格" */
  grid-auto-flow: row dense;
  gap: var(--gap);
  padding: var(--gap);
  align-content: start;
  overflow: auto;
  height: 100%;
}

.card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg-elev-1);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
  transition: border-color var(--motion-fast), transform var(--motion-fast);
  overflow: hidden;
}

.card.dragging {
  opacity: 0.55;
}

.card.over {
  border-color: var(--accent);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 定高 + 与卡体同左内边距：卡头原来 37px、锁定后 31.6px，卡片会跳 5.4px；
     而 10px 的卡头内边距让标题比正文左 16px，整列看起来是歪的 */
  height: 34px;
  padding: 0 12px;
  position: relative;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: var(--fs-sm);
  flex: 0 0 auto;
}

.card-head.grab {
  cursor: grab;
}

.card-head.grab:active {
  cursor: grabbing;
}

.grip {
  position: absolute;
  left: -4px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  opacity: 0;
  transition: opacity var(--motion-fast);
}

.card-head:hover .grip {
  opacity: 0.7;
}

.card-name {
  color: var(--text-secondary);
  font-weight: 500;
}

.spacer {
  flex: 1;
}

.mini {
  font-size: 12px;
  color: var(--text-muted);
  padding: 1px 5px;
  border-radius: var(--r-sm);
  line-height: 1;
  min-height: 20px;
}

.mini:hover {
  background: var(--bg-elev-3);
  color: var(--text-primary);
}

.card-body {
  flex: 1;
  min-height: 0;
  padding: 10px 12px;
  /* 卡内不再滚：只有最外层网格滚动，避免"卡片里有卡片滚动条" */
  overflow: hidden;
}
</style>



