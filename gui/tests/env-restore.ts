/**
 * Scoped process.env overrides for specs (ticket #37).
 *
 * A spec that points FONTALLOY_DEV_* at its fixtures MUST restore
 * whatever its worker inherited: CI injects FONTALLOY_DEV_FONT_DIR at
 * the step boundary, and the old bare `delete process.env.X` in a
 * teardown ERASED it for every later spec sharing that worker — CI
 * run 39343242067 lost round11shots' staged fonts exactly that way
 * (the env-delivery blame was wrong; delivery worked, a sibling spec
 * had eaten the var). The conformance guard bans raw process.env
 * mutation anywhere outside this file.
 */

/**
 * Apply `values` to process.env; the returned restore puts back
 * exactly what was there before (deleting what was absent).
 */
export function overrideEnv(values: Record<string, string>): () => void {
  const saved = new Map<string, string | undefined>(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(values)) {
    process.env[name] = value;
  }
  return () => {
    for (const [name, prior] of saved) {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  };
}
