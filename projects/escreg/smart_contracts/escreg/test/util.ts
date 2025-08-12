export function range(start: number, end: number): number[] {
  return new Array(end - start + 1).fill(1).map((_, i) => start + i)
}
