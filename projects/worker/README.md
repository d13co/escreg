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
| `INDEXER_TOKEN` | Optional indexer API token, sent as `X-Indexer-API-Token` (secret) |

### KV namespace

The `STATE` KV namespace stores indexer cursors keyed as `cursor:<network>`.

## Development

```bash
npm install
wrangler secret put MNEMONIC   # set the signing account mnemonic
wrangler dev                   # local development
wrangler deploy                # deploy to Cloudflare
```

## Running locally as a standalone backup

The same watcher can run on a plain server (no Cloudflare) as an independent
backup. It reuses `watcher.ts` verbatim, swapping the Cloudflare KV `STATE`
binding for a local JSON cursor file (`src/store.ts`). Its cursors are
**independent** of the deployed Worker — you seed it from a known app ID and it
tracks its own progress. Registration is idempotent, so running both the Worker
and a local backup at once is safe (at worst it duplicates work).

Requires Node 18+ (uses global `fetch`). Run via the bundled `tsx`:

```bash
npm install

# Provide the signing account. Either export env vars, or copy the template:
cp .dev.vars.example .dev.vars   # then fill in MNEMONIC (and SENDER if rekeyed)

# 1. Seed each network's cursor from a known app ID (one-time):
npm run local:seed -- mainnet 3000000
npm run local:seed -- fnet 1000

# 2. Inspect cursors at any time:
npm run local:status

# 3a. Run the loop (one pass per minute, like the cron):
npm run local

# 3b. ...or run a single pass and exit (drive it from system cron instead):
npm run local:tick
```

### Configuration

| Env var | Default | Description |
|---|---|---|
| `MNEMONIC` | — | Signing account mnemonic (required to register) |
| `SENDER` | — | Optional sender address override (rekeyed accounts) |
| `INDEXER_TOKEN` | — | Optional indexer API token (`X-Indexer-API-Token` header) |
| `STATE_FILE` | `./.local-state/cursors.json` | Cursor file path |
| `INTERVAL_MS` | `60000` | Poll interval for `npm run local` |

### Keeping it alive

**systemd** (`/etc/systemd/system/escreg-watcher.service`):

```ini
[Unit]
Description=escreg watcher (local backup)
After=network-online.target

[Service]
WorkingDirectory=/opt/escreg/projects/worker
ExecStart=/usr/bin/npm run local
Restart=always
RestartSec=10
Environment=STATE_FILE=/var/lib/escreg/cursors.json
# MNEMONIC/SENDER come from .dev.vars in WorkingDirectory, or set them here.

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now escreg-watcher
journalctl -u escreg-watcher -f
```

**pm2:**

```bash
pm2 start npm --name escreg-watcher -- run local
pm2 save
```

**System cron** (drives `tick` instead of the internal loop):

```cron
* * * * * cd /opt/escreg/projects/worker && /usr/bin/npm run local:tick >> /var/log/escreg.log 2>&1
```
