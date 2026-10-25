/**
 * What a download installs.
 *
 * The interface reaches the kernel by relative path — `await import('../../src/store.ts')` in
 * `electron/host.js`. In the source tree that string is right, because the app's root is `ui/`
 * and two levels up from `ui/electron/` is the repository. Packed into an asar it means
 * something else entirely: the file is then at
 * `Seek.app/Contents/Resources/app.asar/electron/host.js`, so the same `../..` leaves the
 * archive and lands on `Contents/Resources/`. Nothing in the source tree says that, and no
 * test that runs from the source tree can notice it — the source tree is the one layout where
 * the string is obviously correct. The failure would appear on the first launch of the first
 * build anybody downloaded, which is the latest and most expensive place to find it.
 *
 * So the layout is pinned here, as a derived fact rather than a comment: the specifiers are
 * read out of the two files that import the kernel, resolved the way Node resolves them, and
 * required to land where `extraResources` puts them. Change the import and the packaging has
 * to follow; change the packaging and this test says which import it stranded.
 *
 * The rest of the file pins the four other things a packaged app gets wrong quietly, each
 * because the source build hides it: a `package.json` with no module type beside the kernel
 * (Node then re-parses all 47 files on every launch and says so on stderr — measured, and the
 * reason `resources/src-package.json` exists), a production dependency that would be packed
 * into the archive for nothing (the renderer is bundled by vite and the kernel is TypeScript
 * Electron strips itself, so nothing at runtime resolves out of `node_modules`), an output
 * directory that would overwrite the renderer's own build, and an icon or a signature claim
 * that does not match what is actually there.
 *
 * The last two tests pin the **installer** rather than the archive, because a `.pkg` is a
 * second way to install the same bundle and two things about it go wrong quietly: it can be
 * cut from a target that cannot be built in the environment this repository is developed in
 * (`dmg` ends in `hdiutil create`, which that environment refuses), and it can acquire a
 * second recipe on the CI runner, at which point the published file stops being the file the
 * repository makes.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { pkgPlan } from '../../packaging/make-pkg.mjs'

const UI = fileURLToPath(new URL('../', import.meta.url))
const REPO = resolve(UI, '..')
const pkg = JSON.parse(readFileSync(join(UI, 'package.json'), 'utf8'))
const build = pkg.build

/** The files that import the kernel, and the directory Node resolves their specifiers from. */
const IMPORTERS = ['electron/host.js', 'electron/main.js']
const ELECTRON_DIR = join(UI, 'electron')

/** Every relative path either importer uses to reach the kernel, as written. */
function kernelSpecifiers() {
  const found = new Set()
  for (const file of IMPORTERS) {
    const source = readFileSync(join(UI, file), 'utf8')
    for (const [, specifier] of source.matchAll(/(?:await\s+)?import\(\s*'(\.\.\/\.\.\/src\/[^']+)'\s*\)/g)) {
      found.add(specifier)
    }
  }
  return [...found].sort()
}

/** The `extraResources` entry that carries the kernel, by what it copies. */
const kernelEntry = build.extraResources.find((entry) => resolve(UI, entry.from) === join(REPO, 'src'))

test('the kernel is unpacked exactly where the app already looks for it', () => {
  const specifiers = kernelSpecifiers()
  assert.ok(specifiers.length >= 5, `expected the kernel imports, found ${specifiers.length}`)

  assert.ok(kernelEntry, 'extraResources carries ../src')
  assert.equal(kernelEntry.to, 'src')
  assert.deepEqual(kernelEntry.filter, ['**/*.ts'], 'only the kernel sources travel, not its tests or docs')

  // Where a packaged app would be, and where the asar's own `electron/` sits inside it.
  const resources = join('/Applications', 'Seek.app', 'Contents', 'Resources')
  const packedElectron = join(resources, 'app.asar', 'electron')

  for (const specifier of specifiers) {
    // The source tree: `../../src/x.ts` from `ui/electron/` is the repository's own file.
    const inTree = resolve(ELECTRON_DIR, specifier)
    assert.ok(existsSync(inTree), `${specifier} names a file that exists in the source tree`)

    // Packed: the same string leaves the asar, and `extraResources` has to have put the
    // kernel at the other end of it. This is the whole coupling, in one assertion.
    const packed = resolve(packedElectron, specifier)
    assert.ok(
      packed.startsWith(join(resources, kernelEntry.to) + sep),
      `${specifier} lands on ${packed}, which extraResources does not fill`,
    )
    assert.equal(dirname(packed), join(resources, kernelEntry.to))
  }
})

