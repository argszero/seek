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
 * `extraResources` decides which *files* travel too, and until now it carried only the
 * kernel's TypeScript: the prompt artifacts and the catalogues the kernel reads beside itself
 * were in no download, which nothing in the source tree could see, because there they are
 * simply beside the module. That half is pinned the same derived way — the paths come out of
 * the kernel's own `new URL(…, import.meta.url)` calls rather than out of a list kept here.
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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { pkgPlan, signingPlan } from '../../packaging/make-pkg.mjs'
import {
  failureTextOf,
  isNetworkFailure,
  notarizePlan,
  staplingOf,
  validateOutcomeOf,
  verdictOf,
  withRetries,
} from '../../packaging/notarize.mjs'

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

/** The kernel's own directory, which is what `extraResources` copies. */
const SRC = join(REPO, 'src')

/** The part of electron-builder's glob syntax these filters use. */
function globOf(pattern) {
  let source = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*' && pattern[i + 1] === '*') {
      // `**/` spans zero or more directories, `**` alone spans anything.
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i += 1
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/, '\\$&')
    }
  }
  return new RegExp(source + '$')
}

/**
 * Whether a filter selects a path: at least one inclusion matches, and no exclusion does.
 *
 * electron-builder reads a filter as a list of globs where a `!` prefix removes what an
 * earlier entry let in, which is how the star-star and `!` pair below is written.
 */
function selectBy(filter, relative) {
  const matching = (patterns) =>
    patterns.some((pattern) => globOf(pattern).test(relative))
  const excluded = filter.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1))
  return matching(filter.filter((pattern) => !pattern.startsWith('!'))) && !matching(excluded)
}

/**
 * Every path the kernel computes beside itself, read out of the kernel itself.
 *
 * `new URL('./x', import.meta.url)` is how a module names a file that has to travel with it,
 * so this list grows by an artifact being written rather than by someone remembering to add
 * it here. A literal holding an interpolation (`./i18n/${locale}.json`) stands for its
 * directory, because which name it opens is chosen at run time.
 */
function kernelArtifacts() {
  const found = new Set()
  for (const name of readdirSync(SRC)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    const source = readFileSync(join(SRC, name), 'utf8')
    for (const [, literal] of source.matchAll(/new URL\(\s*['`](\.\/[^'`]+)['`]\s*,\s*import\.meta\.url\s*\)/g)) {
      const interpolation = literal.indexOf('${')
      found.add(interpolation === -1 ? literal : literal.slice(0, interpolation))
    }
  }
  return [...found].sort()
}

test('every file the kernel reads beside itself travels in a download', () => {
  // The defect this exists for, measured on the `v0.1.2` installer and on a bundle built from
  // this branch: `extraResources` was filtered to `**/*.ts`, so `src/prompts/` and `src/i18n/`
  // were in no download at all. Nothing in the source tree could see it — there the files are
  // simply beside the module — and nothing at launch said so either, because the shipped state
  // names no model server and the kernel's placeholder reads no artifact. Naming one on a
  // download returned the kernel's own refusal: *the watch prompt artifact could not be read
  // from …/Resources/src/prompts/watch-v1.json: ENOENT*. So stage 1 and stage 2, which default
  // 27 and default 28 describe and which are the whole point of naming a server, were
  // unreachable in every download up to `v0.1.2`.
  //
  // Which is why the filter is checked against the kernel rather than counted by hand: an
  // artifact added tomorrow is covered the moment the module reads it.
  const selected = (relative) => selectBy(kernelEntry.filter, relative)

  const artifacts = kernelArtifacts()
  assert.ok(artifacts.length >= 3, `expected the kernel's own artifacts, found ${artifacts.length}`)

  for (const artifact of artifacts) {
    const relative = artifact.slice('./'.length)
    if (relative.endsWith('/')) {
      const directory = join(SRC, relative)
      assert.ok(existsSync(directory), `${relative} exists in the source tree`)
      const names = readdirSync(directory)
      assert.ok(names.length > 0, `${relative} holds the files the kernel opens`)
      for (const name of names) {
        assert.ok(
          selected(relative + name),
          `${relative}${name} is read at runtime and extraResources does not carry it ` +
            `(filter: ${kernelEntry.filter.join(', ')})`,
        )
      }
    } else {
      assert.ok(existsSync(join(SRC, relative)), `${relative} exists in the source tree`)
      assert.ok(
        selected(relative),
        `${relative} is read at runtime and extraResources does not carry it ` +
          `(filter: ${kernelEntry.filter.join(', ')})`,
      )
    }
  }

  // The other half, so the filter cannot be widened into "carry everything": the tests need
  // `node --test` and the documents are read by neither half.
  assert.ok(selected('store.ts'), 'every kernel source travels')
  assert.ok(!selected('counts.test.ts'), 'the tests stay behind')
  assert.ok(!selected('README.md'), 'and so do the documents')
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

  // A silent failure that *did* run is not a failure that could not start, and the words have to
  // differ: `stapler` exits 66 on a package with no ticket and says nothing on stderr, so "could
  // not be started" would be a false account of what happened.
  const quiet = failureTextOf({ status: 66 }, ['xcrun', 'stapler', 'validate', 'Seek-0.0.0.pkg'])
  assert.match(quiet, /66/, 'the exit status is the only thing there is to report, so it is reported')
  assert.match(quiet, /ran and failed/, 'the command ran — it did not fail to start')
  assert.doesNotMatch(quiet, /could not be started/, 'which is the other, different event')
  assert.match(quiet, /xcrun stapler validate Seek-0\.0\.0\.pkg/, 'and the command line comes with it')

  // The shape that failure really takes, measured: stapler prints `Processing: <path>` on stdout
  // and exits 66 with an empty stderr. Printing that line alone would say which file, not what
  // went wrong — so the status travels with the words.
  const processingOnly = failureTextOf(
    { status: 66, stdout: 'Processing: /tmp/Seek-0.0.0-arm64-mac.pkg\n', stderr: '' },
    ['xcrun', 'stapler', 'validate', '/tmp/Seek-0.0.0-arm64-mac.pkg'],
  )
  assert.match(processingOnly, /Processing: \/tmp\/Seek-0\.0\.0-arm64-mac\.pkg/, 'what it said is kept')
  assert.match(processingOnly, /exit status 66/, 'and the status is added, because the line is not a reason')
})

