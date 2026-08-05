import dotenv from 'dotenv';

// Load environment variables from .env file if it exists
// If ENV is set, load .env.{ENV} file, otherwise load .env
const envFile = process.env.ENV ? `.env.${process.env.ENV}` : '.env';
dotenv.config({ path: envFile });

export interface Config {
  algodHost: string;
  algodPort: number;
  algodToken: string;
  appId: string;
  mnemonic?: string;
  address?: string;
  concurrency?: number;
  debug?: boolean;
  skipCheck?: boolean;
}

export function getConfig(): Config {
  return {
    algodHost: process.env.ALGOD_HOST || 'fnet-api.4160.nodely.dev',
    algodPort: parseInt(process.env.ALGOD_PORT || '443'),
    algodToken: process.env.ALGOD_TOKEN || '',
    appId: process.env.APP_ID || '16954321',
    mnemonic: process.env.MNEMONIC,
    address: process.env.ADDRESS,
    concurrency: parseInt(process.env.CONCURRENCY || "1"),
    debug: process.env.DEBUG === 'true',
    skipCheck: process.env.SKIP_CHECK === 'true',
  };
}
