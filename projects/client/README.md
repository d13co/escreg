# @d13co/escreg

[![npm](https://img.shields.io/npm/v/@d13co/escreg)](https://www.npmjs.com/package/@d13co/escreg)

Command-line client for the [Escreg](https://github.com/d13co/escreg) on-chain escrow registry on Algorand.

## Quick start

```bash
# Run directly with npx (no install needed)
npx @d13co/escreg lookup ADDR1,ADDR2

# Or install globally
npm install -g @d13co/escreg
escreg lookup ADDR1,ADDR2
```

## Build from source

```bash
npm install
npm run build:ts              # compile TypeScript only
npm run build                 # compile + build standalone executables via Bun
```

## Commands

### register

Register application IDs with the Escreg contract.

```bash
escreg register 123,456,789
escreg register --file app-ids.txt --concurrency 4 --skip-check
```

### lookup

Look up addresses to find registered application IDs.

```bash
escreg lookup ADDR1,ADDR2
escreg lookup --file addresses.txt --concurrency 4
```

### convert

Convert application IDs to escrow addresses (local, no network call).

```bash
escreg convert 123,456,789
escreg convert --file app-ids.txt
```

### deposit-credits

Deposit MBR credits before registering app IDs (amount in Algos).

```bash
escreg deposit-credits 1                    # deposit 1 Algo
escreg deposit-credits 0.5 --creditor ADDR  # credit a different account
```

### credits

Check MBR credit balances.

```bash
escreg credits ADDR1,ADDR2
escreg credits --file addresses.txt
escreg credits --all
```

### withdraw-credits

Withdraw all remaining MBR credits.

```bash
escreg withdraw-credits
```

### withdraw

Withdraw funds from the contract (admin only, amount in Algos).

```bash
escreg withdraw 1
```

## Configuration

Defaults to the Fnet deployment (app ID `16954321`, Nodely Fnet endpoint). Override via CLI flags, environment variables, or a `.env` file. Set `ENV` to load environment-specific files (e.g. `ENV=testnet` loads `.env.testnet`).

| Variable | Flag | Default | Description |
|---|---|---|---|
| `ALGOD_HOST` | `--algod-host` | `fnet-api.4160.nodely.dev` | Algorand node host |
| `ALGOD_PORT` | `--algod-port` | `443` | Algorand node port |
| `ALGOD_TOKEN` | `--algod-token` | (empty) | Algorand node token |
| `APP_ID` | `--app-id` | `16954321` | Escreg application ID |
| `MNEMONIC` | `--mnemonic` | | Account mnemonic for write operations |
| `ADDRESS` | `--address` | | Account address (for rekeyed accounts) |
| `CONCURRENCY` | `--concurrency` | `1` | Parallel request count |

All commands support `--debug` for verbose logging.
