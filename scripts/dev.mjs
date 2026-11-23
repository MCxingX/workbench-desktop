import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5273
const DEV_URL = `http://localhost:${PORT}`

const waitPort = (port, timeoutMs = 30_000) =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const sock = net.connect({ port, host: '127.0.0.1' })
      sock.once('connect', () => {
        sock.destroy()
        resolve(true)
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() - started > timeoutMs) reject(new Error('vite 未就绪'))
        else setTimeout(tick, 300)
      })
    }
    tick()
  })

const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

let electron
const shutdown = () => {
  electron?.kill()
  vite.kill()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

try {
  await waitPort(PORT)
} catch (e) {
  console.error('[dev] ' + e.message)
  shutdown()
}

// 开发时先用 tsc 产出 main/preload
const tsc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', 'tsconfig.node.json'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
await new Promise((r) => tsc.on('exit', r))

const electronEnv = { ...process.env, WB_DEV_URL: DEV_URL }
delete electronEnv.ELECTRON_RUN_AS_NODE

electron = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: electronEnv
})
electron.on('exit', shutdown)
