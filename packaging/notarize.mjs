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
 * **Why `xcrun` and not the tools by name.** `notarytool` is not in `/usr/bin`: it lives inside
 * Xcode, at `Xcode.app/Contents/Developer/usr/bin/notarytool`, so a bare `notarytool` is a name
 * the machine has never heard of wherever Xcode is installed but its binary directory is not on
 * `PATH` — which is what the macOS release runner is. The first tag this step ran on proved what
 * that costs: `execFileSync` threw `ENOENT`, an `ENOENT` carries neither `stdout` nor `stderr`,
 * and the release log read `notarytool could not complete the submission:` followed by nothing
 * at all. `/usr/bin/xcrun` is there on every macOS and resolves both tools wherever they are
 * installed, so `stapler` is reached the same way: a machine with the Command Line Tools and no
 * Xcode then notarizes exactly as one with both.
 *
 * **Why stapling is retried, and why an unreachable Apple is not a failed release.** `stapler`
 * and `stapler validate` both talk to Apple: the first fetches the ticket, the second asks Apple's
 * ticket service to confirm the one in the file. Either can lose the network, and losing it is not
 * an answer about the artifact. `v0.1.2`'s first run proved the cost of treating it as one:
 * `stapler staple` printed `The staple and validate action worked!`, the `stapler validate`
 * after it failed with `The validate action failed! Error 68.` and
 * `NSURLErrorDomain Code=-1005 "The network connection was lost."` against
 * `api.apple-cloudkit.com`, and a release whose package was complete and stapled went red until
 * somebody ran it again by hand. So a network answer is retried, and at the last step it is a
 * warning rather than a failure — because a ticket that exists does not stop existing while a
 * host is unreachable. What is **not** retried is any other answer: a file with no ticket will
 * have no ticket on the second ask, and pretending otherwise only delays the report.
 *
 * The distinction is read from sysexits, which is what `stapler` answers in
 * (`MacOSX.sdk/usr/include/sysexits.h`): `EX_DATAERR` 65 is a file that carries no ticket,
 * `EX_NOINPUT` 66 is a file stapler cannot read, `EX_NOHOST` 68 and `EX_UNAVAILABLE` 69 are the
 * two ways the far end can fail to answer. Measured here: an unnotarized `.pkg` exits **66** and
 * an unnotarized `.app` exits **65** — the first with an empty `stderr`, which is why the code
 * and not only the prose is read.
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
    submitArgv: ['xcrun', 'notarytool', 'submit', plan.output, ...credentials, '--wait', '--output-format', 'json'],
    logArgvFor: (id) => ['xcrun', 'notarytool', 'log', id, ...credentials],
    stapleArgv: ['xcrun', 'stapler', 'staple', plan.output],
    validateArgv: ['xcrun', 'stapler', 'validate', plan.output],
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

/**
 * What to print when a call failed, whatever kind of failure it was.
 *
 * The output of a failed call is the interesting part, so the output is what gets printed — but a
 * failure can carry no output at all, and the version of this that printed the output and nothing
 * else produced a red release whose whole message was a colon. Two different events have no
 * output, and the words for them are not the same:
 *
 *   `ENOENT`   the call never started — the binary is not there, so `stdout` and `stderr` are
 *              both `undefined` and the reason is the error's own code.
 *   an exit    the call ran and exited with a status, saying nothing. `stapler` does exactly this
 *              to a package that carries no ticket: measured here as exit **66** with an empty
 *              `stderr`, so a reader who was told "could not be started" would be told the wrong
 *              thing.
 *
 * Either way the command line comes with it when the words do not, because the command line is the
 * line that would have said "notarytool: not found".
 */
export function failureTextOf(error, argv) {
  const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
  const status = error.status;
  if (output !== '') {
    const said = output.split('\n').slice(-10).join('\n');
    // What a tool printed is not always why it failed: `stapler` on a package with no ticket
    // prints `Processing: <path>` and exits 66 with an empty `stderr`, so the printed line alone
    // would name the file and nothing else. The status is what is left when the words run out.
    return status === undefined || status === null ? said : `${said}\n(exit status ${status})`;
  }
  if (error.code !== undefined && error.code !== null) {
    return `${argv[0]} could not be started (${error.code}): ${argv.join(' ')}`;
  }
  return `${argv.join(' ')} ran and failed with exit status ${status ?? error.message ?? 'unknown'}, saying nothing`;
}

const NETWORK_MARKERS = [
  /the network connection was lost/i,
  /network connection was lost/i,
  /COULD NOT CONNECT/i,
  /kCFErrorDomainCFNetwork/i,
  /NSURLErrorDomain/i,
  /operation timed out/i,
];

/**
 * Whether a `stapler` failure means Apple could not be reached, rather than that the file is wrong.
 *
 * The two answers are opposite, which is why they are told apart rather than both failing a
 * release: a file with no ticket is an artifact that is not finished, and a host that could not be
 * reached says nothing at all about the artifact. The answer is read from the exit code because
 * `stapler` sometimes exits with an empty `stderr` — measured on an unnotarized `.pkg`, which
 * answers `66` and says nothing — and from the prose because Apple's tooling does not promise the
 * code (`Code=-1005` arrives with a code *and* a paragraph).
 */
