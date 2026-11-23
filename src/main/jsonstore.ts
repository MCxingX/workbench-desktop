import fs from 'node:fs'
import path from 'node:path'

/**
 * 极简 JSON 持久化：原子写（tmp → rename），用于 UI 状态这类非敏感数据。
 * 业务数据走加密 SQLite（M2），不走这里。
 */
export class JsonStore<T> {
  private cache: T | null = null

  constructor(private filePath: string, private fallback: () => T) {}

  read(): T {
    if (this.cache) return this.cache
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      this.cache = JSON.parse(raw) as T
      return this.cache
    } catch {
      this.cache = this.fallback()
      return this.cache
    }
  }

  write(value: T): void {
    this.cache = value
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = this.filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }
}
