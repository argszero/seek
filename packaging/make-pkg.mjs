/**
 * The installer a download is.
 *
 * `electron-builder` builds the app into `ui/release/mac-arm64/Seek.app`, and what `v0.1.0`
 * published beside that bundle was a `.zip` — the bundle again, for dragging into
 * `Applications` by hand. On macOS the file people expect to double-click is an installer,
 * and electron-builder's own `dmg` target cannot stand in for one here: every dmg build ends
 * in `hdiutil create`, which the environment this repository is developed in refuses
 * outright (`the operation is not permitted`, measured on this machine), while `pkgbuild`
 * is not refused and writes a component package out of the very same `.app`. That is also
 * how the neighbouring EMRG project ships its macOS download — its
 * `packaging/make-installer.sh` `darwin` branch is a `pkgbuild` over a built bundle.
 *
 * A component package needs three things the app does not carry for it: an identifier, a
 * version and a place to install. All three are **read** rather than repeated — the app's
 * own `build.appId` and `version` out of `ui/package.json`, and `/Applications`, which is
 * where the README already tells a reader to drag the bundle — so an installer cannot claim
 * a version the app inside it does not have, and the receipt it leaves is named after the
 * app it installed.
 *
 * **The package is signed when the machine cutting it has an identity.** `pkgbuild` writes an
 * unsigned component package; `productsign` is what turns it into one macOS will install
 * without first asking the reader whether they trust it, and it needs a `Developer ID
 * Installer` certificate — a different one from the `Developer ID Application` that signs the
 * app inside, because an installer and a bundle are assessed by two different parts of the
 * system. Neither is present on a development machine, so the two are found by name in
 * `MACOS_INSTALLER_IDENTITY` and the signature is skipped, loudly, when it is unset: a build
 * that cannot be signed here must still be buildable here.
 *
 * Signing is not the same as notarizing, and the second one is `packaging/notarize.mjs`: a
 * signed package installs, and a notarized one is also stapled so that the app inside it
 * launches on a machine that has never seen the developer.
 *
 * Usage, from the repository root after `npm run dist:dir` in `ui/`:
 *
 *     node packaging/make-pkg.mjs
 *
 * or `npm run dist:pkg` in `ui/`, which builds the bundle first and then runs this. The
 * release workflow (`.github/workflows/release.yml`) runs that same npm script on a macOS
 * runner, so the published installer is the one this command makes rather than a second
 * recipe written for the runner.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGING = dirname(fileURLToPath(import.meta.url));

/** The repository root, and the package whose `build` block describes the app. */
export const REPO = resolve(PACKAGING, '..');
export const UI = join(REPO, 'ui');

/**
 * Where the package puts the app.
 *
 * `/Applications` rather than a directory of this project's own, because the `.zip` beside
 * it installs there: two downloads of one app that landed in two places would be two
 * answers to "where is Seek" and one of them would be wrong. (EMRG's package installs into
 * the user's home, `~/.emrg/install`, because what it installs is a runtime with no place
 * in `/Applications`; this app is a plain bundle and has one.)
 */
export const INSTALL_LOCATION = '/Applications';

/**
 * What one run of `pkgbuild` would do.
 *
 * Exported because this is the single place the installer's shape is decided, and the
 * packaging test pins it: the bundle the package is cut from, where it installs, what it
 * claims to be, and what file it becomes. A caller taking the bundle from anywhere else, or
 * a version typed here instead of read, is the drift this function exists to make visible.
 */
export function pkgPlan(options = {}) {
  const ui = options.ui ?? UI;
  const app = JSON.parse(readFileSync(join(ui, 'package.json'), 'utf8'));
  const arch = options.arch ?? 'arm64';
  const product = app.build.productName;
  const bundle = join(ui, 'release', `mac-${arch}`, `${product}.app`);
  // Named the way electron-builder names the zip beside it, so the two files of one release
  // sort together and a reader can tell them apart by the extension alone.
  const output = join(ui, 'release', `${product}-${app.version}-${arch}-mac.pkg`);
  return {
    product,
    arch,
    version: app.version,
    identifier: app.build.appId,
    bundle,
    output,
    installLocation: INSTALL_LOCATION,
    argv: [
      '--component',
      bundle,
      '--install-location',
      INSTALL_LOCATION,
      '--identifier',
      app.build.appId,
      '--version',
      app.version,
      output,
    ],
  };
}

