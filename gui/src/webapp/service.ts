/**
 * The no-service state (issue #21): the WebApp states plainly that live
 * merging needs the local `fontalloy serve` service (127.0.0.1 only,
 * ADR-0002) and offers the copy-CLI fallback as the default rendering.
 *
 * The detection probe itself is ticket #22 — until it lands, the
 * fallback IS the page's rendering; `probeService()` is the extension
 * point that ticket wires (fetch the service, never a console error).
 */

export interface ServiceStatus {
  available: boolean;
  /** False until the #22 probe exists — we never claim we probed. */
  probed: boolean;
}

/** The default rendering: no service, no probe, fallback shown. */
export const serviceStatus: ServiceStatus = { available: false, probed: false };

/**
 * Extension point for ticket #22: probe `http://127.0.0.1:<port>/…`,
 * flip `serviceStatus`, and re-render the notice. A refused connection
 * is a handled state, never a console error (the zero-JS-errors gate
 * is part of the seam-3 contract).
 */
export async function probeService(): Promise<ServiceStatus> {
  return serviceStatus;
}
