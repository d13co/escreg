#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { getConfig } from './config';
import { handleRegisterCommand, handleLookupCommand, handleConvertCommand } from './commands';

async function main() {
  const config = getConfig();

  yargs(hideBin(process.argv))
    .option('algod-host', {
      type: 'string',
      default: config.algodHost,
      description: 'Algorand node host',
    })
    .option('algod-port', {
      type: 'number',
      default: config.algodPort,
      description: 'Algorand node port',
    })
    .option('algod-token', {
      type: 'string',
      default: config.algodToken,
      description: 'Algorand node token',
    })
    .option('app-id', {
      type: 'string',
      default: config.appId,
      description: 'Escreg application ID',
      demandOption: true,
    })
    .option('mnemonic', {
      type: 'string',
      default: config.mnemonic,
      description: 'Account mnemonic for signing transactions',
    })
    .option('address', {
      type: 'string',
      default: config.address,
      description: 'Account address (optional, will be derived from mnemonic if not provided)',
    })
    .command('register [app-ids]', 'Register application IDs', (yargs: any) => {
      return yargs
        .positional('app-ids', {
          type: 'string',
          description: 'Comma-separated app IDs (required if --file is not provided)',
        })
        .option('file', {
          type: 'string',
          description: 'File path containing app IDs (one per line)',
        })
        .option('concurrency', {
          type: 'number',
          default: 1,
          description: 'Number of concurrent requests (default: 1)',
        })
        .check((argv: any) => {
          if (!argv.file && !argv.appIds) {
            throw new Error('Either app-ids argument or --file option must be provided');
          }
          return true;
        });
    }, handleRegisterCommand)
    .command('lookup [addresses]', 'Lookup addresses', (yargs: any) => {
      return yargs
        .positional('addresses', {
          type: 'string',
          description: 'Comma-separated addresses (required if --file is not provided)',
        })
        .option('file', {
          type: 'string',
          description: 'File path containing addresses (one per line)',
        })
        .option('concurrency', {
          type: 'number',
          default: 1,
          description: 'Number of concurrent requests (default: 1)',
        })
        .check((argv: any) => {
          if (!argv.file && !argv.addresses) {
            throw new Error('Either addresses argument or --file option must be provided');
          }
          return true;
        });
    }, handleLookupCommand)
    .command('convert [app-ids]', 'Convert application IDs to addresses', (yargs: any) => {
      return yargs
        .positional('app-ids', {
          type: 'string',
          description: 'Comma-separated app IDs (required if --file is not provided)',
        })
        .option('file', {
          type: 'string',
          description: 'File path containing app IDs (one per line)',
        })
        .check((argv: any) => {
          if (!argv.file && !argv.appIds) {
            throw new Error('Either app-ids argument or --file option must be provided');
          }
          return true;
        });
    }, handleConvertCommand)
    .demandCommand(1, 'You must specify a command: register, lookup, or convert')
    .help()
    .argv;
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});


