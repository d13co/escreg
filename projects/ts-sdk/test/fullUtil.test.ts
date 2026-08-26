import { describe, expect, test } from "vitest";
import { bytesPerBoxRef, creditBoxRef, maxBoxRefsPerTxn, packBoxKeyBatches } from "../src/fullUtil";
import { SizedBoxKey } from "../src/types";

const key = (n: number): Uint8Array => new Uint8Array([0x7c, 0x3d, 0xeb, n]);
const sized = (sizes: number[]): SizedBoxKey[] => sizes.map((size, i) => ({ key: key(i), size }));

describe("creditBoxRef", () => {
  test("prefixes the public key with the credit box's 'c'", () => {
    const publicKey = new Uint8Array(32).fill(7);
    const ref = creditBoxRef(publicKey);
    expect(ref).toHaveLength(33);
    expect(ref[0]).toBe(0x63);
    expect(ref.subarray(1)).toEqual(publicKey);
  });
});

describe("packBoxKeyBatches", () => {
  test("packs nothing into nothing", () => {
    expect(packBoxKeyBatches([])).toEqual([]);
  });

  test("needs no padding while the keys cover their own budget", () => {
    const batches = packBoxKeyBatches(sized([8, 16, 24]));
    expect(batches).toHaveLength(1);
    expect(batches[0].keys).toHaveLength(3);
    expect(batches[0].padding).toBe(0);
  });

  test("caps a batch at the references a transaction carries", () => {
    const batches = packBoxKeyBatches(sized(Array.from({ length: maxBoxRefsPerTxn + 1 }, () => 8)));
    expect(batches.map((b) => b.keys.length)).toEqual([maxBoxRefsPerTxn, 1]);
  });

  test("pads out the budget a batch's bytes need beyond its keys", () => {
    // 2048 + 1024 bytes over two keys is three references' worth of budget, so one is padding
    const batches = packBoxKeyBatches(sized([2 * bytesPerBoxRef, bytesPerBoxRef]));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ padding: 1 });
    expect(batches[0].keys).toHaveLength(2);
  });

  test("fills a whole transaction's budget with one box and its padding", () => {
    const batches = packBoxKeyBatches(sized([maxBoxRefsPerTxn * bytesPerBoxRef]));
    expect(batches).toEqual([{ keys: [key(0)], padding: maxBoxRefsPerTxn - 1 }]);
  });

  test("starts a new batch rather than overrunning the byte budget", () => {
    const batches = packBoxKeyBatches(sized([5 * bytesPerBoxRef, 4 * bytesPerBoxRef]));
    expect(batches.map((b) => b.keys.length)).toEqual([1, 1]);
    expect(batches.map((b) => b.padding)).toEqual([4, 3]);
  });

  test("keeps the keys in the order they were given", () => {
    const batches = packBoxKeyBatches(sized(Array.from({ length: 10 }, () => 8)));
    expect(batches.flatMap((b) => b.keys)).toEqual(Array.from({ length: 10 }, (_, i) => key(i)));
  });

  test("refuses a box no single transaction could reference", () => {
    expect(() => packBoxKeyBatches(sized([maxBoxRefsPerTxn * bytesPerBoxRef + 1]))).toThrow(/more box references than a transaction can carry/);
  });
});