/**
 * What one run of `productsign` would do, or why it would not run.
 *
 * Derived rather than performed, for the same reason `pkgPlan` is: the packaging test reads
 * this to pin that a signed build signs *this* file with *that* identity, and that an
 * unsigned one says so instead of quietly shipping. The identity is read from the
 * environment because a certificate is a machine's, not a repository's — the runner has one
 * and a laptop does not.
 */
export function signingPlan(options = {}) {
  const environment = options.environment ?? process.env;
  const plan = pkgPlan(options);
  const identity = (options.identity ?? environment.MACOS_INSTALLER_IDENTITY ?? '').trim();
  if (identity === '') {
    return { signed: false, identity: '', input: plan.output, output: plan.output, argv: [] };
  }
  // `productsign` refuses to write over its own input, so the signed copy is a second file
  // that replaces the unsigned one once it exists and has been checked.
  const output = plan.output.replace(/\.pkg$/, '-signed.pkg');
  return { signed: true, identity, input: plan.output, output, argv: ['--sign', identity, plan.output, output] };
}

function main() {
  const plan = pkgPlan();
  if (!existsSync(plan.bundle)) {
    console.error(`no app at ${plan.bundle}`);
    console.error('build it first:  cd ui && npm run dist:dir');
    process.exitCode = 1;
    return;
  }

  console.log(`==> ${plan.product} ${plan.version}: ${plan.bundle}`);
  execFileSync('pkgbuild', plan.argv, { stdio: 'inherit' });

  // A package that carries no app installs nothing and still looks built, so the payload is
  // read back rather than assumed: `pkgutil --payload-files` lists what is inside, and the
  // bundle has to be a top-level row of it.
  const payload = execFileSync('pkgutil', ['--payload-files', plan.output], { encoding: 'utf8' });
  if (!payload.split('\n').some((row) => row.trim() === `./${plan.product}.app`)) {
    console.error(`the package does not carry ${plan.product}.app — it would install nothing`);
    process.exitCode = 1;
    return;
  }

  const megabytes = (statSync(plan.output).size / 1e6).toFixed(1);
  console.log(`==> ${plan.output} (${megabytes} MB), installs ${plan.product}.app into ${plan.installLocation}`);

  const signing = signingPlan();
  if (!signing.signed) {
    console.log('    unsigned: MACOS_INSTALLER_IDENTITY is not set on this machine, so this');
    console.log('    package is one Gatekeeper asks about — see "Install the app" in README.md');
    return;
  }

  console.log(`==> productsign: ${signing.identity}`);
  execFileSync('productsign', signing.argv, { stdio: 'inherit' });

  // Read the signature back instead of trusting the exit code. What macOS asks before it runs
  // an installer is a specific question — is this signed by a `Developer ID Installer`
  // certificate — and a package signed with some other kind of certificate is one the reader
  // is refused, silently, at the moment they double-click it.
  //
  // `pkgutil --check-signature` exits **1** on a package it finds no signature on (measured on
  // an unsigned `v0.1.1` `.pkg`), so its output is what gets read, on both paths: the throw is
  // caught so the release says which chain was missing rather than printing a stack trace.
  let check = '';
  try {
    check = execFileSync('pkgutil', ['--check-signature', signing.output], { encoding: 'utf8' });
  } catch (error) {
    check = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  if (!check.includes('Developer ID Installer')) {
    console.error('the signed package does not carry a Developer ID Installer chain, so macOS');
    console.error('would still refuse it. pkgutil said:');
    console.error(check.trim());
    process.exitCode = 1;
    return;
  }

  // One file, not two: the release publishes `Seek-<version>-arm64-mac.pkg`, and a second name
  // beside it would leave the reader choosing between a signed and an unsigned build.
  renameSync(signing.output, plan.output);
  console.log('    signed: a Developer ID Installer chain, read back with pkgutil');
  console.log('    notarization is a separate step: node packaging/notarize.mjs');
}

// Run only when this file is the program, not when a test imports the plan above.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
