# escreg

[![sdk](https://img.shields.io/npm/v/@d13co/escreg-sdk?label=sdk)](https://www.npmjs.com/package/@d13co/escreg-sdk)
[![cli](https://img.shields.io/npm/v/@d13co/escreg?label=cli)](https://www.npmjs.com/package/@d13co/escreg)

An on-chain registry for Algorand application escrow addresses. Given any Algorand address, escreg lets you answer: "Is this address an application escrow, and if so, which app ID owns it?"

Every Algorand application has a deterministic escrow address derived from its app ID (`sha512_256("appID" || appId)`).

This contract stores registered app IDs in box storage using a 4-byte address prefix bucketing scheme, enabling efficient lookups from address to app ID.

App escrow lookups work by iterating the 4-byte-prefix bucket corresponding to the input address, computing the app escrow on the fly from each application ID, and returning the app ID if a match is found. Offloading the computation to runtime allows us to store less: 4+8 bytes for a new bucket, or 8 bytes to add to an existing bucket.

Buckets are stored as big-endian 8-byte app IDs packed back to back with no length header, so the entry count is derived from the box length (`length / 8`). Avoiding the 2-byte header an ARC-4 dynamic array would carry saves 800 microAlgos of MBR on every box, putting a new single-entry bucket at exactly the 7,300 microAlgos implied above (`2500 + 400 * (4 + 8)`).

### Bucket layout migration

Buckets written before the packed layout are ARC-4 `uint64[]`: the same 8-byte app IDs behind a 2-byte length header. Their size is therefore 2 mod 8, while a packed bucket's is 0 mod 8, so the two can never be confused and readers handle both without a version flag or a migration deadline. Deployments carrying legacy buckets keep working as-is.

Converting is optional and reclaims the 800 microAlgos each header holds:

- `migrateBoxes(bytes<4>[])` strips the header from the given keys, skipping any that are missing or already packed, and returns how many it converted. The freed MBR is not credited back to any account; it stays in the contract balance for the admin to `withdraw`.
- Registering a new app ID into a legacy bucket converts that bucket as a side effect, so writes drift toward the packed layout on their own.
- `escreg migrate` (CLI) scans for legacy buckets and converts them in batches, and `escreg dump` shows which layout each box is in. See [CLI](#cli).

This is currently deployed to Fnet as [App ID 16954321](https://lora.algokit.io/fnet/application/16954321).

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

| Code | Meaning |
|---|---|
| `ERR:CRD` | Insufficient credits to cover MBR increase |
| `ERR:RCV` | Payment receiver must be the contract |
| `ERR:AMT` | Amount must be greater than zero / no credit box exists |

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
| `migrateBoxes(bytes<4>[]) -> uint64` | admin | Convert legacy buckets to the packed layout, returning the number converted |
| `withdraw(uint64)` | admin | Withdraw microAlgos from the contract |
| `updateApplication()` | admin | Update the contract |
| `deleteApplication()` | admin | Delete the contract |

### Build & Deploy

```bash
cd projects/contract
npm install
npm run build    # compile to TEAL + generate typed client
npm run deploy   # deploy (requires DEPLOYER_MNEMONIC in .env)
npm test         # run tests via vitest on LocalNet
```

## SDK

**Package:** `@d13co/escreg-sdk`
**Source:** `projects/ts-sdk/src/index.ts`

Wraps the generated typed client with batching, chunking, simulation-based lookups, and automatic opcode budget management.

### Usage

```typescript
import { EscregSDK } from '@d13co/escreg-sdk'

// Defaults to the current Fnet deployment (app ID, Algorand client)
const sdk = new EscregSDK({})

// Lookup addresses (via simulation, no signing required)
const results = await sdk.lookup({
  addresses: ['A7NMWS3NT3IU...', 'B2XYZ...'],
  concurrency: 4,
})
// results: { 'A7NMWS3NT3IU...': 1001n, 'B2XYZ...': undefined }

// For write operations, pass a writerAccount
const writer = new EscregSDK({ writerAccount })

// Deposit MBR credits before registering (covers box storage costs)
await writer.depositCredit({
  creditor: writerAccount.addr.toString(),
  amount: 1_000_000n, // 1 Algo
})

await writer.register({ appIds: [1001n, 1002n, 1003n], concurrency: 4 })
```

### Key behaviors

- **Register:** chunks app IDs into groups of 7 per transaction, 15 transactions per atomic group (105 app IDs per group). Automatically prepends `increaseBudget` calls when opcode budget is insufficient. Retries failed chunks.
- **Lookup:** uses `simulate` with `allowEmptySignatures` so no signing key is needed. Chunks to 128 addresses per group, 63 per `getList` call.
- **Credits:** deposit, withdraw, and check MBR credit balances.
- **Migration:** `findLegacyBoxes` lists every registry box and returns the keys of those still in the legacy layout; `migrateBoxes` converts them in batches of 8 per transaction. `decodeBucket` decodes a raw bucket box value into app IDs, and `bucketHeaderLen` gives the header length to skip when the value may be legacy.
- **Scanning:** `scanBucketPages` reads the registry from algod's paginated box listing, a page of boxes and their values per request, and `scanBuckets` flattens it into an async iterable of every bucket with its layout version and decoded app IDs. A registry of millions of boxes streams in constant memory. Backs `escreg dump`. Nodes predating the paginated listing answer with every box name in one response, which the SDK falls back to fetching values for with bounded `concurrency`; that path still fails with "Result limit exceeded" past the node's `MaxAPIBoxPerApplication`.
- **Resuming a scan:** every page carries the `next` cursor to resume after it, and `boxCursor` builds the same cursor from the name of the last box a caller finished with, so an interrupted scan restarts from where it stopped rather than from the top. A resumed scan lists at the current round, so a box written behind the cursor while it was stopped is not picked up.

### Build

```bash
cd projects/ts-sdk
npm install
npm run build      # dual CJS + ESM output in dist/
npm run generate   # regenerate typed client from contract artifacts
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

# Convert legacy buckets to the packed layout (admin only)
escreg migrate --dry-run          # report how many boxes need migrating
escreg migrate --concurrency 8    # scan and convert

# Dump every registry box and the app IDs it holds
escreg dump                       # one row per box, streamed as they are read
escreg dump --page-size 5000 | head -20
escreg dump | grep '^1 '          # only boxes still in the legacy layout
escreg dump --resume dump.state >> dump.txt   # pick up where an interrupted dump left off
```

`dump` writes one row per box to stdout, and its header and closing summary to stderr, so the rows pipe cleanly:

```
v  key b64 (b32)       values
1  AAAC9w== (AAAAF5Y)  1x  2925391292 (AAAAF5ZH)
2  AABDYw== (AAAEGYY)  2x  3653985308 (AAAEGYZ5)  1157865993 (AAAEGYQ7)
```

The `v` column is the bucket layout: `1` for a legacy ARC-4 bucket, `2` for a packed one. The key is the 4-byte bucket prefix in base64 and, in parens, base32 — the alphabet addresses use, so it shares its first six characters with every escrow address filed under it. Each value is an app ID followed by the first 8 characters of its escrow address.

Boxes stream as they are read rather than being collected first, so `dump` starts printing immediately and holds only a page of boxes at a time.

A registry of millions of boxes takes a while to dump, so `--resume <file>` makes the run restartable: the file records the listing cursor and the counts behind it after every page, and Ctrl-C stops between rows so what stdout has written and what the file records stay in step. Re-running the same command continues after the recorded cursor — redirect with `>>` to append to the same output — and the file is removed once the dump completes. A resumed dump lists at the current round, so a box registered behind the cursor while the dump was stopped is not picked up.

`migrate` is safe to re-run: the contract skips keys that are missing or already packed. A box written behind the listing cursor while a scan is running is missed, so the command re-scans until a pass comes back clean, up to `--max-passes` (default 3).

### Configuration

Defaults to the Fnet deployment. Override via CLI flags, environment variables, or a `.env` file:

| Variable | Flag | Default | Description |
|---|---|---|---|
| `ALGOD_HOST` | `--algod-host` | `fnet-api.4160.nodely.dev` | Algorand node host |
| `ALGOD_PORT` | `--algod-port` | `443` | Algorand node port |
| `ALGOD_TOKEN` | `--algod-token` | (empty) | Algorand node token |
| `APP_ID` | `--app-id` | `16954321` | Escreg application ID |
| `MNEMONIC` | `--mnemonic` | | Account mnemonic for write operations |
| `ADDRESS` | `--address` | | Account address (for rekeyed accounts) |
| `CONCURRENCY` | `--concurrency` | `1` | Parallel request count |

Every command talks to the node alone. The box-listing commands (`dump`, `migrate`) page through algod's box listing and read box values straight off it, which needs go-algorand 4.7 or newer — the public API nodes are, the AlgoKit LocalNet image (4.4) is not. An older node ignores the paging and answers with every box name in one response, leaving the values to be fetched one box at a time (`--concurrency`) and failing with "Result limit exceeded" past its `MaxAPIBoxPerApplication`.

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
algokit localnet start   # start local Algorand network
cd projects/contract
npm test                 # vitest against LocalNet
```
