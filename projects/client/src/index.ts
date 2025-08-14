#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account';
import { EscregSDK } from 'escreg-sdk';
import { mnemonicToSecretKey, Algodv2, Account, Address, makeBasicAccountTransactionSigner, decodeAddress } from 'algosdk';

// Load environment variables from .env file if it exists
dotenv.config();

interface Config {
  algodHost: string;
  algodPort: number;
  algodToken: string;
  appId: string;
  mnemonic?: string;
  address?: string;
}

function getConfig(): Config {
  return {
    algodHost: process.env.ALGOD_HOST || 'localhost',
    algodPort: parseInt(process.env.ALGOD_PORT || '4001'),
    algodToken: process.env.ALGOD_TOKEN || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    appId: process.env.APP_ID || '',
    mnemonic: process.env.MNEMONIC,
    address: process.env.ADDRESS,
  };
}

function createAlgorandClient(config: Config): AlgorandClient {
  const algodClient = new Algodv2(config.algodToken, `http://${config.algodHost}:${config.algodPort}`, config.algodPort);

  return AlgorandClient.fromClients({
    algod: algodClient,
  });
}

function parseAppIdsFromArgs(input: string): bigint[] {
  return input.split(',').map(id => BigInt(id.trim()));
}

function parseAppIdsFromFile(filePath: string): bigint[] {
  const content = readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(id => BigInt(id));
}

function parseAddressesFromArgs(input: string): string[] {
  const addresses = input.split(',').map(addr => addr.trim());
  const validAddresses: string[] = [];
  const invalidAddresses: string[] = [];

  for (const address of addresses) {
    try {
      decodeAddress(address);
      validAddresses.push(address);
    } catch (error) {
      invalidAddresses.push(address);
    }
  }

  if (invalidAddresses.length > 0) {
    console.warn(`⚠️  Invalid addresses found: ${invalidAddresses.join(', ')}`);
    if (validAddresses.length === 0) {
      throw new Error(`No valid addresses provided. Invalid addresses: ${invalidAddresses.join(', ')}`);
    }
  }

  return validAddresses;
}

function parseAddressesFromFile(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf-8');
  const addresses = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const validAddresses: string[] = [];
  const invalidAddresses: string[] = [];

  for (const address of addresses) {
    try {
      decodeAddress(address);
      validAddresses.push(address);
    } catch (error) {
      invalidAddresses.push(address);
    }
  }

  if (invalidAddresses.length > 0) {
    console.warn(`⚠️  Invalid addresses found in file: ${invalidAddresses.join(', ')}`);
    if (validAddresses.length === 0) {
      throw new Error(`No valid addresses found in file. Invalid addresses: ${invalidAddresses.join(', ')}`);
    }
  }

  return validAddresses;
}

function createWriterAccount(mnemonic?: string, address?: string): (TransactionSignerAccount) | undefined {
  if (!mnemonic) {
    return undefined;
  }

  try {
    const account = mnemonicToSecretKey(mnemonic);
    account.addr = address ? Address.fromString(address) : account.addr
    const signer = makeBasicAccountTransactionSigner(account)
    return { addr: account.addr, signer }
  } catch (error) {
    throw new Error(`Invalid mnemonic: ${error}`);
  }
}

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
    }, async (argv: any) => {
      try {
        const algorand = createAlgorandClient({
          algodHost: argv.algodHost,
          algodPort: argv.algodPort,
          algodToken: argv.algodToken,
          appId: argv.appId,
        });

        const writerAccount = createWriterAccount(argv.mnemonic, argv.address);
        console.log({ writerAccount: writerAccount?.addr.toString() })

        const sdk = new EscregSDK({
          appId: BigInt(argv.appId),
          algorand,
          writerAccount,
        })

        let appIds: bigint[];
        if (argv.file) {
          appIds = parseAppIdsFromFile(argv.file);
        } else {
          appIds = parseAppIdsFromArgs(argv.appIds);
        }

        console.log(`Registering ${appIds.length} application IDs with concurrency ${argv.concurrency}...`);
        const txIds = await sdk.register({ appIds, concurrency: argv.concurrency });

        console.log('Registration successful!');
        console.log('Transaction IDs:');
        txIds.forEach((txId, index) => {
          console.log(`  ${index + 1}. ${txId}`);
        });
      } catch (error) {
        console.error('Error registering app IDs:', error);
        process.exit(1);
      }
    })
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
    }, async (argv: any) => {
      try {
        const algorand = createAlgorandClient({
          algodHost: argv.algodHost,
          algodPort: argv.algodPort,
          algodToken: argv.algodToken,
          appId: argv.appId,
        });

        const writerAccount = createWriterAccount(argv.mnemonic, argv.address);

        const sdk = new EscregSDK({
          appId: BigInt(argv.appId),
          algorand,
          writerAccount,
        });

        let addresses: string[];
        if (argv.file) {
          addresses = parseAddressesFromFile(argv.file);
        } else {
          addresses = parseAddressesFromArgs(argv.addresses);
        }
        console.log({ addresses })
        console.log(`Looking up ${addresses.length} addresses with concurrency ${argv.concurrency}...`);
        const result = await sdk.lookup({ addresses, concurrency: argv.concurrency });

        console.log('Lookup results:');
        for (const [address, appId] of Object.entries(result)) {
          if (appId !== undefined) {
            console.log(`  ${address}: ${appId.toString()}`);
          } else {
            console.log(`  ${address}: Not found`);
          }
        }
      } catch (error) {
        console.error('Error looking up addresses:', error);
        process.exit(1);
      }
    })
    .demandCommand(1, 'You must specify a command: register or lookup')
    .help()
    .argv;
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});

// Export parser functions for testing and external use
export {
  parseAppIdsFromArgs,
  parseAppIdsFromFile,
  parseAddressesFromArgs,
  parseAddressesFromFile
};
