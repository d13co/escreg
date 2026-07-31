import { RegistryBucket } from '@d13co/escreg-sdk';
import { bytesToBase64, getApplicationAddress } from 'algosdk';

/** Leading characters of each escrow address shown next to its app ID. */
const escrowPrefixLen = 8;

/** Width of the rendered key column: 8 base64 characters, then 7 base32 ones in parens. */
const keyColumnWidth = 18;

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode bytes as RFC 4648 base32 without padding.
 *
 * This is the alphabet Algorand addresses use, so a bucket key's base32 shares its leading
 * characters with every escrow address filed under it: 4 bytes are 32 bits, which is 6 whole
 * base32 characters plus a seventh carrying the last 2 bits zero-padded.
 */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += base32Alphabet[(buffer >>> bits) & 31];
    }
  }

  if (bits > 0) {
    out += base32Alphabet[(buffer << (5 - bits)) & 31];
  }

  return out;
}

/** Render a bucket key as `base64 (base32)`. */
export function formatBucketKey(key: Uint8Array): string {
  return `${bytesToBase64(key)} (${base32Encode(key)})`;
}

/** Render a bucket's contents as an entry count followed by `appId (escrow prefix)` per app. */
export function formatBucketValues(appIds: bigint[]): string {
  const values = appIds.map((appId) => `${appId} (${getApplicationAddress(appId).toString().slice(0, escrowPrefixLen)})`);
  return [`${appIds.length}x`, ...values].join('  ');
}

/** Column headings for the rows `formatBucketRow` produces. */
export const bucketHeader = `v  ${'key b64 (b32)'.padEnd(keyColumnWidth)}  values`;

/** Render one bucket as a dump row: layout version, key, then its app IDs. */
export function formatBucketRow({ version, key, appIds }: RegistryBucket): string {
  return `${version}  ${formatBucketKey(key).padEnd(keyColumnWidth)}  ${formatBucketValues(appIds)}`;
}
