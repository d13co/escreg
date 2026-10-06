import { Algodv2, generateAccount, getApplicationAddress, makeBasicAccountTransactionSigner, waitForConfirmation } from "algosdk";
import { describe, expect, test, vi } from "vitest";
import { EscregSDK } from "../src/full";

vi.mock("algosdk", async (importOriginal) => ({ ...(await importOriginal<typeof import("algosdk")>()), waitForConfirmation: vi.fn() }));
vi.mock("../src/fullUtil", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fullUtil")>()),
  getIncreaseBudgetBuilder: vi.fn(async () => undefined),
}));

/** Suggested params good enough to build and encode a transaction from. */
const suggestedParams = {
  minFee: 1000n,
  fee: 0n,
  firstValid: 1n,
  lastValid: 1001n,
  genesisID: "testnet-v1.0",
  genesisHash: new Uint8Array(32),
};

/** An SDK whose algod takes every send, and the spy on those sends. */
const setup = () => {
  const sendRawTransaction = vi.fn(() => ({ do: async () => ({ txid: "" }) }));
  const algod = { getTransactionParams: () => ({ do: async () => suggestedParams }), sendRawTransaction } as unknown as Algodv2;
  const account = generateAccount();
  const sdk = new EscregSDK({ algod, appId: 1234n, writerAccount: { addr: account.addr, signer: makeBasicAccountTransactionSigner(account) } });
  return { sdk, sendRawTransaction };
};

const appIds = (count: number): bigint[] => Array.from({ length: count }, (_, i) => BigInt(1001 + i));

describe("register", () => {
  test("sends the next group without waiting for the previous one to confirm", async () => {
    const { sdk, sendRawTransaction } = setup();

    // confirmations stay pending until the test lets them through
    let confirm!: () => void;
    const confirmed = new Promise<void>((resolve) => (confirm = resolve));
    vi.mocked(waitForConfirmation).mockImplementation(() => confirmed.then(() => ({}) as never));

    // 105 app IDs per group, so two groups
    let settled = false;
    const registering = sdk.register({ appIds: appIds(106), skipCheck: true }).finally(() => (settled = true));

    await vi.waitFor(() => expect(sendRawTransaction).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(settled).toBe(false);

    confirm();
    // 15 calls of 7 app IDs, then one call for the last
    expect(await registering).toHaveLength(16);
  });

  test("re-sends a group whose confirmation failed", async () => {
    const { sdk, sendRawTransaction } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const lookup = vi.spyOn(sdk, "lookup").mockResolvedValue({});
    vi.mocked(waitForConfirmation).mockRejectedValueOnce(new Error("poll failed")).mockResolvedValue({} as never);

    expect(await sdk.register({ appIds: appIds(7), skipCheck: true })).toHaveLength(2);
    expect(sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test("does not re-send a group that landed despite a failed confirmation poll", async () => {
    const { sdk, sendRawTransaction } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids = appIds(7);
    vi.spyOn(sdk, "lookup").mockResolvedValue(Object.fromEntries(ids.map((id) => [getApplicationAddress(id).toString(), id])));
    vi.mocked(waitForConfirmation).mockRejectedValueOnce(new Error("poll failed")).mockResolvedValue({} as never);

    expect(await sdk.register({ appIds: ids, skipCheck: true })).toHaveLength(1);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  test("lets groups already sent settle when a later one fails to build", async () => {
    const { sdk, sendRawTransaction } = setup();
    let confirm!: () => void;
    const confirmed = new Promise<void>((resolve) => (confirm = resolve));
    vi.mocked(waitForConfirmation).mockImplementation(() => confirmed.then(() => ({}) as never));

    // the second group's simulate blows up after the first group went out
    const { getIncreaseBudgetBuilder } = await import("../src/fullUtil");
    vi.mocked(getIncreaseBudgetBuilder).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("simulate failed"));

    let settled = false;
    const registering = sdk.register({ appIds: appIds(106), skipCheck: true }).finally(() => (settled = true));
    await vi.waitFor(() => expect(sendRawTransaction).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    confirm();
    await expect(registering).rejects.toThrow("simulate failed");
  });
});
