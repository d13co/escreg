import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account';
import { mnemonicToSecretKey, Algodv2, Address, makeBasicAccountTransactionSigner, getApplicationAddress } from 'algosdk';
import { Config } from './config';

export function createAlgorandClient(config: Config): AlgorandClient {
  const scheme = config.algodPort === 443 ? 'https' : 'http';
  const algodClient = new Algodv2(config.algodToken, `${scheme}://${config.algodHost}:${config.algodPort}`, config.algodPort);

  return AlgorandClient.fromClients({
    algod: algodClient,
  });
}

export function createWriterAccount(mnemonic?: string, address?: string): (TransactionSignerAccount) | undefined {
  if (!mnemonic) {
    return undefined;
  }

  try {
    const account = mnemonicToSecretKey(mnemonic);
    account.addr = address ? Address.fromString(address) : account.addr
    const signer = makeBasicAccountTransactionSigner(account)
    return { addr: account.addr, signer }
  } catch (error) {
    throw new Error(`Invalid mnemonic: ${error}`);
  }
}

export function convertAppIdsToAddresses(appIds: bigint[]): string[] {
  return appIds.map(appId => getApplicationAddress(appId).toString());
}