test('the unpacked kernel declares the module type it is written in', () => {
  // Without a `package.json` beside them, Node loads each `.ts` file as an unknown type,
  // detects the syntax, re-parses it as ESM and warns on stderr — once per process start,
  // for all 47 files. Measured on the packaged app before this file existed.
  const declaration = join(UI, 'resources', 'src-package.json')
  assert.ok(existsSync(declaration), 'resources/src-package.json exists')
  assert.equal(JSON.parse(readFileSync(declaration, 'utf8')).type, 'module')

  const entry = build.extraResources.find((candidate) => candidate.to === 'src/package.json')
  assert.ok(entry, 'extraResources ships it beside the kernel')
  assert.equal(resolve(UI, entry.from), declaration)
})

test('nothing at runtime resolves out of node_modules, so none is packed', () => {
  // Both halves are already compiled by other means: vite inlines the renderer into `dist/`,
  // and the kernel is TypeScript that Electron strips itself. A `dependencies` entry would be
  // copied into the archive and never required.
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'the app has no production dependencies')
  assert.ok(pkg.devDependencies.electron, 'electron is the dev dependency that builds it')
  assert.ok(pkg.devDependencies['electron-builder'], 'and electron-builder is what packs it')
})

test('the app is written somewhere other than the renderer build it contains', () => {
  // `vite build` owns `dist/`; a builder with the same default would write the .app on top of
  // the page it just bundled.
  assert.notEqual(build.directories.output, 'dist')
  assert.equal(build.directories.output, 'release')
})

test('the archive holds the page, the main process and nothing else', () => {
  const files = build.files
  assert.ok(files.includes('dist/**/*'), 'the built renderer')
  assert.ok(files.includes('electron/**/*'), 'the main process')
  assert.ok(files.includes('!electron/**/*.test.mjs'), 'but not the tests, which need node --test')
  assert.ok(build.asar, 'one archive rather than a directory of loose files')
})

test('the icon is the repository mark, at the size an icns is cut from', () => {
  assert.equal(build.mac.icon, '../assets/icon.png', 'the app wears the mark the README draws')
  const png = readFileSync(join(REPO, 'assets', 'icon.png'))
  assert.deepEqual(png.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  assert.equal(png.readUInt32BE(16), 1024, 'width')
  assert.equal(png.readUInt32BE(20), 1024, 'height')
})

test('the build is unsigned and says so, and the version is a release', () => {
  // No signing identity is available to this project, so the app is unsigned and not
  // notarized; the release notes carry the consequence rather than the build hiding it.
  assert.equal(build.mac.identity, null)
  assert.equal(build.mac.notarize, false)
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.notEqual(pkg.version, '0.0.0', 'a download is a release, not an unfilled placeholder')
})

test('the installer is cut from the app bundle, and claims what the app already declares', () => {
  const plan = pkgPlan()

  // The bundle it is cut from is the `--dir` output, not the `dmg` target: that target ends
  // in `hdiutil create`, which the environment this repository is developed in refuses, so a
  // recipe that needed it would be a recipe nobody here could run.
  assert.equal(plan.bundle, join(UI, 'release', 'mac-arm64', 'Seek.app'))
  assert.equal(plan.output, join(UI, 'release', `Seek-${pkg.version}-arm64-mac.pkg`))

  // Where the `.zip`'s own instructions already send a reader — two downloads of one app that
  // installed to two places would be one answer too many.
  assert.equal(plan.installLocation, '/Applications')

  // Nothing about the package is typed twice: the identifier and the version are the app's
  // own, read out of the `package.json` this file already parsed.
  assert.equal(plan.identifier, build.appId)
  assert.equal(plan.version, pkg.version)

  assert.deepEqual(plan.argv.slice(0, 2), ['--component', plan.bundle])
  const flag = (name) => plan.argv[plan.argv.indexOf(name) + 1]
  assert.equal(flag('--install-location'), '/Applications')
  assert.equal(flag('--identifier'), build.appId)
  assert.equal(flag('--version'), pkg.version)
  assert.equal(plan.argv.at(-1), plan.output, 'and the last argument is the file it writes')
})

test('one command makes the installer, and the release runs that command', () => {
  // Two recipes for one artifact is how a published file stops being the file this repository
  // makes, so the script is named by the npm script and by the workflow, and the packaging
  // test reads both: change one and this fails before a tag is ever pushed.
  const script = pkg.scripts['dist:pkg']
  assert.ok(script, 'ui/package.json declares dist:pkg')
  assert.match(script, /electron-builder --mac --arm64 --dir/, 'the bundle, and not the dmg target')
  assert.match(script, /node \.\.\/packaging\/make-pkg\.mjs/, 'and then the installer script')

  const workflow = readFileSync(join(REPO, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(workflow, /npm run dist:pkg/, 'the runner runs the command a person runs')
  assert.match(workflow, /runs-on: macos-/, 'on macOS, the only system pkgbuild exists on')
  assert.match(workflow, /refs\/tags\//, 'and it publishes from a tag, not from a branch head')
  assert.match(workflow, /does not name the app's version/, 'a tag and the app must name one version')
})
