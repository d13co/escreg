/**
 * Check the hand-written `getList` signature in src/util.ts against the contract's own app spec.
 *
 * The lookup path declares the method itself rather than reading it out of the generated client, so
 * that the light entry point does not carry the 10KB app spec literal for the sake of four bytes of
 * selector. This is what keeps the two from drifting: if the contract ever changes `getList`, the
 * build stops here instead of shipping an SDK that calls a method that no longer exists.
 *
 * Usage: tsx check-abi.ts
 */
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { getListMethod } from '../src/util'

const sdkRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')
const appSpecPath = resolve(sdkRoot, '../contract/smart_contracts/artifacts/escreg/Escreg.arc56.json')

interface Arc56Method {
  name: string
  args: { type: string }[]
  returns: { type: string }
}

const { methods } = JSON.parse(readFileSync(appSpecPath, 'utf-8')) as { methods: Arc56Method[] }
const method = methods.find((m) => m.name === getListMethod.name)

if (!method) {
  throw new Error(`${appSpecPath} has no ${getListMethod.name} method`)
}

const expected = `${method.name}(${method.args.map(({ type }) => type).join(',')})${method.returns.type}`
const actual = getListMethod.getSignature()

if (expected !== actual) {
  throw new Error(`src/util.ts declares ${actual}, but the contract's is ${expected}. Update getListMethod to match.`)
}

console.log(`getList signature matches the app spec: ${actual}`)
