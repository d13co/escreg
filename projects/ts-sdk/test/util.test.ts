import { Address } from "algosdk";
import { describe, expect, test } from "vitest";
import {
  boxCursor,
  chunk,
  compareBoxNames,
  decodeAppIds,
  decodeBoxCursor,
  decodeBucket,
  distinctBoxKeys,
  encodeAddresses,
  getListMethod,
  isArgTooLongError,
  isBoxRefError,
  mapConcurrent,
} from "../src/util";

/** An address with a chosen four-byte bucket prefix, so bucket collisions can be built on purpose. */
const addressWithPrefix = (prefix: number[], tail = 0): string => {
  const publicKey = new Uint8Array(32);
  publicKey.set(prefix);
  publicKey[31] = tail;
  return new Address(publicKey).toString();
};

/** A bucket box value: big-endian app IDs packed back to back. */
const bucketValue = (appIds: bigint[]): Uint8Array => {
  const value = new Uint8Array(appIds.length * 8);
  const view = new DataView(value.buffer);
  appIds.forEach((appId, i) => view.setBigUint64(i * 8, appId));
  return value;
};

describe("box cursors", () => {
  test("round-trips a box name", () => {
    const name = new Uint8Array([0x7c, 0x3d, 0xeb, 0x01]);
    expect(boxCursor(name)).toBe("b64:fD3rAQ==");
    expect(decodeBoxCursor(boxCursor(name))).toEqual(name);
  });

  test("decodes nothing from a cursor that is not in the b64 form", () => {
    expect(decodeBoxCursor("fD3rAQ==")).toBeUndefined();
    expect(decodeBoxCursor("")).toBeUndefined();
  });
});

