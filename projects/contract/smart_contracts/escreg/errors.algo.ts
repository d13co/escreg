// Error codes for escreg contract - messages in comments are parsed by SDK build script.
// Codes are bare: `loggedAssert` prepends the `ERR:` prefix, so the logged form is `ERR:<code>`.
// A `::` in a message is a placeholder for the value the contract appends after `::` in the log.
export const errAuth = 'AUTH' // Unauthorized - caller must be admin
export const errAppNotRegistered = '404' // App escrow is not registered in the contract
export const errCredit = 'CRD' // Insufficient credits to cover MBR increase, deficit :: microALGO
export const errReceiver = 'RCV' // Payment receiver must be the contract
export const errAmt = 'AMT' // Amount must be greater than zero
