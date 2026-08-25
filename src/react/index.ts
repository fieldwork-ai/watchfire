/**
 * React glue.
 *
 * A separate subpath so the core browser bundle never imports React. The whole
 * of it is one adapter: React hands `componentStack` to `componentDidCatch`,
 * and that string is often more useful than the stack trace, because it names
 * the component tree in terms the developer wrote rather than the bundler's.
 *
 * There is deliberately no ErrorBoundary component here. Apps have their own,
 * usually with their own fallback rendering and reset semantics, and replacing
 * a working boundary is a worse trade than adding one line to it.
 */
import { captureError } from "../browser/index.js";

/** Shape of React's second `componentDidCatch` argument. */
export interface ReactErrorInfo {
  componentStack?: string | null;
}

/**
 * Drop-in `onError` for an existing error boundary:
 *
 *   <ErrorBoundary onError={reportBoundaryError} fallback={...}>
 *
 * or inside a class boundary:
 *
 *   componentDidCatch(error, info) { reportBoundaryError(error, info); }
 */
export function reportBoundaryError(error: unknown, info?: ReactErrorInfo): void {
  captureError(error, {
    kind: "boundary",
    ...(info?.componentStack ? { componentStack: info.componentStack } : {}),
  });
}

export { captureError, addBreadcrumb } from "../browser/index.js";
