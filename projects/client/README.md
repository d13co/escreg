# Escreg Client

A command-line client for interacting with the Escreg smart contract.

## Installation

```bash
npm install
npm run build
```

## Usage

### Register Application IDs

Register one or more application IDs with the Escreg contract.

```bash
# Register a single app ID
node dist/index.js register 123

# Register multiple app IDs (comma-separated)
node dist/index.js register 123,456,789

# Register app IDs from a file (one per line)
node dist/index.js register app-ids.txt

# Register with custom concurrency (parallel processing)
node dist/index.js register 123,456,789 --concurrency 5

# Register with debug output and skip validation checks
node dist/index.js register 123,456,789 --debug --skip-check
```

### Lookup Addresses

Lookup addresses to find registered application IDs.

```bash
# Lookup a single address
node dist/index.js lookup ABCDEFGHIJKLMNOPQRSTUVWXYZ234567

# Lookup multiple addresses (comma-separated)
node dist/index.js lookup ABCDEFGHIJKLMNOPQRSTUVWXYZ234567,BCDEFGHIJKLMNOPQRSTUVWXYZ234567A

# Lookup addresses from a file (one per line)
node dist/index.js lookup addresses.txt

# Lookup with custom concurrency (parallel processing)
node dist/index.js lookup ABCDEFGHIJKLMNOPQRSTUVWXYZ234567,BCDEFGHIJKLMNOPQRSTUVWXYZ234567A --concurrency 10

# Lookup with debug output to show progress
node dist/index.js lookup ABCDEFGHIJKLMNOPQRSTUVWXYZ234567,BCDEFGHIJKLMNOPQRSTUVWXYZ234567A --debug
```

### Withdraw Funds

Withdraw funds from the Escreg contract (admin only).

```bash
# Withdraw 1000 microAlgos from the contract
node dist/index.js withdraw 1000

# Withdraw with debug output
node dist/index.js withdraw 1000 --debug

# Withdraw 1 Algo (1,000,000 microAlgos)
node dist/index.js withdraw 1000000
```

## Configuration

The client supports environment-specific configuration files. Set the `ENV` environment variable to load different configuration files:

- **Default**: Loads `.env` file
- **ENV=local**: Loads `.env.local` file  
- **ENV=testnet**: Loads `.env.testnet` file
- **ENV=mainnet**: Loads `.env.mainnet` file

### Environment Files

Set environment variables in a `.env` file (or environment-specific file):

```env
ALGOD_HOST=localhost
ALGOD_PORT=4001
ALGOD_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
APP_ID=123
MNEMONIC="your mnemonic phrase here"
ADDRESS=your-account-address
CONCURRENCY=1
DEBUG=false
SKIP_CHECK=false
```

### Usage Examples

```bash
# Use default .env file
node dist/index.js register 123,456,789

# Use .env.local file for local development
ENV=local node dist/index.js register 123,456,789

# Use .env.testnet file for testnet operations
ENV=testnet node dist/index.js lookup addresses.txt

# Use .env.mainnet file for mainnet operations  
ENV=mainnet node dist/index.js withdraw 1000000
```

## Command Options

### Registration Options

The `register` command supports additional options to control its behavior:

- **`--debug`**: Enable debug mode for SDK operations (shows detailed logging)
- **`--skip-check`**: Skip validation checks during registration (faster but less safe)

These options can be set via CLI arguments or environment variables (`DEBUG` and `SKIP_CHECK`).

### Lookup Options

The `lookup` command supports additional options to control its behavior:

- **`--debug`**: Enable debug mode for lookup operations (shows chunk processing progress and results)

### Withdraw Options

The `withdraw` command supports additional options to control its behavior:

- **`--debug`**: Enable debug mode for withdrawal operations (shows withdrawal progress and transaction details)

### Examples

```bash
# Register with debug output enabled
node dist/index.js register 123,456,789 --debug

# Register without validation checks (faster)
node dist/index.js register 123,456,789 --skip-check

# Register with both debug and skip-check enabled
node dist/index.js register 123,456,789 --debug --skip-check

# Lookup with debug output to see progress
node dist/index.js lookup addresses.txt --debug

# Withdraw funds with debug output
node dist/index.js withdraw 1000000 --debug
```

## Parallel Processing

The client now supports parallel processing using the `--concurrency` flag:

- **register**: Processes chunks of up to 7 app IDs per transaction in parallel
- **lookup**: Processes chunks of up to 8 addresses per transaction in parallel
- **withdraw**: Admin-only operation to withdraw funds from the contract

The concurrency parameter controls how many chunks are processed simultaneously. Higher values can improve performance but may be limited by network capacity and rate limits.

### Examples

```bash
# Process 5 chunks simultaneously (up to 35 app IDs in parallel for register)
node dist/index.js register app-ids.txt --concurrency 5

# Process 10 chunks simultaneously (up to 80 addresses in parallel for lookup)
node dist/index.js lookup addresses.txt --concurrency 10
```

## File Format

### App IDs File
```
123
456
789
```

### Addresses File
```
ABCDEFGHIJKLMNOPQRSTUVWXYZ234567
BCDEFGHIJKLMNOPQRSTUVWXYZ234567A
CDEFGHIJKLMNOPQRSTUVWXYZ234567AB
```

## Limits

- **register**: Maximum 112 app IDs per operation (16 chunks of 7)
- **lookup**: Maximum 128 addresses per operation (16 chunks of 8)
- **concurrency**: No hard limit, but consider network capacity and rate limits
