import { compile, Contract, Global, itxn } from '@algorandfoundation/algorand-typescript'

export class TestParent extends Contract {
  public spawn() {
    const compiled = compile(TestChild)

    const txn = itxn
      .applicationCall({
        // warning: schema params do not match
        // ok to do here because no storage in testchild
        ...compiled,
      })
      .submit()

    itxn
      .payment({
        receiver: txn.createdApp.address,
        amount: 100000,
      })
      .submit()
  }
}

export class TestChild extends Contract {
  constructor() {
    super()
    itxn
      .payment({
        receiver: Global.callerApplicationAddress,
        rekeyTo: Global.callerApplicationAddress,
      })
      .submit()
  }
}
