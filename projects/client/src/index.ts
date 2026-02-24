#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { getConfig } from './config';
import { handleRegisterCommand, handleLookupCommand, handleConvertCommand, handleCreditsCommand, handleDepositCreditCommand, handleWithdrawCreditCommand, handleWithdrawCommand } from './commands';

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
          description: 'Enable debug mode',
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
          description: 'Enable debug mode',
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
    .command('credits [addresses]', 'Check MBR credit balances', (yargs: any) => {
      return yargs
        .positional('addresses', {
          type: 'string',
          description: 'Comma-separated addresses to check (or use --all)',
        })
        .option('file', {
          type: 'string',
          description: 'File path containing addresses (one per line)',
        })
        .option('all', {
          type: 'boolean',
          default: false,
          description: 'Check all accounts with MBR credits',
        })
        .option('debug', {
          type: 'boolean',
          default: config.debug,
          description: 'Enable debug mode',
        })
        .check((argv: any) => {
          if (!argv.file && !argv.addresses && !argv.all) {
            throw new Error('Either addresses argument, --file option, or --all flag must be provided');
          }
          return true;
        });
    }, handleCreditsCommand)
    .command('deposit-credits <amount>', 'Deposit MBR credits for registration', (yargs: any) => {
      return yargs
        .positional('amount', {
          type: 'string',
          description: 'Amount in Algos to deposit as credits',
          demandOption: true,
        })
        .option('creditor', {
          type: 'string',
          description: 'Address to credit (defaults to sender)',
        })
        .option('debug', {
          type: 'boolean',
          default: config.debug,
          description: 'Enable debug mode',
        });
    }, handleDepositCreditCommand)
    .command('withdraw-credits', 'Withdraw all MBR credits', (yargs: any) => {
      return yargs
        .option('debug', {
          type: 'boolean',
          default: config.debug,
          description: 'Enable debug mode',
        });
    }, handleWithdrawCreditCommand)
    .command('withdraw <amount>', 'Withdraw funds from the contract (admin)', (yargs: any) => {
      return yargs
        .positional('amount', {
          type: 'string',
          description: 'Amount in Algos to withdraw',
          demandOption: true,
        })
        .option('debug', {
          type: 'boolean',
          default: config.debug,
          description: 'Enable debug mode',
        });
    }, handleWithdrawCommand)
    // destroy command disabled while using minimal client for bundle size
    .demandCommand(1, 'You must specify a command: register, lookup, convert, credits, deposit-credits, withdraw-credits, or withdraw')
    .help()
    .argv;
}

main().catch((error) => {
  console.error('Unexpected error:', error.message);
  process.exit(1);
});


