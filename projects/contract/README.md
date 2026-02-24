# escreg/contract

Smart contracts for the Escreg on-chain escrow registry, written in [Algorand TypeScript (PuyaTS)](https://github.com/algorandfoundation/puya-ts).

## Contracts

### MbrManager (base contract)

**Source:** `smart_contracts/mbr-manager/contract.algo.ts`

A reusable base contract that implements a pre-paid credit system for box storage MBR costs. Users deposit credits before performing box-creating operations, and the `manageMbrCredits(mbrBefore)` hook automatically debits or credits their balance based on the MBR delta.

See the [root README](../../README.md#mbr-manager-base-contract) for full documentation.

### Escreg (registry contract)

**Source:** `smart_contracts/escreg/contract.algo.ts`

The registry contract. Extends `MbrManager` so callers pre-fund credits before registering app IDs (which allocates box storage). State is stored in a `BoxMap<bytes<4>, uint64[]>` keyed by the first 4 bytes of each app's escrow address. Multiple app IDs can share a prefix bucket; exact matches are resolved by recomputing the full address at runtime.

See the [root README](../../README.md#escreg-contract) for the full method reference.

## Prerequisites

- [Node.js 22](https://nodejs.org/en/download) or later
- [AlgoKit CLI](https://github.com/algorandfoundation/algokit-cli)
- [Docker](https://www.docker.com/) (for LocalNet)

## Build & Deploy

```bash
npm install
npm run build    # compile to TEAL + generate typed client & artifacts
npm run deploy   # deploy (requires DEPLOYER_MNEMONIC in .env)
npm test         # run tests via vitest on LocalNet
```

## Testing

Tests use [vitest](https://vitest.dev/) against AlgoKit LocalNet. Start the local network before running tests:

```bash
algokit localnet start
npm test
```
