import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAlgorandClient, createWriterAccount, convertAppIdsToAddresses } from '../src/utils';
import { Config } from '../src/config';

// Mock algosdk with proper mock functions
vi.mock('algosdk', () => ({
  getApplicationAddress: vi.fn(),
  mnemonicToSecretKey: vi.fn(),
  Algodv2: vi.fn(),
  Address: {
    fromString: vi.fn(),
  },
  makeBasicAccountTransactionSigner: vi.fn(),
}));

// Mock @algorandfoundation/algokit-utils
vi.mock('@algorandfoundation/algokit-utils', () => ({
  AlgorandClient: {
    fromClients: vi.fn(),
  },
}));

// Import mocked functions
import { getApplicationAddress, mnemonicToSecretKey, Algodv2, Address, makeBasicAccountTransactionSigner } from 'algosdk';
import { AlgorandClient } from '@algorandfoundation/algokit-utils';

describe('Utils Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createAlgorandClient', () => {
    it('should create client with http scheme for default port', () => {
      const config: Config = {
        algodHost: 'localhost',
        algodPort: 4001,
        algodToken: 'test-token',
        appId: '1234',
      };

      const mockAlgorandClient = { test: 'client' };
      
      vi.mocked(AlgorandClient.fromClients).mockReturnValue(mockAlgorandClient as any);

      const result = createAlgorandClient(config);

      expect(Algodv2).toHaveBeenCalledWith('test-token', 'http://localhost:4001', 4001);
      expect(result).toBe(mockAlgorandClient);
    });

    it('should create client with https scheme for port 443', () => {
      const config: Config = {
        algodHost: 'api.algonode.cloud',
        algodPort: 443,
        algodToken: 'test-token',
        appId: '1234',
      };

      const mockAlgorandClient = { test: 'client' };
      
      vi.mocked(AlgorandClient.fromClients).mockReturnValue(mockAlgorandClient as any);

      const result = createAlgorandClient(config);

      expect(Algodv2).toHaveBeenCalledWith('test-token', 'https://api.algonode.cloud:443', 443);
      expect(result).toBe(mockAlgorandClient);
    });

    it('should create client with custom host and port', () => {
      const config: Config = {
        algodHost: 'custom-host',
        algodPort: 8080,
        algodToken: 'custom-token',
        appId: '1234',
      };

      const mockAlgorandClient = { test: 'client' };
      
      vi.mocked(AlgorandClient.fromClients).mockReturnValue(mockAlgorandClient as any);

      const result = createAlgorandClient(config);

      expect(Algodv2).toHaveBeenCalledWith('custom-token', 'http://custom-host:8080', 8080);
      expect(result).toBe(mockAlgorandClient);
    });
  });

  describe('createWriterAccount', () => {
    it('should return undefined when no mnemonic is provided', () => {
      const result = createWriterAccount();
      expect(result).toBeUndefined();
    });

    it('should create account with mnemonic only', () => {
      const mockAccount = {
        addr: 'test-address',
        sk: new Uint8Array([1, 2, 3, 4]),
      };
      const mockSigner = vi.fn();

      vi.mocked(mnemonicToSecretKey).mockReturnValue(mockAccount);
      vi.mocked(makeBasicAccountTransactionSigner).mockReturnValue(mockSigner as any);

      const result = createWriterAccount('test mnemonic');

      expect(mnemonicToSecretKey).toHaveBeenCalledWith('test mnemonic');
      expect(makeBasicAccountTransactionSigner).toHaveBeenCalledWith(mockAccount);
      expect(result).toEqual({
        addr: mockAccount.addr,
        signer: mockSigner,
      });
    });

    it('should create account with mnemonic and address', () => {
      const mockAccount = {
        addr: 'test-address',
        sk: new Uint8Array([1, 2, 3, 4]),
      };
      const mockSigner = vi.fn();
      const mockAddress = { toString: () => 'custom-address' };

      vi.mocked(mnemonicToSecretKey).mockReturnValue(mockAccount);
      vi.mocked(Address.fromString).mockReturnValue(mockAddress as any);
      vi.mocked(makeBasicAccountTransactionSigner).mockReturnValue(mockSigner as any);

      const result = createWriterAccount('test mnemonic', 'custom-address');

      expect(Address.fromString).toHaveBeenCalledWith('custom-address');
      expect(result).toEqual({
        addr: mockAddress,
        signer: mockSigner,
      });
    });

    it('should throw error for invalid mnemonic', () => {
      vi.mocked(mnemonicToSecretKey).mockImplementation(() => {
        throw new Error('Invalid mnemonic');
      });

      expect(() => createWriterAccount('invalid mnemonic')).toThrow('Invalid mnemonic: Error: Invalid mnemonic');
    });
  });

  describe('convertAppIdsToAddresses', () => {
    it('should convert app IDs to addresses', () => {
      const appIds = [BigInt(123), BigInt(456), BigInt(789)];
      const expectedAddresses = [
        'address-123',
        'address-456',
        'address-789',
      ];

      vi.mocked(getApplicationAddress).mockImplementation((appId) => ({
        toString: () => `address-${appId}`,
      }) as any);

      const result = convertAppIdsToAddresses(appIds);

      expect(getApplicationAddress).toHaveBeenCalledTimes(3);
      expect(getApplicationAddress).toHaveBeenCalledWith(BigInt(123));
      expect(getApplicationAddress).toHaveBeenCalledWith(BigInt(456));
      expect(getApplicationAddress).toHaveBeenCalledWith(BigInt(789));
      expect(result).toEqual(expectedAddresses);
    });

    it('should handle empty array', () => {
      const result = convertAppIdsToAddresses([]);
      expect(result).toEqual([]);
      expect(getApplicationAddress).not.toHaveBeenCalled();
    });

    it('should handle single app ID', () => {
      const appIds = [BigInt(123)];
      const expectedAddresses = ['address-123'];

      vi.mocked(getApplicationAddress).mockImplementation((appId) => ({
        toString: () => `address-${appId}`,
      }) as any);

      const result = convertAppIdsToAddresses(appIds);

      expect(getApplicationAddress).toHaveBeenCalledOnce();
      expect(getApplicationAddress).toHaveBeenCalledWith(BigInt(123));
      expect(result).toEqual(expectedAddresses);
    });
  });
});
