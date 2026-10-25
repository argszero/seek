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
 * **The package is unsigned.** `productsign` would need a `Developer ID Installer` identity
 * and this project has none — the same fact as `docs/decisions.md` default 26, that the
 * download is unsigned and not notarized — so this script does not pretend to sign. The
 * README says what Gatekeeper does about that instead.
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
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  console.log('    unsigned: Gatekeeper asks the first time — see "Install the app" in README.md');
}

// Run only when this file is the program, not when a test imports the plan above.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
