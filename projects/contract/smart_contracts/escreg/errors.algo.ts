// Error codes for escreg contract - messages in comments are parsed by SDK build script
export const errAuth = 'ERR:AUTH' // Unauthorized - caller must be admin
export const errAppNotRegistered = 'ERR:404' // App escrow is not registered in the contract
export const errCredit = 'ERR:CRD' // Insufficient credits to cover MBR increase
export const errReceiver = 'ERR:RCV' // Payment receiver must be the contract
export const errAmt = 'ERR:AMT' // Amount must be greater than zero
