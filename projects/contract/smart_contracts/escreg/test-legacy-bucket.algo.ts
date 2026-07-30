import { abimethod, bytes, contract, uint64 } from '@algorandfoundation/algorand-typescript'
import { Escreg } from './contract.algo'

/**
 * Test-only subclass that can plant arbitrary bytes in a registry box.
 *
 * Buckets in the pre-migration ARC-4 `uint64[]` layout cannot be produced by this contract any
 * more, so tests encode them off-chain and plant them here to check that readers, `appendAppId`
 * and `migrateBoxes` all still handle them.
 */
@contract({ stateTotals: { globalBytes: 32, globalUints: 32 } })
export class TestLegacyEscreg extends Escreg {
  /**
   * Write raw bytes into a registry box, bypassing the register path and its MBR accounting.
   * @param key 4-byte box key to write.
   * @param value Raw box value, in whichever bucket layout the test is exercising.
   * @param entries Number of app IDs the value holds, added to the counter.
   */
  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public plantBucket(key: bytes<4>, value: bytes, entries: uint64): void {
    this.apps(key).value = value
    this.counter.value += entries
  }
}
