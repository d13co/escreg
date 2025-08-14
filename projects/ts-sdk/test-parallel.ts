#!/usr/bin/env node

import { EscregSDK } from './dist/esm/index.js';

// Mock AlgorandClient for testing
class MockAlgorandClient {
  async simulate() {
    return {
      returns: [[BigInt(123), BigInt(456), BigInt(789), BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0)]]
    };
  }
}

class MockEscregClient {
  newGroup() {
    return {
      registerList: (args: any) => ({
        send: async () => ({
          confirmations: [{ txn: { txn: { txID: () => 'mock-tx-id-' + Math.random().toString(36).substr(2, 9) } } }]
        })
      }),
      getList: (args: any) => ({
        simulate: async () => ({
          returns: [[BigInt(123), BigInt(456), BigInt(789), BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0)]]
        })
      })
    };
  }
}

class MockEscregFactory {
  getAppClientById() {
    return new MockEscregClient();
  }
}

// Mock the generated client
jest.mock('./src/generated/EscregGenerated', () => ({
  EscregFactory: MockEscregFactory
}));

async function testParallelProcessing() {
  console.log('Testing parallel processing functionality...\n');

  // Create mock SDK instance
  const sdk = new EscregSDK({
    appId: BigInt(123),
    algorand: new MockAlgorandClient() as any,
    writerAccount: {
      addr: { toString: () => 'mock-address' },
      signer: {} as any
    }
  });

  // Test data
  const testAppIds = Array.from({ length: 50 }, (_, i) => BigInt(1000 + i));
  const testAddresses = Array.from({ length: 50 }, (_, i) => 
    `ABCDEFGHIJKLMNOPQRSTUVWXYZ${i.toString().padStart(6, '0')}`
  );

  console.log('Testing register with different concurrency levels:');
  
  for (const concurrency of [1, 3, 5]) {
    console.log(`\nConcurrency: ${concurrency}`);
    const startTime = Date.now();
    
    try {
      const result = await sdk.register({ 
        appIds: testAppIds.slice(0, 20), 
        concurrency,
        debug: true 
      });
      
      const duration = Date.now() - startTime;
      console.log(`  ✅ Completed in ${duration}ms`);
      console.log(`  📊 Processed ${result.length} transactions`);
    } catch (error) {
      console.log(`  ❌ Failed: ${error}`);
    }
  }

  console.log('\nTesting lookup with different concurrency levels:');
  
  for (const concurrency of [1, 3, 5]) {
    console.log(`\nConcurrency: ${concurrency}`);
    const startTime = Date.now();
    
    try {
      const result = await sdk.lookup({ 
        addresses: testAddresses.slice(0, 20), 
        concurrency 
      });
      
      const duration = Date.now() - startTime;
      console.log(`  ✅ Completed in ${duration}ms`);
      console.log(`  📊 Processed ${Object.keys(result).length} addresses`);
    } catch (error) {
      console.log(`  ❌ Failed: ${error}`);
    }
  }

  console.log('\n✅ Parallel processing test completed!');
}

// Run the test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testParallelProcessing().catch(console.error);
}

export { testParallelProcessing };
