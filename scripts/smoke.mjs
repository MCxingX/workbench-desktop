import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'dist', 'node', 'main', 'index.js')
const renderer = path.join(root, 'dist', 'renderer', 'index.html')

if (!existsSync(entry) || !existsSync(renderer)) {
  console.error('[smoke] 缺少构建产物，请先 npm run build')
  process.exit(2)
}

const childEnv = { ...process.env, WB_SMOKE: '1' }
// 关键：本机环境存在 ELECTRON_RUN_AS_NODE=1，会把 electron 当 node 跑，必须清掉
delete childEnv.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, ['.', '--smoke'], {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe']
})

let out = ''
let err = ''
child.stdout.on('data', (d) => {
  out += d.toString()
  process.stdout.write(d)
})
child.stderr.on('data', (d) => {
  err += d.toString()
})

const hardTimeout = setTimeout(() => {
  console.error('[smoke] 超时 60s，强制结束')
  child.kill()
}, 60_000)

child.on('exit', (code) => {
  clearTimeout(hardTimeout)
  const line = out.split(/\r?\n/).find((l) => l.startsWith('WB_SMOKE_RESULT '))
  if (!line) {
    console.error('[smoke] 未拿到结果标记，退出码=' + code)
    if (err) console.error(err.slice(-2000))
    process.exit(1)
  }
  const result = JSON.parse(line.slice('WB_SMOKE_RESULT '.length))
  console.log('\n[smoke] 检查项：')
  for (const c of result.checks) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? '  — ' + c.detail : ''}`)
  }
  console.log(`\n[smoke] 结果：${result.ok ? 'ALL PASS' : 'FAILED'}`)
  process.exit(result.ok ? 0 : 1)
})
