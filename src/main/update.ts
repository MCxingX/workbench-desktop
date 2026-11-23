import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { compareVersion } from '../shared/version'

export { compareVersion }

/**
 * 绿色版（portable）在线更新。
 *
 * 不依赖 electron-updater：portable 目标它不支持自更新，而本项目的使用方式就是
 * 一个绿色 exe。这里自己做三件事：
 *   1. 多源「握手探测」——GitHub 直连 + 若干加速镜像并发拉元数据，量出 RTT 与吞吐；
 *   2. 下载时对每个源的整包做 Range 测速，挑最快的那个下（国内直连经常是 0 字节/分钟）；
 *   3. 下载完校验大小与 sha256，写一个替换脚本，退出后覆盖原 exe 再启动。
 */

export interface UpdateSource {
  id: string
  name: string
  /** 对 GitHub 原始 URL 做改写；直连就是原样返回 */
  wrap: (url: string) => string
}

export interface SourceProbe {
  id: string
  name: string
  ok: boolean
  ms: number
  bps: number
  error: string | null
}

export interface UpdateManifest {
  version: string
  asset: string
  size: number
  sha256: string | null
  notes: string
  publishedAt: string
}

export interface UpdateInfo {
  current: string
  latest: string
  notes: string
  asset: string
  size: number
  sha256: string | null
  publishedAt: string
  url: string
  source: string
}

export type UpdatePhase = 'idle' | 'probing' | 'downloading' | 'ready' | 'applying' | 'error'

export interface UpdateState {
  phase: UpdatePhase
  message: string
  pct: number
  bytesPerSec: number
  received: number
  total: number
  probes: SourceProbe[]
  info: UpdateInfo | null
  canApply: boolean
  file: string | null
}

const DEFAULT_REPO = 'MCxingX/workbench-desktop'

function repoSlug(): string {
  try {
    const custom = readSetting('updateRepo')
    if (custom && /^[\w.-]+\/[\w.-]+$/.test(custom)) return custom
  } catch {
    /* 设置没打开也能用默认值 */
  }
  return DEFAULT_REPO
}

let settingReader: ((key: string) => string | null) | null = null

/** 由主进程注入读设置的方法，避免这里直接依赖 store 造成循环引用 */
export function setSettingReader(fn: (key: string) => string | null): void {
  settingReader = fn
}

function readSetting(key: string): string | null {
  return settingReader ? settingReader(key) : null
}

const MIRRORS: UpdateSource[] = [
  { id: 'github', name: 'GitHub 直连', wrap: (u) => u },
  { id: 'ghfast', name: 'ghfast.top', wrap: (u) => `https://ghfast.top/${u}` },
  { id: 'ghproxy', name: 'gh-proxy.com', wrap: (u) => `https://gh-proxy.com/${u}` },
  { id: 'ghpnet', name: 'ghproxy.net', wrap: (u) => `https://ghproxy.net/${u}` },
  {
    id: 'gitmirror',
    name: 'gitmirror',
    wrap: (u) => u.replace('https://raw.githubusercontent.com', 'https://raw.gitmirror.com')
  }
]

/** 设置里可以自行追加/覆盖源：JSON 数组 [{id,name,prefix},{id,name,prefix}] */
export function resolveSources(): UpdateSource[] {
  const raw = readSetting('updateSources')
  if (!raw) return MIRRORS
  try {
    const parsed = JSON.parse(raw) as { id: string; name: string; prefix: string }[]
    if (!Array.isArray(parsed) || parsed.length === 0) return MIRRORS
    return parsed
      .filter((s) => s && typeof s.id === 'string' && typeof s.prefix === 'string')
      .map((s) => ({ id: s.id, name: s.name || s.id, wrap: (u: string) => (s.prefix ? s.prefix + u : u) }))
  } catch {
    return MIRRORS
  }
}

function manifestUrl(src: UpdateSource, repo: string): string {
  const [owner, name] = repo.split('/')
  return src.wrap(`https://raw.githubusercontent.com/${owner}/${name}/main/release/version.json`)
}

function assetUrl(src: UpdateSource, repo: string, version: string, asset: string): string {
  const [owner, name] = repo.split('/')
  return src.wrap(`https://github.com/${owner}/${name}/releases/download/v${version}/${asset}`)
}

// 版本比较在 @shared/version，主进程与测试共用同一份实现

interface FetchSample {
  ok: boolean
  bytes: number
  ms: number
  text: string
  error: string | null
}

