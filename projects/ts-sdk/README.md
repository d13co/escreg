# @d13co/escreg-sdk

[![npm](https://img.shields.io/npm/v/@d13co/escreg-sdk)](https://www.npmjs.com/package/@d13co/escreg-sdk)

> [!WARNING]
> **Escreg has migrated from FNet to TestNet ([App ID 773212345](https://lora.algokit.io/testnet/application/773212345)).** The FNet registry is maintained until Nov 5th, 2026; after that it throws `ERR:FNET_DEPRECATED` for all queries. Upgrade to the latest SDK/CLI (v1.0.0+). Details: [#2](https://github.com/d13co/escreg/issues/2)

TypeScript SDK for the [Escreg](https://github.com/d13co/escreg) on-chain escrow registry on Algorand.

Given any Algorand address, Escreg lets you answer: "Is this address an application escrow, and if so, which app ID owns it?"

The SDK batches, chunks, and simulates those lookups, and — through its second entry point — wraps the generated typed client with registration, MBR credits, the registry scan, and automatic opcode budget management.

## Install

```bash
npm install @d13co/escreg-sdk
```

### Peer dependencies

`algosdk` — `^3.6.0`, required. Looking addresses up needs nothing else.

`@algorandfoundation/algokit-utils` — `^9`, *optional*: it is what the `/full` entry point is built
on, so install it too if you import that one.

```bash
npm install @d13co/escreg-sdk @algorandfoundation/algokit-utils
```

3.6.0 is the lowest algosdk every part of the package works on. Measured against fnet across the 3.x
line:

| algosdk | `lookup` | `/full` |
|---|---|---|
| 3.6.0+ | works | works |
| 3.5.x | works — AVM 13 access lists land in 3.5.0 | everything except the registry scan: algod's paginated box listing (`.limit()`, `.include()`, `.next()`) arrives in 3.6.0 |
| 3.0.0-3.4.x | correct results, but with no `access` field to name box references in, every group falls back to unnamed ones and 127 addresses per round trip | as above |

Nothing below 3.6.0 returns a wrong answer; it either loses the 256-address round trip or throws on
the scan. A lookup-only consumer pinned to 3.5.x can override the peer range and lose nothing.

## Two entry points

| Import | Carries | Bundled, minified |
|---|---|---|
| `@d13co/escreg-sdk` | `lookup` and the pure decoders. algosdk only — no algokit-utils, no generated client, no app spec. | 343 KB (81 KB gzipped) |
| `@d13co/escreg-sdk/full` | Everything: registration, MBR credits, the registry scan, admin methods. | 654 KB (151 KB gzipped) |

Both rows bundle algosdk, which a consumer ships either way — it is a required peer. Measured on top
of an app that already has it, the SDK's own code is **4.8 KB** minified (2.3 KB gzipped) for the
light entry point and **32 KB** (8.9 KB) for the full one, over half of that the generated client's
ARC-56 app spec. Nearly all of the 310 KB between the two rows is algokit-utils.

Both export a class called `EscregSDK`, and the full one **extends** the light one, so anything the
light entry point does the full one does identically. Reach for `/full` when you need to write to the
registry or scan it; import the default when all you do is look addresses up, which is most consumers
and every browser one.

```typescript
import { EscregSDK } from '@d13co/escreg-sdk'        // lookups
import { EscregSDK } from '@d13co/escreg-sdk/full'   // lookups + everything else
```

## Usage

```typescript
import { EscregSDK } from '@d13co/escreg-sdk'

// Defaults to the current Testnet deployment (app ID 773212345, Nodely Testnet algod)
const sdk = new EscregSDK({})

// Lookup addresses (via simulation, no signing required)
const results = await sdk.lookup({
  addresses: ['A7NMWS3NT3IU...', 'B2XYZ...'],
  concurrency: 4,
})
// results: { 'A7NMWS3NT3IU...': 1001n, 'B2XYZ...': undefined }
```

Everything else lives behind `/full`:

```typescript
import { EscregSDK } from '@d13co/escreg-sdk/full'

// For write operations, pass a writerAccount
const writer = new EscregSDK({ writerAccount })

// Deposit MBR credits before registering (covers box storage costs)
await writer.depositCredit({
  creditor: writerAccount.addr.toString(),
  amount: 1_000_000n, // 1 Algo
})

await writer.register({ appIds: [1001n, 1002n, 1003n], concurrency: 4 })

// Check credit balances for specific addresses
const credits = await writer.getCredits({
  addresses: ['A7NMWS3NT3IU...'],
})
// credits: { 'A7NMWS3NT3IU...': 950000n }

// Or get all credit balances
const allCredits = await writer.getCredits({ all: true })
```

### Constructor options

All options are optional and default to the current Testnet deployment.

| Option | Type | Entry point | Description |
|---|---|---|---|
| `appId` | `bigint` | both | Escreg application ID |
| `algod` | `Algodv2` | both | Algod client to read from. Ignored when `algorand` is given |
| `algorand` | `AlgorandClient` | both | Algorand client instance; the light entry point takes anything carrying an `algod` |
| `readerAccount` | `string` | both | Address used as sender for read-only simulate calls |
| `addressesPerGroup` | `number` | both | Addresses `lookup` resolves per simulate group, 1 to 256. Defaults to 256 |
| `writerAccount` | `TransactionSignerAccount` | `/full` | Signing account for write operations |

The default Testnet instance contains registrations for all Algorand networks (mainnet, testnet, fnet, betanet) as well as app IDs 1,001-200,000 for localnet lookups. The Fnet instance (app ID `16954321`) holds the same, with localnet app IDs only up to 100,000. To use it, pass `appId: 16954321n` with a client configured for Fnet.

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

| Method | Entry point | Description |
|---|---|---|
| `lookup({ addresses, concurrency })` | both | Batch lookup addresses to app IDs (read-only, no signer needed) |
| `register({ appIds, concurrency, skipCheck })` | `/full` | Batch register app IDs (requires `writerAccount`) |
| `depositCredit({ creditor, amount })` | `/full` | Deposit MBR credits for an account |
| `withdrawCredit()` | `/full` | Withdraw all remaining MBR credits |
| `getCredits({ addresses?, all? })` | `/full` | Check MBR credit balances for specific addresses or all accounts |
| `scanBucketPages({ pageSize, next, concurrency })` | `/full` | Stream the registry a page of buckets at a time |
| `scanBuckets({ pageSize, next, concurrency })` | `/full` | The same scan, flattened to one bucket at a time |
| `deleteBoxes({ boxKeys, concurrency })` | `/full` | Delete registry boxes by key (admin only) |
| `withdraw({ amount })` | `/full` | Withdraw funds from the contract (admin only) |

`boxCursor(name)`, `decodeBucket(value)` and every type — `LookupResult`, `RegistryBucket`,
`BucketPage`, `SizedBoxKey` — are exported from both entry points.

## Development

```bash
npm run build          # generate the client, check the getList ABI, build cjs + esm
npm test               # unit tests
npm run test:coverage  # the same, with a coverage report
```

The unit tests stub algod, so they need no network and no LocalNet. What they cannot reach — the
registration and credit paths, which sign and send — is covered by the e2e suite in
`projects/contract`, which drives this SDK against a contract deployed to LocalNet.

## License

ISC
