/**
 * Script to parse errors.algo.ts and generate SDK error map
 * Parses lines like: export const errName = 'ERR:CODE' // Error message
 *
 * Usage: tsx generate-errors.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

const sdkRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')
const errorsFilePath = resolve(sdkRoot, '../contract/smart_contracts/escreg/errors.algo.ts')
const outputFilePath = resolve(sdkRoot, 'src/generated/errors.ts')

const content = readFileSync(errorsFilePath, 'utf-8')

// Match lines like: export const errName = 'ERR:CODE' // Message
const errorRegex = /export const \w+ = '(ERR:[^']+)'\s*\/\/\s*(.+)$/gm

const errors: Record<string, string> = {}
let match: RegExpExecArray | null

while ((match = errorRegex.exec(content)) !== null) {
  const [, code, message] = match
  errors[code] = message.trim()
}

mkdirSync(dirname(outputFilePath), { recursive: true })

const output = `// Auto-generated from errors.algo.ts - do not edit manually

/**
 * Map of error codes to human-readable error messages
 */
export const ErrorMessages: Record<string, string> = ${JSON.stringify(errors, null, 2)};
`

writeFileSync(outputFilePath, output)
console.log(`Generated ${Object.keys(errors).length} error messages to ${outputFilePath}`)
