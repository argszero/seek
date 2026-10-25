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
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { pkgPlan, signingPlan } from '../../packaging/make-pkg.mjs'
import { failureTextOf, notarizePlan, verdictOf } from '../../packaging/notarize.mjs'

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

test('the build signs when it is given a certificate, and is honest when it is not', () => {
  // `identity: null` used to stand here, and it meant "never sign". It was true while this
  // project had no certificate; it is false now, and worse, it *forbids* the runner from
  // signing even when `CSC_LINK` is set. What is asserted instead is the arrangement that
  // makes both machines work: nothing is pinned, electron-builder signs when a certificate is
  // supplied and skips (with a warning) when none is, which is what a laptop has.
  assert.equal(build.mac.identity, undefined, 'no identity is hard-coded, so CSC_LINK decides')

  // Hardened runtime is one of the three conditions notarization requires — the other two are
  // a Developer ID certificate and a timestamp, and they are `codesign`'s flags rather than
  // this file's.
  assert.equal(build.mac.hardenedRuntime, true)

  // The app is notarized as the installer that contains it, so electron-builder's own
  // notarize step would be a second submission of the same code.
  assert.equal(build.mac.notarize, false)
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.notEqual(pkg.version, '0.0.0', 'a download is a release, not an unfilled placeholder')
})

