import { ABIType, Address, Algodv2 } from "algosdk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_APP_ID, DEFAULT_READER_ACCOUNT, MAX_BOXES_PER_GROUP_NAMED } from "../src/constants";
import { EscregSDK } from "../src/index";

const uint64Array = ABIType.from("uint64[]");
const addressArray = ABIType.from("address[]");

/** Suggested params good enough to build and encode a transaction from. */
const suggestedParams = {
  minFee: 1000n,
  fee: 0n,
  firstValid: 1n,
  lastValid: 1001n,
  genesisID: "testnet-v1.0",
  genesisHash: new Uint8Array(32),
};

/** Address number `i`, with a bucket prefix of its own so every address costs a box reference. */
const address = (i: number): string => {
  const publicKey = new Uint8Array(32);
  new DataView(publicKey.buffer).setUint32(0, i);
  return new Address(publicKey).toString();
};

/** App ID the fake registry holds for address number `i`. */
const appId = (i: number): bigint => BigInt(1000 + i);

const addresses = (count: number): string[] => Array.from({ length: count }, (_, i) => address(i));

/** The number `address` put in the public key, so the fake registry can answer wherever an address turns up. */
const addressIndex = (a: string): number => {
  const publicKey = Address.fromString(a).publicKey;
  return new DataView(publicKey.buffer, publicKey.byteOffset).getUint32(0);
};

/** What the fake registry holds every address in `addresses` as. */
const expected = (count: number): Record<string, bigint> => Object.fromEntries(addresses(count).map((a, i) => [a, appId(i)]));

/** The `address[]` argument of each app call in a simulate request, in group order. */
const groupCalls = (request: any): string[][] =>
  // a copy rather than the msgpack decoder's view: the ABI decoder reads from byte 0 of the buffer
  request.txnGroups[0].txns.map(({ txn }: any) => addressArray.decode(new Uint8Array(txn.applicationCall.appArgs[1])) as string[]);

/** Box references the group named across its access lists. */
const groupBoxRefs = (request: any): number =>
  request.txnGroups[0].txns.reduce((sum: number, { txn }: any) => sum + (txn.applicationCall.access?.length ?? 0), 0);

interface NodeOptions {
  /** Registered addresses. Anything else resolves to 0, the way the contract answers for a miss. */
  registry?: Set<string>;
  /** Whether the node honours AVM 13 access lists, i.e. a group that names its own boxes. */
  accessLists?: boolean;
  /** Bytes of app args the node accepts per call, as a node predating AVM 13 caps them. */
  maxArgBytes?: number;
  /** Message the node reports the group as rejected with, rather than throwing. */
  failureMessage?: string;
}

/** An algod that answers `getList` calls out of an in-memory registry. */
function fakeAlgod({ registry, accessLists = true, maxArgBytes = Infinity, failureMessage }: NodeOptions = {}) {
  const requests: any[] = [];
  let paramCalls = 0;

  const algod = {
    getTransactionParams: () => ({
      do: async () => {
        paramCalls++;
        return { ...suggestedParams };
      },
    }),
    simulateTransactions: (request: any) => ({
      do: async () => {
        requests.push(request);

        if (!accessLists && !request.allowUnnamedResources) {
          throw new Error("invalid Box reference 0x00000001");
        }
        for (const { txn } of request.txnGroups[0].txns) {
          const bytes = txn.applicationCall.appArgs.reduce((sum: number, arg: Uint8Array) => sum + arg.length, 0);
          if (bytes > maxArgBytes) {
            throw new Error(`ApplicationArgs total length is too long, max len ${maxArgBytes} bytes`);
          }
        }

        return {
          txnGroups: [
            {
              failureMessage,
              txnResults: groupCalls(request).map((called) => ({
                txnResult: {
                  logs: [
                    new Uint8Array([
                      0x15,
                      0x1f,
                      0x7c,
                      0x75,
                      ...(uint64Array.encode(called.map((a) => (!registry || registry.has(a) ? appId(addressIndex(a)) : 0n))) as Uint8Array),
                    ]),
                  ],
                },
              })),
            },
          ],
        };
      },
    }),
  };

  return { algod: algod as unknown as Algodv2, requests, paramCalls: () => paramCalls };
}

