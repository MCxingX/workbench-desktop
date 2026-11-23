// 生成更新清单：release/version.json
// 更新器从 raw.githubusercontent.com/<owner>/<repo>/main/release/version.json 读它，
// 因此发布流程里要把这个文件提交回 main（GitHub Actions 已经这么做）。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const releaseDir = path.join(root, 'release')

if (!fs.existsSync(releaseDir)) {
  console.error('还没有 release 目录，先跑 npm run dist')
  process.exit(1)
}

const exe = fs
  .readdirSync(releaseDir)
  .filter((f) => f.endsWith('.exe') && f.includes('portable'))
  .map((f) => ({ f, stat: fs.statSync(path.join(releaseDir, f)) }))
  .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]

if (!exe) {
  console.error('release 目录里没有 portable exe')
  process.exit(1)
}

const file = path.join(releaseDir, exe.f)
const buf = fs.readFileSync(file)
const sha256 = crypto.createHash('sha256').update(buf).digest('hex')

const notesFile = path.join(root, 'CHANGELOG.md')
let notes = ''
if (fs.existsSync(notesFile)) {
  const text = fs.readFileSync(notesFile, 'utf8')
  const firstSection = text.split(/^## /m)[1]
  if (firstSection) notes = '## ' + firstSection.trim()
}

const manifest = {
  version: pkg.version,
  asset: exe.f,
  size: buf.length,
  sha256,
  notes: notes || `Workbench ${pkg.version}`,
  publishedAt: new Date().toISOString()
}

const out = path.join(releaseDir, 'version.json')
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log('version.json 已生成：')
console.log(JSON.stringify(manifest, null, 2))
