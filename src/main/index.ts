import { app, BrowserWindow, ipcMain, shell, dialog, globalShortcut , Notification } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { resolveDataDirInfo, readBootstrap, writeBootstrap } from './paths'
import {
  logInfo,
  logWarn,
  logError,
  recentLogs,
  logStats,
  buildReport,
  exportReport,
  pruneLogs,
  setEchoDir,
  setLogDirForTest,
  resetErrorCount,
  fixedLogDir,
  type DiagContext
} from './log'
import {
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  getUpdateState,
  onUpdateState,
  setSettingReader
} from './update'
import { keyFilePath } from './crypto'
import { acquireLaunchLock, cleanOldUnpackDirs, releaseLaunchLock } from './single-instance'
import { autoRepair, diagnose, disablePasswordKey, enablePasswordKey, resetToEmpty, restoreFromBackup, unlockWithPassword } from './recovery'
import { deleteRule, listRules, ruleStats, saveRule, setRuleEnabled } from './rules'
import { JsonStore } from './jsonstore'
import { createTray, destroyTray, setTrayTooltip } from './tray'
import { runSmoke } from './smoke'
import { getScheduleState, saveScheduleState, presets, importLegacySchedule, setSetting as setSettingValue } from './scheduleStore'
import { validateProfile } from '../shared/schedule/resolve'
import { computeCountdown, resolveDay } from '../shared/schedule/resolve'
import { openStore, closeStore, reopenStore, persistNow, dataFilePath, persistStats, persistError, storeInfo, onPersistError, isOpen, audit } from './store'
import { createBackup, restoreBackup, exportRedacted, copyDataDir, tableCounts, listBackups, autoBackup } from './backup'
import {
  listTodos,
  listDone,
  addTodo,
  completeTodo,
  uncompleteTodo,
  updateTodo,
  deleteTodo,
  reorderTodos,
  listWorklog,
  addWorklog,
  deleteWorklog,
  updateWorklog,
  worklogDays,
  dailySummary,
  dueSoonTodos,
  weekReport,
  listKnowledge,
  addKnowledge,
  deleteKnowledge,
  updateKnowledge,
  knowledgeScopes,
  parsePaste,
  applyPaste,
  setSettingBool,
  todayAnchors,
  parseWithRules
} from './todos'
import { parseQuickTodo } from '../shared/parse/quick'
import {
  getCheckin,
  markCheckin,
  updateCheckin,
  deleteCheckin,
  checkinStats,
  checkinCalendar,
  markManyCheckins,
  monthSummary,
  workDayOf,
  rangeCheckins,
  exportCheckins,
  getSettings,
  settingSet,
  todayStr
} from './checkin'
import { lockState, setPassword, changePassword, disableLock, setAutoLockMinutes, lockNow, unlock, issueRecoveryCode, resetByRecovery, hasRecoveryCode, recoveryHint, setRecoveryHint } from './lock'
import { listNotes, addNote, updateNote, deleteNote, recordPomodoro, pomodoroToday, PALETTE_ACTIONS } from './extras'
import { loadPlugins, writeSampleManifest, BUILTIN_MODULE_IDS } from './plugins'
import { DEFAULT_UI_STATE, LAYOUT_VERSION, type UiState, type AppInfo, type ScheduleState, type TodoRow } from '../shared/types'
import { migrateLayout } from '../shared/layout'

app.setName('Workbench')

const SMOKE = process.argv.includes('--smoke')
// 排版只能靠眼睛看：--shot 启动 → 跳过导览 → 截一张主界面 PNG 后退出
const SHOT = process.argv.includes('--shot')
const HIDDEN = process.argv.includes('--hidden')
const RENDERER_INDEX = path.join(__dirname, '..', '..', 'renderer', 'index.html')
const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js')

let mainWindow: BrowserWindow | null = null
let quickWin: BrowserWindow | null = null

/**
 * 全局快速记事小窗：任何软件里按 Ctrl+Alt+T 弹出，回车进库、Esc/失焦关闭。
 * 复用主窗口的 preload，走 ?quick=1 参数让渲染层只挂快速录入组件。
 */
function toggleQuickCapture(): void {
  if (quickWin && !quickWin.isDestroyed()) {
    quickWin.show()
    quickWin.focus()
    return
  }
  quickWin = new BrowserWindow({
    width: 560,
    height: 132,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#0e1116',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  quickWin.loadFile(RENDERER_INDEX, { search: 'quick=1' })
  quickWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logError('quick', new Error(`窗口加载失败 ${code} ${desc} ${url}`))
  })
  quickWin.once('ready-to-show', () => quickWin?.show())
  quickWin.on('closed', () => { quickWin = null })
  quickWin.on('blur', () => {
    setTimeout(() => {
      if (quickWin && !quickWin.isDestroyed() && !quickWin.isFocused()) quickWin.close()
    }, 150)
  })
}
let dataDir = ''
let dataDirSource = '未知'
let storeError: string | null = null
let trayTimer: NodeJS.Timeout | null = null
let uiStore: JsonStore<UiState>

/** 托盘/后台用的当前班表 */
function activeProfileSafe() {
  const s = getScheduleState()
  return s.profiles.find((p) => p.id === s.activeId) ?? s.profiles[0] ?? null
}