afterEach(() => vi.restoreAllMocks());

describe("constructor", () => {
  test("defaults to the testnet deployment, read as the fee sink", () => {
    const sdk = new EscregSDK();
    expect(sdk.appId).toBe(DEFAULT_APP_ID);
    expect(sdk.readerAccount).toBe(DEFAULT_READER_ACCOUNT);
    expect(sdk.addressesPerGroup).toBe(MAX_BOXES_PER_GROUP_NAMED);
    expect(sdk.algod).toBeInstanceOf(Algodv2);
  });

  test("takes the algod out of a client when given one", () => {
    const { algod } = fakeAlgod();
    const sdk = new EscregSDK({ algorand: { client: { algod } }, algod: new Algodv2("", "https://example.com", 443) });
    expect(sdk.algod).toBe(algod);
  });

  test("refuses a group size no group could carry", () => {
    for (const addressesPerGroup of [0, -1, 1.5, NaN, MAX_BOXES_PER_GROUP_NAMED + 1]) {
      expect(() => new EscregSDK({ addressesPerGroup })).toThrow(/addressesPerGroup must be a whole number from 1 to 256/);
    }
  });

  test("takes a group size a group can carry", () => {
    expect(new EscregSDK({ addressesPerGroup: 1 }).addressesPerGroup).toBe(1);
    expect(new EscregSDK({ addressesPerGroup: MAX_BOXES_PER_GROUP_NAMED }).addressesPerGroup).toBe(MAX_BOXES_PER_GROUP_NAMED);
  });
});

