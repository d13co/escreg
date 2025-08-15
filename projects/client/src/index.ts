#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { getConfig } from './config';
import { handleRegisterCommand, handleLookupCommand, handleConvertCommand } from './commands';

async function main() {
  const config = getConfig();

  // Get the proper script name for help display
  const scriptName = process.argv0?.includes('bun') || process.argv[0]?.includes('bun') 
    ? 'escreg' 
    : process.argv[1]?.split('/').pop()?.replace(/\.(js|ts)$/, '') || 'escreg';

  yargs(hideBin(process.argv))
    .scriptName(scriptName)
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
      description: 'Account mnemonic for signing transactions',
    })
    .option('address', {
      type: 'string',
      description: 'Account address (optional, required when account is rekeyed)',
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
          default: config.concurrency,
          description: 'Number of concurrent requests',
        })
        .option('debug', {
          type: 'boolean',
          default: config.debug,
          description: 'Enable debug mode for SDK operations',
        })
        .option('skip-check', {
          type: 'boolean',
          default: config.skipCheck,
          description: 'Skip validation checks before registration',
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
          default: config.concurrency,
          description: 'Number of concurrent requests',
        })
        .option('debug', {
          type: 'boolean',
          default: config.debug,
          description: 'Enable debug mode for lookup operations',
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