/** 托盘提示：还剩多久下班 */
function trayTip(profile: ReturnType<typeof activeProfileSafe>): string {
  if (!profile) return '工作台 · 未配置班表'
  const c = computeCountdown(profile, new Date())
  const fmt = (sec: number): string => {
    const s = Math.max(0, Math.floor(sec))
    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
  }
  switch (c.phase) {
    case 'working':
      return `距下班 ${fmt(c.wallRemainingSec)} · ${profile.name}`
    case 'lunch':
      return `午休中 · 距下班 ${fmt(c.wallRemainingSec)}`
    case 'overtime':
      return `已加班 ${fmt(c.overtimeSec)}`
    case 'before':
      return `距上班 ${fmt(c.untilStartSec)}`
    case 'after':
    case 'off':
      return `休息中 · 距上班 ${fmt(c.untilStartSec || c.tomorrowStartSec)}`
    default:
      return `工作台 · ${profile.name}`
  }
}

// 单实例：拦在解压/开库之前，否则两个进程各写一份加密库 → 后写覆盖先写
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 第二个实例：Electron 会在已有实例里触发 second-instance 把窗口顶到前面，
  // 自己立刻退出——不建库、不写盘、不做任何改动
  app.quit()
  setTimeout(() => process.exit(0), 50)
}

// 启动器级互斥：portable 的解压发生在应用代码之前，上面那把锁管不到。
// 连点几下会多个启动器同时往同一个 %TEMP% 目录解压 → app.asar 残缺 → ENOENT package.json。
// 没拿到锁就安静退出（用户看到的仍是那一个已经在跑的窗口）。
const launchLock = gotLock ? acquireLaunchLock() : null
if (launchLock && !launchLock.acquired) {
  app.quit()
  setTimeout(() => process.exit(0), 50)
}
app.on('will-quit', () => releaseLaunchLock(launchLock))

// 兜底：漏网异常只记日志，不让主进程带着未落盘数据崩掉
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err?.stack || String(err))
  logError('uncaught', err)
})
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', (err as Error)?.stack || String(err))
  logError('unhandledRejection', err)
})

function buildRecoveryWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 640,
    minHeight: 520,
    title: '数据救援',
    show: false,
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  w.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logError('recovery', new Error(`窗口加载失败 ${code} ${desc} ${url}`))
  })
  return w
}

/**
 * 救援 IPC 必须早于 openStore 注册：
 * 库打不开时 registerIpc() 还没跑到，救援窗口会调不到任何接口（表现为一直"正在检查"）。
 */
function registerRecoveryIpc(): void {
  ipcMain.handle('recovery:diagnose', () => diagnose(dataDir))
  ipcMain.handle('recovery:autoFix', () => autoRepair(dataDir))
  ipcMain.handle('recovery:unlock', (_e, password: string) => unlockWithPassword(dataDir, password))
  ipcMain.handle('recovery:restore', (_e, file: string) => restoreFromBackup(dataDir, file))
  ipcMain.handle('recovery:reset', () => resetToEmpty(dataDir))
  ipcMain.handle('recovery:openDir', () => shell.openPath(dataDir))
  ipcMain.handle('recovery:finish', (_e, action: 'retry' | 'quit') => {
    const r = recoveryResolve
    recoveryResolve = null
    recoveryWin?.close()
    recoveryWin = null
    r?.(action)
  })
  ipcMain.handle('recovery:protectKey', (_e, password: string) => enablePasswordKey(dataDir, password))
  ipcMain.handle('recovery:removePwdKey', () => disablePasswordKey(dataDir))
}

let recoveryWin: BrowserWindow | null = null
let recoveryResolve: ((action: 'retry' | 'quit') => void) | null = null

/** 库打不开时弹出的数据救援窗口：诊断 + 自动修复 + 密码解锁 + 备份恢复 + 留档重建 */
function openRecoveryWindow(): Promise<'retry' | 'quit'> {
  return new Promise((resolve) => {
    if (recoveryWin && !recoveryWin.isDestroyed()) {
      recoveryWin.focus()
      recoveryResolve = resolve
      return
    }
    recoveryResolve = resolve
    recoveryWin = buildRecoveryWindow()
    recoveryWin.loadFile(RENDERER_INDEX, { search: 'recovery=1' })
    recoveryWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
      logError('recovery', new Error(`窗口加载失败 ${code} ${desc} ${url}`))
    })
    recoveryWin.once('ready-to-show', () => recoveryWin?.show())
    recoveryWin.on('closed', () => {
      recoveryWin = null
      const r = recoveryResolve
      recoveryResolve = null
      r?.('quit')
    })
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    // 九卡最低要 13 行（约 1276px），默认窗口给高一点，首屏能看到三行多
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    title: '工作台',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => {
    // 开机自启带 --hidden：只留托盘，不怼到脸上
    if (!SMOKE && !HIDDEN) win.show()
  })

  // 关闭 → 最小化到托盘（M4 会加"关闭即退出"设置）
  win.on('close', (e) => {
    if (!SMOKE && !(app as unknown as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (SHOT) {
    win.webContents.on('did-finish-load', () => {
      void (async () => {
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
        await wait(1800)
        try {
          // WB_SHOT_NO_SKIP：要拍导览/首次流程时别自动跳过
          if (!process.env.WB_SHOT_NO_SKIP) {
            await win.webContents.executeJavaScript(`(() => {
            const skip = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '以后再说')
            if (skip) skip.click()
            return true
          })()`)
          }
          // WB_SHOT_JS：截图前先点几下，拍弹层/交互态用
          const extra = process.env.WB_SHOT_JS
          if (extra) {
            await wait(400)
            try {
              const out = await win.webContents.executeJavaScript(extra)
              if (out) console.log('[shot] js =>', String(out))
            } catch (err) {
              console.error('[shot] js failed', (err as Error).message)
            }
          }
        } catch {
          /* 没有导览就直接截 */
        }
        await wait(1500)
        try {
          const img = await win.webContents.capturePage()
          const dir = path.join(dataDir, 'logs')
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, 'shot.png'), img.toPNG())
        } catch (err) {
          console.error('[shot] failed', (err as Error).message)
        }
        app.quit()
      })()
    })
  }

  const devUrl = process.env.WB_DEV_URL
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(RENDERER_INDEX)
  }

  return win
}

