import { Account, BoxMap, Contract, gtxn, itxn, Txn, uint64 } from '@algorandfoundation/algorand-typescript'
import { Global } from '@algorandfoundation/algorand-typescript/op'
import { ensure } from '../common.algo'
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
    const mbrAfter = Global.currentApplicationAddress.minBalance
    if (mbrAfter === mbrBefore) return
    else if (mbrAfter > mbrBefore) {
      const creditNeeded: uint64 = mbrAfter - mbrBefore
      const userCredit: uint64 = this.userCredits(Txn.sender).exists ? this.userCredits(Txn.sender).value : 0
      ensure(userCredit >= creditNeeded, errCredit)
      this.userCredits(Txn.sender).value = userCredit - creditNeeded
    } else {
      const creditToReturn: uint64 = mbrBefore - mbrAfter
      ensure(this.userCredits(Txn.sender).exists, errReceiver)
      this.userCredits(Txn.sender).value += creditToReturn
    }
  }

  /**
   * public method to deposit MBR credits for an account
   * @param creditor account to credit
   * @param txn payment transaction to contract. amount is the credit received
   * @throws ERR:RCV if the receiver of the transaction is not the contract
   * @throws ERR:AMT if the amount of the transaction is 0
   * @throws ERR:CRD if sender has insufficient credits to cover box MBR increase
   */
  public depositCredits(creditor: Account, txn: gtxn.PaymentTxn) {
    ensure(txn.receiver === Global.currentApplicationAddress, errReceiver)
    ensure(txn.amount > 0, errAmt)
    const current: uint64 = this.userCredits(creditor).exists ? this.userCredits(creditor).value : 0

    const mbrBefore = Global.currentApplicationAddress.minBalance
    this.userCredits(creditor).value = current + txn.amount
    // subtract a bit for the user userCredit box itself
    this.manageMbrCredits(mbrBefore)
  }

  /**
   * Withdraw all remaining MBR credits for sender. This will delete the user credit box, so all credits are withdrawn including the MBR locked for the box itself.
   * @throws ERR:AMT if sender has no credit box
   */
  public withdrawCredits() {
    const mbrBefore = Global.currentApplicationAddress.minBalance
    // must have some credits. zero is fine, it represents MBR locked in user credit box
    ensure(this.userCredits(Txn.sender).exists, errAmt)
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
