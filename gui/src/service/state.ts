/**
 * The synthesis store (issue #16): the service connection state plus one
 * row per submitted build. Same store pattern as the app store —
 * regions subscribe and patch themselves.
 *
 * The UI-only statuses extend the service's own (`queued | running |
 * done | failed`) with `saving` (artifact handoff in flight), `saved`
 * (artifact on disk, report rendered) and `error` (submission or
 * resolution failure before a build id existed).
 */

import { createStore } from "../state";
import type {
  CatalogDocument,
  FontsDocument,
  ReportDocument,
  ServeClient,
} from "./client";

export type ServiceStatus =
  /** No service configured (browser default): nothing probed. */
  | "none"
  /** Resolving the address / probing /health. */
  | "connecting"
  /** /health answered; the synthesize action can drive real merges. */
  | "connected"
  /** Configured but the probe failed (sidecar crash, early launch). */
  | "unavailable";

export interface ServiceState {
  status: ServiceStatus;
  /** The bound base URL (`http://127.0.0.1:<port>`), when known. */
  url: string | null;
  /** Why a configured service is unavailable (inline display). */
  error?: string;
  client: ServeClient | null;
  /** The /fonts listing captured at connect time (path resolution). */
  fontsIndex: FontsDocument | null;
  /**
   * The /catalog document (round 6): the manifest families the service
   * can resolve catalog-family recipe references against. Null when no
   * fetch has completed (a serve without a manifest answers an empty
   * family list — catalog picks then resolve through the path flow).
   */
  catalogIndex: CatalogDocument | null;
}

export type BuildRowStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "saving"
  | "saved"
  | "error";

export interface BuildRow {
  id: string;
  /** Output family of the submitted recipe (row heading). */
  family: string;
  status: BuildRowStatus;
  /** The pipeline stage (serve's own stage string, `done` at the end). */
  stage: string | null;
  /**
   * The current stage's live facts (round 13, owner item 5): the
   * serve's quantitative readout of the running stage (file counts and
   * sizes, slot counts, rule and codepoint counts, format and an
   * estimated size, the check count). Optional because the synthesize
   * flow's poll patch decides what it carries — absent/null/empty
   * degrades the panel to the elapsed timer alone.
   */
  stageFacts?: Readonly<Record<string, string | number>> | null;
  /** 1-based queue position while queued, else null. */
  queuePosition: number | null;
  /** Inline failure text (service message or resolution error). */
  error: string | null;
  /** Where the artifact was saved (page text once saved). */
  savedPath: string | null;
  /**
   * A plain notice beside the saved line (round 12): the 另存为
   * fallback to the default directory explains itself here. Null
   * clears it.
   */
  savedNotice: string | null;
  /** The verification report (machine JSON), once fetched. */
  report: ReportDocument | null;
  submittedAt: string;
}

export interface SynthesisState {
  service: ServiceState;
  builds: BuildRow[];
}

export const synthStore = createStore<SynthesisState>({
  service: {
    status: "none",
    url: null,
    client: null,
    fontsIndex: null,
    catalogIndex: null,
  },
  builds: [],
});

export function patchService(patch: Partial<ServiceState>): void {
  synthStore.set({
    service: { ...synthStore.get().service, ...patch },
  });
}

export function patchBuild(id: string, patch: Partial<BuildRow>): void {
  synthStore.set({
    builds: synthStore
      .get()
      .builds.map((row) => (row.id === id ? { ...row, ...patch } : row)),
  });
}

export function addBuild(row: BuildRow): void {
  synthStore.set({ builds: [...synthStore.get().builds, row] });
}

export function removeBuild(id: string): void {
  synthStore.set({
    builds: synthStore.get().builds.filter((row) => row.id !== id),
  });
}
