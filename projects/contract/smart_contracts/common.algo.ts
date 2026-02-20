import { err, log } from '@algorandfoundation/algorand-typescript'

export function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) {
    log(message)
    err()
  }
}
