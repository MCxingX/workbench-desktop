import type { Component } from 'vue'
import CountdownCard from './countdown/CountdownCard.vue'
import CheckinCard from './checkin/CheckinCard.vue'
import TodosCard from './todos/TodosCard.vue'
import WorklogCard from './worklog/WorklogCard.vue'
import PasteCard from './pasteparse/PasteCard.vue'
import KnowledgeCard from './knowledge/KnowledgeCard.vue'
import NotesCard from './notes/NotesCard.vue'
import PomodoroCard from './pomodoro/PomodoroCard.vue'
import SettingsCard from './settings/SettingsCard.vue'

export interface ModuleMeta {
  id: string
  name: string
  component: Component
  props?: Record<string, unknown>
}

/**
 * 模块注册表：壳层不硬编码任何模块，M6 会改为外部 manifest + 内置清单合并。
 * 顺序即默认新增顺序。
 */
export const MODULES: ModuleMeta[] = [
  { id: 'countdown', name: '倒计时', component: CountdownCard },
  { id: 'checkin', name: '到岗记录', component: CheckinCard },
  { id: 'todos', name: '待办', component: TodosCard },
  { id: 'pasteparse', name: '粘贴解析', component: PasteCard },
  { id: 'worklog', name: '今日记录', component: WorklogCard },
  { id: 'knowledge', name: '口径库', component: KnowledgeCard },
  { id: 'notes', name: '闪记', component: NotesCard },
  { id: 'pomodoro', name: '番茄钟', component: PomodoroCard },
  { id: 'settings', name: '数据与备份', component: SettingsCard }
]

export const moduleMap: Map<string, ModuleMeta> = new Map(MODULES.map((m) => [m.id, m]))