/** 拉一小段就断开：既拿内容又量速度，避免把整个安装包拖下来探速 */
async function sample(url: string, maxBytes = 32768, timeoutMs = 8000): Promise<FetchSample> {
  const started = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${maxBytes - 1}`, 'User-Agent': 'Workbench-Updater' },
      signal: ac.signal,
      redirect: 'follow'
    })
    if (!res.ok && res.status !== 206) {
      return { ok: false, bytes: 0, ms: Date.now() - started, text: '', error: `HTTP ${res.status}` }
    }
    const chunks: Uint8Array[] = []
    let got = 0
    const reader = res.body?.getReader()
    if (!reader) return { ok: false, bytes: 0, ms: Date.now() - started, text: '', error: '无响应体' }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        got += value.length
        if (got >= maxBytes) {
          await reader.cancel()
          break
        }
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
    return {
      ok: got > 0,
      bytes: got,
      ms: Date.now() - started,
      text: buf.toString('utf8'),
      error: got > 0 ? null : '空响应'
    }
  } catch (err) {
    return { ok: false, bytes: 0, ms: Date.now() - started, text: '', error: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

let state: UpdateState = {
  phase: 'idle',
  message: '',
  pct: 0,
  bytesPerSec: 0,
  received: 0,
  total: 0,
  probes: [],
  info: null,
  canApply: false,
  file: null
}

let onState: ((s: UpdateState) => void) | null = null

export function onUpdateState(cb: (s: UpdateState) => void): void {
  onState = cb
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  try {
    onState?.(state)
  } catch {
    /* 推送失败不影响下载 */
  }
}

export function getUpdateState(): UpdateState {
  return state
}

/** 兼容旧字段，避免界面拿到 undefined */
export function resetUpdateState(): void {
  state = { ...state, phase: 'idle', message: '', pct: 0, received: 0, total: 0, bytesPerSec: 0 }
}

/**
 * 多源握手：并发拉每个源的 version.json，谁先回、谁回得快就用谁。
 * 全部失败时抛错，并把每个源的失败原因带出去，方便用户判断是网络还是仓库没配。
 */
async function fetchManifest(repo: string): Promise<{ manifest: UpdateManifest; probe: SourceProbe; url: string }> {
  const sources = resolveSources()
  setState({ phase: 'probing', message: '正在探测更新源…', probes: [] })

  const results = await Promise.all(
    sources.map(async (src) => {
      const url = manifestUrl(src, repo)
      const r = await sample(url, 32768, 8000)
      let manifest: UpdateManifest | null = null
      if (r.ok) {
        try {
          const parsed = JSON.parse(r.text) as UpdateManifest
          if (parsed && typeof parsed.version === 'string' && typeof parsed.asset === 'string') manifest = parsed
        } catch {
          /* 不是 JSON：可能返回了 HTML 错误页 */
        }
      }
      const probe: SourceProbe = {
        id: src.id,
        name: src.name,
        ok: !!manifest,
        ms: r.ms,
        bps: r.ms > 0 ? Math.round((r.bytes * 1000) / r.ms) : 0,
        error: manifest ? null : (r.error ?? '返回内容不是有效的 version.json')
      }
      return { src, probe, manifest }
    })
  )

  setState({ probes: results.map((x) => x.probe) })
  const usable = results.filter((x) => x.manifest)
  if (usable.length === 0) {
    throw new Error('所有更新源都不可用：' + results.map((x) => `${x.probe.name}=${x.probe.error}`).join('；'))
  }
  // 元数据小的可怜，比 RTT 更可靠
  usable.sort((a, b) => a.probe.ms - b.probe.ms)
  const best = usable[0]
  return { manifest: best.manifest as UpdateManifest, probe: best.probe, url: manifestUrl(best.src, repo) }
}

/** 对整包做 Range 测速，挑最快源（元数据快不代表大文件快） */
async function pickFastestForAsset(repo: string, version: string, asset: string, size: number): Promise<{ url: string; probe: SourceProbe }> {
  const sources = resolveSources()
  const sampleBytes = Math.min(512 * 1024, Math.max(64 * 1024, Math.floor(size / 20) || 65536))
  const results = await Promise.all(
    sources.map(async (src) => {
      const url = assetUrl(src, repo, version, asset)
      const r = await sample(url, sampleBytes, 12000)
      const bps = r.ms > 0 ? Math.round((r.bytes * 1000) / r.ms) : 0
      return {
        url,
        probe: { id: src.id, name: src.name, ok: r.ok, ms: r.ms, bps, error: r.error } as SourceProbe
      }
    })
  )
  setState({ probes: results.map((r) => r.probe) })
  const usable = results.filter((r) => r.probe.ok && r.probe.bps > 0)
  if (usable.length === 0) throw new Error('所有源都下载不动，请换个网络或用代理后重试')
  usable.sort((a, b) => b.probe.bps - a.probe.bps)
  return usable[0]
}

export async function checkForUpdate(): Promise<UpdateState> {
  const repo = repoSlug()
  const current = app.getVersion()
  try {
    setState({ phase: 'probing', message: '正在探测更新源…', info: null, canApply: false, pct: 0, received: 0, total: 0 })
    const { manifest, probe } = await fetchManifest(repo)
    if (compareVersion(manifest.version, current) <= 0) {
      setState({
        phase: 'idle',
        message: `已是最新版本（${current}）`,
        info: null,
        canApply: false
      })
      return state
    }
    const info: UpdateInfo = {
      current,
      latest: manifest.version,
      notes: manifest.notes ?? '',
      asset: manifest.asset,
      size: manifest.size ?? 0,
      sha256: manifest.sha256 ?? null,
      publishedAt: manifest.publishedAt ?? '',
      url: assetUrl(resolveSources().find((s) => s.id === probe.id) ?? MIRRORS[0], repo, manifest.version, manifest.asset),
      source: probe.name
    }
    setState({ phase: 'idle', message: `发现新版本 ${manifest.version}`, info, canApply: false })
    return state
  } catch (err) {
    setState({ phase: 'error', message: (err as Error).message })
    return state
  }
}

function updateDir(): string {
  const dir = path.join(os.tmpdir(), 'Workbench-update')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function sha256File(file: string): string {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex')
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (!state.info) throw new Error('还没有可下载的版本，请先检查更新')
  const repo = repoSlug()
  const info = state.info
  try {
    setState({ phase: 'probing', message: '正在挑最快的下载节点…', pct: 0, received: 0, total: info.size })
    const best = await pickFastestForAsset(repo, info.latest, info.asset, info.size || 80 * 1024 * 1024)
    const target = path.join(updateDir(), info.asset)
    setState({ phase: 'downloading', message: `从 ${best.probe.name} 下载…`, total: info.size, received: 0, pct: 0 })

    const ac = new AbortController()
    const res = await fetch(best.url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': 'Workbench-Updater' } })
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)
    const total = info.size || Number(res.headers.get('content-length') ?? 0) || 0
    const out = fs.createWriteStream(target)
    const reader = res.body.getReader()
    let received = 0
    const t0 = Date.now()
    let lastPush = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      out.write(Buffer.from(value))
      received += value.length
      const now = Date.now()
      if (now - lastPush > 200) {
        lastPush = now
        setState({
          phase: 'downloading',
          message: `正在下载 ${info.asset}`,
          received,
          total,
          pct: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0,
          bytesPerSec: Math.round((received * 1000) / Math.max(1, now - t0))
        })
      }
    }
    await new Promise<void>((resolve) => out.end(resolve))

    const size = fs.statSync(target).size
    if (info.size && size !== info.size) throw new Error(`文件大小不符：期望 ${info.size}，实际 ${size}`)
    if (info.sha256) {
      const digest = sha256File(target)
      if (digest.toLowerCase() !== info.sha256.toLowerCase()) throw new Error('sha256 校验失败，文件可能被篡改或下载不完整')
    }

    setState({ phase: 'ready', message: `已下载 ${info.latest}，可以重启安装`, pct: 100, received: size, total: size, canApply: true, file: target })
    return state
  } catch (err) {
    setState({ phase: 'error', message: (err as Error).message })
    return state
  }
}

/** portable 运行时真正的 exe 是 electron-builder 解压出来的临时副本，要替换原始文件 */
export function targetExecutable(): string | null {
  const portable = process.env.PORTABLE_EXECUTABLE_PATH
  if (portable && fs.existsSync(portable)) return portable
  if (app.isPackaged) return process.execPath
  return null
}

export function applyUpdate(): void {
  const target = targetExecutable()
  const file = state.file
  if (!target || !file) throw new Error('没有可安装的更新')
  const dir = updateDir()
  const bat = path.join(dir, 'apply-update.bat')
  const script = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    ':wait',
    'taskkill /f /im Workbench.exe >nul 2>&1',
    'timeout /t 1 /nobreak >nul',
    ':retry',
    `move /y "${file}" "${target}" >nul 2>&1`,
    'if errorlevel 1 (',
    '  timeout /t 1 /nobreak >nul',
    '  goto retry',
    ')',
    `start "" "${target}"`,
    'del "%~f0"'
  ].join('\r\n')
  fs.writeFileSync(bat, script, 'utf8')
  setState({ phase: 'applying', message: '正在替换程序并重启…' })
  const child = spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  setTimeout(() => app.exit(0), 200)
}
