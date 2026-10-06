import { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { Address, encodeAddress, getApplicationAddress, waitForConfirmation } from "algosdk";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { EscregClient, EscregComposer } from "./generated/EscregGenerated.js";
import { EscregSDK as EscregLookupSDK, EscregLookupOptions } from "./index.js";
import { chunk, compareBoxNames, decodeBoxCursor, decodeBucket, mapConcurrent } from "./util.js";
import { creditBoxRef, fnetNodelyClient, getIncreaseBudgetBuilder, packBoxKeyBatches } from "./fullUtil.js";
import { errorTransformer, wrapErrorsInternal } from "./wrapErrors.js";
import { DEFAULT_VALIDITY_WINDOW, SUGGESTED_PARAMS_CACHE_MS } from "./constants.js";
import { BucketPage, CreditResult, RegistryBucket, SizedBoxKey } from "./types.js";

/**
 * The whole SDK: lookups, registration, MBR credits, the registry scan, and the admin methods.
 *
 * Everything here needs the generated client and algokit-utils, which is why it is a separate entry
 * point - `@d13co/escreg-sdk` on its own is the lookup half, and this extends it.
 */

export { boxCursor, decodeBucket } from "./util.js";
export type { AlgodProvider, BucketPage, CreditResult, LookupResult, RegistryBucket, SizedBoxKey } from "./types.js";
export type { EscregLookupOptions } from "./index.js";

/** Options the full SDK takes, on top of what a lookup-only one does. */
export interface EscregOptions extends EscregLookupOptions {
  /** Algorand client instance for interacting with the network. Defaults to the public fnet endpoint. */
  algorand?: AlgorandClient;
  /** Account with signing capability for write operations (register, deposit, withdraw). */
  writerAccount?: TransactionSignerAccount;
}

/**
 * SDK for interacting with the Escreg (Escrow Registry) smart contract.
 * Provides methods for registering app escrow accounts, looking up addresses,
 * managing MBR credits, and admin operations.
 */
export class EscregSDK extends EscregLookupSDK {
  /** Algorand client instance for interacting with the network. */
  public algorand: AlgorandClient;
  /** Escreg algokit generated client */
  public client: EscregClient;
  /** Account with signing capability for write operations (register, deposit, withdraw). */
  public writerAccount?: TransactionSignerAccount;

  /**
   * @param appId - The Escreg application ID.
   * @param algorand - AlgorandClient instance for interacting with the network.
   * @param algod - Algod client to build an `AlgorandClient` around, when one was not passed.
   * @param writerAccount - Account with signing capability for write operations (register, deposit, withdraw).
   * @param readerAccount - Address used as sender for read-only simulate calls. Defaults to a dummy address.
   * @param addressesPerGroup - Addresses `lookup` resolves per simulate group, 1 to 256. Defaults to
   *   254. Anything above 128 names the group's boxes in AVM 13 access lists, so it needs a node that
   *   supports them; drop it to 127 or below for one round trip per `getList` call.
   */
  constructor(options: EscregOptions = {}) {
    const algorand = options.algorand ?? (options.algod ? AlgorandClient.fromClients({ algod: options.algod }) : fnetNodelyClient);

    super({ ...options, algorand });

    this.algorand = algorand;
    this.writerAccount = options.writerAccount;

    this.algorand
      .setSuggestedParamsCacheTimeout(SUGGESTED_PARAMS_CACHE_MS)
      .setDefaultValidityWindow(DEFAULT_VALIDITY_WINDOW)
      .registerErrorTransformer(errorTransformer);

    this.client = new EscregClient({
      algorand: this.algorand,
      appId: this.appId,
      defaultSender: this.writerAccount ? this.writerAccount.addr.toString() : undefined,
      defaultSigner: this.writerAccount ? this.writerAccount.signer : undefined,
    });
  }

  /**
   * Register application escrow accounts in the contract. Derives app escrow addresses from the given app IDs
   * and stores them in the contract state for later lookup. Automatically batches into transaction groups
   * and increases opcode budget as needed. Failed chunks are retried automatically, re-checking the registry first.
   *
   * Unless `skipCheck` is set, existing registrations are filtered out via a lookup before registering.
   *
   * @param appIds - Array of app IDs to register.
   * @param skipCheck - Skip the pre-registration lookup check for existing entries.
   * @param debug - Enable debug logging.
   * @param concurrency - Number of transaction groups to send in parallel.
   * @returns Array of transaction IDs from the registration groups.
   * @throws If writer account is not set, or if credits are insufficient (ERR:CRD).
   */
  async register({
    appIds,
    skipCheck,
    debug,
    concurrency = 1,
    passIdx = 1,
    prevPassFails = 0,
  }: {
    appIds: bigint[];
    skipCheck?: true;
    debug?: true;
    concurrency?: number;
    passIdx?: number;
    prevPassFails?: number;
  }): Promise<string[]> {
    if (!this.writerAccount) throw new Error("Write operation requested without writer account");

    if (!skipCheck) {
      if (debug) console.time("getApplicationAddress");
      const addresses = appIds.map((appId) => getApplicationAddress(appId).toString());
      if (debug) console.timeEnd("getApplicationAddress");
      if (debug) console.time("lookup");
      const results = await this.lookup({ addresses, concurrency, debug });
      if (debug) console.timeEnd("lookup");

      const existingIndices = new Set(Object.values(results).flatMap((v, idx) => (v !== undefined ? [idx] : [])));

      if (existingIndices.size) {
        if (debug) {
          console.warn(`Found ${existingIndices.size} existing appIDs`);
        }
        appIds = appIds.filter((_, idx) => !existingIndices.has(idx));
      }
    }

    if (!appIds.length) return [];

    const perTxn = 7;
    const groupChunks = chunk(appIds, perTxn * 15);
    if (debug)
      console.debug(
        `Starting registration for ${appIds.length} appIds${skipCheck ? " with skipCheck" : ""}${perTxn ? ` and perGroup ${perTxn}` : ""}${passIdx > 1 ? ` on pass ${passIdx}` : ""}`,
      );

    if (debug) console.debug(`Doing ${appIds.length} in ${groupChunks.length} chunks with concurrency ${concurrency}`);

    const senderBoxRef = creditBoxRef(Address.fromString(this.writerAccount!.addr.toString()).publicKey);

    let thisPassFails = 0;
    let failedAppIds: bigint[] = [];
    const confirmations: Promise<void>[] = [];
    // Process chunks in parallel
    const results = await mapConcurrent(
      groupChunks,
      async (groupChunk, chunkIdx) => {
        if (debug)
          console.debug(
            `Starting chunkIdx ${chunkIdx}/${groupChunks.length} ${groupChunk.length > 1 ? groupChunk[0] + ".." + groupChunk[groupChunk.length - 1] : groupChunk[0]}`,
          );
        const appIdChunk = chunk(groupChunk, perTxn);

        // Helper to add registerList calls to a builder
        const addRegisterListCalls = (builder: EscregComposer<any>) => {
          for (const appIds of appIdChunk) {
            const boxReferences = [senderBoxRef, ...appIds.map((appId) => getApplicationAddress(appId).publicKey.slice(0, 4))];
            builder = builder.registerList({ args: { appIds }, boxReferences });
          }
          return builder;
        };

        // Build initial group
        let group = addRegisterListCalls(this.client.newGroup());

        // Check if budget increase is needed via simulation
        const increasedBuilder = await getIncreaseBudgetBuilder(
          group,
          () => this.client.newGroup(),
          this.writerAccount!.addr.toString(),
          this.writerAccount!.signer,
          this.algorand.client.algod,
        );

        // If increased budget needed, rebuild with increaseBudget prepended
        if (increasedBuilder) {
          group = addRegisterListCalls(increasedBuilder);
        }

        const composer = await group.composer();
        const { transactions } = await composer.build();
        const txns = transactions.map(({ txn }) => txn);
        const signed = await transactions[0].signer(
          txns,
          txns.map((_, i) => i),
        );
        const fail = async (e: unknown) => {
          const transformed = await errorTransformer(e as Error);
          if (debug) {
            console.error(`Chunk ${chunkIdx}/${groupChunks.length} failed with error:`, transformed);
            console.debug(`Failed chunk appIds: ${groupChunk.join(" ")}`);
          }
          thisPassFails += groupChunk.length;
          failedAppIds.push(...groupChunk);
        };

        try {
          await this.algorand.client.algod.sendRawTransaction(signed).do();
          // Confirm in the background: a group sent only after the previous one confirmed reaches the
          // pool after the next block has been assembled, leaving every other block empty.
          // ponytail: unconfirmed groups are uncapped - the budget simulate paces sends; cap them if a node pushes back
          confirmations.push(waitForConfirmation(this.algorand.client.algod, txns[0].txID(), 8).then(() => {}, fail));
        } catch (e) {
          await fail(e);
        }

        return txns.map((t) => t.txID());
      },
      concurrency,
      // a group that failed to build stops the pass, but the ones already sent still settle first
    ).finally(() => Promise.all(confirmations));

    if (thisPassFails && thisPassFails === prevPassFails) {
      // If the number of failures is the same as the previous pass, it likely means these are persistent failures
      throw new Error(`Pass ${passIdx} failed with ${thisPassFails} failures, same as previous pass. Aborting to avoid infinite retries.`);
    } else if (thisPassFails) {
      console.warn(`Pass failed with ${thisPassFails} failures. Retrying failed ones.`);
      // no skipCheck: a group whose confirmation poll failed may still have landed, and re-sending it
      // byte-identical is rejected as already in the ledger - a failure that would never clear
      const nextResults = await this.register({
        appIds: failedAppIds,
        debug,
        concurrency,
        prevPassFails: thisPassFails,
        passIdx: passIdx + 1,
      });
      results.push(nextResults);
    }

    // Flatten results
    return results.flat();
  }

  /**
   * Send one app call per batch of registry box keys, in atomic groups, waiting for each group.
   *
   * Keys are packed into batches sized to the box budget they need, then sent 15 calls per group
   * with `increaseBudget` prepended when the opcode budget needs it. A group's box budget is 1024
   * bytes per distinct reference it carries, so padding references are named per group.
   *
   * @param label - Verb for the debug lines, e.g. "Deleting".
   * @param boxes - Keys to act on, with the size of the box each names.
   * @param addCall - Adds the call for one batch of keys, with its box references, to a builder.
   * @param concurrency - Number of transaction groups to send in parallel.
   * @param debug - Enable debug logging.
   * @returns The transaction IDs sent.
   */
  private async sendBoxKeyGroups({
    label,
    boxes,
    addCall,
    concurrency = 1,
    debug,
  }: {
    label: string;
    boxes: SizedBoxKey[];
    addCall: (builder: EscregComposer<any>, keys: Uint8Array[], boxReferences: Uint8Array[]) => EscregComposer<any>;
    concurrency?: number;
    debug?: boolean;
  }): Promise<string[]> {
    const groupChunks = chunk(packBoxKeyBatches(boxes), 15);

    if (debug) console.debug(`${label} ${boxes.length} boxes in ${groupChunks.length} groups with concurrency ${concurrency}`);

    const results = await mapConcurrent(
      groupChunks,
      async (batches, chunkIdx) => {
        if (debug) console.debug(`Starting group ${chunkIdx + 1}/${groupChunks.length} (${batches.length} calls)`);

        const addCalls = (builder: EscregComposer<any>) => {
          // padding names are unique within the group: only distinct references add to its budget,
          // and a one-byte name can never collide with a 4-byte bucket key
          let padName = 0;
          for (const { keys, padding } of batches) {
            const boxReferences = [...keys, ...Array.from({ length: padding }, () => new Uint8Array([padName++]))];
            builder = addCall(builder, keys, boxReferences);
          }
          return builder;
        };

        let group = addCalls(this.client.newGroup());

        const increasedBuilder = await getIncreaseBudgetBuilder(
          group,
          () => this.client.newGroup(),
          this.writerAccount!.addr.toString(),
          this.writerAccount!.signer,
          this.algorand.client.algod,
        );

        if (increasedBuilder) {
          group = addCalls(increasedBuilder);
        }

        const composer = await group.composer();
        const { transactions } = await composer.build();
        const txns = transactions.map(({ txn }) => txn);
        const signed = await transactions[0].signer(
          txns,
          txns.map((_, i) => i),
        );

        await this.algorand.client.algod.sendRawTransaction(signed).do();
        await waitForConfirmation(this.algorand.client.algod, txns[0].txID(), 8);

        return txns.map((t) => t.txID());
      },
      concurrency,
    );

    return results.flat();
  }

  /**
   * Delete app registry boxes by their 4-byte keys. Admin only.
   *
   * @param boxKeys - Array of 4-byte box keys to delete.
   * @param debug - Enable debug logging.
   * @param concurrency - Number of transaction groups to send in parallel.
   * @returns Array of transaction IDs.
   * @throws If writer account is not set, or if sender is not the admin (ERR:AUTH).
   */
  async deleteBoxes({
    boxKeys,
    debug,
    concurrency = 1,
  }: {
    boxKeys: Uint8Array[];
    debug?: boolean;
    concurrency?: number;
  }): Promise<string[]> {
    return wrapErrorsInternal(async () => {
      if (!this.writerAccount) throw new Error("Write operation requested without writer account");

      if (!boxKeys.length) return [];

      // box sizes are not known here, so this keeps to one reference per key: 8 keys per transaction
      return await this.sendBoxKeyGroups({
        label: "Deleting",
        boxes: boxKeys.map((key) => ({ key, size: 0 })),
        addCall: (builder, keys, boxReferences) => builder.deleteBoxes({ args: { boxKeys: keys }, boxReferences }),
        concurrency,
        debug,
      });
    });
  }

  /** Decode a raw registry box into a bucket. */
  private toBucket(key: Uint8Array, value: Uint8Array): RegistryBucket {
    // buckets are packed 8-byte app IDs with no header; any other length would decode shifted
    if (value.length % 8 !== 0) {
      const name = Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join("");
      throw new Error(`Malformed registry box 0x${name}: ${value.length} bytes is not a packed bucket`);
    }

    return {
      key,
      size: value.length,
      appIds: decodeBucket(value),
    };
  }

  /**
   * Stream the registry's bucket boxes from algod, a page at a time.
   *
   * Boxes are listed with their values, so a page costs one request no matter how many boxes it
   * holds. Nodes older than the paginated listing ignore the pagination and value parameters and
   * answer with every box name in one response, which this falls back to fetching values for with
   * bounded concurrency; that path still hits "Result limit exceeded" past the node's
   * `MaxAPIBoxPerApplication`, so a large registry needs a node that pages.
   *
   * Each page carries the cursor to resume after it, so an interrupted scan can pick up where it
   * stopped by passing that cursor back as `next`. `boxCursor` builds the same cursor from the name
   * of the last box a caller finished with, for resuming mid-page. A resumed scan lists at the
   * current round, so boxes written behind the cursor while it was stopped are not picked up. A node
   * that ignores the pagination would answer a resumed scan with the listing from the top, which
   * this rejects rather than handing back boxes the caller has already seen.
   *
   * @param pageSize - Boxes to request per page.
   * @param next - Cursor to resume the listing after, from an earlier page or `boxCursor`.
   * @param concurrency - Box value fetches to run in parallel, when the node does not return values.
   * @param debug - Enable debug logging.
   * @returns An async iterable of pages of decoded buckets.
   */
  async *scanBucketPages({
    pageSize = 1000,
    next,
    concurrency = 8,
    debug,
  }: {
    pageSize?: number;
    next?: string;
    concurrency?: number;
    debug?: boolean;
  } = {}): AsyncGenerator<BucketPage> {
    const appId = Number(this.appId);
    const algod = this.algorand.client.algod;
    let cursor = next;
    // the box the caller asked to resume after, to check the node actually skipped past it
    const resumeAfter = next ? decodeBoxCursor(next) : undefined;

    for (let page = 1; ; page++) {
      let request = algod.getApplicationBoxes(appId).limit(pageSize).include("values");
      if (cursor) request = request.next(cursor);

      const { boxes, nextToken, round } = await request.do();

      // a node predating the paginated listing ignores the cursor and answers from the first box,
      // which would silently hand back everything the caller has already processed
      if (page === 1 && resumeAfter && boxes.some(({ name }) => compareBoxNames(name, resumeAfter) <= 0)) {
        throw new Error(`Node ignored the box listing cursor ${next}, so this scan cannot be resumed on it. Resuming needs go-algorand 4.7 or newer.`);
      }

      // registry buckets are keyed by a bare 4-byte address prefix; credit boxes are 'c' + 32 bytes
      const descriptors = boxes.filter((box) => box.name.length === 4);

      if (debug && descriptors.some(({ value }) => value === undefined)) {
        console.debug(`Node returned box names without values, fetching values with concurrency ${concurrency}`);
      }

      const buckets = await mapConcurrent(
        descriptors,
        async ({ name, value }) => this.toBucket(name, value ?? (await algod.getApplicationBoxByName(appId, name).do()).value),
        concurrency,
      );

      if (debug) console.debug(`Listed page ${page}${round ? ` at round ${round}` : ""}: ${boxes.length} boxes, ${buckets.length} of them buckets`);

      yield { buckets, next: nextToken, round };

      if (!nextToken || !boxes.length) return;
      cursor = nextToken;
    }
  }

  /**
   * Stream every registry bucket box with its decoded contents.
   *
   * Yields buckets in listing order as pages arrive, so a caller can print or process each one
   * without holding the whole registry in memory. Credit boxes are skipped. Use `scanBucketPages`
   * instead to see page boundaries, which is what resuming a scan needs.
   *
   * @param pageSize - Boxes to request per listing page.
   * @param next - Cursor to resume the listing after.
   * @param concurrency - Box value fetches to run in parallel, when the node does not return values.
   * @param debug - Enable debug logging.
   * @returns An async iterable of decoded buckets.
   */
  async *scanBuckets(options: { pageSize?: number; next?: string; concurrency?: number; debug?: boolean } = {}): AsyncGenerator<RegistryBucket> {
    for await (const { buckets } of this.scanBucketPages(options)) yield* buckets;
  }

  /**
   * Deposit MBR credits for an account. Sends a payment to the contract and credits the specified account.
   * Credits are used to cover box MBR costs when registering app IDs.
   *
   * @param creditor - Address of the account to credit.
   * @param amount - Amount of microAlgos to deposit as credits.
   * @param debug - Enable debug logging.
   * @returns Transaction ID of the deposit.
   * @throws If writer account is not set, or if the payment amount is 0 (ERR:AMT).
   */
  async depositCredit({ creditor, amount, debug }: { creditor: string; amount: bigint; debug?: boolean }): Promise<string> {
    return wrapErrorsInternal(async () => {
      if (!this.writerAccount) throw new Error("Write operation requested without writer account");

      if (debug) {
        console.debug(`Depositing ${amount.toString()} microAlgos for ${creditor}`);
      }

      const appAddress = getApplicationAddress(this.appId).toString();
      const payTxn = await this.algorand.createTransaction.payment({
        sender: this.writerAccount.addr.toString(),
        receiver: appAddress,
        amount: amount.microAlgo(),
      });

      const boxRef = creditBoxRef(Address.fromString(creditor).publicKey);

      const { confirmation } = await this.client.send.depositCredits({
        args: { creditor, txn: payTxn },
        boxReferences: [boxRef],
        sender: this.writerAccount.addr.toString(),
        signer: this.writerAccount.signer,
      });

      if (debug) {
        console.debug(`Deposit successful. Transaction ID: ${confirmation.txn.txn.txID()}`);
      }

      return confirmation.txn.txn.txID();
    });
  }

  /**
   * Withdraw all remaining MBR credits for the sender. Deletes the user credit box,
   * so all credits are withdrawn including the MBR locked for the credit box itself.
   *
   * @param debug - Enable debug logging.
   * @returns Transaction ID of the withdrawal.
   * @throws If writer account is not set, or if sender has no credit box (ERR:AMT).
   */
  async withdrawCredit({ debug }: { debug?: boolean } = {}): Promise<string> {
    return wrapErrorsInternal(async () => {
      if (!this.writerAccount) throw new Error("Write operation requested without writer account");

      const sender = this.writerAccount.addr.toString();
      const boxRef = creditBoxRef(Address.fromString(sender).publicKey);

      if (debug) {
        console.debug(`Withdrawing all credits for ${sender}`);
      }

      const { confirmation } = await this.client.send.withdrawCredits({
        args: {},
        boxReferences: [boxRef],
        extraFee: (1000).microAlgo(),
        sender,
        signer: this.writerAccount.signer,
      });

      if (debug) {
        console.debug(`Credit withdrawal successful. Transaction ID: ${confirmation.txn.txn.txID()}`);
      }

      return confirmation.txn.txn.txID();
    });
  }

  /**
   * Check MBR credit balances. Either provide specific addresses to check,
   * or set `all` to true to retrieve all accounts with credit boxes.
   *
   * @param addresses - Array of Algorand addresses to check credits for.
   * @param all - If true, retrieve credits for all accounts with credit boxes.
   * @param debug - Enable debug logging.
   * @returns Map of address to credit balance in microAlgos.
   */
  async getCredits({
    addresses,
    all,
    debug,
  }: {
    addresses?: string[];
    all?: boolean;
    debug?: boolean;
  }): Promise<CreditResult> {
    const appId = Number(this.appId);
    const algod = this.algorand.client.algod;
    const result: CreditResult = {};

    let boxNames: Uint8Array[];

    if (all) {
      const { boxes } = await algod.getApplicationBoxes(appId).do();
      // Credit boxes: 'c' prefix (0x63) + 32-byte public key = 33 bytes
      boxNames = boxes
        .filter((b: { name: Uint8Array }) => b.name.length === 33 && b.name[0] === 0x63)
        .map((b: { name: Uint8Array }) => b.name);
      if (debug) console.debug(`Found ${boxNames.length} credit boxes`);
    } else if (addresses?.length) {
      boxNames = addresses.map((addr) => creditBoxRef(Address.fromString(addr).publicKey));
    } else {
      throw new Error("Either 'addresses' or 'all' must be provided");
    }

    for (const boxName of boxNames) {
      const publicKey = boxName.slice(1);
      const address = encodeAddress(publicKey);
      try {
        const { value } = await algod.getApplicationBoxByName(appId, boxName).do();
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
        result[address] = view.getBigUint64(0);
      } catch (e: any) {
        if (debug) console.debug(`No credit box found for ${address}`);
      }
    }

    return result;
  }

  /**
   * Withdraw funds from the contract to the admin. Admin only.
   *
   * @param amount - Amount of microAlgos to withdraw.
   * @param debug - Enable debug logging.
   * @returns Transaction ID of the withdrawal.
   * @throws If writer account is not set, or if sender is not the admin (ERR:AUTH).
   */
  async withdraw({ amount, debug }: { amount: bigint; debug?: boolean }): Promise<string> {
    return wrapErrorsInternal(async () => {
      if (!this.writerAccount) throw new Error("Write operation requested without writer account");

      if (debug) {
        console.debug(`Withdrawing ${amount.toString()} microAlgos from contract ${this.appId}`);
      }

      const { confirmation } = await this.client.send.withdraw({
        args: { amount },
        sender: this.writerAccount.addr.toString(),
        signer: this.writerAccount.signer,
        extraFee: (1000).microAlgo(),
      });

      if (debug) {
        console.debug(`Withdrawal successful. Transaction ID: ${confirmation.txn.txn.txID()}`);
      }

      return confirmation.txn.txn.txID();
    });
  }

  // this requires full client, we are now using minimal client for bundle size reasons
  //
  // async destroyApp({
  //   debug,
  //   concurrency = 1,
  // }: {
  //   debug?: boolean;
  //   concurrency?: number;
  // } = {}): Promise<void> {
  //   return wrapErrorsInternal(async () => {
  //     if (!this.writerAccount) throw new Error("Write operation requested without writer account");

  //     const appId = Number(this.appId);
  //     const escrowAddress = getApplicationAddress(this.appId).toString();

  //     // 1. Get all box keys and delete them
  //     const { boxes } = await this.algorand.client.algod.getApplicationBoxes(appId).do();
  //     if (debug) console.debug(`Found ${boxes.length} boxes to delete`);

  //     if (boxes.length) {
  //       const boxKeys = boxes.map((b: { name: Uint8Array }) => b.name);
  //       await this.deleteBoxes({ boxKeys, debug, concurrency });
  //       if (debug) console.debug("All boxes deleted");
  //     }

  //     // 2. Withdraw all funds above the minimum balance
  //     let accountInfo = await this.algorand.client.algod.accountInformation(escrowAddress).do();
  //     let balance = BigInt(accountInfo.amount);
  //     let minBalance = BigInt(accountInfo.minBalance);
  //     let withdrawable = balance - minBalance;

  //     if (withdrawable > 0n) {
  //       await this.withdraw({ amount: withdrawable, debug });
  //       if (debug) console.debug(`Withdrew ${withdrawable} microAlgos`);
  //     }

  //     accountInfo = await this.algorand.client.algod.accountInformation(escrowAddress).do();
  //     if (accountInfo.minBalance > 100_000) {
  //       throw new Error(`Expected minimum balance to be 0.1, instead found ${accountInfo.minBalance}`)
  //     }

  //     // 3. Delete the application
  //     await this.client.send.deleteApplication({
  //       args: {},
  //       sender: this.writerAccount.addr.toString(),
  //       signer: this.writerAccount.signer,
  //     });
  //     if (debug) console.debug("Application deleted");
  //   });
  // }
}
