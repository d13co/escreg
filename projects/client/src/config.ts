import dotenv from 'dotenv';

// Load environment variables from .env file if it exists
dotenv.config();

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
    algodHost: process.env.ALGOD_HOST || 'localhost',
    algodPort: parseInt(process.env.ALGOD_PORT || '4001'),
    algodToken: process.env.ALGOD_TOKEN || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    appId: process.env.APP_ID || '',
    mnemonic: process.env.MNEMONIC,
    address: process.env.ADDRESS,
    concurrency: parseInt(process.env.CONCURRENCY || "1"),
    debug: process.env.DEBUG === 'true',
    skipCheck: process.env.SKIP_CHECK === 'true',
  };
}
