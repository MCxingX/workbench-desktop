import { LAYOUT_MIN_H, LAYOUT_VERSION, DEFAULT_UI_STATE, type LayoutItem, type UiState } from './types'

/** 每张卡最小宽度（行数限制见 LAYOUT_MIN_H） */
export const MIN_WIDTH: Record<string, number> = {
  countdown: 6,
  checkin: 4,
  todos: 4,
  pasteparse: 3,
  worklog: 3,
  pomodoro: 3,
  notes: 3,
  knowledge: 4,
  settings: 4
}

/** 把 layout 数组按默认顺序补齐（新增模块、缺项也在这里兜住） */
function freshLayout(): LayoutItem[] {
  return DEFAULT_UI_STATE.layout.map((l) => ({ ...l }))
}

/**
 * 布局迁移。
 *
 * v3 起换了排布规则：四行填满 12 列、同行等高，所以 v2 及更早的布局直接按新默认重排
 * （用户反馈"九张卡大小不一、长度不一"就是旧布局留下的空洞与错行）。
 * 主题、是否锁布局、当前班表这些用户偏好一律保留，只重排卡片位置。
 *
 * v1→v2 那一版只抬不降的老规则保留在下面，避免跨版本升级时反而把卡片压小。
 */
export function migrateLayout(state: UiState): boolean {
  const from = state.layoutVersion ?? 1
  if (from >= LAYOUT_VERSION) return false

  if (from < 3) {
    // 保留用户在用的模块与可见性，但位置/尺寸按新默认来
    const hidden = new Set(state.layout.filter((l) => !l.visible).map((l) => l.moduleId))
    state.layout = freshLayout().map((l) => ({ ...l, visible: !hidden.has(l.moduleId) }))
    state.layoutVersion = LAYOUT_VERSION
    return true
  }

  for (const item of state.layout) {
    const minH = LAYOUT_MIN_H[item.moduleId]
    const minW = MIN_WIDTH[item.moduleId]
    if (minH && item.h < minH) item.h = minH
    if (minW && item.w < minW) item.w = minW
  }
  state.layoutVersion = LAYOUT_VERSION
  return true
}