describe("lookup", () => {
  test("resolves a group small enough to leave its boxes to the node", async () => {
    const { algod, requests } = fakeAlgod({ registry: new Set(addresses(3)) });
    const sdk = new EscregSDK({ algod, appId: 1234n });

    const result = await sdk.lookup({ addresses: addresses(3) });

    expect(result).toEqual({ [address(0)]: appId(0), [address(1)]: appId(1), [address(2)]: appId(2) });
    expect(requests).toHaveLength(1);
    expect(requests[0].allowUnnamedResources).toBe(true);
    expect(groupBoxRefs(requests[0])).toBe(0);
    expect(groupCalls(requests[0])).toHaveLength(1);
  });

  test("reports an address the registry does not hold as undefined", async () => {
    const { algod } = fakeAlgod({ registry: new Set([address(0)]) });
    const sdk = new EscregSDK({ algod });

    expect(await sdk.lookup({ addresses: addresses(2) })).toEqual({ [address(0)]: appId(0), [address(1)]: undefined });
  });

  test("names every box a group past the unnamed ceiling reads", async () => {
    const { algod, requests } = fakeAlgod();
    const sdk = new EscregSDK({ algod });

    await sdk.lookup({ addresses: addresses(256) });

    expect(requests).toHaveLength(1);
    expect(requests[0].allowUnnamedResources).toBe(false);
    // 256 addresses over 127-address calls, in a group whose other slots carry the box references
    expect(groupCalls(requests[0]).map((c) => c.length)).toEqual([127, 127, 2, ...Array(13).fill(0)]);
    expect(groupBoxRefs(requests[0])).toBe(256);
  });

  test("splits what one group cannot carry into groups it can", async () => {
    const { algod, requests } = fakeAlgod();
    const sdk = new EscregSDK({ algod });

    const result = await sdk.lookup({ addresses: addresses(300), concurrency: 2 });

    expect(result).toEqual(expected(300));
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => groupCalls(r).flat().length)).toEqual([256, 44]);
    // the leftover group is under the unnamed ceiling, so it goes back to the cheaper path
    expect(requests.map((r) => r.allowUnnamedResources)).toEqual([false, true]);
  });

  test("honours a group size the caller asked for", async () => {
    const { algod, requests } = fakeAlgod();
    const sdk = new EscregSDK({ algod, addressesPerGroup: 10 });

    await sdk.lookup({ addresses: addresses(25) });

    expect(requests.map((r) => groupCalls(r).flat().length)).toEqual([10, 10, 5]);
  });

  test("gives up access lists for good against a node that turns them down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { algod, requests } = fakeAlgod({ accessLists: false });
    const sdk = new EscregSDK({ algod });

    const result = await sdk.lookup({ addresses: addresses(256) });

    expect(result).toEqual(expected(256));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("falling back to unnamed"));
    // the rejected group, then the whole lookup again in groups the node will take
    expect(requests[0].allowUnnamedResources).toBe(false);
    expect(requests.slice(1).every((r) => r.allowUnnamedResources)).toBe(true);
    expect(requests.slice(1).map((r) => groupCalls(r).flat().length)).toEqual([127, 127, 2]);

    // and the next lookup does not try again
    requests.length = 0;
    await sdk.lookup({ addresses: addresses(256) });
    expect(requests.every((r) => r.allowUnnamedResources)).toBe(true);
  });

  test("drops to the pre-AVM-13 call size against a node that caps its app args", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { algod, requests } = fakeAlgod({ maxArgBytes: 2048 });
    const sdk = new EscregSDK({ algod, addressesPerGroup: 127 });

    const result = await sdk.lookup({ addresses: addresses(127) });

    expect(result).toEqual(expected(127));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("falling back to 63"));
    expect(sdk.addressesPerCall).toBe(63);
    // the groups that got through carry 63-address calls, the most such a node will take
    expect(requests.slice(-2).map((r) => groupCalls(r).map((c) => c.length))).toEqual([[63, 63], [1]]);
  });

  test("surfaces a group the node rejected as an error", async () => {
    const { algod } = fakeAlgod({ failureMessage: "logic eval error: assert failed" });
    const sdk = new EscregSDK({ algod });

    await expect(sdk.lookup({ addresses: addresses(1) })).rejects.toThrow("logic eval error: assert failed");
  });

  test("resolves nothing without asking the node", async () => {
    const { algod, requests } = fakeAlgod();
    const sdk = new EscregSDK({ algod });

    expect(await sdk.lookup({ addresses: [] })).toEqual({});
    expect(requests).toHaveLength(0);
  });

  test("reuses suggested params across groups and lookups", async () => {
    const { algod, paramCalls } = fakeAlgod();
    const sdk = new EscregSDK({ algod, addressesPerGroup: 10 });

    await sdk.lookup({ addresses: addresses(25) });
    await sdk.lookup({ addresses: addresses(25) });

    expect(paramCalls()).toBe(1);
  });

  test("asks for suggested params once for groups that start together", async () => {
    const { algod, paramCalls } = fakeAlgod();
    const sdk = new EscregSDK({ algod, addressesPerGroup: 10 });

    expect(await sdk.lookup({ addresses: addresses(50), concurrency: 5 })).toEqual(expected(50));

    expect(paramCalls()).toBe(1);
  });

  test("asks the node again when the shared suggested params request fails", async () => {
    const { algod, paramCalls } = fakeAlgod();
    vi.spyOn(algod, "getTransactionParams").mockImplementationOnce(() => ({ do: async () => Promise.reject(new Error("node is down")) }) as any);

    const sdk = new EscregSDK({ algod, addressesPerGroup: 10 });

    await expect(sdk.lookup({ addresses: addresses(50), concurrency: 5 })).rejects.toThrow("node is down");
    expect(await sdk.lookup({ addresses: addresses(50), concurrency: 5 })).toEqual(expected(50));

    expect(paramCalls()).toBe(1);
  });
});
