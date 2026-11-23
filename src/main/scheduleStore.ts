import { query, run, transaction } from './store'
import { baseProfile, builtinPresets } from '../shared/schedule/presets'
import type { ShiftProfile } from '../shared/schedule/model'
import type { ScheduleState } from '../shared/types'

/** 设置项读写（settings 表，值统一存字符串） */
export function getSetting(key: string): string | null {
  const rows = query<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
  return rows.length > 0 ? rows[0].value : null
}

export function setSetting(key: string, value: string): void {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
}

function insertProfile(p: ShiftProfile): void {
  run('INSERT INTO shift_profiles (id, name, json, updated_at) VALUES (?, ?, ?, ?)', [
    p.id,
    p.name,
    JSON.stringify(p),
    new Date().toISOString()
  ])
}

function seedIfEmpty(): ShiftProfile[] {
  const rows = query<{ id: string; json: string }>('SELECT id, json FROM shift_profiles ORDER BY rowid')
  if (rows.length > 0) return rows.map((r) => JSON.parse(r.json) as ShiftProfile)
  const p = baseProfile()
  insertProfile(p)
  setSetting('activeProfileId', p.id)
  return [p]
}

export function getScheduleState(): ScheduleState {
  const profiles = seedIfEmpty()
  const activeId = getSetting('activeProfileId') ?? profiles[0].id
  return { activeId: profiles.some((p) => p.id === activeId) ? activeId : profiles[0].id, profiles }
}

export function saveScheduleState(next: ScheduleState): void {
  transaction(() => {
    for (const p of next.profiles) {
      run('INSERT INTO shift_profiles (id, name, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, json = excluded.json, updated_at = excluded.updated_at', [
        p.id,
        p.name,
        JSON.stringify(p),
        new Date().toISOString()
      ])
    }
    const ids = next.profiles.map((p) => p.id)
    const rows = query<{ id: string }>('SELECT id FROM shift_profiles')
    for (const r of rows) {
      if (!ids.includes(r.id)) run('DELETE FROM shift_profiles WHERE id = ?', [r.id])
    }
    setSetting('activeProfileId', next.activeId)
  })
}

export function presets(): ShiftProfile[] {
  return builtinPresets()
}

/** 从旧版 schedule.json 导入（一次性） */
export function importLegacySchedule(legacy: { activeId: string; profiles: ShiftProfile[] }): void {
  const rows = query<{ id: string }>('SELECT id FROM shift_profiles')
  if (rows.length > 0) return
  transaction(() => {
    for (const p of legacy.profiles) insertProfile(p)
    setSetting('activeProfileId', legacy.activeId)
  })
}
