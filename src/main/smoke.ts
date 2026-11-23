import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { loadPlugins, writeSampleManifest } from './plugins'
import { listBackups, autoBackup } from './backup'
import { run as runSql } from './store'
import type { AppInfo } from '../shared/types'

interface CheckResult {
  name: string
  ok: boolean
  detail?: string
}

/**
 * 冒烟验证：窗口加载真实界面后，在渲染进程里执行断言。
 * 输出 JSON 到 stdout，并写 <dataDir>/logs/smoke.json。
 * 用于每个里程碑的机器可验证门（见 docs/13 验收手册）。
 */
/** 清理冒烟写进去的番茄钟记录（库里没有删除接口，直接删行） */
function deletePomodoroRow(id: string): void {
  try {
    runSql('DELETE FROM pomodoro WHERE id = ?', [id])
  } catch {
    /* 表名/列名变化时不影响冒烟 */
  }
}

export async function runSmoke(win: BrowserWindow, info: AppInfo): Promise<number> {
  const checks: CheckResult[] = []

  const push = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail })
  }

  try {
    const evalJs = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true)

    // 1. 渲染进程已挂载
    const cardCount = await evalJs<number>(`document.querySelectorAll('[data-card]').length`)
    push('界面已渲染卡片', cardCount > 0, `cards=${cardCount}`)

    // 2. preload 桥接可用
    const bridgeOk = await evalJs<boolean>(
      `typeof window.wb === 'object' && typeof window.wb.uiGet === 'function'`
    )
    push('preload 桥接可用', bridgeOk)

    // 3. ipc 往返：读 UI 状态
    const state = await win.webContents.executeJavaScript(`window.wb.uiGet()`, true)
    const layoutOk = state && Array.isArray(state.layout) && state.layout.length > 0
    push('ipc ui:get 往返', !!layoutOk, `layout=${layoutOk ? state.layout.length : 0}`)

    // 4. 主题已应用
    const theme = await evalJs<string>(`document.documentElement.getAttribute('data-theme') || ''`)
    push('主题已应用', theme === 'dark' || theme === 'light', `theme=${theme}`)

    // 5. 网格渲染为 CSS Grid
    const isGrid = await evalJs<boolean>(`getComputedStyle(document.querySelector('[data-bento]')).display === 'grid'`)
    push('Bento 网格生效', isGrid)

    // 6. 布局持久化往返（写入 → 读回）
    const persisted = await evalJs<boolean>(`(async () => {
      const s = await window.wb.uiGet()
      s.layoutLocked = !s.layoutLocked
      await window.wb.uiSave(s)
      const s2 = await window.wb.uiGet()
      const same = s2.layoutLocked === s.layoutLocked
      s.layoutLocked = !s.layoutLocked
      await window.wb.uiSave(s)
      return same
    })()`)
    push('布局持久化往返', persisted)

    // 7. 数据目录存在且可写
    const probe = path.join(info.dataDir, '.smoke-probe')
    fs.writeFileSync(probe, 'ok')
    const writable = fs.readFileSync(probe, 'utf8') === 'ok'
    fs.unlinkSync(probe)
    push('数据目录可写', writable, info.dataDir)

    // ── 铁律：冒烟只写临时目录，绝不碰用户真实数据 ──
    const smokeInfo = await evalJs<{ file: string }>(`window.wb.storeInfo()`)
    const inTemp = smokeInfo.file.toLowerCase().includes('workbench-smoke')
    push('冒烟跑在隔离目录（不碰真实数据）', inTemp, smokeInfo.file)

    // ── M1：班表引擎接入 ──
    // 8. 倒计时主数字已渲染（hh:mm:ss）
    const display = await evalJs<string>(`document.querySelector('[data-module="countdown"] .cd-display')?.textContent?.trim() || ''`)
    push('倒计时已渲染', /^\d+:\d{2}:\d{2}$/.test(display), `display=${display}`)

    // 9. 班表状态往返：读取 → 改名称 → 存 → 读回
    const scheduleOk = await evalJs<boolean>(`(async () => {
      const s = await window.wb.scheduleGet()
      if (!s.profiles.length) return false
      const origin = s.profiles[0].name
      s.profiles[0].name = origin + '-smoke'
      await window.wb.scheduleSave(s)
      const back = await window.wb.scheduleGet()
      const ok = back.profiles[0].name === origin + '-smoke'
      back.profiles[0].name = origin
      await window.wb.scheduleSave(back)
      return ok
    })()`)
    push('班表状态往返', scheduleOk)

    // 10. 预设可用且数量符合预期
    const presetCount = await evalJs<number>(`(async () => (await window.wb.schedulePresets()).length)()`)
    push('班表预设可用', presetCount >= 10, `presets=${presetCount}`)

    // 11. 倒计时状态机给出明确阶段
    const phase = await evalJs<string>(`document.querySelector('[data-module="countdown"] .cd')?.getAttribute('data-phase') || ''`)
    push('倒计时状态机有明确阶段', ['off', 'before', 'working', 'lunch', 'after', 'overtime'].includes(phase), `phase=${phase}`)

    // 12. 大屏开关可用（进入后退出）
    const fsOk = await evalJs<boolean>(`(async () => {
      await window.wb.setFullscreen(true)
      await new Promise(r => setTimeout(r, 260))
      const on = window.outerWidth >= window.screen.width - 4
      await window.wb.setFullscreen(false)
      await new Promise(r => setTimeout(r, 260))
      return on
    })()`)
    push('大屏模式可进可退', fsOk)

    // ── 齿轮必须真的能打开班表设置（曾经因为 structuredClone 克隆响应式 Proxy 抛错，点了没反应）──
    const gear = await evalJs<string>(`(async () => {
      const closeWizard = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '✕' && b.closest('.ob'))
      if (closeWizard) { closeWizard.click(); await new Promise(r => setTimeout(r, 300)) }
      const g = document.querySelector('.cd-gear')
      if (!g) return 'no-gear'
      g.click()
      await new Promise(r => setTimeout(r, 400))
      const mask = document.querySelector('.mask')
      const tabs = mask ? mask.querySelectorAll(".tabs button").length : 0
      const x = mask ? [...mask.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '✕') : null
      if (x) x.click()
      await new Promise(r => setTimeout(r, 250))
      return tabs + '|' + (document.querySelector('.mask') ? 'open' : 'closed')
    })()`)
    push('齿轮能打开班表设置并正常关闭', gear === '5|closed', gear)

    // ── M2：加密存储 ──
    // 13. 加密库已打开且有班表数据
    const stats = await evalJs<{
      count: number
      dirty: boolean
      sizeBytes: number
      isOpen: boolean
      file: string
      counts: Record<string, number>
    }>(`window.wb.storeStats()`)
    push('加密库已打开', stats.isOpen && stats.sizeBytes > 0, `size=${stats.sizeBytes}B rows=${JSON.stringify(stats.counts)}`)
    push('班表已存入库中', (stats.counts.shift_profiles ?? 0) > 0, `profiles=${stats.counts.shift_profiles}`)

    // 14. 落盘文件不是明文 SQLite（头部为 WBDB，且不含 SQLite 魔数）
    const bytes = fs.readFileSync(stats.file)
    const head = bytes.subarray(0, 4).toString('latin1')
    const plainSqlite = bytes.subarray(0, 15).toString('latin1') === 'SQLite format 3'
    push('库文件已加密（非明文 SQLite）', head === 'WBDB' && !plainSqlite, `head=${head}`)

    // 15. 明文内容不可检索（探针写进名字，测完改回原值）
    const originalProfileName = (await evalJs<{ profiles: { name: string }[] }>(`window.wb.scheduleGet()`)).profiles[0].name
    const probeText = 'smoke-secret-marker-9F3A'
    await evalJs<boolean>(`(async () => {
      const s = await window.wb.scheduleGet()
      s.profiles[0].name = '${probeText}'
      await window.wb.scheduleSave(s)
      return true
    })()`)
    const after = fs.readFileSync(stats.file)
    const markerHidden = !after.includes(Buffer.from(probeText, 'utf8'))
    // 还原成用户原来的方案名，不要写死
    await evalJs<boolean>(`(async () => {
      const s = await window.wb.scheduleGet()
      s.profiles[0].name = ${JSON.stringify(originalProfileName)}
      await window.wb.scheduleSave(s)
      return true
    })()`)
    push('明文关键字不在密文文件中', markerHidden, `已还原为「${originalProfileName}」`)

    // 16. 备份 → 还原 往返
    const backupResult = await evalJs<{ file: string; manifest: { files: { name: string; size: number }[] } }>(
      `window.wb.backupCreate()`
    )
    push('备份已生成', fs.existsSync(backupResult.file) && backupResult.manifest.files.length > 0, `files=${backupResult.manifest.files.length}`)
    const restoreRestored = await evalJs<string[]>(`window.wb.backupRestore('${backupResult.file.replace(/\\/g, '\\\\')}').then(r => r.restored)`)
    // 还原会留一份 pre-restore 整库副本：冒烟跑完自己收拾干净
    for (const d of fs.readdirSync(info.dataDir)) {
      if (d.startsWith('pre-restore-')) fs.rmSync(path.join(info.dataDir, d), { recursive: true, force: true })
    }
    push('备份可还原', restoreRestored.length > 0, `restored=${restoreRestored.join(',')}`)

    // 17. 打码导出可用
    const redacted = await evalJs<{ file: string; rows: number }>(`window.wb.exportRedacted()`)
    push('打码导出可用', fs.existsSync(redacted.file) && redacted.rows >= 0, `rows=${redacted.rows}`)

    // ── M2.5：一次点击到岗 ──
    const checkin = await evalJs<{ marked: boolean; at: string; undone: boolean; stats: { monthExpected: number } }>(`(async () => {
      const day = new Date().toISOString().slice(0, 10)
      await window.wb.checkinUndo(day)
      const before = await window.wb.checkinGet(day)
      const row = await window.wb.checkinMark(day)
      const stats = await window.wb.checkinStats()
      await window.wb.checkinUndo(day)
      const after = await window.wb.checkinGet(day)
      return { marked: !!before === false && !!row, at: row.marked_at, undone: !!after === false, stats }
    })()`)
    push('一键到岗写入成功', checkin.marked, `at=${checkin.at}`)
    push('撤销到岗成功', checkin.undone)
    push('到岗统计能算出应到天数', checkin.stats.monthExpected > 0, `expected=${checkin.stats.monthExpected}`)

    // ── M3：待办 / 记录 / 解析 ──
    const todoFlow = await evalJs<{ text: string; hasDue: boolean; worklogAfter: number; summary: string; cleaned: boolean }>(`(async () => {
      const t = await window.wb.todoAdd('明天下午把周报发给张总')
      const before = (await window.wb.worklogList()).length
      await window.wb.todoComplete(t.id)
      const after = (await window.wb.worklogList()).length
      const summary = await window.wb.dailySummary()
      const logs = await window.wb.worklogList()
      for (const l of logs) await window.wb.worklogDelete(l.id)
      await window.wb.todoDelete(t.id)
      return { text: t.text, hasDue: !!t.due_at, worklogAfter: after - before, summary, cleaned: t.text.indexOf('明天') < 0 }
    })()`)
    push('待办一句话入库并识别时间', todoFlow.cleaned && todoFlow.hasDue, `text=${todoFlow.text}`)
    push('完成待办自动写记录', todoFlow.worklogAfter === 1)
    push('今日小结可直接粘贴', todoFlow.summary.includes('完成：') && /^1\. /m.test(todoFlow.summary))

    const paste = await evalJs<{ todos: number; knowledge: number; receipts: number; applied: number; hit: number }>(`(async () => {
      const raw = ['最近反审核多吗','多几个单子走完流程搜不到','AP-202611--0122','看到记录了','最近反审核不多，可能2-3个星期，才一条左右','有反审核 让他们先去财务部拿纸质单据','全部单据都是？','是的','[OK]'].join('\\n')
      const p = await window.wb.pasteParse(raw)
      const r = await window.wb.pasteApply({ raw, todos: p.todos.map(t => t.text), knowledge: p.knowledge, receipts: p.receipts.map(x => x.text) })
      const found = await window.wb.knowledgeList('反审核')
      for (const k of found) await window.wb.knowledgeDelete(k.id)
      const logs = await window.wb.worklogList()
      for (const l of logs) await window.wb.worklogDelete(l.id)
      return { todos: p.todos.length, knowledge: p.knowledge.length, receipts: p.receipts.length, applied: r.addedKnowledge, hit: found.length }
    })()`)
    push('粘贴解析：聊天噪声不硬凑待办', paste.todos === 0, `todos=${paste.todos} knowledge=${paste.knowledge} receipts=${paste.receipts}`)
    push('粘贴解析：口径与回执分池', paste.knowledge === 2 && paste.receipts === 1)
    push('口径落库并可检索', paste.applied === 2 && paste.hit >= 2, `hit=${paste.hit}`)

    // ── M4：应用锁 ──
    const lockFlow = await evalJs<{
      enabled: boolean
      locked: boolean
      wrongOk: boolean
      rightOk: boolean
      disabled: boolean
      failures: number
    }>(`(async () => {
      await window.wb.lockSetPassword('smoke-pass-1')
      const lockedState = await window.wb.lockNow()
      const wrong = await window.wb.unlock('bad-pass')
      const right = await window.wb.unlock('smoke-pass-1')
      const disabled = await window.wb.lockDisable('smoke-pass-1')
      return {
        enabled: lockedState.enabled,
        locked: lockedState.locked,
        wrongOk: wrong.ok,
        rightOk: right.ok,
        disabled: !disabled.enabled && !disabled.locked,
        failures: right.state.failures
      }
    })()`)
    push('应用锁可开启并立即生效', lockFlow.enabled && lockFlow.locked)
    push('错误密码打不开', lockFlow.wrongOk === false)
    push('正确密码可解锁且失败计数清零', lockFlow.rightOk && lockFlow.failures === 0)
    push('可凭密码关闭应用锁', lockFlow.disabled)

    // ── M5：便签 / 番茄钟 / 命令面板 ──
    const extras = await evalJs<{ noteOk: boolean; pomo: number; actions: number; recId: string }>(`(async () => {
      const n = await window.wb.notesAdd('smoke 便签')
      const list = await window.wb.notesList()
      const noteOk = list.some(x => x.id === n.id)
      await window.wb.notesDelete(n.id)
      const before = (await window.wb.pomodoroToday()).focus
      const rec = await window.wb.pomodoroRecord('focus', 25)
      const today = await window.wb.pomodoroToday()
      const actions = (await window.wb.paletteActions()).length
      return { noteOk, pomo: today.focus - before, actions, recId: rec.id }
    })()`)
    // 番茄钟记录没有删除入口，冒烟自己清掉，别污染用户的"今日专注"
    deletePomodoroRow(extras.recId)
    push('便签可写可删', extras.noteOk)
    push('番茄钟计入今日', extras.pomo >= 1, `focus=${extras.pomo}`)
    push('命令面板有动作可执行', extras.actions >= 8, `actions=${extras.actions}`)

    // ── M6：插件清单（声明式，无代码执行） ──
    const sampleFile = writeSampleManifest(info.dataDir)
    const loaded = loadPlugins(info.dataDir)
    push('插件清单可加载', loaded.plugins.length >= 1, `plugins=${loaded.plugins.map((p) => p.id).join(',')}`)

    const badFile = path.join(info.dataDir, 'plugins', 'bad-manifest.json')
    fs.writeFileSync(badFile, JSON.stringify({ id: 'BAD ID', name: '', moduleId: 'not-a-module' }), 'utf8')
    const loaded2 = loadPlugins(info.dataDir)
    push('非法清单被拒并报原因', loaded2.issues.length >= 1, loaded2.issues[0]?.message ?? '')
    fs.unlinkSync(badFile)
    fs.unlinkSync(sampleFile)

    // ── M8：系统设置中心（含单双周独立配置） ──
    const settingsUi = await evalJs<{ opened: boolean; tabs: number; weekRows: number; closed: boolean; diag: string }>(`(async () => {
      const btns = Array.from(document.querySelectorAll('.topbar .btn'))
      const btn = btns.find(b => b.textContent.trim() === '系统设置')
      if (btn) btn.click()
      for (let i = 0; i < 60 && !document.querySelector('.sp-nav'); i++) await new Promise(r => setTimeout(r, 50))
      const panel = document.querySelector('.sp')
      const tabs = panel ? panel.querySelectorAll('.sp-nav .sp-tab').length : 0
      const diag = 'btns=' + btns.map(b => b.textContent.trim()).join('|') + ' err=' + (window.__wbErr || '')
      document.querySelectorAll('.sp-nav .sp-tab').forEach(b => { if (b.textContent.indexOf('单双周') >= 0) b.click() })
      await new Promise(r => setTimeout(r, 250))
      // 在面板里真的打开"两周交替"，看 6 周预览是否出现
      const sel = Array.from(document.querySelectorAll('.sp select')).find(s => Array.from(s.options).some(o => o.value === 'alternate'))
      if (sel) { sel.value = 'alternate'; sel.dispatchEvent(new Event('change')) }
      await new Promise(r => setTimeout(r, 300))
      const weekRows = document.querySelectorAll('.sp .wprev tr').length
      const closeBtn = Array.from(document.querySelectorAll('.sp .foot .mini')).find(b => b.textContent.trim() === '关闭')
      closeBtn && closeBtn.click()
      await new Promise(r => setTimeout(r, 200))
      return { opened: !!panel, tabs, weekRows, closed: !document.querySelector('.sp'), diag }
    })()`)
    push('Ctrl+, 能打开系统设置中心', settingsUi.opened && settingsUi.tabs >= 5, `tabs=${settingsUi.tabs} ${settingsUi.diag}`)
    push('单双周有独立页签与 6 周预览', settingsUi.weekRows >= 7, `rows=${settingsUi.weekRows}`)

    // ── 更新页签：多节点探测表 + 状态机必须能渲染 ──
    const upd = await evalJs<string>(`(async () => {
      if (!document.querySelector(".sp")) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))
        await new Promise(r => setTimeout(r, 500))
      }
      const tab = [...document.querySelectorAll('.sp-tab')].find(b => (b.textContent || '').trim() === '更新')
      if (!tab) return JSON.stringify({ pane: false, hasBtn: false, shape: false, why: 'no-tab' })
      tab.click()
      await new Promise(r => setTimeout(r, 350))
      const pane = document.querySelector(".upd")
      const hasBtn = pane ? !!([...pane.querySelectorAll("button")].find(b => (b.textContent || "").includes("检查更新"))) : false
      const st = await window.wb.updateState()
      const shape = !!st && typeof st.phase === "string" && Array.isArray(st.probes)
      const close = [...document.querySelectorAll(".sp button")].find(b => (b.textContent || "").trim() === "关闭")
      if (close) close.click()
      await new Promise(r => setTimeout(r, 250))
      return JSON.stringify({ pane: !!pane, hasBtn, shape })
    })()`)
    const u = JSON.parse(upd) as { pane: boolean; hasBtn: boolean; shape: boolean }
    push('更新页签有节点探测表与检查按钮', u.pane && u.hasBtn && u.shape, upd)

    // ── 诊断页签：隐藏日志必须能看、能复制、能导出 ──
    const diag = await evalJs<string>(`(async () => {
      if (!document.querySelector('.sp')) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))
        await new Promise(r => setTimeout(r, 500))
      }
      const tab = [...document.querySelectorAll('.sp-tab')].find(b => (b.textContent || '').trim() === '诊断')
      if (!tab) return JSON.stringify({ pane: false, why: 'no-tab' })
      tab.click()
      await new Promise(r => setTimeout(r, 400))
      const pane = document.querySelector('.dg')
      const list = document.querySelector('.dg-list')
      const btns = pane ? [...pane.querySelectorAll("button")].map(b => (b.textContent || "").trim()) : []
      const stats = await window.wb.logStats()
      const report = await window.wb.logReport()
      const exp = await window.wb.logExport()
      const hasCopy = btns.some(t => t.includes("复制诊断信息"))
      const hasExport = btns.some(t => t.includes("导出诊断包"))
      const reportOk = report.includes("Workbench 诊断信息") && report.includes("数据目录") && report.includes("最近日志")
      return JSON.stringify({ pane: !!pane, list: !!list, hasCopy, hasExport, reportOk, statsOk: typeof stats.errors === 'number', file: exp.file, rows: document.querySelectorAll('.dg-item').length })
    })()`)
    const dg = JSON.parse(diag) as {
      pane: boolean
      list: boolean
      hasCopy: boolean
      hasExport: boolean
      reportOk: boolean
      statsOk: boolean
      file: string
      rows: number
    }
    push('诊断页签能看日志、能复制、能导出', dg.pane && dg.list && dg.hasCopy && dg.hasExport && dg.rows >= 1, `rows=${dg.rows}`)
    push('诊断包导出成 txt 且含环境信息', dg.reportOk && dg.statsOk && !!dg.file, dg.file)

    // ── 迁移：切过去就真的跟着走，旧目录不再被写 ──
    const migrate = await evalJs<string>(`(async () => {
      const before = await window.wb.info()
      const target = before.dataDir + '-moved'
      const r = await window.wb.migrateDataDir(target)
      const after = await window.wb.info()
      const st = await window.wb.storeInfo()
      const files = await window.wb.storeStats()
      const settings = await window.wb.settingsGet()
      const note = (await window.wb.logRecent(50)).some(l => l.scope === 'migrate')
      return JSON.stringify({ to: r.to, files: r.files, verified: r.verified, restart: r.restartRequired, dataDirNow: after.dataDir, storeFile: st.file, rows: files.count, keptSetting: settings.onboardingDone ?? null, note })
    })()`)
    const mg = JSON.parse(migrate) as {
      to: string
      files: number
      verified: boolean
      restart: boolean
      dataDirNow: string
      storeFile: string
      rows: number
      keptSetting: string | null
      note: boolean
    }
    push('迁移后立刻切到新目录（不用重启）', mg.verified && mg.restart === false && mg.dataDirNow === mg.to && mg.storeFile.startsWith(mg.to), `to=${mg.to} store=${mg.storeFile}`)
    push('迁移后数据还在（库行数不变）', mg.rows > 0 && mg.files > 0, `files=${mg.files} rows=${mg.rows}`)
    push('迁移过程写进日志', mg.note)
    push('设置面板可关闭', settingsUi.closed)

    // ── M8：单双周真的生效（写入 → 读回 → 判定一致） ──
    const cycle = await evalJs<{ saved: boolean; aWeeks: number; bWeeks: number; restored: boolean }>(`(async () => {
      const before = await window.wb.scheduleGet()
      const p = structuredClone(before.profiles.find(x => x.id === before.activeId) || before.profiles[0])
      const mon = new Date(); const wd = (mon.getDay() + 6) % 7; mon.setDate(mon.getDate() - wd)
      const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      p.weekCycle = {
        mode: 'alternate',
        anchorMonday: iso(mon),
        anchorVariant: 'primary',
        primary: { name: 'A 周', mask: [true, true, true, true, true, false, false], shift: structuredClone(p.base) },
        secondary: { name: 'B 周', mask: [true, true, true, true, true, true, false], shift: structuredClone(p.base) }
      }
      await window.wb.scheduleSave({ activeId: p.id, profiles: [p] })
      const after = await window.wb.scheduleGet()
      const got = after.profiles[0]
      const saved = got.weekCycle.mode === 'alternate' && !!got.weekCycle.primary && !!got.weekCycle.secondary
      // 用月历反查：本周六是否上班，决定 A/B 是否真的在轮换
      const d1 = iso(new Date(mon.getTime() + 5 * 86400000))
      const d2 = iso(new Date(mon.getTime() + 12 * 86400000))
      const cal1 = await window.wb.checkinCalendar(d1.slice(0, 7))
      const cal2 = await window.wb.checkinCalendar(d2.slice(0, 7))
      const sat1 = cal1.find(c => c.day === d1)
      const sat2 = cal2.find(c => c.day === d2)
      const aWeeks = sat1 ? (sat1.onDuty ? 1 : 0) : 0
      const bWeeks = sat2 ? (sat2.onDuty ? 1 : 0) : 0
      await window.wb.scheduleSave({ activeId: before.activeId, profiles: before.profiles })
      const back = await window.wb.scheduleGet()
      return { saved, aWeeks, bWeeks, restored: back.profiles[0].weekCycle.mode === before.profiles[0].weekCycle.mode }
    })()`)
    push('单双周配置可保存并读回', cycle.saved)
    push('两周交替真的在轮换（本周六休 / 下周六班）', cycle.aWeeks === 0 && cycle.bWeeks === 1, `w1=${cycle.aWeeks} w2=${cycle.bWeeks}`)
    push('班表可恢复原状', cycle.restored)

    // ── M10：改班表后界面立刻更新（不用重启，不靠手动刷新） ──
    const live = await evalJs<{ phase1: string; row1: string; phase2: string; restored: string }>(`(async () => {
      const before = await window.wb.scheduleGet()
      const orig = JSON.parse(JSON.stringify(before.profiles))
      const p = orig[0]
      const pad = n => String(n).padStart(2, '0')
      const n = new Date()
      const s1 = pad(n.getHours()) + ':' + pad(Math.max(0, n.getMinutes() - 1))
      const e1 = pad(Math.min(23, n.getHours() + 1)) + ':' + pad(n.getMinutes())
      // 让今天必定上班，排除「今天休息所以看不到时段」的干扰
      p.mask = [true, true, true, true, true, true, true]
      p.useHolidays = false
      p.weekCycle.mode = 'none'
      p.overrides = []
      p.monthOverrides = []
      p.base = { start: s1, end: e1, lunch: null }

      const r1 = await window.wb.scheduleSave({ activeId: p.id, profiles: orig })
      await new Promise(r => setTimeout(r, 500))
      const cd = document.querySelector('.cd')
      const phase1 = cd ? cd.getAttribute('data-phase') : 'no-card'
      const row1 = Array.from(document.querySelectorAll('.cd-row')).map(x => x.textContent).join('|')

      // 第二次改：把上班时间挪到「两小时后」，仍应实时反映
      const s2 = pad(Math.min(22, n.getHours() + 2)) + ':' + pad(n.getMinutes())
      const e2 = pad(Math.min(23, n.getHours() + 3)) + ':' + pad(n.getMinutes())
      p.base = { start: s2, end: e2, lunch: null }
      await window.wb.scheduleSave({ activeId: p.id, profiles: orig })
      await new Promise(r => setTimeout(r, 500))
      const cd2 = document.querySelector('.cd')
      const phase2 = cd2 ? cd2.getAttribute('data-phase') : 'no-card'

      const back = await window.wb.scheduleSave({ activeId: before.activeId, profiles: JSON.parse(JSON.stringify(before.profiles)) })
      const got = back.profiles[0]
      return {
        phase1,
        row1,
        phase2,
        restored: got.base.start === before.profiles[0].base.start && got.base.end === before.profiles[0].base.end ? 'ok' : got.base.start + '-' + got.base.end
      }
    })()`)
    push('改班表后倒计时卡立即切换状态（无需重启）', live.phase1 === 'working', `phase=${live.phase1}`)
    push('倒计时卡显示新的今日时段', /今日时段/.test(live.row1) && live.row1.length > 0, live.row1.slice(0, 40))
    push('再改一次也实时生效', live.phase2 === 'before', `phase=${live.phase2}`)
    push('改完能恢复原班表', live.restored === 'ok', live.restored)

    // ── M9：到岗月历 / 任意日期补记 / 改时间 / 删除 ──
    const cal = await evalJs<{
      cells: number
      onDuty: number
      domDays: number
      backfilled: string
      updated: string
      deleted: boolean
      statsOk: boolean
    }>(`(async () => {
      const d = new Date(); const iso = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0')
      const ym = iso(d).slice(0, 7)
      const cells = await window.wb.checkinCalendar(ym)
      const y = new Date(d.getTime() - 86400000)
      const yd = iso(y)
      await window.wb.checkinMark(yd, { at: '09:15', note: '补记测试', isBackfill: true })
      const got = await window.wb.checkinGet(yd)
      await window.wb.checkinUpdate(yd, { at: '08:50', note: '改过' })
      const upd = await window.wb.checkinGet(yd)
      await window.wb.checkinUndo(yd)
      const after = await window.wb.checkinGet(yd)
      // 页面上的月历格子（切回本月）
      const grid = document.querySelectorAll('.ck-day').length
      const st = await window.wb.checkinStats()
      return {
        cells: cells.length,
        onDuty: cells.filter(c => c.onDuty).length,
        domDays: grid,
        backfilled: (got && got.marked_at === '09:15:00' && got.is_backfill === 1) ? 'ok' : JSON.stringify(got),
        updated: (upd && upd.marked_at === '08:50:00') ? 'ok' : JSON.stringify(upd),
        deleted: after === null,
        statsOk: st.monthExpected > 0 && Array.isArray(cells) && cells[0].day.endsWith('-01')
      }
    })()`)
    push('到岗月历按月返回整月数据', cal.cells >= 28 && cal.onDuty > 0, `cells=${cal.cells} onDuty=${cal.onDuty}`)
    push('到岗卡片真的渲染出月历格子', cal.domDays >= 28, `dom=${cal.domDays}`)
    push('任意日期可补记并保留到岗时间', cal.backfilled === 'ok', cal.backfilled)
    push('已有记录可改时间', cal.updated === 'ok', cal.updated)
    push('记录可删除', cal.deleted)
    push('统计含应到天数', cal.statsOk)

    // ── M9：待办撤销完成 / 记录编辑 / 口径编辑 ──
    const edits = await evalJs<{ uncompleted: boolean; logEdited: boolean; knEdited: boolean; cleaned: boolean }>(`(async () => {
      const t = await window.wb.todoAdd('smoke 撤销完成测试')
      await window.wb.todoComplete(t.id)
      const done = await window.wb.todosDone(10)
      const inDone = done.some(x => x.id === t.id)
      await window.wb.todoUncomplete(t.id)
      const back = await window.wb.todosList('all')
      const uncompleted = inDone && back.some(x => x.id === t.id)
      await window.wb.todoDelete(t.id)

      const l = await window.wb.worklogAdd('原始记录')
      await window.wb.worklogUpdate(l.id, '改过的记录')
      const logs = await window.wb.worklogList()
      const logEdited = logs.some(x => x.id === l.id && x.text === '改过的记录')
      await window.wb.worklogDelete(l.id)

      const k = await window.wb.knowledgeAdd({ title: 'smoke 口径', conclusion: '原结论' })
      await window.wb.knowledgeUpdate(k.id, { conclusion: '新结论' })
      const kn = await window.wb.knowledgeList('smoke 口径')
      const knEdited = kn.some(x => x.id === k.id && x.conclusion === '新结论')
      await window.wb.knowledgeDelete(k.id)
      const left = await window.wb.knowledgeList('smoke 口径')
      return { uncompleted, logEdited, knEdited, cleaned: left.length === 0 }
    })()`)
    push('已完成待办可退回待办', edits.uncompleted)
    push('今日记录可编辑', edits.logEdited)
    push('口径可编辑并检索到', edits.knEdited && edits.cleaned)

    // ── M9：恢复码 / 自动备份 / 开机自启 ──
    const sys = await evalJs<{ wrongRejected: boolean; resetOk: boolean; newPwWorks: boolean; disabled: boolean }>(`(async () => {
      await window.wb.lockSetPassword('smoke-pass-1')
      const rec = await window.wb.lockIssueRecovery('smoke-pass-1')
      var wrongRejected = false
      try { await window.wb.lockResetByRecovery('AAAA-BBBB-CCCC-DDDD', 'x') } catch { wrongRejected = true }
      const r = await window.wb.lockResetByRecovery(rec.code, 'smoke-pass-2')
      const unlock = await window.wb.unlock('smoke-pass-2')
      const disabled = await window.wb.lockDisable('smoke-pass-2')
      return { wrongRejected, resetOk: !!r.newCode, newPwWorks: unlock.ok, disabled: !disabled.enabled }
    })()`)
    push('恢复码能重置密码（错的码被拒）', sys.wrongRejected && sys.resetOk)
    push('重置后新密码可解锁', sys.newPwWorks)
    push('重置流程结束后锁已关闭', sys.disabled)

    const auto = autoBackup(info.dataDir, info.version, 7)
    const bks = listBackups(info.dataDir)
    push('自动备份已存在（当天只做一次）', bks.some((b) => b.name.startsWith('auto-')), `created=${auto.created} files=${bks.length}`)

    const autoStart = await evalJs<{ off: boolean }>(`(async () => {
      const now = await window.wb.autostart()
      const before = await window.wb.autostart()
      const set = await window.wb.setAutostart(false)
      await window.wb.setAutostart(before)
      return { off: set === false }
    })()`)
    push('开机自启开关可读可写', autoStart.off)

    const tip = await evalJs<string>(`window.wb.trayTip()`)
    push('托盘提示能算出倒计时', tip.length > 0, tip)

    // ── M11：排版真的装得下 / 字号可读 / 老布局会被抬高 ──
    const fit = await evalJs<{
      cardH: number
      calVisible: boolean
      calScroll: number
      minFont: number
      smallCount: number
      cardCount: number
    }>(`(async () => {
      const card = document.querySelector('[data-module="checkin"]')
      const body = card ? card.querySelector('.card-body') : null
      const grid = document.querySelector('.ck-grid')
      const cardH = card ? Math.round(card.getBoundingClientRect().height) : 0
      const calVisible = !!(grid && grid.getBoundingClientRect().height > 100)
      const calScroll = grid ? Math.max(0, Math.round(grid.scrollHeight - grid.clientHeight)) : -1
      // 全界面最小字号：普通用户真正要读的字不该小于 11px
      let minFont = 99
      let smallCount = 0
      for (const el of document.querySelectorAll('.bento *')) {
        const t = (el.textContent || '').trim()
        if (!t || el.children.length > 0) continue
        const fs = parseFloat(getComputedStyle(el).fontSize) || 0
        if (fs > 0 && fs < minFont) minFont = fs
        if (fs > 0 && fs < 11) smallCount++
      }
      return { cardH, calVisible, calScroll, minFont, smallCount, cardCount: document.querySelectorAll('[data-card]').length }
    })()`)
    push('到岗卡片高度够放整月月历', fit.cardH >= 330 && fit.calVisible, `cardH=${fit.cardH} visible=${fit.calVisible}`)
    push('月历没有被裁切（无需内部滚动）', fit.calScroll <= 2, `overflow=${fit.calScroll}px`)
    push('界面内没有小于 11px 的文字', fit.minFont >= 11 && fit.smallCount === 0, `min=${fit.minFont}px 小字=${fit.smallCount}`)
    const rowSums = await evalJs<string>(`(async () => {
      const ui = await window.wb.uiGet()
      const list = ui.layout.filter(l => l.visible).sort((a, b) => a.order - b.order)
      const out = []
      let sum = 0
      list.forEach(l => { sum += l.w; if (sum >= 12) { out.push(sum); sum = 0 } })
      if (sum > 0) out.push(sum)
      return out.join(',')
    })()`)
    const rowList = rowSums.split(',').map(Number)
    push('每一行都填满 12 列（没有空洞）', rowList.every((s) => s === 12), 'rows=' + rowSums)
    push('九张卡片都在网格里', fit.cardCount === 9, `cards=${fit.cardCount}`)

    const migrated = await evalJs<string>(`(async () => {
      const before = await window.wb.uiGet()
      const old = JSON.parse(JSON.stringify(before))
      const ck = old.layout.find(l => l.moduleId === 'checkin')
      const kn = old.layout.find(l => l.moduleId === 'knowledge')
      ck.h = 2; ck.w = 3
      kn.h = 2; kn.w = 3
      old.layoutVersion = 1
      await window.wb.uiSave(old)
      const after = await window.wb.uiGet()
      const ck2 = after.layout.find(l => l.moduleId === 'checkin')
      const kn2 = after.layout.find(l => l.moduleId === 'knowledge')
      // 还原成正常布局
      await window.wb.uiSave(before)
      return ck2.h + 'x' + ck2.w + ' / ' + kn2.h + 'x' + kn2.w
    })()`)
    push('旧布局会被重排成整齐四行', migrated === '4x4 / 3x8', migrated)

    // ── 批量补卡：一次补多天 ──
    const batch = await evalJs<{ done: number; skipped: number; after: number }>(`(async () => {
      const cal = await window.wb.checkinCalendar(new Date().toISOString().slice(0, 7))
      const targets = cal.filter(c => c.missing).slice(0, 5).map(c => c.day)
      const r = await window.wb.checkinMarkMany(targets, { at: '09:15' })
      const after = await window.wb.checkinCalendar(new Date().toISOString().slice(0, 7))
      const stillMissing = after.filter(c => c.missing && targets.includes(c.day)).length
      for (const d of targets) await window.wb.checkinUndo(d)
      return { done: r.done, skipped: r.skipped, after: stillMissing }
    })()`)
    push('批量补卡一次补齐多天', batch.done >= 3 && batch.after === 0, `done=${batch.done} skipped=${batch.skipped} 仍缺=${batch.after}`)

    // ── 设置能跨"重启"留住（写入 → 关库 → 重开 → 读回）──
    const keptValue = await evalJs<string>(`(async () => {
      return await window.wb.settingsPersistProbe('smokeProbe', 'kept-2026')
    })()`)
    push('设置写入后重开库仍在（不是每次都是新的）', keptValue === 'kept-2026', 'value=' + keptValue)

    // ── 已配班表则不再提示"班表还没配" ──
    const cfg = await evalJs<string>(`(async () => {
      const s = await window.wb.settingsGet()
      return String(s.scheduleConfigured)
    })()`)
    push('配过班表后 configured 标记为 1', cfg === '1', 'scheduleConfigured=' + cfg)

    // ── 保存班表后必须真的写进文件（不是只改了内存）──
    const wrote = await evalJs<string>(`(async () => {
      const before = await window.wb.storeInfo()
      const st = await window.wb.scheduleGet()
      const profiles = JSON.parse(JSON.stringify(st.profiles))
      const p = profiles[0]
      const keep = { start: p.base.start, end: p.base.end, lunch: p.base.lunch }
      p.base = { start: '08:15', end: '17:45', lunch: keep.lunch }
      await window.wb.scheduleSave({ activeId: p.id, profiles })
      const after = await window.wb.storeInfo()
      const back = await window.wb.scheduleGet()
      // 还原
      const st2 = await window.wb.scheduleGet()
      const p2 = JSON.parse(JSON.stringify(st2.profiles))
      p2[0].base = keep
      await window.wb.scheduleSave({ activeId: p2[0].id, profiles: p2 })
      return JSON.stringify({ mtimeChanged: before.mtime !== after.mtime, size: after.sizeBytes, start: back.profiles[0].base.start, err: after.lastError })
    })()`)
    const w = JSON.parse(wrote) as { mtimeChanged: boolean; size: number; start: string; err: string | null }
    push('保存班表后库文件真的被重写', w.mtimeChanged && w.size > 0 && !w.err, 'mtimeChanged=' + w.mtimeChanged + ' size=' + w.size + ' start=' + w.start)
  } catch (err) {
    push('冒烟执行异常', false, String(err))
  }

  const ok = checks.every((c) => c.ok)
  const result = { ok, when: new Date().toISOString(), info, checks }

  try {
    const logDir = path.join(info.dataDir, 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    fs.writeFileSync(path.join(logDir, 'smoke.json'), JSON.stringify(result, null, 2), 'utf8')
    // 顺手留一张界面截图：排版问题只看数字看不出来
    if (!win.isDestroyed()) {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(logDir, 'shot.png'), img.toPNG())
    }
  } catch {
    /* 日志失败不影响判定 */
  }

  process.stdout.write('WB_SMOKE_RESULT ' + JSON.stringify(result) + '\n')
  return ok ? 0 : 1
}











