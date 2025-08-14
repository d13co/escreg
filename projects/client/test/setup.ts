import { beforeAll, afterAll } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

// Create temporary test files
export const createTestFiles = () => {
  const testAppIds = ['1001', '1002', '1003', '1004', '1005'];
  const testAddresses = [
    'OKSDOCOXVGMBXQ5TP5YA4VWTZWZJLJP3OMIILPHMHGHURUFE2Q3JP62QNU',
    'O3VYQKJ45XILV2GVDO44LM2IGPUD2QYRXNFX5K4ZDC2B4BD4ZZXU5AQG24',
    'FPKJ7KD37AEIB3MJ6WXEXJIZH4DACLBNCR5PNUQREUWMC2YLIWFH2NHX24',
  ];

  const testAppIdsFile = join(__dirname, 'test-app-ids.txt');
  const testAddressesFile = join(__dirname, 'test-addresses.txt');

  writeFileSync(testAppIdsFile, testAppIds.join('\n'));
  writeFileSync(testAddressesFile, testAddresses.join('\n'));

  return { testAppIdsFile, testAddressesFile, testAppIds, testAddresses };
};

// Clean up test files
export const cleanupTestFiles = (files: string[]) => {
  files.forEach(file => {
    try {
      unlinkSync(file);
    } catch (error) {
      // File might not exist, ignore
    }
  });
};

// Global test setup
beforeAll(() => {
  // Note: Environment variables are set per-test as needed
  // to avoid interfering with config tests
});

// Global test cleanup
afterAll(() => {
  // Clean up any remaining test files
  const testFiles = [
    join(__dirname, 'test-app-ids.txt'),
    join(__dirname, 'test-addresses.txt'),
  ];
  cleanupTestFiles(testFiles);
});
