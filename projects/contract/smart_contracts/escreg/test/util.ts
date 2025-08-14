export function range(start: number, end: number): number[] {
  return new Array(end - start + 1).fill(1).map((_, i) => start + i)
}

export function brange(start: number, end: number): bigint[] {
  return new Array(end - start + 1).fill(1).map((_, i) => BigInt(start + i))
}

export function chunk<T>(array: T[], size: number): T[][] {
  if (size <= 0) throw new Error("Chunk size must be greater than 0");

  const result: T[][] = [];

  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }

  return result;
}
