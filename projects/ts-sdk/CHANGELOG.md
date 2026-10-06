# Changelog

## 1.0.0 — Unreleased

### Breaking

- **The default deployment moved from Fnet to Testnet.** With no `appId`, both entry points now target app `773212345` — lookups and `/full` writes alike — and with no client they talk to `https://testnet-api.4160.nodely.dev`. To keep using the Fnet instance, pass `appId: 16954321n` with a client configured for Fnet; callers who already pass their own Fnet `algorand` or `algod` but no `appId` must now add it. The Testnet instance holds the same registrations as Fnet, and extends the localnet range from app IDs 1,001-100,000 to 1,001-200,000.

### Added

- **Contract errors carry the value the contract logged with them.** The contract now logs its errors (ARC-65) and can append a value to the code, as in `ERR:CRD::7300`. The wrapped error puts that value into its message — `Error CRD: Insufficient credits to cover MBR increase, deficit 7300 microALGO` — and exposes it as `value`. `code` and `description` are set as before.

### Changed

- **`register` sends each group without waiting for the previous one to confirm.** Confirmations are awaited in the background and the pass settles once they all have. Waiting on each group meant it reached the pool after the next block had been assembled, which left every other block empty.

### Fixed

- **A `register` retry re-checks the registry before re-sending.** Retry passes used to skip the lookup. A group whose confirmation poll timed out may still have landed, and re-sending it identically is rejected as already in the ledger, so the retry failed every time until the run aborted.

- **`getCredits({ all: true })` works on a large registry.** It listed every box name in the app to pick out the credit boxes, which algod refuses with "Result limit exceeded" past `MaxAPIBoxPerApplication` — as on the Testnet deployment. It now pages through only the `c`-prefixed boxes, values included, so it reads no box on its own. A node predating the paginated listing still answers with every box name and still hits the limit.

## 0.1.1 — 2026-09-10

The package is now two entry points — a lookup-only default and `/full` — and the on-chain registry has been fully migrated to the packed bucket layout, so everything that existed to read or convert the legacy ARC-4 `uint64[]` layout is removed.

### Breaking

- **`@d13co/escreg-sdk` is now the lookup half of the SDK.** It exports an `EscregSDK` with `lookup`, the pure decoders (`boxCursor`, `decodeBucket`) and every type, and depends on algosdk alone — no algokit-utils, no generated client, no ARC-56 app spec. Bundled and minified it is 343 KB against the old 654 KB, or 81 KB gzipped against 151 KB.
- **Everything else moved to `@d13co/escreg-sdk/full`**: `register`, `depositCredit`, `withdrawCredit`, `getCredits`, `deleteBoxes`, `withdraw`, `scanBuckets`, `scanBucketPages`. Its `EscregSDK` extends the light one, so an import that only changes to `/full` keeps working exactly as it did — the constructor, `lookup`, and every method signature are unchanged.
- **`@algorandfoundation/algokit-utils` is now an optional peer dependency.** Only `/full` is built on it, so npm no longer installs it alongside the SDK; install it explicitly if you import `/full`. `algosdk` stays a required peer at `^3.6.0`.
- **The ESM build declares itself as ESM.** `dist/esm` now carries `{"type":"module"}` and its relative imports are extension-qualified, so Node loads it as the ESM half of the package instead of failing on it. Bundlers are unaffected.

### Removed

- `findLegacyBoxes` and `migrateBoxes` — there are no legacy boxes left to find or convert. `migrateBoxes(bytes<4>[])` is also removed from the contract ABI.
- `bucketHeaderLen` — buckets no longer carry a header; `decodeBucket(value)` takes the raw box value as-is.
- The `BucketVersion` type and the `version` field on `RegistryBucket` — every bucket is packed.
- `ERR:BKT` from the error map.

### Added

- `algod` on the constructor — an `Algodv2` to read from, for a caller who has no `AlgorandClient` and no reason to build one. `algorand` still wins when both are given, and the light entry point accepts anything carrying a `client.algod`, so an `AlgorandClient` still passes as-is without the light bundle importing algokit-utils.
- `npm run check:abi` — holds the `getList` signature the lookup path declares against the contract's own app spec, so the two cannot drift. Runs as part of `prebuild`.
- `addressesPerGroup` on the constructor — addresses `lookup` resolves per simulate group, 1 to 256, default **256** — the ceiling of 16 references per transaction over a group's 16 transactions. Anything above 128 makes the group name every box it reads in an access list, which is what raises the ceiling past what `allowUnnamedResources` will pool, at the cost of filling the group's remaining transaction slots with carriers. Worth it when a round trip is expensive — against a public node at concurrency 1 it resolves about a third more addresses per second — and not when it is cheap, where the carriers make it slower. Pass 127 or lower for one `getList` call per round trip and no access lists.

### Changed