describe("compareBoxNames", () => {
  test("orders byte by byte", () => {
    expect(compareBoxNames(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBeLessThan(0);
    expect(compareBoxNames(new Uint8Array([2, 0]), new Uint8Array([1, 255]))).toBeGreaterThan(0);
  });

  test("puts the shorter name first on a shared prefix", () => {
    expect(compareBoxNames(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBeLessThan(0);
  });

  test("is 0 for the same name", () => {
    expect(compareBoxNames(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(0);
  });

  test("sorts a listing the way algod orders it", () => {
    const names = [new Uint8Array([2]), new Uint8Array([1, 1]), new Uint8Array([1])];
    expect([...names].sort(compareBoxNames)).toEqual([new Uint8Array([1]), new Uint8Array([1, 1]), new Uint8Array([2])]);
  });
});

describe("decodeBucket", () => {
  test("decodes packed app IDs in order", () => {
    expect(decodeBucket(bucketValue([1002n, 16954321n]))).toEqual([1002n, 16954321n]);
  });

  test("decodes an empty bucket", () => {
    expect(decodeBucket(new Uint8Array(0))).toEqual([]);
  });

  test("reads from a view into a larger buffer, not from its start", () => {
    const backing = new Uint8Array(16);
    backing.set(bucketValue([1002n]), 8);
    expect(decodeBucket(backing.subarray(8))).toEqual([1002n]);
  });

  test("throws on a value that is not whole app IDs", () => {
    expect(() => decodeBucket(new Uint8Array(12))).toThrow(/not a multiple of 8/);
  });
});

describe("chunk", () => {
  test("splits into whole chunks and a remainder", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("returns nothing for an empty array", () => {
    expect(chunk([], 4)).toEqual([]);
  });

  test("throws on a size that would never finish", () => {
    expect(() => chunk([1], 0)).toThrow(/greater than 0/);
    expect(() => chunk([1], -1)).toThrow(/greater than 0/);
  });
});

describe("mapConcurrent", () => {
  test("returns results in input order, not completion order", async () => {
    const results = await mapConcurrent(
      [30, 20, 10],
      async (delay) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return delay;
      },
      3,
    );
    expect(results).toEqual([30, 20, 10]);
  });

  test("keeps at most `concurrency` items in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent(
      Array.from({ length: 10 }, (_, i) => i),
      async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
      },
      3,
    );
    expect(peak).toBe(3);
  });

  test("runs one at a time by default", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapConcurrent(Array.from({ length: 4 }, (_, i) => i), async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
    });
    expect(peak).toBe(1);
  });

  test("throws the first rejection and starts nothing further", async () => {
    const started: number[] = [];
    await expect(
      mapConcurrent(
        [0, 1, 2, 3, 4, 5],
        async (item) => {
          started.push(item);
          if (item === 0) throw new Error("boom");
          return item;
        },
        1,
      ),
    ).rejects.toThrow("boom");
    expect(started).toEqual([0]);
  });
});

describe("error sniffing", () => {
  test("spots an oversized app arg list", () => {
    expect(isArgTooLongError(new Error("ApplicationArgs 0 length is too long, max len 2048 bytes"))).toBe(true);
    expect(isArgTooLongError("ApplicationArgs total length is too long")).toBe(true);
    expect(isArgTooLongError(new Error("logic eval error: assert failed"))).toBe(false);
    expect(isArgTooLongError(undefined)).toBe(false);
  });

  test("spots a box the group did not carry a reference for", () => {
    expect(isBoxRefError(new Error("invalid Box reference 0x7c3deb01"))).toBe(true);
    expect(isBoxRefError(new Error("unknown field tx.Access"))).toBe(true);
    expect(isBoxRefError(new Error("logic eval error: assert failed"))).toBe(false);
    expect(isBoxRefError(undefined)).toBe(false);
  });
});

describe("getList encoding", () => {
  test("declares the signature the contract's check:abi holds it to", () => {
    expect(getListMethod.getSignature()).toBe("getList(address[])uint64[]");
    expect(getListMethod.getSelector()).toHaveLength(4);
  });

  test("round-trips app IDs through the ARC-4 return log", () => {
    const log = new Uint8Array([0x15, 0x1f, 0x7c, 0x75, 0x00, 0x02, ...new Uint8Array(8).fill(0), ...new Uint8Array(8).fill(0)]);
    new DataView(log.buffer).setBigUint64(6, 1002n);
    new DataView(log.buffer).setBigUint64(14, 0n);
    expect(decodeAppIds(log)).toEqual([1002n, 0n]);
  });

  test("decodes a log that is a view into a larger buffer", () => {
    const backing = new Uint8Array(64);
    const log = new Uint8Array([0x15, 0x1f, 0x7c, 0x75, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 3, 0xea]);
    backing.set(log, 20);
    expect(decodeAppIds(backing.subarray(20, 20 + log.length))).toEqual([1002n]);
  });

  test("refuses a log that is not an ARC-4 return", () => {
    expect(() => decodeAppIds(undefined)).toThrow(/did not return an ARC-4 value/);
    expect(() => decodeAppIds(new Uint8Array([0x15, 0x1f]))).toThrow(/did not return an ARC-4 value/);
    expect(() => decodeAppIds(new Uint8Array([1, 2, 3, 4, 0, 0]))).toThrow(/did not return an ARC-4 value/);
  });

  test("encodes an address[] arg, empty ones included", () => {
    expect(encodeAddresses([])).toEqual(new Uint8Array([0, 0]));
    expect(encodeAddresses([addressWithPrefix([1, 2, 3, 4])])).toHaveLength(2 + 32);
  });
});

describe("distinctBoxKeys", () => {
  test("takes the leading four bytes of each address", () => {
    expect(distinctBoxKeys([addressWithPrefix([0x7c, 0x3d, 0xeb, 0x01])])).toEqual([new Uint8Array([0x7c, 0x3d, 0xeb, 0x01])]);
  });

  test("counts addresses sharing a bucket once, in first-seen order", () => {
    const keys = distinctBoxKeys([
      addressWithPrefix([2, 0, 0, 0], 1),
      addressWithPrefix([1, 0, 0, 0], 2),
      addressWithPrefix([2, 0, 0, 0], 3),
    ]);
    expect(keys).toEqual([new Uint8Array([2, 0, 0, 0]), new Uint8Array([1, 0, 0, 0])]);
  });
});