export function isNetworkFailure(error) {
  if (error === null || error === undefined) return false;
  // EX_NOHOST and EX_UNAVAILABLE: the far end did not answer. Everything else — EX_DATAERR,
  // EX_NOINPUT, a signal, a crash — is an answer about this file or this machine.
  if (Number(error.status) === 68 || Number(error.status) === 69) return true;
  const said = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`;
  return NETWORK_MARKERS.some((marker) => marker.test(said));
}

/** The pause before asking a second and a third time. No number here is measured, so it is small. */
function sleepMs(pause) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
}

/**
 * Run something until it stops failing in a way that asking again could change.
 *
 * Only a network failure is retried: everything else is an answer, and an answer that is asked
 * twice is asked twice to learn the same thing. `wait` and `attempts` are injectable so a test can
 * hold the policy without holding a clock, and so the release step does not sleep in a test.
 */
export function withRetries(run, options = {}) {
  const attempts = Math.max(1, options.attempts ?? 3);
  const waits = options.waits ?? [5_000, 20_000];
  const wait = options.wait ?? sleepMs;
  const onRetry = options.onRetry ?? (() => {});
  let error = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { ok: true, value: run(attempt), attempts: attempt, error: null };
    } catch (caught) {
      error = caught;
      if (attempt === attempts || !isNetworkFailure(caught)) {
        return { ok: false, value: null, attempts: attempt, error };
      }
      const pause = waits[Math.min(attempt - 1, waits.length - 1)];
      onRetry(caught, attempt, pause);
      wait(pause);
    }
  }
  return { ok: false, value: null, attempts, error };
}

/**
 * What a `stapler validate` result means for the release — three answers, two of them about the file.
 *
 * `confirmed`   Apple's ticket service re-read the ticket out of the file.
 * `unconfirmed` Apple could not be reached. The ticket is in the file — the staple step wrote it
 *               and said so — but nobody re-read it. This is a warning: failing here would fail a
 *               release over the state of a network the artifact does not depend on.
 * `failed`      the file does not carry a ticket, which is an artifact that is not finished.
 */
export function validateOutcomeOf(result) {
  if (result.ok) return 'confirmed';
  return isNetworkFailure(result.error) ? 'unconfirmed' : 'failed';
}

/**
 * Staple the ticket, then have Apple read it back — and say which of the three things happened.
 *
 * Exported and injectable for the same reason `notarizePlan` is: this is the half of the release
 * that cannot be reached on a laptop (a package built without the installer identity is not one
 * Apple accepts, so there is no `Accepted` verdict to staple a ticket from), and the behaviour it
 * owes a reader is a set of outcomes a test can hold. `run`, `retry` and `wait` are what a test
 * replaces; the release replaces none of them.
 *
 *   'stapled'      the ticket is in the file and Apple re-read it
 *   'unconfirmed'  the ticket is in the file; Apple could not be reached to re-read it
 *   'failed'       one of the two steps gave an answer that is about the file
 */
export function staplingOf(plan, options = {}) {
  const run = options.run ?? runCaptured;
  const retry = options.retry ?? withRetries;
  const settings = {
    attempts: options.attempts,
    wait: options.wait,
    onRetry: (error, attempt, pause) => options.onRetry?.(error, attempt, pause, 'staple'),
  };

  const stapled = retry(() => run(plan.stapleArgv), settings);
  if (!stapled.ok) return { outcome: 'failed', step: 'staple', error: stapled.error, attempts: stapled.attempts };

  const validated = retry(() => run(plan.validateArgv), {
    ...settings,
    onRetry: (error, attempt, pause) => options.onRetry?.(error, attempt, pause, 'validate'),
  });
  const verdict = validateOutcomeOf(validated);
  if (verdict === 'confirmed') return { outcome: 'stapled', step: 'validate', error: null, attempts: validated.attempts };
  return { outcome: verdict, step: 'validate', error: validated.error, attempts: validated.attempts };
}

/** One captured stapler run, repeating what it said so the log still shows it. */
function runCaptured(argv) {
  const say = (text) => {
    const trimmed = (text ?? '').trim();
    if (trimmed !== '') console.log(trimmed);
  };
  try {
    const output = execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    say(output);
    return output;
  } catch (error) {
    say(`${error.stdout ?? ''}${error.stderr ?? ''}`);
    throw error;
  }
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
  // the other kind of answer — and a call that never started at all is reported by
  // `failureTextOf`, rather than as the empty line it used to be.
  let output = '';
  try {
    output = execFileSync(plan.submitArgv[0], plan.submitArgv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    console.error('notarytool could not complete the submission:');
    console.error(failureTextOf(error, plan.submitArgv));
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
  // to check against. Both calls it makes go to Apple, so both are retried on a network answer
  // and neither is retried on any other (`isNetworkFailure`).
  const stapling = staplingOf(plan, {
    onRetry: (error, attempt, pause, step) => {
      const argv = step === 'staple' ? plan.stapleArgv : plan.validateArgv;
      console.log(`    ${step}: Apple did not answer — ${failureTextOf(error, argv)}`);
      console.log(`    asking again in ${pause / 1000}s (attempt ${attempt + 1})`);
    },
  });

  if (stapling.outcome === 'failed') {
    // No ticket in the file is an artifact that is not finished, whoever is at fault: this one
    // stays a failure, and which half failed decides what the reader is told.
    const argv = stapling.step === 'staple' ? plan.stapleArgv : plan.validateArgv;
    console.error(
      stapling.step === 'staple'
        ? '::error::the notarization ticket could not be stapled to the package:'
        : '::error::the package carries no notarization ticket after stapling:',
    );
    console.error(failureTextOf(stapling.error, argv));
    process.exitCode = 1;
    return;
  }
  if (stapling.outcome === 'unconfirmed') {
    // The ticket was written by the step above; this is Apple's service not answering the
    // question, and the artifact is not in doubt. Said loudly so a red release is never needed
    // to learn it.
    console.log(`::warning::the ticket is stapled, but Apple's service did not confirm it — ${failureTextOf(stapling.error, plan.validateArgv)}`);
  }
  console.log('    notarized and stapled: this package installs and its app launches without a prompt');
}

// Run only when this file is the program, not when a test imports the plan above.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { UI };
