# escreg

An on-chain registry for Algorand application escrow addresses. Given any Algorand address, escreg lets you answer: "Is this address an application escrow, and if so, which app ID owns it?"

Every Algorand application has a deterministic escrow address derived from its app ID (`sha512_256("appID" || appId)`).

This contract stores registered app IDs in box storage using a 4-byte address prefix bucketing scheme, enabling efficient lookups from address to app ID.

App escrow lookups work by iterating the 4-byte-prefix bucket corresponding to the input address, computing the app escrow on the fly from each application ID, and returning the app ID if a match is found. Offloading the computation to runtime allows us to store less: 4+8 bytes for a new bucket, or 8 bytes to add to an existing bucket.

This is currently deployed to Fnet as [App ID 16382607](https://lora.algokit.io/fnet/application/16382607).

## Project Structure

```
projects/
  contract/    # Algorand smart contract (PuyaTS)
  ts-sdk/      # TypeScript SDK
  client/      # CLI tool
  data/        # Test data (bulk app ID/address sets)
```

Workspace build order: `contract` -> `ts-sdk` -> `client`

## Contract

**Source:** `projects/contract/smart_contracts/escreg/contract.algo.ts`

Written in [Algorand TypeScript (PuyaTS)](https://github.com/algorandfoundation/puya-ts). State is stored in a `BoxMap<bytes<4>, uint64[]>` keyed by the first 4 bytes of each app's escrow address. Multiple app IDs can share a prefix bucket; exact matches are resolved by recomputing the full address.

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
| `increaseBudget(uint64)` | write | Add opcode budget via inner transactions |
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

**Package:** `escreg-sdk`
**Source:** `projects/ts-sdk/src/index.ts`

Wraps the generated typed client with batching, chunking, simulation-based lookups, and automatic opcode budget management.

### Usage

```typescript
import { EscregSDK } from 'escreg-sdk'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'

const algorand = AlgorandClient.fromConfig({ /* algod config */ })
const sdk = new EscregSDK({ appId: 16382607n, algorand, writerAccount })

// Register app IDs (batched, with retry logic)
await sdk.register({ appIds: [1001n, 1002n, 1003n], concurrency: 4 })

// Lookup addresses (via simulation, no signing required)
const results = await sdk.lookup({
  addresses: ['A7NMWS3NT3IU...', 'B2XYZ...'],
  concurrency: 4,
})
// results: { 'A7NMWS3NT3IU...': 1001n, 'B2XYZ...': undefined }
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
