/**
 * The functions the e2e specs throw from.
 *
 * Kept in a named module with a distinctive call chain so the resolved stack
 * can be asserted against real file names and line numbers. The chain is three
 * deep because the fingerprint uses the top three frames.
 */

export function innerFailure(): never {
  throw new TypeError("watchfire e2e failure");
}

export function middleLayer(): void {
  innerFailure();
}

export function triggerError(): void {
  middleLayer();
}

export function triggerRejection(): void {
  void Promise.reject(new RangeError("watchfire e2e rejection"));
}