test('stapling asks Apple again when Apple did not answer, and never when the package has no ticket', () => {
  // The two failures below are the measured ones. `v0.1.2`'s release run stapled its package
  // (`The staple and validate action worked!`) and then failed the release at `stapler validate`
  // with exactly this pair: exit 68 and `Code=-1005` against `api.apple-cloudkit.com`. The
  // no-ticket failure was measured on this machine: an unnotarized `.pkg` exits 66 and an
  // unnotarized `.app` exits 65, and the `.pkg` says nothing at all on stderr — which is why the
  // exit code is read and not only the prose.
  const unreachable = Object.assign(new Error('Command failed'), {
    status: 68,
    stderr: 'The validate action failed! Error 68.',
    stdout: '/Users/runner/work/_temp/Seek-0.1.2-arm64-mac.pkg\n',
  })
  const lostMidway = Object.assign(new Error('Command failed'), {
    status: 68,
    stderr: 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."',
  })
  const noTicket = Object.assign(new Error('Command failed'), { status: 65, stderr: 'Seek.app does not have a ticket stapled to it.' })
  const unreadable = Object.assign(new Error('Command failed'), { status: 66, stderr: '' })

  assert.equal(isNetworkFailure(unreachable), true, 'EX_NOHOST is Apple not answering')
  assert.equal(isNetworkFailure(lostMidway), true, 'and so is the same thing said in words')
  assert.equal(isNetworkFailure(noTicket), false, 'a file with no ticket is an answer about the file')
  assert.equal(isNetworkFailure(unreadable), false, 'and so is a file stapler cannot read')
  assert.equal(isNetworkFailure(undefined), false, 'nothing to judge is not a network failure')
  // EX_UNAVAILABLE: the far end answered that it could not answer.
  assert.equal(isNetworkFailure({ status: 69 }), true)

  const waits = []
  let calls = 0
  const flaky = withRetries(
    () => {
      calls += 1
      if (calls < 3) throw unreachable
      return 'The staple and validate action worked!'
    },
    { wait: (pause) => waits.push(pause) },
  )
  assert.equal(flaky.ok, true, 'the third answer is taken')
  assert.equal(flaky.attempts, 3)
  assert.equal(flaky.value, 'The staple and validate action worked!')
  assert.deepEqual(waits, [5000, 20000], 'the pauses are the declared ones, and only between attempts')

  // A real answer is not asked twice: one call, no pause, and the error comes back as it was.
  let asked = 0
  const missing = withRetries(
    () => {
      asked += 1
      throw noTicket
    },
    {
      wait: () => {
        throw new Error('a package with no ticket must not be waited on')
      },
    },
  )
  assert.equal(missing.ok, false)
  assert.equal(asked, 1, 'asked once, because the answer would be the same')
  assert.equal(missing.error.status, 65)

  // Exhausting the retries still reports what happened, and says how many times it asked.
  let tries = 0
  const down = withRetries(
    () => {
      tries += 1
      throw lostMidway
    },
    { wait: () => {} },
  )
  assert.equal(down.ok, false)
  assert.equal(tries, 3)
  assert.equal(down.error, lostMidway, 'the last error is the one reported')

  // The decision the release hangs on: the same three results read as three different things.
  assert.equal(validateOutcomeOf({ ok: true, value: 'The validate action worked!', attempts: 1, error: null }), 'confirmed')
  assert.equal(validateOutcomeOf(down), 'unconfirmed', 'an unreachable service does not unsign the package')
  assert.equal(validateOutcomeOf(missing), 'failed', 'a package with no ticket is not finished')
})

