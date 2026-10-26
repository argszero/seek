/**
 * Accounts: one directory each, and an index that says which one is open.
 *
 * What is measured here is what could silently lose a world. **The layout**: an organization's store
 * and the two things that live beside it move together, so pictures and a roster are isolated
 * by the same change that isolates messages. **The adoption**: a machine that ran the version
 * before organizations has `seek-data/seek.json` and no index, and the first start must move that
 * store into a directory rather than leave it behind — a fresh organization would look exactly like
 * a person's rooms disappearing. **The last organization**: removing it is refused, because an app
 * with an empty organization list would have to invent one at the next start, which is a delete that
 * undid itself.
 *
 * Every fixture is a directory this test makes, so nothing here reads the machine it runs on.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  adoptLegacyStore,
  createOrganization,
  deleteOrganization,
  layoutOf,
  openOrganizations,
  readIndex,
  removeOrganization,
  renameOrganization,
  switchOrganization,
  writeIndex,
} from './organizations.js'

async function root() {
  return mkdtemp(join(tmpdir(), 'seek-organizations-'))
}

const at = (n) => `2026-10-26T19:0${n}:00.000Z`
const ids = () => {
  let n = 0
  return () => `org-${(n += 1)}`
}

test('an organization keeps its store, its pictures and its roster in one directory', () => {
  const paths = layoutOf('/data')
  assert.equal(paths.indexPath, '/data/organizations.json')
  assert.equal(paths.storePath('org-1'), '/data/org-1/seek.json')
  assert.equal(paths.orgDir('org-1'), '/data/org-1')
})

test('a machine with nothing gets one organization, called me, and no directory yet', async () => {
  const dir = await root()
  try {
    const opened = await openOrganizations({ root: dir, now: at(1), id: ids() })
    assert.equal(opened.refusal, null)
    assert.equal(opened.index.organizations.length, 1)
    assert.equal(opened.index.organizations[0].name, 'me')
    assert.equal(opened.index.current, opened.index.organizations[0].id)
    // The store is seeded when an organization is first *opened*, so listing one must not make an
    // empty world on disk.
    await assert.rejects(stat(join(dir, opened.index.current)))
    const written = JSON.parse(await readFile(join(dir, 'organizations.json'), 'utf8'))
    assert.equal(written.current, opened.index.current)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the store from before organizations is adopted into a directory, with its pictures and roster', async () => {
  const dir = await root()
  try {
    // The layout the version before organizations left behind.
    await writeFile(join(dir, 'seek.json'), '{"shards":true}', 'utf8')
    await mkdir(join(dir, 'media'))
    await writeFile(join(dir, 'media', 'one.png'), 'bytes', 'utf8')
    await writeFile(join(dir, 'agents.yml'), 'rows: []\n', 'utf8')

    const opened = await openOrganizations({ root: dir, now: at(1), id: ids() })
    const id = opened.index.current

    assert.equal(await readFile(join(dir, id, 'seek.json'), 'utf8'), '{"shards":true}')
    assert.equal(await readFile(join(dir, id, 'media', 'one.png'), 'utf8'), 'bytes')
    assert.equal(await readFile(join(dir, id, 'agents.yml'), 'utf8'), 'rows: []\n')
    // Moved, not copied: the old paths are gone, or the next launch would adopt it again.
    await assert.rejects(stat(join(dir, 'seek.json')))
    await assert.rejects(stat(join(dir, 'media')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an adopted store is not adopted twice', async () => {
  const dir = await root()
  try {
    await writeFile(join(dir, 'seek.json'), '{}', 'utf8')
    const first = await openOrganizations({ root: dir, now: at(1), id: ids() })
    const second = await openOrganizations({ root: dir, now: at(2), id: ids() })
    assert.deepEqual(second.index.organizations, first.index.organizations)
    assert.equal(second.created, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an index that cannot be read is said, not replaced with a fresh organization', async () => {
  const dir = await root()
  try {
    await writeFile(join(dir, 'organizations.json'), 'not json at all', 'utf8')
    const opened = await openOrganizations({ root: dir, now: at(1), id: ids() })
    assert.equal(opened.index, null)
    assert.match(opened.refusal, /not readable JSON/)
    // Nothing was written over it.
    assert.equal(await readFile(join(dir, 'organizations.json'), 'utf8'), 'not json at all')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an index naming a current organization that is not in the list opens the first one', async () => {
  const dir = await root()
  try {
    const path = join(dir, 'organizations.json')
    await writeIndex(path, {
      current: 'org-gone',
      organizations: [
        { id: 'org-1', name: 'one', createdAt: at(1) },
        { id: 'org-2', name: 'two', createdAt: at(2) },
      ],
    })
    const read = await readIndex(path)
    assert.equal(read.index.current, 'org-1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an organization name is a label: anything goes, including a name already used', () => {
  const index = { current: 'org-1', organizations: [{ id: 'org-1', name: 'work', createdAt: at(1) }] }

  const made = createOrganization(index, '  personal  ', { id: 'org-2', now: at(2) })
  assert.equal(made.refusal, null)
  assert.equal(made.organization.name, 'personal')
  assert.equal(made.index.organizations.length, 2)

  // The name is shown in the list and nowhere else — not in the rooms, not in the store — so
  // there is no wrong answer to give. Ids are what tell two organizations apart.
  const twice = createOrganization(index, 'work', { id: 'org-3' })
  assert.equal(twice.refusal, null)
  assert.equal(twice.organization.name, 'work')

  // Whitespace is trimmed, and nothing at all becomes a visible word rather than a blank row.
  assert.equal(createOrganization(index, '\t  \n', { id: 'org-4' }).organization.name, 'untitled')
  assert.equal(createOrganization(index, 'any length at all '.repeat(10), { id: 'org-5' }).refusal, null)
})

test('an organization name is never written into the store, because it has no other use', async () => {
  // The rule the host gave: it is for display. A store whose self principal was renamed to
  // match would give it a second use, and the second use is what this asserts against.
  const host = await readFile(new URL('./host.js', import.meta.url), 'utf8')
  assert.doesNotMatch(host, /nameTheSelf|nameAccountOnDisk/)
})

test('renaming keeps the id, so nothing that points at the organization moves', () => {
  const index = {
    current: 'org-1',
    organizations: [
      { id: 'org-1', name: 'work', createdAt: at(1) },
      { id: 'org-2', name: 'personal', createdAt: at(2) },
    ],
  }
  const renamed = renameOrganization(index, 'org-1', 'office')
  assert.equal(renamed.refusal, null)
  assert.equal(renamed.index.organizations[0].id, 'org-1')
  assert.equal(renamed.index.organizations[0].name, 'office')
  // Renaming to its own name is not a clash with itself.
  assert.equal(renameOrganization(index, 'org-1', 'work').refusal, null)
  // Renaming onto another organization's name is allowed: the names are labels, not keys.
  assert.equal(renameOrganization(index, 'org-1', 'personal').index.organizations[0].name, 'personal')
  assert.match(renameOrganization(index, 'org-9', 'x').refusal, /no organization called org-9/)
})

test('switching changes which organization is open and nothing else', () => {
  const index = {
    current: 'org-1',
    organizations: [
      { id: 'org-1', name: 'work', createdAt: at(1) },
      { id: 'org-2', name: 'personal', createdAt: at(2) },
    ],
  }
  const switched = switchOrganization(index, 'org-2')
  assert.equal(switched.refusal, null)
  assert.equal(switched.index.current, 'org-2')
  assert.deepEqual(switched.index.organizations, index.organizations)
  assert.match(switchOrganization(index, 'org-9').refusal, /no organization called org-9/)
})

test('the last organization is not removed, and removing another moves the open one only if it must', () => {
  const one = { current: 'org-1', organizations: [{ id: 'org-1', name: 'work', createdAt: at(1) }] }
  assert.match(removeOrganization(one, 'org-1').refusal, /only organization/)

  const two = {
    current: 'org-2',
    organizations: [
      { id: 'org-1', name: 'work', createdAt: at(1) },
      { id: 'org-2', name: 'personal', createdAt: at(2) },
    ],
  }
  const keptOpen = removeOrganization(two, 'org-1')
  assert.equal(keptOpen.refusal, null)
  assert.equal(keptOpen.index.current, 'org-2')
  assert.equal(keptOpen.index.organizations.length, 1)

  const closedOpenOne = removeOrganization(two, 'org-2')
  assert.equal(closedOpenOne.index.current, 'org-1')
})

test('deleting an organization deletes its directory with it, and leaves the other world alone', async () => {
  const dir = await root()
  try {
    // Two worlds on disk, each with a store in its own directory.
    for (const id of ['org-1', 'org-2']) {
      await mkdir(join(dir, id), { recursive: true })
      await writeFile(join(dir, id, 'seek.json'), `{"owner":"${id}"}`, 'utf8')
    }
    await writeIndex(join(dir, 'organizations.json'), {
      current: 'org-1',
      organizations: [
        { id: 'org-1', name: 'work', createdAt: at(1) },
        { id: 'org-2', name: 'personal', createdAt: at(2) },
      ],
    })

    const deleted = await deleteOrganization(dir, 'org-1')
    assert.equal(deleted.refusal, null)
    // The whole directory goes, not just the store inside it.
    await assert.rejects(stat(join(dir, 'org-1')), /ENOENT/)
    // The world that was not deleted is untouched, byte for byte.
    assert.equal(await readFile(join(dir, 'org-2', 'seek.json'), 'utf8'), '{"owner":"org-2"}')
    // And the list no longer names it, with the open organization moved off it.
    const after = await readIndex(join(dir, 'organizations.json'))
    assert.deepEqual(after.index.organizations.map((one) => one.id), ['org-2'])
    assert.equal(after.index.current, 'org-2')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleting the last organization is refused and its directory is still there', async () => {
  const dir = await root()
  try {
    await mkdir(join(dir, 'org-1'), { recursive: true })
    await writeFile(join(dir, 'org-1', 'seek.json'), '{}', 'utf8')
    await writeIndex(join(dir, 'organizations.json'), {
      current: 'org-1',
      organizations: [{ id: 'org-1', name: 'work', createdAt: at(1) }],
    })

    const refused = await deleteOrganization(dir, 'org-1')
    assert.match(refused.refusal, /only organization/)
    // A refused delete must not be a delete that half happened.
    await stat(join(dir, 'org-1', 'seek.json'))
    const after = await readIndex(join(dir, 'organizations.json'))
    assert.equal(after.index.organizations.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleting an organization that is not in the list deletes no directory', async () => {
  const dir = await root()
  try {
    await mkdir(join(dir, 'org-1'), { recursive: true })
    await mkdir(join(dir, 'org-9'), { recursive: true })
    await writeFile(join(dir, 'org-9', 'seek.json'), '{"keep":true}', 'utf8')
    await writeIndex(join(dir, 'organizations.json'), {
      current: 'org-1',
      organizations: [{ id: 'org-1', name: 'work', createdAt: at(1) }],
    })

    const refused = await deleteOrganization(dir, 'org-9')
    assert.match(refused.refusal, /no organization called org-9/)
    await stat(join(dir, 'org-9', 'seek.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('adopting does nothing when there is no store to adopt', async () => {
  const dir = await root()
  try {
    assert.equal(await adoptLegacyStore(dir, { id: 'org-1' }), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('adopting does nothing when the target directory is already there', async () => {
  const dir = await root()
  try {
    await writeFile(join(dir, 'seek.json'), '{}', 'utf8')
    await mkdir(join(dir, 'org-1'))
    assert.equal(await adoptLegacyStore(dir, { id: 'org-1' }), null)
    // The store it would have moved over is still where it was.
    await stat(join(dir, 'seek.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
