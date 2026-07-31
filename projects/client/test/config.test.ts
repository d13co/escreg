import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig, Config } from '../src/config';

describe('Config Module', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment variables before each test
    process.env = { ...originalEnv };
    // Clear specific environment variables that might be set by .env file
    delete process.env.ALGOD_HOST;
    delete process.env.ALGOD_PORT;
    delete process.env.ALGOD_TOKEN;
    delete process.env.INDEXER_HOST;
    delete process.env.INDEXER_PORT;
    delete process.env.INDEXER_TOKEN;
    delete process.env.APP_ID;
    delete process.env.MNEMONIC;
    delete process.env.ADDRESS;
    delete process.env.CONCURRENCY;
    delete process.env.DEBUG;
    delete process.env.SKIP_CHECK;
  });

  afterEach(() => {
    // Restore original environment variables
    process.env = originalEnv;
  });

  describe('getConfig', () => {
    it('should return default values when no environment variables are set', () => {
      const config = getConfig();
      
      expect(config).toEqual({
        algodHost: 'fnet-api.4160.nodely.dev',
        algodPort: 443,
        algodToken: '',
        indexerHost: 'fnet-idx.4160.nodely.dev',
        indexerPort: 443,
        indexerToken: '',
        appId: '16954321',
        mnemonic: undefined,
        address: undefined,
        concurrency: 1,
        debug: false,
        skipCheck: false,
      });
    });

    it('should use environment variables when provided', () => {
      process.env.ALGOD_HOST = 'test-host';
      process.env.ALGOD_PORT = '8080';
      process.env.ALGOD_TOKEN = 'test-token-123';
      process.env.INDEXER_HOST = 'test-idx';
      process.env.INDEXER_PORT = '8980';
      process.env.INDEXER_TOKEN = 'test-idx-token';
      process.env.APP_ID = '5678';
      process.env.MNEMONIC = 'test mnemonic phrase';
      process.env.ADDRESS = 'test-address';
      process.env.CONCURRENCY = '4';

      const config = getConfig();

      expect(config).toEqual({
        algodHost: 'test-host',
        algodPort: 8080,
        algodToken: 'test-token-123',
        indexerHost: 'test-idx',
        indexerPort: 8980,
        indexerToken: 'test-idx-token',
        appId: '5678',
        mnemonic: 'test mnemonic phrase',
        address: 'test-address',
        concurrency: 4,
        debug: false,
        skipCheck: false,
      });
    });

    it('should parse port as integer', () => {
      process.env.ALGOD_PORT = '443';
      
      const config = getConfig();
      
      expect(config.algodPort).toBe(443);
      expect(typeof config.algodPort).toBe('number');
    });

    it('should handle missing optional environment variables', () => {
      process.env.ALGOD_HOST = 'test-host';
      process.env.ALGOD_PORT = '8080';
      process.env.ALGOD_TOKEN = 'test-token';
      process.env.APP_ID = '1234';
      // MNEMONIC and ADDRESS not set

      const config = getConfig();
      
      expect(config.mnemonic).toBeUndefined();
      expect(config.address).toBeUndefined();
    });

    it('should handle empty string environment variables', () => {
      process.env.ALGOD_HOST = '';
      process.env.ALGOD_PORT = '';
      process.env.ALGOD_TOKEN = '';
      process.env.APP_ID = '';

      const config = getConfig();

      expect(config.algodHost).toBe('fnet-api.4160.nodely.dev');
      expect(config.algodPort).toBe(443);
      expect(config.algodToken).toBe('');
      expect(config.appId).toBe('16954321');
    });

    it('should keep an empty indexer host, which disables the indexer', () => {
      process.env.INDEXER_HOST = '';

      expect(getConfig().indexerHost).toBe('');
    });
  });

  describe('Config interface', () => {
    it('should allow valid config object', () => {
      const config: Config = {
        algodHost: 'localhost',
        algodPort: 4001,
        algodToken: 'test-token',
        appId: '1234',
        mnemonic: 'test mnemonic',
        address: 'test-address',
      };

      expect(config.algodHost).toBe('localhost');
      expect(config.algodPort).toBe(4001);
      expect(config.algodToken).toBe('test-token');
      expect(config.appId).toBe('1234');
      expect(config.mnemonic).toBe('test mnemonic');
      expect(config.address).toBe('test-address');
    });

    it('should allow config without optional fields', () => {
      const config: Config = {
        algodHost: 'localhost',
        algodPort: 4001,
        algodToken: 'test-token',
        appId: '1234',
      };

      expect(config.mnemonic).toBeUndefined();
      expect(config.address).toBeUndefined();
    });
  });
});
