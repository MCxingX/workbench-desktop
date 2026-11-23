/**
 * 版本比较（语义化，够用版）。
 * 更新器的成败全押在这一个判断上：判错就会漏更新，或者把旧包当新包让人装回退。
 */
export function compareVersion(a: string, b: string): number {
  const norm = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((x) => Number.parseInt(x.replace(/\D/g, ''), 10) || 0)
  const pa = norm(a)
  const pb = norm(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}
