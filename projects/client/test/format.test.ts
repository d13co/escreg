import { describe, it, expect } from 'vitest';
import { decodeAddress, getApplicationAddress } from 'algosdk';
import { base32Encode, bucketHeader, formatBucketKey, formatBucketRow, formatBucketValues } from '../src/format';

describe('Format Module', () => {
  describe('base32Encode', () => {
    // RFC 4648 test vectors, unpadded
    it.each([
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ])('should encode %o as %o', (input, expected) => {
      expect(base32Encode(new TextEncoder().encode(input))).toBe(expected);
    });

    it('should encode a 4-byte bucket key as 7 characters', () => {
      expect(base32Encode(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBe('777777Y');
    });

    it('should share leading characters with the addresses filed under the key', () => {
      const address = getApplicationAddress(1001n).toString();
      const key = decodeAddress(address).publicKey.slice(0, 4);

      // 4 bytes are 6 whole base32 characters; the 7th is zero-padded and may differ
      expect(base32Encode(key).slice(0, 6)).toBe(address.slice(0, 6));
    });
  });

  describe('formatBucketKey', () => {
    it('should render the key in base64 and base32', () => {
      expect(formatBucketKey(new Uint8Array([0x7c, 0x3d, 0xeb, 0x00]))).toBe('fD3rAA== (PQ66WAA)');
    });
  });

  describe('formatBucketValues', () => {
    it('should prefix the entry count and show each escrow prefix', () => {
      const escrow = getApplicationAddress(1001n).toString().slice(0, 8);

      expect(formatBucketValues([1001n])).toBe(`1x  1001 (${escrow})`);
    });

    it('should separate multiple values', () => {
      const [first, second] = [1001n, 1002n].map((appId) => getApplicationAddress(appId).toString().slice(0, 8));

      expect(formatBucketValues([1001n, 1002n])).toBe(`2x  1001 (${first})  1002 (${second})`);
    });

    it('should handle an empty bucket', () => {
      expect(formatBucketValues([])).toBe('0x');
    });
  });

  describe('formatBucketRow', () => {
    const key = new Uint8Array([0x7c, 0x3d, 0xeb, 0x00]);

    it('should lead with the layout version', () => {
      const legacy = formatBucketRow({ key, version: 1, size: 10, appIds: [1001n] });
      const packed = formatBucketRow({ key, version: 2, size: 8, appIds: [1001n] });

      expect(legacy.startsWith('1  ')).toBe(true);
      expect(packed.startsWith('2  ')).toBe(true);
      expect(legacy.slice(1)).toBe(packed.slice(1));
    });

    it('should align its values column with the header', () => {
      const row = formatBucketRow({ key, version: 2, size: 8, appIds: [1001n] });

      expect(row.indexOf('1x')).toBe(bucketHeader.indexOf('values'));
    });
  });
});
