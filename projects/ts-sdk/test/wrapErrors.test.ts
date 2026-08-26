import { describe, expect, test } from "vitest";
import { errorMap, errorTransformer, wrapErrorsInternal } from "../src/wrapErrors";

describe("errorTransformer", () => {
  test("turns a contract error code into the message it stands for", async () => {
    const error = await errorTransformer(new Error("logic eval error: assert failed; ERR:AUTH"));
    expect(error.message).toBe("Error AUTH: Unauthorized - caller must be admin");
    expect((error as any).code).toBe("ERR:AUTH");
    expect((error as any).description).toBe(errorMap["ERR:AUTH"]);
  });

  test("keeps the original message in the stack", async () => {
    const error = await errorTransformer(new Error("logic eval error: assert failed; ERR:CRD"));
    expect(error.stack).toContain("Error CRD: Insufficient credits to cover MBR increase");
    expect(error.stack).toContain("logic eval error: assert failed; ERR:CRD");
  });

  test("names a code the contract has since grown but the SDK has not", async () => {
    const error = await errorTransformer(new Error("ERR:NEW"));
    expect(error.message).toBe("Error NEW: Unknown error");
    expect((error as any).code).toBe("ERR:NEW");
  });

  test("leaves an error carrying no code alone", async () => {
    const original = new Error("overspend");
    const error = await errorTransformer(original);
    expect(error).toBe(original);
    expect(error.message).toBe("overspend");
    expect((error as any).code).toBeUndefined();
  });
});

describe("wrapErrorsInternal", () => {
  test("passes a resolved value through, promise or thunk", async () => {
    await expect(wrapErrorsInternal(Promise.resolve("tx-id"))).resolves.toBe("tx-id");
    await expect(wrapErrorsInternal(async () => "tx-id")).resolves.toBe("tx-id");
  });

  test("transforms what a rejection carries", async () => {
    await expect(wrapErrorsInternal(Promise.reject(new Error("ERR:404")))).rejects.toThrow(
      "Error 404: App escrow is not registered in the contract",
    );
    await expect(
      wrapErrorsInternal(async () => {
        throw new Error("ERR:AMT");
      }),
    ).rejects.toThrow("Error AMT: Amount must be greater than zero");
  });
});