test('the entitlements an Electron app needs under hardened runtime are in the repository', () => {
  // V8 compiles JavaScript while it runs, and the hardened runtime refuses to execute that
  // memory unless the entitlement says so. A signed build that lacks it opens a window and
  // then dies on the first script — a failure no unsigned build can show, because unsigned
  // builds are not hardened.
  const path = join(UI, build.mac.entitlements)
  assert.ok(existsSync(path), `${build.mac.entitlements} exists`)
  assert.equal(build.mac.entitlementsInherit, build.mac.entitlements, 'the helpers get the same answers as the app')

  const plist = readFileSync(path, 'utf8')
  for (const key of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
  ]) {
    assert.match(plist, new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<true/>`), `${key} is granted`)
  }

  // Apple rejects a notarization submission for an entitlement it did not grant, so an
  // unknown key is a red release rather than a permissive default.
  // `-` belongs in this class: every entitlement name here has one (`allow-jit`), and a
  // pattern without it silently matches nothing — which would make this assertion vacuous.
  const declared = new Set([...plist.matchAll(/<key>([\w.-]+)<\/key>/g)].map(([, key]) => key))
  assert.deepEqual([...declared].sort(), [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
  ])
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

test('the package is signed by the installer identity, and unsigned builds stay buildable', () => {
  // Two identities, two jobs, and the wrong one is refused outright: `productsign` will not
  // take a `Developer ID Application` certificate, because an installer and a bundle are
  // assessed by different parts of the system. The identity is a machine's, so it comes from
  // the environment — set on the runner, absent on a laptop.
  const unsigned = signingPlan({ environment: {} })
  assert.equal(unsigned.signed, false)
  assert.equal(unsigned.identity, '')
  assert.deepEqual(unsigned.argv, [], 'nothing is run when there is no identity')
  assert.equal(unsigned.output, unsigned.input, 'and no second file appears beside the package')

  const identity = 'Developer ID Installer: anqing shao (Y55RQ6LU24)'
  const signed = signingPlan({ environment: { MACOS_INSTALLER_IDENTITY: identity } })
  assert.equal(signed.signed, true)
  assert.equal(signed.identity, identity)
  assert.deepEqual(signed.argv, ['--sign', identity, signed.input, signed.output])

  // `productsign` refuses to write over its own input, so the signed copy is a second name
  // that replaces the first once `pkgutil --check-signature` has read the chain back.
  assert.notEqual(signed.output, signed.input)
  assert.match(signed.output, /-signed\.pkg$/)
  assert.equal(signed.input, pkgPlan().output, 'the input is the file pkgPlan writes')
})

test('notarization refuses to run on a guess, and never reads an Invalid verdict as done', () => {
  // Three values and no defaults: a wrong issuer ID and a missing one fail the same quiet way,
  // so the plan says which are absent rather than submitting something Apple will reject.
  const bare = notarizePlan({ environment: {} })
  assert.equal(bare.ready, false)
  assert.deepEqual(bare.missing, ['MACOS_NOTARY_KEY', 'MACOS_NOTARY_KEY_ID', 'MACOS_NOTARY_ISSUER_ID'])

  const ready = notarizePlan({
    environment: { MACOS_NOTARY_KEY: '/tmp/AuthKey.p8', MACOS_NOTARY_KEY_ID: 'KEYID', MACOS_NOTARY_ISSUER_ID: 'ISSUER' },
  })
  assert.equal(ready.ready, true)
  assert.deepEqual(ready.missing, [])

  // The file submitted is the file `dist:pkg` published — one name, or "notarize the installer"
  // could come to mean a different file from "build the installer".
  assert.equal(ready.file, pkgPlan().output)
  assert.equal(ready.file, join(UI, 'release', `Seek-${pkg.version}-arm64-mac.pkg`))
  assert.deepEqual(ready.submitArgv.slice(0, 3), ['xcrun', 'notarytool', 'submit'])
  assert.equal(ready.submitArgv[3], ready.file, 'the file comes before the credentials')
  assert.ok(ready.submitArgv.includes('--wait'), 'the step waits rather than polling later')
  assert.deepEqual(ready.submitArgv.slice(-2), ['--output-format', 'json'], 'the verdict is read, not the exit code')

  // `notarytool` is not in `/usr/bin` — it ships inside Xcode — so its bare name is one the
  // release runner does not have. That is measured, not supposed: `v0.1.2`'s first run failed
  // at this step on `ENOENT` and printed `notarytool could not complete the submission:`
  // followed by an empty line, because an `ENOENT` carries no `stdout` for a message to hold.
  // Every call therefore goes through `xcrun`, which is `/usr/bin/xcrun` on every macOS.
  assert.equal(ready.submitArgv[0], 'xcrun', 'the tool is reached through xcrun, never by bare name')
  assert.deepEqual(ready.logArgvFor('sub-1').slice(0, 4), ['xcrun', 'notarytool', 'log', 'sub-1'])
  assert.deepEqual(ready.stapleArgv.slice(0, 3), ['xcrun', 'stapler', 'staple'])
  assert.deepEqual(ready.validateArgv.slice(0, 3), ['xcrun', 'stapler', 'validate'])
  assert.equal(ready.stapleArgv[3], ready.file, 'the ticket is stapled to the file that was submitted')
  assert.equal(ready.validateArgv[3], ready.file, 'and validated on the same file')

  // The trap this exists for: `notarytool submit --wait` exits **0** on `Invalid`, so the
  // status is a value and it is asserted as one. Anything that is not `Accepted` — including
  // output that is not JSON at all — must not read as accepted.
  assert.equal(verdictOf('{"status":"Accepted","id":"a-1"}').status, 'Accepted')
  const rejected = verdictOf('{"status":"Invalid","id":"b-2","message":"see log"}')
  assert.equal(rejected.status, 'Invalid')
  assert.equal(rejected.id, 'b-2', 'the id is what `notarytool log` needs for the reasons')
  assert.equal(verdictOf('error: something went wrong').status, 'unreadable')
  for (const output of ['{"status":"Invalid"}', 'not json', '{}']) {
    assert.notEqual(verdictOf(output).status, 'Accepted', `${output} is not a pass`)
  }

  // The other half of that run: a failure that produced no output at all still has to say
  // something. A call that never started is the case that has none, so the reason printed is
  // the error's own code — and the command line comes with it, which is the line a person
  // needs to see the missing tool in. Before this, a red release's whole message was a colon.
  const absent = Object.assign(new Error('spawn xcrun ENOENT'), { code: 'ENOENT' })
  const silent = failureTextOf(absent, ['xcrun', 'notarytool', 'submit', 'Seek-0.0.0.pkg'])
  assert.match(silent, /ENOENT/, 'the reason is named when there is no output to carry it')
  assert.match(silent, /xcrun notarytool submit Seek-0\.0\.0\.pkg/, 'and so is the command line')
  assert.notEqual(silent.trim(), '', 'a failed step never prints nothing')

  // When there *is* output, that is what gets printed: notarytool's own account is the answer,
  // and this must not talk over it.
  assert.equal(
    failureTextOf({ stderr: 'line\nError: HTTP status 401\n' }, ['xcrun', 'notarytool']),
    'line\nError: HTTP status 401',
  )
})

test('the entitlements are well-formed XML, which is a stricter question than plutil asks', () => {
  // This case exists because the file shipped broken once, and every check that was here
  // passed: the keys were all present, the values were all `<true/>`, and `plutil -lint`
  // answered OK. What failed was `codesign`, on the release runner, with
  // "Failed to parse entitlements: AMFIUnserializeXML: syntax error near line 7" — the
  // explanation at the top of the file had written a flag out in full, and two hyphens in a
  // row are illegal inside an XML comment. A comment is not a safe place to put prose.
  const path = join(UI, build.mac.entitlements)
  const plist = readFileSync(path, 'utf8')

  const comments = [...plist.matchAll(/<!--([\s\S]*?)-->/g)].map(([, body]) => body)
  assert.ok(comments.length > 0, 'the file explains itself in comments, which is why this matters')
  for (const body of comments) {
    assert.ok(
      !body.includes('--'),
      'two hyphens in a row are illegal inside an XML comment: codesign refuses the whole file while plutil -lint answers OK',
    )
  }

  // The rule above is only one way to be malformed, so a real parser is asked as well.
  // `plutil` is deliberately not used here — it is the reader that said OK on the file
  // `codesign` refused, so trusting it would reproduce the defect rather than catch it.
  let xmllint
  try {
    execFileSync('xmllint', ['--nonet', '--noout', path], { stdio: ['ignore', 'pipe', 'pipe'] })
    xmllint = { ran: true, output: '' }
  } catch (error) {
    if (error?.code === 'ENOENT') xmllint = { ran: false, output: '' }
    else xmllint = { ran: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
  if (xmllint.ran) {
    assert.equal(xmllint.output.trim(), '', `xmllint accepts the entitlements: ${xmllint.output.trim()}`)
  } else {
    // Recorded rather than silently passing: the double-hyphen rule above still held.
    console.log('# xmllint is not installed, so only the double-hyphen rule was checked')
  }
})
