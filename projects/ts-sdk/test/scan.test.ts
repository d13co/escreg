import { Address, Algodv2, encodeAddress } from "algosdk";
import { describe, expect, test } from "vitest";
import { boxCursor } from "../src/util";
import { EscregSDK } from "../src/full";

/** A registry bucket box: a bare 4-byte key naming packed app IDs. */
const bucketBox = (key: number[], appIds: bigint[]) => {
  const value = new Uint8Array(appIds.length * 8);
  const view = new DataView(value.buffer);
  appIds.forEach((appId, i) => view.setBigUint64(i * 8, appId));
  return { name: new Uint8Array(key), value };
};

/** A user credit box: 'c' + the account's public key, holding a microAlgo balance. */
const creditBox = (address: string, credits: bigint) => {
  const name = new Uint8Array([0x63, ...Address.fromString(address).publicKey]);
  const value = new Uint8Array(8);
  new DataView(value.buffer).setBigUint64(0, credits);
  return { name, value };
};

const account = (i: number): string => {
  const publicKey = new Uint8Array(32).fill(i);
  return encodeAddress(publicKey);
};

interface Listing {
  boxes: { name: Uint8Array; value?: Uint8Array }[];
  nextToken?: string;
  round?: number;
}

/**
 * An algod serving a canned box listing, one response per page requested.
 *
 * @param pages - Listing responses, in the order the pages are asked for.
 * @param stored - Box values the node will only hand over one box at a time, as an older node does.
 */
function fakeAlgod(pages: Listing[], stored: { name: Uint8Array; value: Uint8Array }[] = []) {
  const listings: { limit?: number; include?: string; next?: string }[] = [];
  const valueReads: Uint8Array[] = [];
  const boxes = new Map<string, Uint8Array | undefined>([
    ...pages.flatMap((page) => page.boxes.map((box) => [String(box.name), box.value] as const)),
    ...stored.map((box) => [String(box.name), box.value] as const),
  ]);

  const algod = {
    getApplicationBoxes: (_appId: number) => {
      const call: { limit?: number; include?: string; next?: string } = {};
      listings.push(call);
      const request = {
        limit: (limit: number) => ((call.limit = limit), request),
        include: (include: string) => ((call.include = include), request),
        next: (next: string) => ((call.next = next), request),
        do: async () => pages[listings.length - 1] ?? { boxes: [] },
      };
      return request;
    },
    getApplicationBoxByName: (_appId: number, name: Uint8Array) => ({
      do: async () => {
        valueReads.push(name);
        const value = boxes.get(String(name));
        if (!value) throw new Error("box not found");
        return { name, value };
      },
    }),
  };

  return { algod: algod as unknown as Algodv2, listings, valueReads };
}

const sdkOver = (pages: Listing[], stored?: { name: Uint8Array; value: Uint8Array }[]) => {
  const node = fakeAlgod(pages, stored);
  return { ...node, sdk: new EscregSDK({ algod: node.algod, appId: 1234n }) };
};

