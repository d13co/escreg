# escreg/worker

A Cloudflare Worker that automatically discovers and registers new Algorand application escrow addresses into the [Escreg](https://github.com/d13co/escreg) on-chain registry.

## How it works

Runs on a cron schedule (every minute). Each invocation:

1. Polls Algorand indexers across multiple networks (mainnet, testnet, fnet, betanet) for newly created applications
2. Batch-registers discovered app IDs via `@d13co/escreg-sdk`
3. Advances per-network cursors stored in Cloudflare KV

## HTTP endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/status` | Returns current cursor positions for all networks |
| POST | `/start/:network?appId=N` | Initialize a cursor for a network (fails if cursor already exists) |

## Configuration

### Environment variables

| Variable | Description |
|---|---|
| `MNEMONIC` | Account mnemonic for signing registration transactions (secret) |
| `SENDER` | Optional sender address override (for rekeyed accounts) |

### KV namespace

The `STATE` KV namespace stores indexer cursors keyed as `cursor:<network>`.

## Development

```bash
npm install
wrangler secret put MNEMONIC   # set the signing account mnemonic
wrangler dev                   # local development
wrangler deploy                # deploy to Cloudflare
```
