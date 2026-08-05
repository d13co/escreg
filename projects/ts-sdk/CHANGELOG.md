# Changelog

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
