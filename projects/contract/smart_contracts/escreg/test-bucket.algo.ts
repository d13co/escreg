import { abimethod, bytes, contract, uint64 } from '@algorandfoundation/algorand-typescript'
import { Escreg } from './contract.algo'

/**
 * Test-only subclass that can plant arbitrary bytes in a registry box.
 *
 * Buckets past the limits the register path can reach in one call - such as those larger than the
 * 2048-byte application-argument cap - are encoded off-chain and planted here to check the readers
 * handle them.
 */
@contract({ stateTotals: { globalBytes: 32, globalUints: 32 } })
export class TestBucketEscreg extends Escreg {
  /**
   * Write raw bytes into a registry box, bypassing the register path and its MBR accounting.
   * @param key 4-byte box key to write.
   * @param value Raw box value.
   * @param entries Number of app IDs the value holds, added to the counter.
   */
  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public plantBucket(key: bytes<4>, value: bytes, entries: uint64): void {
    this.apps(key).value = value
    this.counter.value += entries
  }

  /**
   * Append raw bytes to a registry box. Buckets larger than the 2048-byte application-argument
   * limit cannot be planted in one call, so tests build them up a chunk at a time.
   * @param key 4-byte box key to append to. The box must exist.
   * @param value Raw bytes to append.
   * @param entries Number of app IDs the appended bytes hold, added to the counter.
   */
  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public growBucket(key: bytes<4>, value: bytes, entries: uint64): void {
    const size = this.apps(key).length
    this.apps(key).resize(size + value.length)
    this.apps(key).replace(size, value)
    this.counter.value += entries
  }
}
