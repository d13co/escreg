import { ErrorTransformer } from "@algorandfoundation/algokit-utils/types/composer";
import { ErrorMessages } from "./generated/errors";

/**
 * Map of error codes to human-readable error messages
 */
export const errorMap = ErrorMessages;

export const errorTransformer: ErrorTransformer = async (ogError) => {
  const [errCode] = /ERR:[^" ]+/.exec(ogError.message) ?? [];
  if (errCode) {
    const humanMessage = errorMap[errCode] ?? "Unknown error";
    const message = `${errCode.replace("ERR:", "Error ")}: ${humanMessage}`

    ogError.stack = `${message}\n    ${ogError.message}\n${ogError.stack}`;
    ogError.message = message;
    (ogError as any).code = errCode;
    (ogError as any).description = humanMessage;
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
