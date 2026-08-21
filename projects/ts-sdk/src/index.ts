import { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import {
  Address,
  AtomicTransactionComposer,
  encodeAddress,
  getApplicationAddress,
  makeApplicationCallTxnFromObject,
  modelsv2,
  OnApplicationComplete,
  waitForConfirmation,
} from "algosdk";
import { EscregClient, EscregComposer } from "./generated/EscregGenerated";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import {
  boxCursor,
  chunk,
  compareBoxNames,
  creditBoxRef,
  decodeAppIds,
  decodeBoxCursor,
  decodeBucket,
  distinctBoxKeys,
  emptySigner,
  encodeAddresses,
  fnetNodelyClient,
  getIncreaseBudgetBuilder,
  getListMethod,
  isArgTooLongError,
  isBoxRefError,
  packBoxKeyBatches,
  SizedBoxKey,
} from "./util";
import { errorTransformer, wrapErrorsInternal } from "./wrapErrors";
import pMap from "p-map";

export { boxCursor, decodeBucket } from "./util";
export type { SizedBoxKey } from "./util";

/**
 * Addresses per `getList` call. The `address[]` arg encodes to 2 + 32N bytes and a single app arg is
 * capped at 4096 bytes, so 127 is the ceiling - 128 needs 4098. The ARC-4 return is logged, and the
 * 1024-byte log cap puts the same 127 ceiling on the `uint64[]` coming back (6 + 8 * 127 = 1022).
 *
 * AVM 13 raised the total app arg budget to 16KB, which is what lifted this from 63: before it, the
 * whole arg list - selector included - had to fit in 2048 bytes.
 */
const ADDRESSES_PER_CALL = 127;

/** Addresses per `getList` call on nodes predating AVM 13, where all args had to fit in 2048 bytes. */
const ADDRESSES_PER_CALL_LEGACY = 63;

/**
 * Boxes a simulate group may reference when it leaves them to `allowUnnamedResources`. Every address
 * in a lookup costs one, so this - not the arg limit - is what caps such a round trip.
 */
const MAX_BOXES_PER_GROUP_UNNAMED = 128;

/** References an AVM 13 access list carries. Boxes, accounts, apps and assets share the one list. */
const REFS_PER_ACCESS_LIST = 16;

/** Transactions an atomic group carries. */
const TXNS_PER_GROUP = 16;

/**
 * Boxes a group can reference when every one is named in a transaction's access list. The pool is
 * shared across the group, so a call can read a box another transaction in the group named.
 */
const MAX_BOXES_PER_GROUP_NAMED = REFS_PER_ACCESS_LIST * TXNS_PER_GROUP;

/**
 * Addresses per simulate group by default: everything a group's references can cover. Filling it
 * costs no extra transaction - the sixteen slots are already spoken for by the references, so the
 * two addresses past the second whole call land in a slot that would otherwise be a carrier.
 */
const DEFAULT_ADDRESSES_PER_GROUP = MAX_BOXES_PER_GROUP_NAMED;

/**
 * Addresses per simulate group when the boxes are left unnamed: as many whole `getList` calls as the
 * box budget covers. The leftover the ceiling allows is not worth a call of its own - a one-address
 * call costs a whole extra transaction to resolve a single box - so a group stops at its last whole
 * call.
 *
 * @param perCall - Addresses each call in the group carries.
 * @returns Addresses the group as a whole carries.
 */
const unnamedAddressesPerGroup = (perCall: number) => perCall * Math.floor(MAX_BOXES_PER_GROUP_UNNAMED / perCall);

/**
 * Fee for the read-only `getList` calls. Never actually paid - they only ever run through simulate -
 * but fnet prices transactions by usage, and a full 4KB arg list costs more than the 1000 microAlgo
 * minimum, so the group would be underfunded at the default fee.
 */
const LOOKUP_CALL_FEE = 5_000;

/** Opcode budget handed to a lookup group. A full 254-address group burns about a sixth of it. */
const LOOKUP_OPCODE_BUDGET = 170_000;

/** Map of address to app ID, or undefined if not registered. */
export type LookupResult = Record<string, bigint | undefined>;

/** Map of address to credit balance in microAlgos. */
export type CreditResult = Record<string, bigint>;

/** A registry bucket box, decoded. */
export interface RegistryBucket {
  /** The 4-byte box key: the leading four bytes of every escrow address in the bucket. */
  key: Uint8Array;
  /** Raw box size in bytes. */
  size: number;
  /** The app IDs the bucket holds, in insertion order. */
  appIds: bigint[];
}

/** One page of a registry box listing. */
export interface BucketPage {
  /** The buckets on this page, in listing order. Credit boxes are left out. */
  buckets: RegistryBucket[];
  /** Cursor to resume the listing after this page, or undefined once it is exhausted. */
  next?: string;
  /** Round the page was read at, when the node reports one. */
  round?: number;
}

/**
 * SDK for interacting with the Escreg (Escrow Registry) smart contract.
 * Provides methods for registering app escrow accounts, looking up addresses,
 * managing MBR credits, and admin operations.
 */
export class EscregSDK {
  /** The Escreg application ID. */
  public appId: bigint = 16954321n;
  /** Escreg algokit generated client */
  public client: EscregClient;
  /** Algorand client instance for interacting with the network. */
  public algorand: AlgorandClient = fnetNodelyClient;
  /** Address used as sender for read-only simulate calls. Defaults to fee sink, funded mostly everywhere. */
  public readerAccount = "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE";
  /** Addresses per `getList` call. Drops to the pre-AVM-13 size the first time a node rejects a full-size call. */
  public addressesPerCall = ADDRESSES_PER_CALL;
  /**
   * Addresses per simulate group, and so per round trip. Past 128 the group has to name its boxes in
   * access lists, which costs transactions - the addresses go into as few calls as they fit, and the
   * rest of the group's slots become carriers that name boxes and look nothing up. Worth it when the
   * round trip is expensive, not when it is cheap: measured against a public node it resolves a third
   * more addresses per second at concurrency 1, and against a local node it is slower.
   */
  public addressesPerGroup = DEFAULT_ADDRESSES_PER_GROUP;
  /** Whether this node has been seen to honour access lists. Cleared for good if one is rejected. */
  private namedBoxRefs = true;
  /** Account with signing capability for write operations (register, deposit, withdraw). */
  public writerAccount?: TransactionSignerAccount;

  /**
   * @param appId - The Escreg application ID.
   * @param algorand - AlgorandClient instance for interacting with the network.
   * @param writerAccount - Account with signing capability for write operations (register, deposit, withdraw).
   * @param readerAccount - Address used as sender for read-only simulate calls. Defaults to a dummy address.
   * @param addressesPerGroup - Addresses `lookup` resolves per simulate group, 1 to 256. Defaults to
   *   254. Anything above 128 names the group's boxes in AVM 13 access lists, so it needs a node that
   *   supports them; drop it to 127 or below for one round trip per `getList` call.
   */
  constructor({
    appId,
    algorand,
    readerAccount,
    writerAccount,
    addressesPerGroup,
  }: {
    appId?: bigint;
    algorand?: AlgorandClient;
    writerAccount?: TransactionSignerAccount;
    addressesPerGroup?: number;
    readerAccount?: string;
  }) {
    this.appId = appId ?? this.appId;
    this.algorand = algorand ?? this.algorand;
    this.readerAccount = readerAccount ?? this.readerAccount;
    this.writerAccount = writerAccount ?? this.writerAccount;

    if (addressesPerGroup !== undefined) {
      if (!Number.isInteger(addressesPerGroup) || addressesPerGroup < 1 || addressesPerGroup > MAX_BOXES_PER_GROUP_NAMED) {
        throw new Error(`addressesPerGroup must be a whole number from 1 to ${MAX_BOXES_PER_GROUP_NAMED}, got ${addressesPerGroup}`);
      }
      this.addressesPerGroup = addressesPerGroup;
    }

    this.algorand
      .setSuggestedParamsCacheTimeout(3 * 60 * 1000)
      .setDefaultValidityWindow(1000)
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
   * and increases opcode budget as needed. Failed chunks are retried automatically.
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
    let chunkIdx = 0;
    // Process chunks in parallel with pMap
    const results = await pMap(
      groupChunks,
      async (groupChunk) => {
        if (debug)
          console.debug(
            `Starting chunkIdx ${chunkIdx++}/${groupChunks.length} ${groupChunk.length > 1 ? groupChunk[0] + ".." + groupChunk[groupChunk.length - 1] : groupChunk[0]}`,
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
        try {
          await this.algorand.client.algod.sendRawTransaction(signed).do();
          await waitForConfirmation(this.algorand.client.algod, txns[0].txID(), 8);
        } catch (e) {
          const transformed = await errorTransformer(e as Error);
          if (debug) {
            console.error(`Chunk ${chunkIdx}/${groupChunks.length} failed with error:`, transformed);
            console.debug(`Failed chunk appIds: ${groupChunk.join(" ")}`);
          }
          thisPassFails += groupChunk.length;
          failedAppIds.push(...groupChunk);
        }

        return txns.map((t) => t.txID());
      },
      { concurrency },
    );

    if (thisPassFails && thisPassFails === prevPassFails) {
      // If the number of failures is the same as the previous pass, it likely means these are persistent failures
      throw new Error(`Pass ${passIdx} failed with ${thisPassFails} failures, same as previous pass. Aborting to avoid infinite retries.`);
    } else if (thisPassFails) {
      console.warn(`Pass failed with ${thisPassFails} failures. Retrying failed ones.`);
      const nextResults = await this.register({
        appIds: failedAppIds,
        skipCheck: true,
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
   * Look up app IDs for the given app escrow addresses. Uses simulate to read contract state
   * without requiring a signer. Returns 0 (mapped to undefined) for addresses not found.
   *
   * @param addresses - Array of Algorand addresses to look up.
   * @param concurrency - Number of simulate calls to run in parallel.
   * @param debug - Enable debug logging.
   * @returns Map of address to app ID, or undefined if not registered.
   */
  async lookup({
    addresses,
    concurrency = 1,
    debug,
  }: {
    addresses: string[];
    concurrency?: number;
    debug?: boolean;
  }): Promise<LookupResult> {
    const perGroup = this.groupSize();
    const chunks = chunk(addresses, perGroup);
    const start = Date.now();

    if (debug) {
      console.debug(
        `Looking up ${addresses.length} addresses in ${chunks.length} chunks (${
          addresses.length <= perGroup ? addresses.length : `${perGroup} per chunk`
        }) with concurrency ${concurrency}`,
      );
    }

    // Process chunks in parallel with pMap
    const results = await pMap(
      chunks,
      async (addressesChunk, chunkIndex) => {
        // a group only needs access lists once it outgrows what simulate will work out on its own,
        // and naming boxes costs transactions, so the smaller groups stay on the cheaper path
        const appIds =
          this.namedBoxRefs && addressesChunk.length > MAX_BOXES_PER_GROUP_UNNAMED
            ? await this.simulateNamedGroup(addressesChunk)
            : await this.simulateUnnamedGroup(addressesChunk);

        const out: LookupResult = {};
        appIds.forEach((appId, i) => {
          out[addressesChunk[i]] = appId || undefined;
        });

        if (debug) {
          const found = Object.values(out).filter((appId) => appId !== undefined).length;
          console.debug(`Chunk ${chunkIndex + 1}/${chunks.length} completed: ${found}/${addressesChunk.length} addresses found`);
        }

        return out;
      },
      { concurrency },
    ).catch((e) => {
      // An older node cannot do what was asked of it: it ignores or rejects the access lists, or -
      // predating AVM 13 entirely - caps the whole arg list at 2048 bytes and turns down a full-size
      // call before it runs. Give up the capability for good on this SDK and start over, so the
      // groups are rebuilt around what the node will take.
      if (this.namedBoxRefs && (isBoxRefError(e) || isArgTooLongError(e))) {
        console.warn(`escreg: node turned down a group with named box references, falling back to unnamed ones: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
        this.namedBoxRefs = false;
        return undefined;
      }
      if (isArgTooLongError(e) && this.addressesPerCall !== ADDRESSES_PER_CALL_LEGACY) {
        console.warn(`escreg: node rejected a ${this.addressesPerCall}-address call, falling back to ${ADDRESSES_PER_CALL_LEGACY}`);
        this.addressesPerCall = ADDRESSES_PER_CALL_LEGACY;
        return undefined;
      }
      throw e;
    });

    if (!results) return this.lookup({ addresses, concurrency, debug });

    if (debug) {
      console.debug("Merging results...");
    }
    // Merge all results
    // const finalResult = results.reduce((acc, result) => ({ ...acc, ...result }), {}); // slow
    const finalResult: LookupResult = {};
    for (const result of results) {
      for (const [key, value] of Object.entries(result)) {
        finalResult[key] = value;
      }
    }

    if (debug) {
      console.debug("Results merged.");
      const elapsed = (Date.now() - start) / 1000;
      const totalFound = Object.values(finalResult).filter((appId) => appId !== undefined).length;
      console.debug(`Lookup completed: ${totalFound}/${addresses.length} addresses found in ${elapsed} seconds`);
    }

    return finalResult;
  }

  /**
   * Addresses to put in one simulate group: what the caller asked for, held down to what the node
   * and the current call size can actually carry.
   *
   * @returns Addresses per group.
   */
  private groupSize(): number {
    const ceiling = this.namedBoxRefs ? MAX_BOXES_PER_GROUP_NAMED : unnamedAddressesPerGroup(this.addressesPerCall);
    return Math.min(this.addressesPerGroup, ceiling);
  }

  /**
   * Resolve one group of addresses, leaving simulate to work out which boxes the calls touch. Cheap -
   * the group is one transaction per call - but simulate will only pool 128 boxes for a group that
   * way, which is the ceiling on how many addresses this can carry.
   *
   * @param addresses - Addresses the group resolves.
   * @returns App IDs in the order the addresses were given; 0 for an address that is not registered.
   */
  private async simulateUnnamedGroup(addresses: string[]): Promise<bigint[]> {
    let composer: EscregComposer<any> = this.client.newGroup();

    for (const group of chunk(addresses, this.addressesPerCall)) {
      composer = composer.getList({
        args: { addresses: group },
        sender: this.readerAccount,
        signer: emptySigner,
        staticFee: LOOKUP_CALL_FEE.microAlgo(),
      });
    }

    const { returns } = await composer.simulate({
      allowEmptySignatures: true,
      allowUnnamedResources: true,
      extraOpcodeBudget: LOOKUP_OPCODE_BUDGET,
    });

    return (returns as bigint[][]).flat();
  }

  /**
   * Resolve one group of addresses with every box it reads named in an access list, which doubles
   * what a round trip can carry: 16 references per transaction over 16 transactions is 256 boxes,
   * and the pool is shared, so a call can read a box another transaction in the group named.
   *
   * The addresses go into as few calls as the per-call cap allows; the group's remaining slots become
   * carriers, which name references and look nothing up.
   *
   * @param addresses - Addresses the group resolves.
   * @returns App IDs in the order the addresses were given; 0 for an address that is not registered.
   */
  private async simulateNamedGroup(addresses: string[]): Promise<bigint[]> {
    const calls = chunk(addresses, this.addressesPerCall);
    const references = chunk(distinctBoxKeys(addresses), REFS_PER_ACCESS_LIST);
    const txns = Math.max(calls.length, references.length);
    if (txns > TXNS_PER_GROUP) {
      throw new Error(`${addresses.length} addresses need ${txns} transactions, more than a group's ${TXNS_PER_GROUP}`);
    }

    const suggestedParams = await this.algorand.getSuggestedParams();
    const atc = new AtomicTransactionComposer();

    for (let i = 0; i < txns; i++) {
      atc.addTransaction({
        txn: makeApplicationCallTxnFromObject({
          sender: this.readerAccount,
          appIndex: this.appId,
          onComplete: OnApplicationComplete.NoOpOC,
          appArgs: [getListMethod.getSelector(), encodeAddresses(calls[i] ?? [])],
          access: (references[i] ?? []).map((name) => ({ box: { appIndex: this.appId, name } })),
          suggestedParams: { ...suggestedParams, fee: BigInt(LOOKUP_CALL_FEE), flatFee: true },
        }),
        signer: emptySigner,
      });
    }

    const { simulateResponse } = await atc.simulate(
      this.algorand.client.algod,
      new modelsv2.SimulateRequest({
        txnGroups: [],
        allowEmptySignatures: true,
        allowMoreLogging: true,
        extraOpcodeBudget: LOOKUP_OPCODE_BUDGET,
      }),
    );

    const group = simulateResponse.txnGroups[0];
    // simulate reports a rejected group rather than throwing, so surface it as one
    if (group.failureMessage) throw new Error(group.failureMessage);

    // carriers return an empty array, so concatenating in transaction order is the input order
    return group.txnResults.flatMap(({ txnResult }) => decodeAppIds(txnResult.logs?.[(txnResult.logs?.length ?? 0) - 1]));
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

    const results = await pMap(
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
      { concurrency },
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

      const buckets = await pMap(
        descriptors,
        async ({ name, value }) => this.toBucket(name, value ?? (await algod.getApplicationBoxByName(appId, name).do()).value),
        { concurrency },
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
