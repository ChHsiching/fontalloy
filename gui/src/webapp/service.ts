/**
 * Local-service detection (issue #22): the WebApp probes the local
 * `fontalloy serve` service on load (127.0.0.1 only, ADR-0002) and the
 * whole page renders from the published status — live merging when the
 * service answers, the copy-CLI fallback with a plain statement of why
 * when it does not.
 *
 * The address probed comes from the `?serve=` query parameter (the user
 * pins the port serve listens on — `fontalloy serve --port 7777
 * --allow-origin <this site's origin>`), restricted to loopback hosts;
 * without the parameter the well-known default port is probed. A
 * refused connection, a timeout, or a CORS block is a handled state:
 * the rejection never becomes a console error the page itself emits,
 * and the notice offers a click-reachable re-probe.
 */

import { createStore } from "../state";

/** The default probe target: `fontalloy serve --port 7777`. */
export const DEFAULT_SERVE_ADDRESS = "http://127.0.0.1:7777";

/** How long the load-time probe may take before "absent" is declared. */
export const PROBE_TIMEOUT_MS = 1_500;

export interface ServiceStatus {
  /** `checking` from load until the probe settles one way or the other. */
  state: "checking" | "available" | "absent";
  /** The base URL that was (or will be) probed. */
  address: string;
  /** The service version from /health, when connected. */
  version: string | null;
}

/** The `?serve=` parameter, validated to a loopback http origin. */
export function serveAddress(): string {
  const raw = new URLSearchParams(window.location.search).get("serve");
  if (raw !== null && raw.trim() !== "") {
    try {
      const url = new URL(raw);
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      if (url.protocol === "http:" && loopback) {
        return url.origin;
      }
    } catch {
      // An unparseable value falls through to the default probe target.
    }
  }
  return DEFAULT_SERVE_ADDRESS;
}

export const serviceStore = createStore<ServiceStatus>({
  state: "checking",
  address: serveAddress(),
  version: null,
});

/**
 * Probe `address` once. Never throws and never logs: every failure
 * mode (connection refused, timeout, CORS-blocked response, a non-
 * fontalloy responder) resolves to the plain absent status the page
 * states as the reason for the fallback rendering.
 */
export async function probeService(
  address: string = serviceStore.get().address,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ServiceStatus> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${address}/health`, {
      signal: controller.signal,
    });
    if (response.ok) {
      const doc = (await response.json()) as { service?: string; version?: string };
      if (doc.service === "fontalloy") {
        return { state: "available", address, version: doc.version ?? null };
      }
    }
  } catch {
    // Handled by design: absence is a state, not an error.
  } finally {
    window.clearTimeout(timer);
  }
  return { state: "absent", address, version: null };
}

/** Probe and publish — the load-time and re-probe entry point. */
export async function detectService(): Promise<void> {
  serviceStore.set({ state: "checking" });
  serviceStore.set(await probeService());
}
