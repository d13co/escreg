# @d13co/escreg-sdk

[![npm](https://img.shields.io/npm/v/@d13co/escreg-sdk)](https://www.npmjs.com/package/@d13co/escreg-sdk)

TypeScript SDK for the [Escreg](https://github.com/d13co/escreg) on-chain escrow registry on Algorand.

Given any Algorand address, Escreg lets you answer: "Is this address an application escrow, and if so, which app ID owns it?"

The SDK wraps the generated typed client with batching, chunking, simulation-based lookups, and automatic opcode budget management.

## Install

```bash
npm install @d13co/escreg-sdk
```

Peer dependencies: `@algorandfoundation/algokit-utils` and `algosdk`.

## Usage

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

// Check credit balances for specific addresses
const credits = await sdk.getCredits({
  addresses: ['A7NMWS3NT3IU...'],
})
// credits: { 'A7NMWS3NT3IU...': 950000n }

// Or get all credit balances
const allCredits = await sdk.getCredits({ all: true })
```

### Constructor options

All options are optional and default to the current Fnet deployment.

| Option | Type | Description |
|---|---|---|
| `appId` | `bigint` | Escreg application ID |
| `algorand` | `AlgorandClient` | Algorand client instance |
| `writerAccount` | `TransactionSignerAccount` | Signing account for write operations |
| `readerAccount` | `string` | Address used as sender for read-only simulate calls |

The deployed instance on Fnet contains registrations for all Algorand networks (mainnet, testnet, fnet, betanet) as well as app IDs 1,001-100,000 for localnet lookups. To use it, either pass no `algorand` client (the default) or pass one configured for Fnet.

### Key behaviors

- **Register:** chunks app IDs into groups of 7 per transaction, 15 transactions per atomic group. Automatically prepends `increaseBudget` calls when opcode budget is insufficient. Retries failed chunks.
- **Lookup:** uses `simulate` with `allowEmptySignatures` so no signing key is needed. Chunks up to 128 addresses per simulate call.
- **MBR credits:** before registering, deposit credits via `depositCredit()` to cover box storage costs. Withdraw unused credits with `withdrawCredit()`.

## API

| Method | Description |
|---|---|
| `lookup({ addresses, concurrency })` | Batch lookup addresses to app IDs (read-only, no signer needed) |
| `register({ appIds, concurrency, skipCheck })` | Batch register app IDs (requires `writerAccount`) |
| `depositCredit({ creditor, amount })` | Deposit MBR credits for an account |
| `withdrawCredit()` | Withdraw all remaining MBR credits |
| `getCredits({ addresses?, all? })` | Check MBR credit balances for specific addresses or all accounts |
| `deleteBoxes({ boxKeys, concurrency })` | Delete registry boxes by key (admin only) |
| `withdraw({ amount })` | Withdraw funds from the contract (admin only) |

## License

ISC