describe("scanBucketPages", () => {
  test("yields a page of decoded buckets with the cursor to resume after it", async () => {
    const { sdk, listings } = sdkOver([
      { boxes: [bucketBox([1, 2, 3, 4], [1002n, 1003n])], nextToken: "b64:AQIDBA==", round: 500 },
      { boxes: [bucketBox([5, 6, 7, 8], [1004n])] },
    ]);

    const pages = [];
    for await (const page of sdk.scanBucketPages({ pageSize: 1 })) pages.push(page);

    expect(pages).toEqual([
      { buckets: [{ key: new Uint8Array([1, 2, 3, 4]), size: 16, appIds: [1002n, 1003n] }], next: "b64:AQIDBA==", round: 500 },
      { buckets: [{ key: new Uint8Array([5, 6, 7, 8]), size: 8, appIds: [1004n] }], next: undefined, round: undefined },
    ]);
    expect(listings).toEqual([
      { limit: 1, include: "values" },
      { limit: 1, include: "values", next: "b64:AQIDBA==" },
    ]);
  });

  test("leaves credit boxes out of the buckets", async () => {
    const { sdk } = sdkOver([{ boxes: [creditBox(account(1), 500_000n), bucketBox([1, 2, 3, 4], [1002n])] }]);

    const [page] = await Array.fromAsync(sdk.scanBucketPages());

    expect(page.buckets).toEqual([{ key: new Uint8Array([1, 2, 3, 4]), size: 8, appIds: [1002n] }]);
  });

  test("fetches values itself against a node that lists names alone", async () => {
    const { name, value } = bucketBox([1, 2, 3, 4], [1002n]);
    // a node predating the paginated listing returns box names and ignores the values parameter
    const { sdk, valueReads } = sdkOver([{ boxes: [{ name }] }], [{ name, value }]);

    const [page] = await Array.fromAsync(sdk.scanBucketPages());

    expect(page.buckets).toEqual([{ key: name, size: 8, appIds: [1002n] }]);
    expect(valueReads).toEqual([name]);
  });

  test("refuses a resumed scan the node answered from the top", async () => {
    const first = new Uint8Array([1, 2, 3, 4]);
    const { sdk } = sdkOver([{ boxes: [bucketBox([...first], [1002n]), bucketBox([5, 6, 7, 8], [1003n])] }]);

    await expect(Array.fromAsync(sdk.scanBucketPages({ next: boxCursor(first) }))).rejects.toThrow(
      /ignored the box listing cursor/,
    );
  });

  test("takes the same listing from the top, where there is nothing to skip past", async () => {
    const { sdk } = sdkOver([{ boxes: [bucketBox([1, 2, 3, 4], [1002n])] }]);

    await expect(Array.fromAsync(sdk.scanBucketPages())).resolves.toHaveLength(1);
  });

  test("resumes when the node did skip past the cursor", async () => {
    const { sdk } = sdkOver([{ boxes: [bucketBox([5, 6, 7, 8], [1003n])] }]);

    const [page] = await Array.fromAsync(sdk.scanBucketPages({ next: boxCursor(new Uint8Array([1, 2, 3, 4])) }));

    expect(page.buckets).toEqual([{ key: new Uint8Array([5, 6, 7, 8]), size: 8, appIds: [1003n] }]);
  });

  test("refuses a box that is not a packed bucket", async () => {
    const { sdk } = sdkOver([{ boxes: [{ name: new Uint8Array([0x7c, 0x3d, 0xeb, 0x01]), value: new Uint8Array(12) }] }]);

    await expect(Array.fromAsync(sdk.scanBucketPages())).rejects.toThrow(
      "Malformed registry box 0x7c3deb01: 12 bytes is not a packed bucket",
    );
  });

  test("stops on a page that carries no cursor", async () => {
    const { sdk, listings } = sdkOver([{ boxes: [bucketBox([1, 2, 3, 4], [1002n])] }, { boxes: [bucketBox([5, 6, 7, 8], [1003n])] }]);

    await Array.fromAsync(sdk.scanBucketPages());

    expect(listings).toHaveLength(1);
  });
});

describe("scanBuckets", () => {
  test("streams every bucket across pages, page boundaries left behind", async () => {
    const { sdk } = sdkOver([
      { boxes: [bucketBox([1, 2, 3, 4], [1002n]), creditBox(account(1), 1n)], nextToken: "b64:AQIDBA==" },
      { boxes: [bucketBox([5, 6, 7, 8], [1003n, 1004n])] },
    ]);

    const buckets = await Array.fromAsync(sdk.scanBuckets());

    expect(buckets).toEqual([
      { key: new Uint8Array([1, 2, 3, 4]), size: 8, appIds: [1002n] },
      { key: new Uint8Array([5, 6, 7, 8]), size: 16, appIds: [1003n, 1004n] },
    ]);
  });
});

describe("getCredits", () => {
  test("reads the credit box of each address asked for", async () => {
    const { sdk } = sdkOver([{ boxes: [creditBox(account(1), 481_100n), creditBox(account(2), 1n)] }]);

    expect(await sdk.getCredits({ addresses: [account(1), account(2)] })).toEqual({
      [account(1)]: 481_100n,
      [account(2)]: 1n,
    });
  });

  test("leaves out an address that has no credit box", async () => {
    const { sdk } = sdkOver([{ boxes: [creditBox(account(1), 481_100n)] }]);

    expect(await sdk.getCredits({ addresses: [account(1), account(2)] })).toEqual({ [account(1)]: 481_100n });
  });

  test("finds every credit box in the registry, buckets left out", async () => {
    const { sdk } = sdkOver([{ boxes: [bucketBox([1, 2, 3, 4], [1002n]), creditBox(account(3), 900n)] }]);

    expect(await sdk.getCredits({ all: true })).toEqual({ [account(3)]: 900n });
  });

  test("needs to be told what to read", async () => {
    const { sdk } = sdkOver([{ boxes: [] }]);

    await expect(sdk.getCredits({})).rejects.toThrow(/Either 'addresses' or 'all' must be provided/);
    await expect(sdk.getCredits({ addresses: [] })).rejects.toThrow(/Either 'addresses' or 'all' must be provided/);
  });
});
