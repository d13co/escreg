import { decodeAddress } from "algosdk";
import { readFileSync } from "fs";

export function parseAppIdsFromArgs(input: string): bigint[] {
  return input.split(',').map(id => BigInt(id.trim()));
}

export function parseAppIdsFromFile(filePath: string): bigint[] {
  const content = readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(id => BigInt(id));
}

export function parseAddressesFromArgs(input: string): string[] {
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

export function parseAddressesFromFile(filePath: string): string[] {
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