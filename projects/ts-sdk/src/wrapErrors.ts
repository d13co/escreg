import type { ErrorTransformer } from "@algorandfoundation/algokit-utils/types/composer";
import { ErrorMessages } from "./generated/errors.js";

/**
 * Map of error codes to human-readable error messages
 *
 * A `::` in a message is a placeholder for a value the contract appends to the logged code after
 * `::` - see {@link errorTransformer}.
 */
export const errorMap = ErrorMessages;

/**
 * Matches what the contract logs: `ERR:` followed by the code, and optionally `::` and the value
 * the contract appended to it, e.g. `ERR:CRD::7300`.
 */
const ERROR_CODE = /ERR:([^\s":]+)(?:::([^\s"]*))?/;

/** Stands in for the appended value when the error carries a placeholder but no value. */
const NO_VALUE = "unknown";

export const errorTransformer: ErrorTransformer = async (ogError) => {
  const match = ERROR_CODE.exec(ogError.message);
  if (match) {
    const [, code, value] = match;
    const errCode = `ERR:${code}`;
    // `::` in the mapped message is where the appended value goes
    const humanMessage = (errorMap[errCode] ?? "Unknown error").replace("::", value || NO_VALUE);
    const message = `Error ${code}: ${humanMessage}`;

    ogError.stack = `${message}\n    ${ogError.message}\n${ogError.stack}`;
    ogError.message = message;
    (ogError as any).code = errCode;
    (ogError as any).description = humanMessage;
    if (value) (ogError as any).value = value;
    return ogError;
  }
  return ogError;
};

export async function wrapErrorsInternal<T>(promiseOrGenerator: Promise<T> | (() => Promise<T>)): Promise<T> {
  try {
    if (typeof promiseOrGenerator === "function") {
      return await promiseOrGenerator();
    } else {
      return await promiseOrGenerator;
    }
  } catch (e) {
    throw await errorTransformer(e as Error);
  }
}
