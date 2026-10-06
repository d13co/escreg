# escreg

[![sdk](https://img.shields.io/npm/v/@d13co/escreg-sdk?label=sdk)](https://www.npmjs.com/package/@d13co/escreg-sdk)
[![cli](https://img.shields.io/npm/v/@d13co/escreg?label=cli)](https://www.npmjs.com/package/@d13co/escreg)

> [!WARNING]
> **Escreg has migrated from FNet to TestNet ([App ID 773212345](https://lora.algokit.io/testnet/application/773212345)).** The FNet registry is maintained until Nov 5th, 2026; after that it throws `ERR:FNET_DEPRECATED` for all queries. Upgrade to the latest SDK/CLI (v1.0.0+). Details: [#2](https://github.com/d13co/escreg/issues/2)

An on-chain registry for Algorand application escrow addresses. Given any Algorand address, escreg lets you answer: "Is this address an application escrow, and if so, which app ID owns it?"

Every Algorand application has a deterministic escrow address derived from its app ID (`sha512_256("appID" || appId)`).

This contract stores registered app IDs in box storage using a 4-byte address prefix bucketing scheme, enabling efficient lookups from address to app ID.

App escrow lookups work by iterating the 4-byte-prefix bucket corresponding to the input address, computing the app escrow on the fly from each application ID, and returning the app ID if a match is found. Offloading the computation to runtime allows us to store less: 4+8 bytes for a new bucket, or 8 bytes to add to an existing bucket.

Buckets are stored as big-endian 8-byte app IDs packed back to back with no length header, so the entry count is derived from the box length (`length / 8`). Avoiding the 2-byte header an ARC-4 dynamic array would carry saves 800 microAlgos of MBR on every box, putting a new single-entry bucket at exactly the 7,300 microAlgos implied above (`2500 + 400 * (4 + 8)`).

This is currently deployed to Testnet as [App ID 773212345](https://lora.algokit.io/testnet/application/773212345), the SDK and CLI default, and to Fnet as [App ID 16954321](https://lora.algokit.io/fnet/application/16954321).

## Project Structure

```
projects/
  contract/
    smart_contracts/
      mbr-manager/   # Reusable MBR credit base contract
      escreg/        # Registry contract (extends MbrManager)
  ts-sdk/            # TypeScript SDK (@d13co/escreg-sdk)
  client/            # CLI tool (escreg)
  worker/            # Cloudflare Worker — auto-registers new apps
```

Workspace build order: `contract` -> `ts-sdk` -> `client`

## MBR Manager (Base Contract)

**Source:** `projects/contract/smart_contracts/mbr-manager/contract.algo.ts`

A reusable base contract that implements a pre-paid credit system for Algorand box storage costs. Any contract that uses box storage can extend `MbrManager` to let users fund, track, and reclaim the minimum balance requirement (MBR) that box operations impose on the application account.

### How it works

Creating or expanding boxes increases an application's minimum balance. `MbrManager` tracks per-user credit balances in a `BoxMap<Account, uint64>` (key prefix `'c'`), so each user independently funds the MBR for the boxes their transactions create.

1. **Deposit** — a user calls `depositCredits` with a payment transaction to top up their credit balance. On first deposit the box MBR for the credit box itself (18,900 microAlgos) is automatically deducted.
2. **Use** — the subclass calls the protected `manageMbrCredits(mbrBefore)` hook after any operation that may create or delete boxes. The hook computes the MBR delta and debits or credits the caller's balance accordingly.
3. **Withdraw** — a user calls `withdrawCredits` to reclaim all unused credits. The credit box is deleted and its freed MBR is included in the returned payment.

### Extending MbrManager

```typescript
import { MbrManager } from '../mbr-manager/contract.algo'

export class MyContract extends MbrManager {
  data = BoxMap<bytes<4>, uint64[]>({ keyPrefix: '' })

  register(key: bytes<4>, value: uint64) {
    const mbrBefore = Global.currentApplicationAddress.minBalance
    // ... write to boxes ...
    this.manageMbrCredits(mbrBefore)
  }
}
```

Snapshot `minBalance` before the box operation, then call `manageMbrCredits` after. The hook handles the rest.

### Methods

| Method | Type | Description |
|---|---|---|
| `depositCredits(account, pay)` | public | Deposit MBR credits for an account. The creditor can differ from the sender. |
| `withdrawCredits()` | public | Withdraw all remaining credits and delete the credit box. Requires an extra fee to cover the inner payment. |
| `manageMbrCredits(uint64)` | protected | Hook for subclasses. Compares current MBR to the snapshot and debits/credits the caller. |

### Error codes

Failures log an [ARC-65](https://github.com/algorandfoundation/ARCs) line and halt, through
`loggedAssert`, which also puts the code in the contract's ARC-56 source info - so a client names any
of them without reading the logs.

| Code | Logged | Meaning |
|---|---|---|
| `ERR:CRD` | `ERR:CRD::<deficit>` | Insufficient credits to cover MBR increase, deficit in microALGO |
| `ERR:RCV` | `ERR:RCV` | Payment receiver must be the contract |
| `ERR:AMT` | `ERR:AMT` | Amount must be greater than zero / no credit box exists |

`ERR:CRD` adds a line carrying the shortfall. It logs `ERR:CRD::<deficit>` and then fails through the
same `loggedAssert` as everything else, so it keeps its ARC-56 entry:

```ts
const deficit: uint64 = userCredit < creditNeeded ? creditNeeded - userCredit : 0
if (deficit > 0) {
  log(Bytes('ERR:').concat(Bytes(errCredit)).concat(Bytes('::')).concat(Bytes(deficit.toString())))
}
loggedAssert(deficit === 0, errCredit)
```

It fails with two log lines: `ERR:CRD::7300` then the bare `ERR:CRD`.

The assert has to stay here rather than move into a helper alongside the log. `loggedAssert` and
`assert` both take their message as a compile-time constant, and a code arriving through a parameter
is not one - the compiler rejects it with `Expected constant of type string`. A helper that asserted
internally could only fall back to a bare `err()`, which carries no source info, and a client would
then get no code at all. The log is written out inline for a different reason: it keeps `itoa` on the
failing path only.

Whether a halt is `err` or `assert` makes no difference to any of this, nor to the logs - every `log`
written before a failure is in the simulate response either way. What decides whether the caller sees
a code is the ARC-56 entry, which needs the literal.

The deficit is worked out with a saturating subtraction because it is computed whether or not there
is a shortfall, and a plain `creditNeeded - userCredit` would trap.

## Escreg Contract

**Source:** `projects/contract/smart_contracts/escreg/contract.algo.ts`

The registry contract. Extends `MbrManager` so that callers pre-fund credits before registering app IDs (which allocates box storage). Written in [Algorand TypeScript (PuyaTS)](https://github.com/algorandfoundation/puya-ts). State is stored in a `BoxMap<bytes<4>, bytes>` keyed by the first 4 bytes of each app's escrow address, each box holding a packed, headerless array of 8-byte app IDs. Multiple app IDs can share a prefix bucket; exact matches are resolved by recomputing the full address.

### Methods

| Method | Type | Description |
|---|---|---|
| `register(uint64)` | write | Register a single app ID |
| `registerList(uint64[])` | write | Batch register multiple app IDs |
| `exists(address) -> bool` | read | Check if an address is a registered app escrow |
| `get(address) -> uint64` | read | Get app ID for address (returns 0 if not found) |
| `mustGet(address) -> uint64` | read | Get app ID for address (aborts if not found) |
| `getList(address[]) -> uint64[]` | read | Batch lookup |
| `mustGetList(address[]) -> uint64[]` | read | Batch lookup (aborts if any not found) |
| `getWithAuth(address) -> (uint64, uint64)` | read | Returns app ID and auth-address app ID (for rekeyed accounts) |
| `getWithAuthList(address[]) -> (uint64, uint64)[]` | read | Batch version of getWithAuth |
| `increaseBudget(uint64)` | noop | Add opcode budget via inner transactions |
| `deleteBoxes(bytes<4>[])` | admin | Delete app registry boxes by key |
| `withdraw(uint64)` | admin | Withdraw microAlgos from the contract |
| `updateApplication()` | admin | Update the contract |
| `deleteApplication()` | admin | Delete the contract |

### Build & Deploy

```bash
cd projects/contract
npm install
npm run build    # compile to TEAL + generate typed client
npm run deploy   # deploy (requires DEPLOYER_MNEMONIC in .env)
npm test         # run contract and SDK e2e tests via vitest on LocalNet
```

## SDK

**Package:** `@d13co/escreg-sdk`
**Source:** `projects/ts-sdk/src/index.ts` (lookups), `projects/ts-sdk/src/full.ts` (everything else)

Batches, chunks and simulates lookups, and — behind its second entry point — wraps the generated typed client with registration, MBR credits, the registry scan, and automatic opcode budget management.

### Entry points

| Import | Carries | Bundled, minified |
|---|---|---|
| `@d13co/escreg-sdk` | `lookup` and the pure decoders. algosdk only — no algokit-utils, no generated client, no app spec. | 343 KB (81 KB gzipped) |
| `@d13co/escreg-sdk/full` | Everything: registration, MBR credits, the registry scan, admin methods. | 654 KB (151 KB gzipped) |

Both rows bundle algosdk, which a consumer ships either way. The SDK's own code on top of it is 4.8 KB minified (2.3 KB gzipped) light against 32 KB (8.9 KB) full — nearly all of the 310 KB between the rows is algokit-utils.

Both export a class called `EscregSDK` and the full one extends the light one, so `/full` is a strict superset. Looking addresses up is what most consumers do and all a browser one needs, so that is what the default entry point costs them.

### Usage

```typescript
import { EscregSDK } from '@d13co/escreg-sdk'

// Defaults to the current Fnet deployment (app ID, algod endpoint)
const sdk = new EscregSDK({})

// Lookup addresses (via simulation, no signing required)
const results = await sdk.lookup({
  addresses: ['A7NMWS3NT3IU...', 'B2XYZ...'],
  concurrency: 4,
})
// results: { 'A7NMWS3NT3IU...': 1001n, 'B2XYZ...': undefined }

// Anything running beside its node should ask for smaller groups: 256 buys a
// saved round trip with extra transactions, which only pays off across a network
const local = new EscregSDK({ algorand, addressesPerGroup: 127 })

// Registering, credits, scanning and the admin methods live behind /full
import { EscregSDK as EscregFullSDK } from '@d13co/escreg-sdk/full'

// For write operations, pass a writerAccount
const writer = new EscregFullSDK({ writerAccount })

// Deposit MBR credits before registering (covers box storage costs)
await writer.depositCredit({
  creditor: writerAccount.addr.toString(),
  amount: 1_000_000n, // 1 Algo
})

await writer.register({ appIds: [1001n, 1002n, 1003n], concurrency: 4 })
```

### Key behaviors

- **Register:** chunks app IDs into groups of 7 per transaction, 15 transactions per atomic group (105 app IDs per group). Automatically prepends `increaseBudget` calls when opcode budget is insufficient. Retries failed chunks.
- **Lookup:** uses `simulate` with `allowEmptySignatures` so no signing key is needed. Resolves `addressesPerGroup` addresses per round trip — 256 by default, the ceiling of 16 references over a group's 16 transactions — in `getList` calls of 127. Past 128 addresses a group has to name every box it reads in an AVM 13 access list, which is what lifts the ceiling but fills the group's spare transaction slots with carriers that name boxes and look nothing up. That trade is worth it across a network and not beside the node, so **anything running beside its node should pass `addressesPerGroup: 127`**: a local node is 25-35% slower at 256, while a public one is about a third faster. On a node that will not take a full-size call or will not honour access lists, the SDK steps down once — with a warning — to the pre-AVM-13 shape of 63 per call and 126 per group.
- **Credits:** deposit, withdraw, and check MBR credit balances.
- **Scanning:** `scanBucketPages` reads the registry from algod's paginated box listing, a page of boxes and their values per request, and `scanBuckets` flattens it into an async iterable of every bucket with its decoded app IDs (`decodeBucket` decodes a raw bucket box value). A registry of millions of boxes streams in constant memory. Backs `escreg dump`. Nodes predating the paginated listing answer with every box name in one response, which the SDK falls back to fetching values for with bounded `concurrency`; that path still fails with "Result limit exceeded" past the node's `MaxAPIBoxPerApplication`.
- **Resuming a scan:** every page carries the `next` cursor to resume after it, and `boxCursor` builds the same cursor from the name of the last box a caller finished with, so an interrupted scan restarts from where it stopped rather than from the top. A resumed scan lists at the current round, so a box written behind the cursor while it was stopped is not picked up. A node that ignores the pagination would answer a resumed scan from the first box, which the SDK rejects rather than handing back rows the caller has already processed.

### Error handling

Every SDK call runs through an error transformer that turns a contract error code into the sentence
it stands for. `src/generated/errors.ts` is generated from the comments in the contract's
`errors.algo.ts` by `npm run generate:errors`, so the two never drift.

A message may carry `::` as a placeholder for a value the contract appends to the code it logs -
`ERR:CRD::7300` fills the deficit into `Insufficient credits to cover MBR increase, deficit ::
microALGO`. The parsed value is also put on the error as `.value`; alongside `.code` and
`.description`. A placeholder with no value to fill it reads `unknown`.

```ts
try {
  await sdk.register({ appIds: [1002] })
} catch (e) {
  e.code         // "ERR:CRD"
  e.value        // "7300", when the log reached the client
  e.message      // "Error CRD: Insufficient credits to cover MBR increase, deficit 7300 microALGO"
}
```

Note that algokit-utils reports the code from the contract's ARC-56 source info and does not carry
the transaction's logs, so the appended value only arrives when the caller has the raw log - the
message falls back to `deficit unknown microALGO` otherwise. The value is always in the app call's
logs.

### Build

```bash
cd projects/ts-sdk
npm install
npm run build      # dual CJS + ESM output in dist/, one bundle per entry point
npm run generate   # regenerate typed client from contract artifacts
npm run check:abi  # hold the hand-written getList signature to the contract's own
```

## CLI

**Package:** `@d13co/escreg`
**Source:** `projects/client/src/index.ts`

```bash
npx @d13co/escreg lookup ADDR1,ADDR2
```

### Commands

```bash
# Register app IDs
escreg register 1001,1002,1003
escreg register --file app-ids.txt --concurrency 4 --skip-check

# Lookup addresses
escreg lookup ADDR1,ADDR2
escreg lookup --file addresses.txt --concurrency 4

# Convert app IDs to escrow addresses (local, no network)
escreg convert 1001,1002,1003

# MBR credit management
escreg deposit-credits 1         # deposit 1 Algo of credits
escreg credits --all             # check all credit balances
escreg credits ADDR1,ADDR2       # check specific balances
escreg withdraw-credits           # withdraw all your credits

# Withdraw funds (admin only)
escreg withdraw 1

# Dump every registry box and the app IDs it holds
escreg dump                       # one row per box, streamed as they are read
escreg dump --page-size 5000 | head -20
escreg dump --resume dump.state >> dump.txt   # pick up where an interrupted dump left off
```

`dump` writes one row per box to stdout, and its header and closing summary to stderr, so the rows pipe cleanly:

```
key b64 (b32)       values
AAAC9w== (AAAAF5Y)  1x  2925391292 (AAAAF5ZH)
AABDYw== (AAAEGYY)  2x  3653985308 (AAAEGYZ5)  1157865993 (AAAEGYQ7)
```

The key is the 4-byte bucket prefix in base64 and, in parens, base32 — the alphabet addresses use, so it shares its first six characters with every escrow address filed under it. Each value is an app ID followed by the first 8 characters of its escrow address.

Boxes stream as they are read rather than being collected first, so `dump` starts printing immediately and holds only a page of boxes at a time.

A registry of millions of boxes takes a while to dump, so `--resume <file>` makes the run restartable: the file records the listing cursor and the counts behind it after every page, and Ctrl-C stops between rows so what stdout has written and what the file records stay in step. Ctrl-C again quits immediately, without a checkpoint, for when the scan is stuck waiting on the node. Re-running the same command continues after the recorded cursor — redirect with `>>` to append to the same output — and the file is removed once the dump completes, including when the interrupt lands on the last row there was. Resuming needs a node that honours the listing cursor; on one that does not, the command stops rather than dumping from the top again. A resumed dump lists at the current round, so a box registered behind the cursor while the dump was stopped is not picked up.

### Configuration

Defaults to the Testnet deployment. Override via CLI flags, environment variables, or a `.env` file:

| Variable | Flag | Default | Description |
|---|---|---|---|
| `ALGOD_HOST` | `--algod-host` | `testnet-api.4160.nodely.dev` | Algorand node host |
| `ALGOD_PORT` | `--algod-port` | `443` | Algorand node port |
| `ALGOD_TOKEN` | `--algod-token` | (empty) | Algorand node token |
| `APP_ID` | `--app-id` | `773212345` | Escreg application ID |
| `MNEMONIC` | `--mnemonic` | | Account mnemonic for write operations |
| `ADDRESS` | `--address` | | Account address (for rekeyed accounts) |
| `CONCURRENCY` | `--concurrency` | `1` | Parallel request count |

Every command talks to the node alone. The box-listing command (`dump`) pages through algod's box listing and reads box values straight off it, which needs go-algorand 4.7 or newer — the public API nodes are, the AlgoKit LocalNet image (4.4) is not. An older node ignores the paging and answers with every box name in one response, leaving the values to be fetched one box at a time (`--concurrency`) and failing with "Result limit exceeded" past its `MaxAPIBoxPerApplication`.

### Build

```bash
cd projects/client
npm install
npm run build:ts              # compile TypeScript
npm run build                 # compile + build standalone executables via Bun
```

## Worker

**Source:** `projects/worker/`

A Cloudflare Worker that automatically discovers and registers new Algorand application escrow addresses. Runs on a cron schedule (every minute), polling indexers across multiple networks (mainnet, testnet, fnet, betanet) for newly created applications and batch-registering them via the SDK.

- Uses KV storage to track indexer cursors per network
- Exposes a `/status` endpoint to inspect current cursor positions
- Exposes `POST /start/:network?appId=N` to initialize a cursor for a new network

```bash
cd projects/worker
wrangler secret put MNEMONIC   # set the signing account mnemonic
wrangler dev                   # local development
wrangler deploy                # deploy to Cloudflare
```

## Development

### Prerequisites

- [AlgoKit CLI](https://github.com/algorandfoundation/algokit-cli)
- Node.js
- [Bun](https://bun.sh) (for building standalone executables)

### Getting Started

```bash
npm install              # install all workspace dependencies
cd projects/contract
npm run build            # compile contract + generate typed client
cd ../ts-sdk
npm run generate         # generate SDK client from contract artifacts
npm run build            # build SDK
cd ../client
npm run build            # build CLI
```

### Running Tests

```bash
algokit localnet start   # start local Algorand network (the contract tests need it)
algokit project run test # every project's tests, in dependency order

# or one project at a time
cd projects/ts-sdk && npm test   # SDK unit tests, no network
cd projects/client && npm run test:run   # CLI unit tests, no network
cd projects/contract && npm test # contract and SDK e2e tests, against LocalNet
```

The SDK and client suites stub the network, so they run anywhere. The contract suite deploys to
LocalNet and drives the SDK against it, so it needs a built SDK — `algokit project run build` first,
which is the order CI runs them in.

### CI

`.github/workflows/ci.yaml` runs on every push to `main` and every pull request, and calls the
reusable `escreg-ci.yaml`: audit, lint, build, test, TEAL analysis. `escreg-cd.yaml` deploys to
TestNet and is left without a trigger on purpose — release by invoking it by hand.
