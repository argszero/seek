/**
 * The other half of "a download that installs without an argument".
 *
 * `packaging/make-pkg.mjs` signs the package, and a signed package is one macOS will install
 * — `spctl -a -t install` stops answering `rejected` and starts answering `accepted`. What
 * signing does not do is satisfy the *other* refusal, the one that appears when the installed
 * app is launched on a machine Apple has never seen it on: "Apple cannot check it for
 * malicious software". That sentence is about notarization, and it is answered by sending the
 * package to Apple, waiting for a verdict, and stapling the verdict to the file.
 *
 * **Why the status is parsed and the exit code is not trusted.** `notarytool submit --wait`
 * exits **0** when the submission comes back `Invalid` — measured on the neighbouring EMRG
 * project's release workflow, where a release step that only checked `$?` would have published
 * a package Apple had rejected. So this reads the JSON it prints, and on anything but
 * `Accepted` it fetches Apple's own reasons with `notarytool log` and fails.
 *
 * **Why an API key and not an Apple ID.** `notarytool` accepts either an Apple ID with an
 * app-specific password or an App Store Connect API key (`.p8`, plus the key's ID and the
 * team's issuer ID). The key is what this uses: an app-specific password has to be generated
 * in a browser by a person, and a key is generated once and then lives in the repository's
 * secrets like every other credential here.
 *
 * The three values are read from the environment and none has a default, because a wrong
 * issuer ID and a missing one fail the same way — quietly, with a refusal a person would have
 * to read a JSON body to understand:
 *
 *   MACOS_NOTARY_KEY        path to the `AuthKey_XXXXXXXXXX.p8` file
 *   MACOS_NOTARY_KEY_ID     that file's key ID, which is in its own name
 *   MACOS_NOTARY_ISSUER_ID  the team's issuer ID
 *
 * Usage, from the repository root after `npm run dist:pkg` in `ui/`:
 *
 *     node packaging/notarize.mjs
 *
 * or `npm run dist:notarize` in `ui/`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UI, pkgPlan } from './make-pkg.mjs';

const PACKAGING = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(PACKAGING, '..');

/**
 * What one run of `notarytool` would submit, or why it would not run.
 *
 * The file is the same one `pkgPlan` names — the signed package that is about to be published
 * — so "notarize the installer" cannot come to mean a different file from "build the
 * installer".
 */
export function notarizePlan(options = {}) {
  const environment = options.environment ?? process.env;
  const plan = pkgPlan(options);
  const key = (environment.MACOS_NOTARY_KEY ?? '').trim();
  const keyId = (environment.MACOS_NOTARY_KEY_ID ?? '').trim();
  const issuer = (environment.MACOS_NOTARY_ISSUER_ID ?? '').trim();

  const missing = [
    key === '' ? 'MACOS_NOTARY_KEY' : '',
    keyId === '' ? 'MACOS_NOTARY_KEY_ID' : '',
    issuer === '' ? 'MACOS_NOTARY_ISSUER_ID' : '',
  ].filter((name) => name !== '');

  const credentials = ['--key', key, '--key-id', keyId, '--issuer', issuer];
  return {
    ready: missing.length === 0,
    missing,
    file: plan.output,
    product: plan.product,
    version: plan.version,
    submitArgv: ['notarytool', 'submit', plan.output, ...credentials, '--wait', '--output-format', 'json'],
    logArgvFor: (id) => ['notarytool', 'log', id, ...credentials],
    stapleArgv: ['stapler', 'staple', plan.output],
    validateArgv: ['stapler', 'validate', plan.output],
  };
}

/**
 * The verdict out of what `notarytool` printed.
 *
 * It prints one JSON object, and the field that decides everything is `status`. Exported
 * because the failure this guards against is a *value*, not an exit status, and a test can
 * hold a value.
 */
export function verdictOf(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Not JSON at all is not a verdict — say so rather than reading a missing field as `ok`.
    return { status: 'unreadable', id: '', message: output.trim().split('\n').slice(-3).join(' ') };
  }
  return { status: parsed.status ?? 'unknown', id: parsed.id ?? '', message: parsed.message ?? '' };
}

function main() {
  const plan = notarizePlan();
  if (!plan.ready) {
    console.error(`notarization needs ${plan.missing.join(', ')}, which this machine does not have`);
    console.error('an unsigned, un-notarized package is still buildable: skip this step');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(plan.file)) {
    console.error(`no package at ${plan.file}`);
    console.error('build it first:  cd ui && npm run dist:pkg');
    process.exitCode = 1;
    return;
  }

  const megabytes = (statSync(plan.file).size / 1e6).toFixed(1);
  console.log(`==> notarizing ${plan.product} ${plan.version} (${megabytes} MB)`);
  console.log('    Apple answers in minutes; --wait means this step waits rather than guessing');

  // `execFileSync` throws on a non-zero exit, and a network failure is exactly that, so the
  // output is captured even when the call fails: the JSON is the verdict and its absence is
  // the other kind of answer.
  let output = '';
  try {
    output = execFileSync(plan.submitArgv[0], plan.submitArgv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    console.error('notarytool could not complete the submission:');
    console.error(output.trim().split('\n').slice(-10).join('\n'));
    process.exitCode = 1;
    return;
  }

  const verdict = verdictOf(output);
  console.log(`    ${verdict.id === '' ? '' : `${verdict.id}: `}${verdict.status}`);

  if (verdict.status !== 'Accepted') {
    // Apple's answer is a status and a submission ID; the reasons are a second call, and
    // without them a red release says "Invalid" and nothing else.
    console.error(`::error::Apple did not accept ${plan.file}: ${verdict.status} ${verdict.message}`);
    if (verdict.id !== '') {
      const logArgv = plan.logArgvFor(verdict.id);
      try {
        console.error(execFileSync(logArgv[0], logArgv.slice(1), { encoding: 'utf8' }));
      } catch (error) {
        console.error('and notarytool log could not be read either:');
        console.error(`${error.stdout ?? ''}${error.stderr ?? ''}`.trim());
      }
    }
    process.exitCode = 1;
    return;
  }

  // Stapling is what makes the verdict travel with the file: without it the ticket lives on
  // Apple's servers and a machine that is offline — or that Apple has never seen — has nothing
  // to check against.
  execFileSync(plan.stapleArgv[0], plan.stapleArgv.slice(1), { stdio: 'inherit' });
  execFileSync(plan.validateArgv[0], plan.validateArgv.slice(1), { stdio: 'inherit' });
  console.log('    notarized and stapled: this package installs and its app launches without a prompt');
}

// Run only when this file is the program, not when a test imports the plan above.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { UI };