- The `algosdk` peer range stays at `^3.6.0`, now measured rather than assumed: every 3.x was built and run against fnet. `lookup` needs **3.5.0**, where the `access` field and `ResourceReference` arrive — below it there is nowhere to name box references, so every group falls back to unnamed ones and 127 addresses per round trip, with correct results either way. `/full` needs **3.6.0** for the registry scan alone: `getApplicationBoxes(...).limit()` does not exist before it, and nothing else in the package does. The range is the floor for the package as a whole, so it is the higher of the two.
- `algosdk` and `@algorandfoundation/algokit-utils` are now devDependencies as well as peers, so the package builds and typechecks on its own rather than off whatever the workspace happens to hoist.
- `lookup` builds its groups straight from algosdk's `AtomicTransactionComposer` rather than the generated client's composer, on both the named and unnamed box reference paths. It sends the same transactions and behaves identically; it is what lets the lookup path stay off algokit-utils.
- The `p-map` dependency is gone, replaced by the twenty lines of it the SDK used. The package now has no runtime dependencies at all. `concurrency` behaves as it did: results in input order, the first rejection thrown, no further items started.
- **`lookup` sends 127 addresses per `getList` call, up from 63.** AVM 13 raised the app argument budget to 16KB; the per-argument cap of 4096 bytes now sets the size, and 127 addresses encode to 4066. Nothing in the signature changed.
- `lookup` steps itself down on a node that cannot keep up, once per SDK instance and with a warning each time: first to unnamed box references, then to 63 addresses per call, which is the pre-AVM-13 shape. `addressesPerCall` and `addressesPerGroup` are public if you would rather pin them.
- The read-only `getList` calls now carry an explicit 5000 microAlgo fee, since fnet prices transactions by usage and a full argument list costs more than the minimum. They only ever run through simulate, so it is never actually paid.
- The registry scan now rejects any box whose size is not a multiple of 8 as malformed, instead of classifying it as legacy.

## 0.1.0 — 2026-08-05

The packed bucket layout, registry scanning, and legacy bucket migration.

0.0.4 through 0.0.6 were never published, so everything below is relative to **0.0.3**, the previous release on npm. No existing method changed its signature, arguments, or return type, and nothing was removed from the public API — the two breaking items are an install requirement and a default-client change.

### Breaking

- **Peer dependency `algosdk` moved from `^3.0.0` to `^3.6.0`.** The registry scan uses algod's paginated box listing builder (`.limit()`, `.include('values')`, `.next()`) and `base64ToBytes`/`bytesToBase64`, none of which exist in earlier 3.x. npm 7 and newer fail the install rather than warn, so upgrade algosdk in the same step.
- **The default Fnet client no longer configures an indexer.** Nothing in the SDK reads from indexer any more, so `fnetNodelyClient` — what `new EscregSDK({})` falls back to — is algod-only. `sdk.algorand` is public, so code reaching for `sdk.algorand.client.indexer` on a default-constructed SDK now throws. Pass your own `AlgorandClient` if you need an indexer on the same instance.

### Added

- `scanBucketPages({ pageSize, next, concurrency, debug })` — streams the registry from algod's box listing, one page of boxes and their values per request, yielding decoded buckets with the cursor and round for each page. A registry of millions of boxes streams in constant memory.
- `scanBuckets(...)` — the same scan flattened to an async iterable of individual buckets.
- `findLegacyBoxes({ pageSize, concurrency, debug })` — returns the keys of boxes still in the legacy ARC-4 layout, each with its size (`SizedBoxKey[]`), which is what sizing a migration transaction's box references needs.
- `migrateBoxes({ boxes, concurrency, debug })` — converts those boxes to the packed layout and returns `{ txIds, migrated }`, where `migrated` is the count the contract itself reports, not the count submitted. Admin only. Batches keys to the box budget they need, so a bucket larger than one box reference covers is sent with the padding references its read and write budget takes.
- `boxCursor(name)` — builds a listing cursor from the name of the last box you finished with, so an interrupted scan resumes mid-page instead of from the top.
- `bucketHeaderLen(size)` and `decodeBucket(value)` — decode a raw bucket box value; `bucketHeaderLen` gives the header length to skip when the value may be legacy.
- Types `RegistryBucket`, `BucketPage`, `BucketVersion`, and `SizedBoxKey`.
- `ERR:BKT` in the error map: a bucket whose size matches neither layout.

### Changed

- `deleteBoxes` now shares its send path with `migrateBoxes`. Batching (8 keys per transaction, 15 transactions per group), box references, and the `string[]` of transaction IDs it returns are all unchanged; only its debug log wording differs.

### Contract changes visible through the SDK

These land when the deployed app is updated, independently of the SDK version.

- Registry buckets are stored as packed big-endian 8-byte app IDs with no length header, so **a new bucket now costs 7,300 microAlgos of MBR instead of 8,100** (appending to one is unchanged at 3,200). Code that pre-computes a deposit will over-deposit, which is safe — the credit stays on the account — but an exact-cost assertion will need updating.
- Buckets written before this layout are still read correctly, with no version flag and no migration deadline: a legacy bucket's size is 2 mod 8 and a packed one's is 0 mod 8, so the two can never be confused. Registering a new app ID into a legacy bucket converts it as a side effect, so writes drift toward the packed layout on their own.
- The MBR freed by `migrateBoxes` is not credited back to any account. It stays in the contract balance for the admin to `withdraw`, so a reconciliation of "contract balance equals credits plus MBR" has to account for it.
- Lookups read one candidate at a time rather than the whole box, so a bucket can now grow past the 4096-byte AVM value limit, up to the 32,768-byte box limit. The budget rule is unchanged — 1024 bytes of read budget per distinct box reference, pooled across the group — but the ceiling moved, so a caller building its own read calls may need more references than the four that always sufficed before. `lookup()` is unaffected: it simulates with `allowUnnamedResources`, and algod fills the references in.
- `migrateBoxes(bytes<4>[]) -> uint64` is added to the ABI. Every other method keeps its exact signature, so existing selectors and callers are untouched.

### Node requirements

`scanBucketPages`, `scanBuckets`, and `findLegacyBoxes` need a node with the paginated box listing, which is go-algorand 4.7 or newer — the public API nodes qualify, the AlgoKit LocalNet image (4.4) does not. An older node ignores the paging and answers with every box name in one response, which the SDK falls back to fetching values for with bounded `concurrency`; that path still fails with "Result limit exceeded" past the node's `MaxAPIBoxPerApplication`. A *resumed* scan on such a node is refused outright rather than replaying boxes the caller has already processed.
