/**
 * Hermetic environment for unit specs that exercise config().
 *
 * config.ts loads the developer's real apps/api/.env into process.env when it is first imported, so a spec that merely
 * assigns the variables it cares about still inherits everything else (the Embedded Signup flag, config id, app ids,
 * APP_URL, ...). A spec that then deletes one value and reloads config can fail validation for reasons that have
 * nothing to do with the code under test.
 *
 * useHermeticEnv() gives the spec a clean slate: before the spec runs, every variable except a small OS/Node allow-list
 * is removed and only `base` is applied; afterwards the original environment is restored exactly. Nothing is read from
 * or written to .env, and the result is identical whatever the developer's .env contains.
 */
import { resetConfigForTests } from '../src/config/config';

const KEEP = /^(NODE_ENV|PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|TZ|LANG|LC_.*|JEST_.*|FORCE_COLOR|NO_COLOR|CI)$/i;

export function useHermeticEnv(base: Record<string, string>) {
  let saved: NodeJS.ProcessEnv = {};
  beforeAll(() => {
    saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (!KEEP.test(k)) delete process.env[k];
    Object.assign(process.env, base);
    resetConfigForTests();
  });
  afterAll(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
    resetConfigForTests();
  });
}
