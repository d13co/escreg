import { Account, BoxMap, Bytes, Contract, gtxn, itxn, log, loggedAssert, Txn, uint64 } from '@algorandfoundation/algorand-typescript'
import { Global } from '@algorandfoundation/algorand-typescript/op'
import { errAmt, errCredit, errReceiver } from './errors.algo'

export class MbrManager extends Contract {
  userCredits = BoxMap<Account, uint64>({ keyPrefix: 'c' })

  /**
   * Deduct MBR credits if needed by comparing pre and post MBR and ensuring sender has enough credits to cover the difference. This should be called at the end of any method that may increase MBR, after the state changes that would cause the MBR increase.
   * @param mbrBefore Minimum balance before the operation.
   * @throws ERR:CRD if sender has insufficient credits to cover MBR increase
   * @throws ERR:RCV if the receiver of the credit does not have a userCredit box
   */
  protected manageMbrCredits(mbrBefore: uint64) {
    this.settleMbrCredits(Txn.sender, mbrBefore)
  }

  /** `manageMbrCredits`, charging or refunding `account` instead of the sender. */
  protected settleMbrCredits(account: Account, mbrBefore: uint64) {
    const mbrAfter = Global.currentApplicationAddress.minBalance
    if (mbrAfter === mbrBefore) return
    else if (mbrAfter > mbrBefore) {
      const creditNeeded: uint64 = mbrAfter - mbrBefore
      const userCredit: uint64 = this.userCredits(account).exists ? this.userCredits(account).value : 0
      // saturating: computed either way, and a plain `creditNeeded - userCredit` would trap here
      const deficit: uint64 = userCredit < creditNeeded ? creditNeeded - userCredit : 0
      if (deficit > 0) {
        // ARC-65 line with the shortfall after `::`. Inlined rather than behind a helper so `itoa`
        // only runs on this path
        log(Bytes('ERR:').concat(Bytes(errCredit)).concat(Bytes('::')).concat(Bytes(deficit.toString())))
      }
      // Does the failing. The code has to be a literal at the call site to reach the ARC-56 source
      // info, which is where a client reads it from - a helper taking it as a parameter could not
      loggedAssert(deficit === 0, errCredit)
      this.userCredits(account).value = userCredit - creditNeeded
    } else {
      const creditToReturn: uint64 = mbrBefore - mbrAfter
      loggedAssert(this.userCredits(account).exists, errReceiver)
      this.userCredits(account).value += creditToReturn
    }
  }

  /**
   * public method to deposit MBR credits for an account
   * @param creditor account to credit
   * @param txn payment transaction to contract. amount is the credit received
   * @throws ERR:RCV if the receiver of the transaction is not the contract
   * @throws ERR:AMT if the amount of the transaction is 0
   * @throws ERR:CRD if a first deposit is too small to cover the creditor's credit box MBR
   */
  public depositCredits(creditor: Account, txn: gtxn.PaymentTxn) {
    loggedAssert(txn.receiver === Global.currentApplicationAddress, errReceiver)
    loggedAssert(txn.amount > 0, errAmt)
    const current: uint64 = this.userCredits(creditor).exists ? this.userCredits(creditor).value : 0

    const mbrBefore = Global.currentApplicationAddress.minBalance
    this.userCredits(creditor).value = current + txn.amount
    // the creditor's credit box is paid out of the deposit itself
    this.settleMbrCredits(creditor, mbrBefore)
  }

  /**
   * Withdraw all remaining MBR credits for sender. This will delete the user credit box, so all credits are withdrawn including the MBR locked for the box itself.
   * @throws ERR:AMT if sender has no credit box
   */
  public withdrawCredits() {
    const mbrBefore = Global.currentApplicationAddress.minBalance
    // must have some credits. zero is fine, it represents MBR locked in user credit box
    loggedAssert(this.userCredits(Txn.sender).exists, errAmt)
    const credit: uint64 = this.userCredits(Txn.sender).value

    // delete credit box, then increment credit held by user box
    this.userCredits(Txn.sender).delete()
    const mbrAfter = Global.currentApplicationAddress.minBalance
    const finalCredit: uint64 = credit + (mbrBefore - mbrAfter)

    itxn
      .payment({
        receiver: Txn.sender,
        amount: finalCredit,
        fee: 0,
      })
      .submit()
  }
}
