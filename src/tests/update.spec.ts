import { describe, expect, it } from 'vitest'
import { compareVersion } from '@shared/version'

/**
 * 版本比较是更新器的唯一判断依据：判错就会漏更新，或者把旧包当成新包让人装。
 * 这里只测纯函数，不碰网络。
 */
describe('compareVersion', () => {
  it('同一版本返回 0', () => {
    expect(compareVersion('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersion('v1.2.3', '1.2.3')).toBe(0)
  })

  it('主次修订号逐段比较', () => {
    expect(compareVersion('1.0.1', '1.0.0')).toBe(1)
    expect(compareVersion('1.0.0', '1.0.1')).toBe(-1)
    expect(compareVersion('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersion('2.0.0', '1.99.99')).toBe(1)
  })

  it('位数不同时短的补 0', () => {
    expect(compareVersion('1.2', '1.2.0')).toBe(0)
    expect(compareVersion('1.2.1', '1.2')).toBe(1)
    expect(compareVersion('1.3', '1.2.9')).toBe(1)
  })

  it('带 v 前缀与脏字符也能比', () => {
    expect(compareVersion('v1.1.0', '1.0.9')).toBe(1)
    expect(compareVersion('1.0.0-beta', '1.0.0')).toBe(0)
  })
})