test('the release staples, then re-reads, and tells the three outcomes apart', () => {
  // This is the half of the release that cannot run on a laptop — a package built without the
  // installer identity is not one Apple accepts, so there is no ticket to staple and no way to
  // reach this code — so it is driven here with the tools replaced. What is asserted is the
  // decision the release hangs on, in the order it makes it.
  const plan = notarizePlan({
    environment: { MACOS_NOTARY_KEY: '/tmp/AuthKey.p8', MACOS_NOTARY_KEY_ID: 'KEYID', MACOS_NOTARY_ISSUER_ID: 'ISSUER' },
  })
  const unconfirmedRun = Object.assign(new Error('Command failed'), {
    status: 68,
    stdout: `Processing: ${plan.file}\n`,
    stderr: 'The validate action failed! Error 68.\n',
  })

  // Both steps answered: stapled, and no warning to explain.
  const seen = []
  const happy = staplingOf(plan, {
    run: (argv) => {
      seen.push(argv.join(' '))
      return argv === plan.stapleArgv ? 'The staple and validate action worked!' : 'The validate action worked!'
    },
    wait: () => assert.fail('nothing is waited on when both steps answer'),
  })
  assert.equal(happy.outcome, 'stapled')
  assert.equal(happy.error, null)
  assert.deepEqual(seen, [plan.stapleArgv.join(' '), plan.validateArgv.join(' ')], 'staple first, then the re-read')
  assert.ok(seen[0].includes('xcrun stapler staple'), 'the real commands, reached the way they are reached')
  assert.ok(seen[1].includes('xcrun stapler validate'))

  // Apple stops answering only at the re-read — exactly the `v0.1.2` run. Retried, then reported
  // as unconfirmed rather than failed, because the ticket is already in the file.
  const waits = []
  let validations = 0
  const unreachable = staplingOf(plan, {
    run: (argv) => {
      if (argv === plan.validateArgv) {
        validations += 1
        throw unconfirmedRun
      }
      return 'The staple and validate action worked!'
    },
    wait: (pause) => waits.push(pause),
  })
  assert.equal(unreachable.outcome, 'unconfirmed')
  assert.equal(unreachable.step, 'validate')
  assert.equal(validations, 3, 'asked three times before giving up')
  assert.deepEqual(waits, [5000, 20000])
  assert.equal(unreachable.error, unconfirmedRun, 'the last answer is the one reported')

  // A package with no ticket after stapling is a real failure, and the re-read is never reached
  // when stapling itself gives a real answer.
  let reached = []
  const missingTicket = staplingOf(plan, {
    run: (argv) => {
      reached.push(argv === plan.stapleArgv ? 'staple' : 'validate')
      const error = Object.assign(new Error('Command failed'), { status: 65, stderr: 'no ticket' })
      throw error
    },
    wait: () => assert.fail('a package with no ticket is not waited on'),
  })
  assert.equal(missingTicket.outcome, 'failed')
  assert.equal(missingTicket.step, 'staple')
  assert.deepEqual(reached, ['staple'], 'and the second step is not asked about a file the first one refused')

  // A re-read that runs and answers 65 is the other real failure, and it is not the network.
  const noTicketAfterStaple = staplingOf(plan, {
    run: (argv) => {
      if (argv === plan.stapleArgv) return 'The staple and validate action worked!'
      throw Object.assign(new Error('Command failed'), { status: 65, stdout: `Processing: ${plan.file}\n` })
    },
    wait: () => assert.fail('that answer would not change on a second ask'),
  })
  assert.equal(noTicketAfterStaple.outcome, 'failed')
  assert.equal(noTicketAfterStaple.step, 'validate')
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