function registerIpc(): void {

  // ── 诊断：隐藏日志，出问题能查 ──
  const diagCtx = (): DiagContext => ({
    dataDir,
    dataDirSource,
    masterKeyOk: (() => {
      try {
        return fs.existsSync(keyFilePath())
      } catch {
        return false
      }
    })(),
    storeError
  })

  ipcMain.handle('log:recent', (_e, limit?: number) => recentLogs(limit ?? 120))
  ipcMain.handle('log:stats', () => logStats())
  ipcMain.handle('log:report', () => buildReport(diagCtx()))
  ipcMain.handle('log:export', (_e, targetDir?: string) => {
    const dir = targetDir || path.join(dataDir, 'exports')
    const file = exportReport(diagCtx(), dir)
    logInfo('diag', '导出诊断包 ' + file)
    return { file }
  })
  ipcMain.handle('log:openDir', async () => { await shell.openPath(fixedLogDir()) })
  ipcMain.handle('log:clear', () => { resetErrorCount(); return logStats() })
  // 渲染层任何异常都送到这里：用户看到的红字 = 日志里的一行
  ipcMain.on('log:renderer', (_e, level: 'info' | 'warn' | 'error', scope: string, message: string) => {
    if (level === 'error') logError('renderer/' + scope, message)
    else if (level === 'warn') logWarn('renderer/' + scope, message)
    else logInfo('renderer/' + scope, message)
  })

  ipcMain.handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    dataDir,
    isPackaged: app.isPackaged,
    platform: process.platform
  }))

  ipcMain.handle('ui:get', (): UiState => {
    const state = uiStore.read()
    let changed = false
    // 兜底：新版本新增模块时补齐布局项
    for (const item of DEFAULT_UI_STATE.layout) {
      if (!state.layout.some((l) => l.moduleId === item.moduleId)) {
        state.layout.push({ ...item, order: state.layout.length })
        changed = true
      }
    }
    // 卡片内容变高了，旧布局按版本号一次性抬到最小尺寸
    if (migrateLayout(state)) changed = true
    if (changed) uiStore.write(state)
    return state
  })

  ipcMain.handle('ui:save', (_e, state: UiState): void => {
    // 渲染进程不知道版本号，缺失才补；已有旧版本号要保留，否则迁移测不出来也回不去
    if (typeof state.layoutVersion !== 'number') state.layoutVersion = LAYOUT_VERSION
    uiStore.write(state)
  })

  ipcMain.handle('app:hide', (): void => {
    mainWindow?.hide()
  })

  ipcMain.handle('app:quit', (): void => {
    ;(app as unknown as { isQuitting?: boolean }).isQuitting = true
    app.quit()
  })

  // ── 班表 ──
  ipcMain.handle('schedule:get', (): ScheduleState => getScheduleState())
  ipcMain.handle('schedule:save', (_e, next: ScheduleState): ScheduleState => {
    // 没有这一层，一条非法班表（如 25:00）就能让托盘倒计时抛异常带走主进程
    if (!next || !Array.isArray(next.profiles) || next.profiles.length === 0) {
      throw new Error('班表至少要保留一个方案')
    }
    const ids = new Set<string>()
    for (const p of next.profiles) {
      if (!p || typeof p.id !== 'string' || p.id.length === 0) throw new Error('班表方案的 id 不合法')
      if (ids.has(p.id)) throw new Error('班表方案 id 有重复')
      ids.add(p.id)
      const issues = validateProfile(p)
      if (issues.length > 0) {
        throw new Error((p.name || '班表') + '：' + issues[0].message)
      }
    }
    if (!ids.has(next.activeId)) next.activeId = next.profiles[0].id
    saveScheduleState(next)
    setSettingValue('scheduleConfigured', '1')
    // 立刻落盘并检查：只写内存不写文件，用户重启就"没了"，还以为自己没点
    const written = persistNow()
    if (!written.ok) {
      throw new Error('写入磁盘失败：' + (written.error ?? '未知原因') + '（数据目录 ' + dataDir + '）')
    }
    const fresh = getScheduleState()
    // 广播：所有卡片（倒计时/到岗/设置面板）立即跟着新班表重算，不用重启
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('schedule:changed', fresh)
    audit('schedule:save', `${fresh.profiles.length} profile(s)`)
    return fresh
  })
  ipcMain.handle('schedule:presets', () => presets())

  ipcMain.handle('schedule:preview', (_e, date: string) => {
    const st = getScheduleState()
    const p = st.profiles.find((x) => x.id === st.activeId) ?? st.profiles[0]
    if (!p) return null
    const day = resolveDay(p, date)
    return { date, onDuty: day.attendance.onDuty, shift: day.shift, lunch: day.lunch, pieces: day.pieces, trail: day.trail }
  })

  ipcMain.handle('window:fullscreen', (_e, on: boolean): void => {
    mainWindow?.setFullScreen(on)
  })
  ipcMain.handle('window:isFullscreen', (): boolean => mainWindow?.isFullScreen() ?? false)

  // ── 存储 / 备份 ──
  ipcMain.handle('store:stats', () => ({
    ...persistStats(),
    isOpen: isOpen(),
    file: dataFilePath(),
    counts: tableCounts()
  }))

  ipcMain.handle('backup:create', (_e, suggested?: string) => {
    const target = suggested || path.join(dataDir, 'backups', `wb-${new Date().toISOString().slice(0, 10)}.wbk`)
    return { file: target, manifest: createBackup(dataDir, target, app.getVersion()) }
  })

  ipcMain.handle('backup:pick', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: '选择备份文件',
      filters: [{ name: '工作台备份', extensions: ['wbk'] }],
      properties: ['openFile']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('backup:restore', async (_e, file: string) => {
    const report = restoreBackup(dataDir, file)
    // 内存库还开着：不重开的话，下一次落盘会把刚还原的文件用旧库覆盖回去
    const reopened = await reopenStore(dataDir)
    return { ...report, reopened }
  })
  ipcMain.handle('backup:list', () => listBackups(dataDir))
  ipcMain.handle('backup:autoNow', () => autoBackup(dataDir, app.getVersion(), 7))

  ipcMain.handle('backup:exportRedacted', (_e, suggested?: string) => {
    const target = suggested || path.join(dataDir, 'exports', `redacted-${Date.now()}.json`)
    return { file: target, ...exportRedacted(dataDir, target) }
  })

  ipcMain.handle('datadir:pick', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: '选择新的数据目录',
      defaultPath: path.dirname(dataDir),
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('datadir:migrate', async (_e, targetDir: string) => {
    const target = path.resolve(targetDir)
    const from = path.resolve(dataDir)
    if (!target || target === from) throw new Error('新目录与当前目录相同')

    // 1) 先落盘，再复制：不然复制出去的是旧快照
    persistNow()
    const report = copyDataDir(from, target)
    if (!report.verified) throw new Error('复制校验失败，已保留原目录，未切换')

    // 2) 主密钥单独保存一份在数据目录里：换盘/换机时它就是救命的那把
    try {
      const keyFile = keyFilePath()
      if (fs.existsSync(keyFile)) fs.copyFileSync(keyFile, path.join(target, 'master.key.copy'))
    } catch (err) { logWarn('migrate', '密钥副本失败：' + (err as Error).message) }

    // 3) 引导文件必须指向新目录，这才是"跟随"的根
    //    测试模式（WB_DATA_DIR）绝不改写真实引导文件
    const testing = !!process.env.WB_DATA_DIR?.trim()
    const b = readBootstrap()
    if (!testing) {
      writeBootstrap({
        dataDir: target,
        version: b?.version ?? 1,
        keyRef: b?.keyRef ?? 'workbench/master-key-v1',
        lastOpenedAt: new Date().toISOString()
      })
    }

    // 4) 立刻切过去：不切的话，界面还连着旧目录继续写，用户就会看到旧盘又"活"了
    dataDir = target
    dataDirSource = 'bootstrap.json 记录（迁移后）'
    setEchoDir(target)
    const reopened = await reopenStore(target)
    if (!reopened) {
      logError('migrate', '新目录重开失败，已回滚指针')
      if (!testing) {
        writeBootstrap({
          dataDir: from,
          version: b?.version ?? 1,
          keyRef: b?.keyRef ?? 'workbench/master-key-v1',
          lastOpenedAt: new Date().toISOString()
        })
      }
      dataDir = from
      await reopenStore(from)
      throw new Error('新目录打不开，已回滚到原目录：' + target)
    }

    // 5) 旧目录留一张便条，不删任何东西（删数据这件事永远交给用户）
    try {
      fs.writeFileSync(path.join(from, '已迁移到.txt'), '数据已迁移到：' + target + '\n确认新目录能正常打开后，这个目录可以自己删除。', 'utf8')
    } catch { /* 旧目录可能已经只读，不影响 */ }

    logInfo('migrate', from + ' → ' + target + ` files=${report.files}`)
    return { from, to: target, ...report, restartRequired: false }
  })

  ipcMain.handle('app:openDataDir', async () => {
    await shell.openPath(dataDir)
  })

  // ── 待办 ──
  ipcMain.handle('todos:list', (_e, scope: 'open' | 'today' | 'all') => listTodos(scope ?? 'open'))
  ipcMain.handle('todos:done', (_e, limit?: number) => listDone(limit))
  ipcMain.handle('todo:add', (_e, text: string, opts) => addTodo(text, opts))
  ipcMain.handle('todo:complete', (_e, id: string) => completeTodo(id))
  ipcMain.handle('todo:uncomplete', (_e, id: string) => uncompleteTodo(id))
  ipcMain.handle('todo:update', (_e, id: string, patch: Partial<TodoRow>) => updateTodo(id, patch))
  ipcMain.handle('todo:delete', (_e, id: string) => deleteTodo(id))
  ipcMain.handle('todo:reorder', (_e, ids: string[]) => reorderTodos(ids))
  ipcMain.handle('todo:autoWorklog', (_e, on: boolean) => setSettingBool('autoWorklog', on))

  // ── 工作记录 ──
  ipcMain.handle('worklog:list', (_e, day?: string) => listWorklog(day))
  ipcMain.handle('worklog:add', (_e, text: string, kind?: string) => addWorklog(text, kind))
  ipcMain.handle('worklog:update', (_e, id: string, text: string) => updateWorklog(id, text))
  ipcMain.handle('worklog:days', (_e, limit?: number) => worklogDays(limit))
  ipcMain.handle('worklog:delete', (_e, id: string) => deleteWorklog(id))
  ipcMain.handle('worklog:summary', (_e, day?: string) => dailySummary(day))
  ipcMain.handle('report:week', () => weekReport())


  // ── 口径库 ──
  ipcMain.handle('knowledge:list', (_e, q?: string) => listKnowledge(q ?? ''))
  ipcMain.handle('knowledge:add', (_e, k) => addKnowledge(k))
  ipcMain.handle('knowledge:update', (_e, id: string, patch) => updateKnowledge(id, patch))
  ipcMain.handle('knowledge:scopes', () => knowledgeScopes())

  // ── 学出来的规则 ──
  ipcMain.handle('rules:list', (_e, kind?: 'category' | 'time' | 'regex') => listRules(kind))
  ipcMain.handle('rules:save', (_e, input: { kind: 'category' | 'time' | 'regex'; pattern: string; value: string }) => saveRule(input))
  ipcMain.handle('rules:toggle', (_e, id: string, enabled: boolean) => setRuleEnabled(id, enabled))
  ipcMain.handle('rules:delete', (_e, id: string) => deleteRule(id))
  ipcMain.handle('rules:stats', () => ruleStats())
  ipcMain.handle('rules:try', (_e, text: string) => parseWithRules(text))
  ipcMain.handle('knowledge:delete', (_e, id: string) => deleteKnowledge(id))

  // ── 粘贴解析 ──
  ipcMain.handle('paste:parse', (_e, raw: string) => parsePaste(raw))
  ipcMain.handle('paste:apply', (_e, input) => applyPaste(input))

  // ── 到岗 ──
  ipcMain.handle('checkin:get', (_e, day?: string) => getCheckin(day ?? todayStr()))
  ipcMain.handle('checkin:mark', (_e, day?: string, opts?: { at?: string; isBackfill?: boolean; note?: string | null }) => {
    // 不指定日期 / 指定"今天"时按班次归属日算：跨零点夜班凌晨打卡要记到前一天
    const target = !day || day === todayStr() ? workDayOf() : day
    return markCheckin(target, opts ?? {})
  })
  ipcMain.handle('checkin:update', (_e, day: string, patch: { at?: string; note?: string | null; isBackfill?: boolean }) =>
    updateCheckin(day, patch)
  )
  ipcMain.handle('checkin:undo', (_e, day?: string) => deleteCheckin(day ?? todayStr()))
  // 批量补卡：一次最多 366 天，逐条校验日期格式，坏的跳过不炸整批
  ipcMain.handle('checkin:markMany', (_e, days: string[], opts?: { at?: string; note?: string | null }) => {
    if (!Array.isArray(days)) throw new Error('要补的日期必须是一个列表')
    if (days.length > 366) throw new Error('一次最多补 366 天')
    const clean = days.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    if (clean.length === 0) throw new Error('没有可用的日期')
    return markManyCheckins(clean, opts ?? {})
  })
  ipcMain.handle('checkin:stats', () => checkinStats())
  ipcMain.handle('checkin:calendar', (_e, ym: string) => checkinCalendar(ym))
  ipcMain.handle('checkin:monthSummary', (_e, ym: string) => monthSummary(ym))
  ipcMain.handle('checkin:range', (_e, from: string, to: string) => rangeCheckins(from, to))
  ipcMain.handle('checkin:export', (_e, ym: string, file?: string) =>
    exportCheckins(ym, file ?? path.join(dataDir, 'exports', `checkins-${ym}.xlsx`))
  )

  // ── 设置 ──
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('store:info', () => storeInfo())

  // ── 在线更新 ──
  ipcMain.handle('update:state', () => getUpdateState())
  ipcMain.handle('update:check', async () => await checkForUpdate())
  ipcMain.handle('update:download', async () => await downloadUpdate())
  ipcMain.handle('update:apply', () => applyUpdate())
  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    // 保留键不许渲染进程直接写：否则一行脚本就能关锁/改锁哈希
    if (/^lock/i.test(key) || key.startsWith('masterKey')) throw new Error('该设置项不允许直接写入')
    settingSet(key, value)
  })
  // 探针：写值 → 落盘 → 关库 → 重开 → 读回，只给冒烟验证「重启后还在」用
  ipcMain.handle('settings:persistProbe', async (_e, key: string, value: string) => {
    if (typeof key !== 'string' || !key) throw new Error('key 不能为空')
    if (/^lock/i.test(key) || key.startsWith('masterKey')) throw new Error('该设置项不允许直接写入')
    settingSet(key, value)
    persistNow()
    const ok = await reopenStore(dataDir)
    if (!ok) throw new Error('重开库失败')
    return getSettings()[key] ?? ''
  })

  // ── 应用锁 ──
  ipcMain.handle('lock:state', () => lockState())
  ipcMain.handle('lock:setPassword', (_e, pw: string) => setPassword(pw))
  ipcMain.handle('lock:changePassword', (_e, oldPw: string, newPw: string) => changePassword(oldPw, newPw))
  ipcMain.handle('lock:disable', (_e, pw: string) => disableLock(pw))
  ipcMain.handle('lock:autoMinutes', (_e, min: number) => setAutoLockMinutes(min))
  ipcMain.handle('lock:lock', () => {
    const s = lockNow()
    mainWindow?.webContents.send('lock:changed', s)
    return s
  })
  ipcMain.handle('lock:unlock', (_e, pw: string) => {
    const r = unlock(pw)
    if (r.ok) mainWindow?.webContents.send('lock:changed', r.state)
    return r
  })
  ipcMain.handle('lock:issueRecovery', (_e, pw: string) => issueRecoveryCode(pw))
  ipcMain.handle('lock:hasRecovery', () => hasRecoveryCode())
  ipcMain.handle('lock:recoveryHint', () => recoveryHint())
  ipcMain.handle('lock:setRecoveryHint', (_e, text: string) => setRecoveryHint(text))
  ipcMain.handle('lock:resetByRecovery', (_e, code: string, newPw: string) => resetByRecovery(code, newPw))

  // ── 系统集成 ──
  // 绿色版真正的 exe 是 PORTABLE_EXECUTABLE_PATH；用 process.execPath 会指向
  // %TEMP% 里的解压副本，重启后那个路径就没了 → 自启必然失效
  const selfExe = (): string => process.env.PORTABLE_EXECUTABLE_PATH || process.execPath
  ipcMain.handle('app:autostart', () => app.getLoginItemSettings({ path: selfExe() }).openAtLogin)
  ipcMain.handle('app:setAutostart', (_e, on: boolean) => {
    app.setLoginItemSettings({ openAtLogin: on, path: selfExe(), args: ['--hidden'] })
    return app.getLoginItemSettings({ path: selfExe() }).openAtLogin
  })
  ipcMain.handle('app:trayTip', () => trayTip(activeProfileSafe()))

  // ── 便签 / 番茄钟 / 命令面板 ──
  ipcMain.handle('notes:list', () => listNotes())
  ipcMain.handle('notes:add', (_e, text: string) => addNote(text))
  ipcMain.handle('notes:update', (_e, id: string, patch) => updateNote(id, patch))
  ipcMain.handle('notes:delete', (_e, id: string) => deleteNote(id))
  ipcMain.handle('pomodoro:record', (_e, kind: 'focus' | 'break', minutes: number, todoId?: string) =>
    recordPomodoro(kind, minutes, todoId ?? null)
  )
  ipcMain.handle('pomodoro:today', () => pomodoroToday())
  ipcMain.handle('palette:actions', () => PALETTE_ACTIONS)

  // ── 插件（声明式清单，无代码执行） ──
  ipcMain.handle('plugins:list', () => loadPlugins(dataDir))
  ipcMain.handle('plugins:sample', () => ({ file: writeSampleManifest(dataDir) }))
}

