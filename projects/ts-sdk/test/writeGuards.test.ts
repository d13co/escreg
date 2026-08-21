import { Algodv2 } from "algosdk";
import { describe, expect, test } from "vitest";
import { EscregSDK } from "../src/full";

/** An algod that would fail loudly if a write op got as far as touching the network. */
const unusableAlgod = new Proxy({} as Algodv2, {
  get() {
    throw new Error("the network was reached");
  },
});

const sdk = new EscregSDK({ algod: unusableAlgod, appId: 1234n });
const noWriter = /Write operation requested without writer account/;

describe("write operations without a writer account", () => {
  test("register refuses before it derives an address", async () => {
    await expect(sdk.register({ appIds: [1002n] })).rejects.toThrow(noWriter);
  });

  test("deleteBoxes refuses", async () => {
    await expect(sdk.deleteBoxes({ boxKeys: [new Uint8Array([1, 2, 3, 4])] })).rejects.toThrow(noWriter);
  });

  test("depositCredit refuses", async () => {
    await expect(sdk.depositCredit({ creditor: "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE", amount: 1n })).rejects.toThrow(noWriter);
  });

  test("withdrawCredit refuses", async () => {
    await expect(sdk.withdrawCredit()).rejects.toThrow(noWriter);
  });

  test("withdraw refuses", async () => {
    await expect(sdk.withdraw({ amount: 1n })).rejects.toThrow(noWriter);
  });
});
