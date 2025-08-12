import { Contract } from '@algorandfoundation/algorand-typescript'

export class Escreg extends Contract {
  public hello(name: string): string {
    return `Hello, ${name}`
  }
}