app.on('second-instance', () => {
  // 用户又点了一下 exe：把已经在跑的窗口顶到前面，别让他以为没反应而继续乱点
  //（portable 每点一次都会解压一遍，乱点正是 app.asar 被写坏的来源）
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  try {
    mainWindow.flashFrame(true)
  } catch {
    /* 闪烁提示失败不影响把窗口顶前 */
  }
})

app.whenReady().then(async () => {
  // 冒烟一律跑在临时目录：即使调用方忘了设 WB_DATA_DIR，也不许碰真实数据
  if (SMOKE && !process.env.WB_DATA_DIR?.trim()) {
    process.env.WB_DATA_DIR = path.join(app.getPath('temp'), 'Workbench-smoke-auto')
  }
  // 日志先就位：后面任何一步炸了都要留下痕迹
  if (process.env.WB_DATA_DIR?.trim()) setLogDirForTest(require('node:path').join(process.env.WB_DATA_DIR.trim(), 'logs'))
  logInfo('app', `启动 v${app.getVersion()} packaged=${app.isPackaged} pid=${process.pid}`)
  // 顺便清掉旧版本留在 %TEMP% 里的解压目录（只清 Workbench-x.y.z 形状、且没被占用的）。
  // 不清的话，别人机器上会越积越多，而且旧目录正是 ENOENT package.json 的来源之一。
  if (app.isPackaged) {
    try {
      const gone = cleanOldUnpackDirs(app.getVersion())
      if (gone.length) logInfo('app', `已清理旧解压目录 ${gone.length} 个：${gone.join(' , ')}`)
    } catch (err) {
      logInfo('app', `清理旧解压目录跳过：${(err as Error).message}`)
    }
  }
  pruneLogs()

  const resolved = resolveDataDirInfo()
  dataDir = resolved.dir
  dataDirSource = process.env.WB_DATA_DIR?.trim() ? 'WB_DATA_DIR 环境变量（测试）' : readBootstrap() ? 'bootstrap.json 记录' : '默认路径'
  setEchoDir(dataDir)
  logInfo('dataDir', `${dataDir} ← ${dataDirSource}`)
  if (resolved.warn) {
    // 目录打不开就明说，绝不悄悄换个新目录让用户以为数据丢了
    console.error('[dataDir]', resolved.warn)
    logError('dataDir', resolved.warn)
    void dialog.showMessageBox({
      type: 'warning',
      title: '数据目录打不开',
      message: resolved.warn,
      detail: '原来的数据还在这个目录里，接好磁盘/修好权限后重启即可。本次不会新建空库。',
      buttons: ['知道了']
    })
  }
  registerRecoveryIpc()

  try {
    await openStore(dataDir)
  } catch (err) {
    // 打不开就进救援：自动修复 / 密码解锁 / 从备份恢复 / 重建空库（留档）
    // 绝不静默新建空库，也绝不删除任何文件
    const msg = (err as Error).message
    console.error('[store] open failed', msg)
    logError('store', err)
    storeError = msg
    console.warn('[store] 进入数据救援')

    // 自检钩子：只在 WB_RECOVERY_SELFTEST=1 时跑，用来端到端验证救援路径（生产环境永不触发）
    if (process.env.WB_RECOVERY_SELFTEST === 'render') {
      const probe = buildRecoveryWindow()
      await probe.loadFile(RENDERER_INDEX, { search: 'recovery=1' })
      // 等诊断往返完成（渲染层 onMounted → IPC）
      await new Promise((r) => setTimeout(r, 2500))
      const snap = await probe.webContents.executeJavaScript(
        `JSON.stringify({
          buttons: [...document.querySelectorAll("button")].map((b) => b.textContent.trim()),
          title: document.querySelector("h1")?.textContent ?? "",
          msg: document.querySelector(".rc-msg")?.textContent ?? "",
          chars: document.body.innerText.length
        })`
      )
      console.log('WB_RECOVERY_RENDER ' + snap)

      // 真实点一次「从备份恢复」：验证备份里的密钥能把库打开（不留黑箱）
      const restored = await probe.webContents.executeJavaScript(
        `(async () => {
          const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "从备份恢复")
          if (!b) return JSON.stringify({ ok: false, why: "按钮找不到" })
          b.click()
          await new Promise((r) => setTimeout(r, 400))
          const item = document.querySelector(".rc-item")
          if (!item) return JSON.stringify({ ok: false, why: "备份列表没出现" })
          item.click()
          await new Promise((r) => setTimeout(r, 1800))
          return JSON.stringify({ ok: true, result: document.querySelector(".rc-result")?.textContent ?? "", foot: document.querySelector(".rc-foot-btns button.primary")?.disabled })
        })()`
      )
      console.log('WB_RECOVERY_RESTORE ' + restored)

      // 快速记事窗：同一个 RENDERER_INDEX，确认能渲染出输入框（不是黑屏）
      const qw = new BrowserWindow({
        width: 560,
        height: 132,
        show: false,
        frame: false,
        webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
      })
      await qw.loadFile(RENDERER_INDEX, { search: 'quick=1' })
      await new Promise((r) => setTimeout(r, 900))
      const qsnap = await qw.webContents.executeJavaScript(
        `JSON.stringify({ input: !!document.querySelector("input,textarea"), chars: document.body.innerText.length })`
      )
      console.log('WB_QUICK_RENDER ' + qsnap)
      qw.destroy()
      probe.destroy()
      app.exit(0)
      return
    }

    if (process.env.WB_RECOVERY_SELFTEST === '1') {
      const d = diagnose(dataDir)
      const r = await resetToEmpty(dataDir)
      console.log('WB_RECOVERY_SELFTEST ' + JSON.stringify({ message: d.message, canOpen: d.canOpen, ok: r.ok, kept: r.kept, msg: r.message }))
      app.exit(0)
      return
    }

    let recovered = false
    for (let round = 0; round < 4; round++) {
      const action = await openRecoveryWindow()
      if (action === 'quit') {
        app.quit()
        return
      }
      try {
        await openStore(dataDir)
        recovered = true
        storeError = null
        break
      } catch (again) {
        storeError = (again as Error).message
        console.warn('[store] 救援后仍打不开：', storeError)
      }
    }
    if (!recovered) {
      app.quit()
      return
    }
  }

  // 密钥救援副本：数据目录里始终留一份，%APPDATA% 出事也能凭它打开数据
  try {
    const kp = keyFilePath()
    const cp = path.join(dataDir, 'master.key.copy')
    if (fs.existsSync(kp)) {
      const cur = fs.existsSync(cp) ? fs.readFileSync(cp) : null
      const want = fs.readFileSync(kp)
      if (!cur || cur.toString('hex') !== want.toString('hex')) {
        fs.writeFileSync(cp, want)
        logInfo('key', '已在数据目录放置密钥救援副本 master.key.copy')
      }
    }
  } catch (err) {
    console.warn('[key] 救援副本写入失败：', (err as Error).message)
  }

  // 待办到期提醒：到期前 15 分钟弹一次；只提醒将来的，过期不补弹（不制造愧疚）
  const notifiedReminders = new Set<string>()
  setInterval(() => {
    try {
      for (const t of dueSoonTodos(new Date())) {
        const key = t.id + '|' + t.due_at
        if (notifiedReminders.has(key)) continue
        notifiedReminders.add(key)
        const n = new Notification({ title: '快到点了：' + t.text, body: '到期时间 ' + t.due_at.slice(11, 16) })
        n.on('click', () => {
          mainWindow?.show()
          mainWindow?.focus()
        })
        n.show()
      }
    } catch {
      // 提醒失败不影响主流程
    }
  }, 60_000)

  // 首次启动 / 老用户自愈：
  // 默认班表（09:00–18:00，午休 12:00–13:00）本身就是能用的，直接写进库并落盘，
  // 这样"向导没点完"也不会导致倒计时没数据、或界面一直提示"班表还没配"。
  try {
    const st = getScheduleState()
    if (st.profiles.length > 0 && getSettings().scheduleConfigured !== '1') {
      saveScheduleState(st)
      settingSet('scheduleConfigured', '1')
      const r = persistNow()
      if (!r.ok) console.error('[schedule] 默认班表落盘失败：', r.error)
    }
  } catch (err) {
    console.error('[schedule] 初始化失败', (err as Error).message)
  }

  // 旧版 schedule.json 一次性导入
  const legacyPath = path.join(dataDir, 'schedule.json')
  if (fs.existsSync(legacyPath)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as ScheduleState
      importLegacySchedule(legacy)
      fs.renameSync(legacyPath, legacyPath + '.imported')
    } catch {
      /* 导入失败不阻塞启动 */
    }
  }

  uiStore = new JsonStore<UiState>(path.join(dataDir, 'ui.json'), () => structuredClone(DEFAULT_UI_STATE))
  // 落盘失败 → 渲染层红条：绝不让"没写进文件"这件事悄悄发生
  onPersistError((message) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('store:persistError', message)
  })

  // 更新状态推给界面
  setSettingReader((key) => getSettings()[key] ?? null)
  onUpdateState((s) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:state', s)
  })

  // 启动后静默检查一次（可在设置里关掉），有新版本才打扰
  setTimeout(() => {
    if (getSettings().updateAutoCheck === '0') return
    void checkForUpdate().then((s) => {
      if (!s.info) return
      try {
        const n = new Notification({ title: '发现新版本 ' + s.info.latest, body: '在「设置 → 更新」里下载，或稍后手动检查' })
        n.show()
      } catch {
        /* 通知被系统关掉也无所谓 */
      }
    })
  }, 60000)

  registerIpc()

  mainWindow = createWindow()

  // 每日自动备份（当天已有则跳过，保留 7 份）
  try {
    const ab = autoBackup(dataDir, app.getVersion(), 7)
    if (ab.created) console.log('[backup] auto created', ab.file)
  } catch (err) {
    console.error('[backup] auto failed', (err as Error).message)
  }

  if (!SMOKE) {
    createTray({
      onShow: () => {
        mainWindow?.show()
        mainWindow?.focus()
      },
      onHide: () => mainWindow?.hide(),
      onLock: () => {
        const s = lockNow()
        mainWindow?.webContents.send('lock:changed', s)
      },
      onCheckin: () => {
        const row = markCheckin(todayStr(), {})
        mainWindow?.webContents.send('checkin:changed', row)
      },
      onSettings: () => {
        mainWindow?.show()
        mainWindow?.focus()
        mainWindow?.webContents.send('open:settings', 'schedule')
      },
      onQuit: () => {
        ;(app as unknown as { isQuitting?: boolean }).isQuitting = true
        app.quit()
      }
    })

    // 全局快捷键：离开界面也能打卡/上锁
    try {
      const okCheckin = globalShortcut.register('Control+Alt+K', () => {
        try {
          const row = markCheckin(todayStr(), {})
          mainWindow?.webContents.send('checkin:changed', row)
        } catch (err) {
          console.error('[shortcut] checkin failed', (err as Error).message)
        }
      })
      const okLock = globalShortcut.register('Control+Alt+L', () => {
        const s = lockNow()
        mainWindow?.webContents.send('lock:changed', s)
      })
      const okQuick = globalShortcut.register('Control+Alt+T', () => toggleQuickCapture())
      // register 失败只返回 false，不抛异常：静默失效是最坑的，至少记下来
      if (!okCheckin || !okLock || !okQuick) {
        const missing = [!okCheckin ? 'Ctrl+Alt+K' : '', !okLock ? 'Ctrl+Alt+L' : '', !okQuick ? 'Ctrl+Alt+T' : ''].filter(Boolean).join('、')
        console.warn('[shortcut] 被占用：' + missing)
      }
    } catch (err) {
      console.error('[shortcut] register failed', (err as Error).message)
    }

    // 托盘悬浮即见倒计时
    const profile = activeProfileSafe()
    if (profile) {
      setTrayTooltip(trayTip(profile))
      trayTimer = setInterval(() => {
        // 定时器里抛异常会带走整个主进程，这里必须兜住
        try {
          const p = activeProfileSafe()
          if (p) setTrayTooltip(trayTip(p))
        } catch (err) {
          console.error('[tray] tip failed', (err as Error).message)
        }
      }, 20_000)
    }

    const b = readBootstrap()
    if (b) writeBootstrap({ ...b, lastOpenedAt: new Date().toISOString() })
  }

  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (SMOKE && level >= 2) console.log('[renderer]', message)
  })

  mainWindow.webContents.on('did-finish-load', async () => {
    if (!SMOKE) return
    const code = await runSmoke(mainWindow!, {
      version: app.getVersion(),
      dataDir,
      isPackaged: app.isPackaged,
      platform: process.platform
    })
    // 打包版是 GUI 子系统，stdout 会被吞掉；
    // 结果同时落一份文件，冒烟脚本和人都能看（隔离目录内，不碰真实数据）
    try {
      const out = path.join(dataDir, 'smoke-result.json')
      const publish = (globalThis as unknown as { __lastSmoke?: unknown }).__lastSmoke
      fs.writeFileSync(out, JSON.stringify(publish ?? { code }, null, 2), 'utf8')
      console.log('[smoke] 结果已写入 ' + out)
    } catch (err) {
      console.error('[smoke] 结果落盘失败', (err as Error).message)
    }
    destroyTray()
    app.exit(code)
  })
})

app.on('window-all-closed', () => {
  // 托盘常驻：不自动退出（SMOKE 除外）
  if (SMOKE) app.quit()
})

app.on('before-quit', () => {
  ;(app as unknown as { isQuitting?: boolean }).isQuitting = true
  try {
    persistNow()
    closeStore()
  } catch {
    /* 退出时落盘失败不阻塞退出 */
  }
})






















