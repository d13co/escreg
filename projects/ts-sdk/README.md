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
| `addressesPerGroup` | `number` | Addresses `lookup` resolves per simulate group, 1 to 256. Defaults to 256 |

The deployed instance on Fnet contains registrations for all Algorand networks (mainnet, testnet, fnet, betanet) as well as app IDs 1,001-100,000 for localnet lookups. To use it, either pass no `algorand` client (the default) or pass one configured for Fnet.

#### Tuning `addressesPerGroup`

Each group is one round trip, so this sets how many round trips a lookup costs. Every address a group
resolves costs one box reference, and past 128 of them the group has to name each box in an AVM 13
access list — which is what allows 256 in a trip, but fills the group's remaining transaction slots
with carriers that name boxes and look nothing up.

256 is the ceiling: 16 references per transaction over a group's 16 transactions. Filling it costs no
extra transaction, since those slots are already spoken for by the references — the addresses past the
second whole `getList` call simply land in a slot that would otherwise carry nothing.

The default assumes the node is across a network, where a saved round trip is worth far more than the
extra transactions: against a public endpoint at concurrency 1 it resolves about a third more
addresses per second than a group of 127 would.

**Anything running beside its node should pass `addressesPerGroup: 127`.** With no latency to hide,
those carriers are pure overhead — a co-located or local node is 25-35% slower at 256 than at 127. 127
also sends one `getList` call per round trip and no access lists at all, so it works against nodes
predating AVM 13.

```typescript
// worker or service sharing a host with its algod
const sdk = new EscregSDK({ algorand, addressesPerGroup: 127 })
```

Lookups smaller than the group size are unaffected either way: a group only reaches for access lists
once it passes 128 addresses, so a lookup of 50 goes out as a single plain call regardless.

### Key behaviors

- **Register:** chunks app IDs into groups of 7 per transaction, 15 transactions per atomic group. Automatically prepends `increaseBudget` calls when opcode budget is insufficient. Retries failed chunks.
- **Lookup:** uses `simulate` with `allowEmptySignatures` so no signing key is needed. Resolves up to `addressesPerGroup` addresses (256 by default) per round trip, in `getList` calls of 127. On a node that will not take a full-size call or will not honour access lists, it steps down once — with a warning — and carries on at the pre-AVM-13 shape of 63 per call and 126 per group.
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
