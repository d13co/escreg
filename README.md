# escreg

[![npm](https://img.shields.io/npm/v/@d13co/escreg-sdk)](https://www.npmjs.com/package/@d13co/escreg-sdk)

An on-chain registry for Algorand application escrow addresses. Given any Algorand address, escreg lets you answer: "Is this address an application escrow, and if so, which app ID owns it?"

Every Algorand application has a deterministic escrow address derived from its app ID (`sha512_256("appID" || appId)`).

This contract stores registered app IDs in box storage using a 4-byte address prefix bucketing scheme, enabling efficient lookups from address to app ID.

App escrow lookups work by iterating the 4-byte-prefix bucket corresponding to the input address, computing the app escrow on the fly from each application ID, and returning the app ID if a match is found. Offloading the computation to runtime allows us to store less: 4+8 bytes for a new bucket, or 8 bytes to add to an existing bucket.

This is currently deployed to Fnet as [App ID 16382607](https://lora.algokit.io/fnet/application/16382607).

## Project Structure

```
projects/
  contract/
    smart_contracts/
      mbr-manager/   # Reusable MBR credit base contract
      escreg/        # Registry contract (extends MbrManager)
  ts-sdk/            # TypeScript SDK
  client/            # CLI tool
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

The registry contract. Extends `MbrManager` so that callers pre-fund credits before registering app IDs (which allocates box storage). Written in [Algorand TypeScript (PuyaTS)](https://github.com/algorandfoundation/puya-ts). State is stored in a `BoxMap<bytes<4>, uint64[]>` keyed by the first 4 bytes of each app's escrow address. Multiple app IDs can share a prefix bucket; exact matches are resolved by recomputing the full address.

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

- **Register:** chunks app IDs into groups of 8 per transaction, 15 transactions per atomic group (120 app IDs per group). Automatically prepends `increaseBudget` calls when opcode budget is insufficient. Retries failed chunks.
- **Lookup:** uses `simulate` with `allowEmptySignatures` so no signing key is needed. Chunks to 128 addresses per group, 63 per `getList` call.

### Build

```bash
cd projects/ts-sdk
npm install
npm run build      # dual CJS + ESM output in dist/
npm run generate   # regenerate typed client from contract artifacts
```

## CLI

**Binary:** `escreg`
**Source:** `projects/client/src/index.ts`

### Commands

```bash
# Register app IDs
escreg register 1001,1002,1003 --app-id 16382607
escreg register --file app-ids.txt --concurrency 4 --skip-check

# Lookup addresses
escreg lookup ADDR1,ADDR2 --app-id 16382607
escreg lookup --file addresses.txt --concurrency 4

# Convert app IDs to escrow addresses (local, no network)
escreg convert 1001,1002,1003

# Withdraw funds (admin only)
escreg withdraw 1000000 --app-id 16382607
```

### Configuration

Set via CLI flags, environment variables, or a `.env` file:

| Variable | Flag | Description |
|---|---|---|
| `ALGOD_HOST` | `--algod-host` | Algorand node host |
| `ALGOD_PORT` | `--algod-port` | Algorand node port |
| `ALGOD_TOKEN` | `--algod-token` | Algorand node token |
| `APP_ID` | `--app-id` | Escreg application ID (required) |
| `MNEMONIC` | `--mnemonic` | Account mnemonic for write operations |
| `ADDRESS` | `--address` | Account address (for rekeyed accounts) |
| `CONCURRENCY` | `--concurrency` | Parallel request count (default: 1) |

### Build

```bash
cd projects/client
npm install
npm run build           # compile TypeScript
npm run build:exe       # build standalone executables (linux/macos/windows)
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
