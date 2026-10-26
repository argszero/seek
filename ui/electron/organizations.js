/**
 * Organizations: several worlds on one machine, each in its own directory.
 *
 * **What an organization is, and is not.** An organization is a name and a directory. It is not
 * a login, not a tenant, not a permission — there is no server to log in to. What it buys is
 * isolation: two organizations share no room, no message, no picture and no roster, because each
 * has its own `seek.json`, its own `media/` and its own `agents.yml`. Switching between them
 * reads the other store; it moves and deletes nothing, which is the whole point of asking for
 * isolation. Deleting one is the only step that removes anything, and it removes that
 * organization's directory with it, because a row without its world is not an organization
 * anybody asked for.
 *
 * **The name belongs to the organization and to nothing inside it.** The host settled this
 * (2026-10-26T20:03): creating one asks for a name and nothing else, renaming one changes that
 * name and nothing else. In particular it never renames the person inside the world — that
 * person is the store's own business, and an organization called `work` may well hold somebody
 * called 邵安清.
 *
 * **The layout**, under the directory `SEEK_DATA_DIR` names or `seek-data/` by default:
 *
 * ```
 * seek-data/
 *   organizations.json           the index: which organizations exist, and which one is open
 *   <org-id>/seek.json           each world, with media/ and agents.yml beside it
 *   <org-id>/media/
 *   <org-id>/agents.yml
 * ```
 *
 * **A directory per organization rather than a prefix on one file.** The kernel already puts a
 * store's pictures and its roster *beside the store* (`media.js`, `rosterPath`), so a directory
 * is the one change that isolates all three at once — and it keeps every path the rest of the
 * app builds a path it already knew.
 *
 * **The store from before organizations is adopted, not abandoned.** A machine that has been
 * running this app has `seek-data/seek.json` and no index. On the first start after this exists,
 * that store is *moved* — with its `media/` and `agents.yml` — into a new organization directory
 * and indexed under the name its own self principal already has. Nothing is copied and nothing
 * is rewritten: it is the same bytes, in the place the new layout expects.
 *
 * **The weights are not here.** They are 2.18 GB and they are a fact about the machine, not
 * about a world: `weights/` stays where it was, so a second organization costs a `seek.json`.
 */

const { randomUUID } = require('node:crypto')
const { mkdir, readFile, rename, rm, stat, writeFile } = require('node:fs/promises')
const { dirname, join } = require('node:path')

const INDEX_FILE = 'organizations.json'
/** What an organization with no name is called in the list. Visible, and obviously not a name. */
const UNTITLED = 'untitled'
const STORE_FILE = 'seek.json'
/** The two things that live beside a store, and so move with it. */
const STORE_COMPANIONS = ['media', 'agents.yml']

/** The paths this layout implies, for a data root. */
function layoutOf(root) {
  return {
    root,
    indexPath: join(root, INDEX_FILE),
    orgDir: (id) => join(root, id),
    storePath: (id) => join(root, id, STORE_FILE),
  }
}

/**
 * The index, as it is on disk, or why it is not.
 *
 * A missing file is not a failure: it is a machine that has not run this version yet, and
 * `openOrganizations` is what turns that into an organization list (from the store it finds) or
 * into a first organization. Anything else — unreadable, not JSON, no `organizations` array — is
 * a refusal, because guessing at a damaged index would mean guessing which organization a person
 * is looking at.
 */
async function readIndex(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { index: null, refusal: null }
    return { index: null, refusal: `${path} could not be read (${error.message})` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { index: null, refusal: `${path} is not readable JSON (${error.message})` }
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.organizations)) {
    return { index: null, refusal: `${path} does not hold an organizations list` }
  }
  const organizations = parsed.organizations
    .filter((one) => one && typeof one.id === 'string' && typeof one.name === 'string')
    .map((one) => ({ id: one.id, name: one.name, createdAt: one.createdAt ?? null }))
  if (organizations.length === 0) {
    return { index: null, refusal: `${path} lists no organizations` }
  }
  const current = organizations.some((one) => one.id === parsed.current)
    ? parsed.current
    : organizations[0].id
  return { index: { current, organizations }, refusal: null }
}

/**
 * Write the index whole, beside itself and renamed into place.
 *
 * The window and the store are two files that must agree about which organization is open, and a
 * launch that read a half-written index would answer with an organization that does not exist.
 * The temporary name carries the pid so two saves in one process cannot collide.
 */
async function writeIndex(path, index) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  const body = { current: index.current, organizations: index.organizations }
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  return index
}

/**
 * Move a store from before this layout into an organization directory.
 *
 * **Only the store and the two things beside it**, and only when the target does not exist: a
 * directory already there means this ran before, and moving over it would be data loss. The
 * weights are not here on purpose — they are not in `seek-data/`, and a machine that has them
 * must not be asked to fetch them again because it gained an organization list.
 *
 * Returns the id it adopted the store as, or `null` when there was nothing to adopt.
 */
async function adoptLegacyStore(root, { id = `org-${randomUUID()}`, name = 'me' } = {}) {
  const paths = layoutOf(root)
  const legacy = join(root, STORE_FILE)
  const present = await exists(legacy)
  if (!present) return null
  const target = paths.orgDir(id)
  if (await exists(target)) return null
  await mkdir(target, { recursive: true })
  await rename(legacy, join(target, STORE_FILE))
  for (const companion of STORE_COMPANIONS) {
    const from = join(root, companion)
    if (await exists(from)) await rename(from, join(target, companion))
  }
  return { id, name }
}

/**
 * The organization list for this launch, making one where there is none.
 *
 * Three states, in the order they are possible on a real machine:
 *
 * - an index exists → use it;
 * - no index but a store at the root → adopt it (a machine that ran the version before this);
 * - neither → one organization called `me`, which is the name the kernel's own seed gives the
 *   person (`src/main.ts`, `seedOneRoom`). The directory is not made here: opening an
 *   organization seeds it, and a launch that made a directory for a store that was never opened
 *   would leave an empty world on disk.
 *
 * `refusal` is a damaged index and nothing else. A machine whose index cannot be read is not
 * silently given a fresh organization: that would look exactly like a person's rooms
 * disappearing.
 */
async function openOrganizations({
  root,
  now = new Date().toISOString(),
  id = () => `org-${randomUUID()}`,
} = {}) {
  const paths = layoutOf(root)
  const read = await readIndex(paths.indexPath)
  if (read.index) return { ...read, created: false }
  if (read.refusal) return { index: null, refusal: read.refusal, created: false }

  const adopted = await adoptLegacyStore(root, { id: id(), name: 'me' })
  const first = adopted ?? { id: id(), name: 'me' }
  const index = { current: first.id, organizations: [{ ...first, createdAt: now }] }
  await writeIndex(paths.indexPath, index)
  return { index, refusal: null, created: true }
}

/**
 * What an organization's name has to be: nothing in particular.
 *
 * **It is a label and it is only a label.** It is shown in the list of organizations and nowhere
 * else — not in the rooms, not in the store, not in a message, and above all not as the name of
 * the person inside — so there is no wrong answer to give. Two organizations may carry the same
 * name, because the id is what tells them apart and a person who names two worlds `work` has
 * said something the app has no business refusing.
 *
 * The one thing done here is trimming whitespace and substituting a visible word for nothing at
 * all: an entry with no name would be a blank row a person cannot tell from a rendering fault.
 */
function nameOf(name) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return { name: trimmed === '' ? UNTITLED : trimmed, refused: null }
}

/**
 * Add an organization, with the name it was given.
 *
 * `createdAt` is stamped here so the list can be ordered the way a person met them. The
 * directory is the caller's next step — a store is seeded when it is first opened, not when it
 * is listed — so a failure between these two leaves an organization that opens into a fresh
 * world rather than a hole in the list.
 */
function createOrganization(index, name, { id, now = new Date().toISOString() } = {}) {
  const named = nameOf(name)
  const organization = { id, name: named.name, createdAt: now }
  return {
    index: { ...index, organizations: [...index.organizations, organization] },
    organization,
    refusal: null,
  }
}

/**
 * Rename one organization.
 *
 * **A name is a label, and only a label.** It shows in the list and on the organization's own
 * row; it is not the name of the person inside that world, and renaming an organization renames
 * no room, no message and no self principal. Two organizations called `work` are a confusing
 * list, not a clash.
 */
function renameOrganization(index, id, name) {
  if (!index.organizations.some((one) => one.id === id)) {
    return { index, refusal: `there is no organization called ${id} in this list` }
  }
  const named = nameOf(name)
  const organizations = index.organizations.map((one) =>
    one.id === id ? { ...one, name: named.name } : one,
  )
  return {
    index: { ...index, organizations },
    organization: organizations.find((one) => one.id === id),
    refusal: null,
  }
}

/** Which organization is open, if changing it is possible at all. */
function switchOrganization(index, id) {
  if (!index.organizations.some((one) => one.id === id)) {
    return { index, refusal: `there is no organization called ${id} in this list` }
  }
  return { index: { ...index, current: id }, refusal: null }
}

/**
 * Take one organization out of the list, and say which organization is open afterwards.
 *
 * **The last organization is not removed.** Somewhere has to be open, and an app with an
 * organization list of zero would have to make one silently at the next start — which is a
 * delete that undid itself. The caller removes the directory *after* this returns; nothing here
 * touches the disk, so a failure in that step leaves an organization that came back rather than
 * a directory nobody can reach.
 */
function removeOrganization(index, id) {
  if (!index.organizations.some((one) => one.id === id)) {
    return { index, refusal: `there is no organization called ${id} in this list` }
  }
  if (index.organizations.length === 1) {
    return { index, refusal: 'this is the only organization: one has to stay open' }
  }
  const organizations = index.organizations.filter((one) => one.id !== id)
  const current = index.current === id ? organizations[0].id : index.current
  return { index: { ...index, current, organizations }, refusal: null }
}

/** Where an organization's directory is. */
function directoryOf(root, id) {
  return layoutOf(root).orgDir(id)
}

/**
 * Delete an organization: its row in the list and its directory, together.
 *
 * **This is the one destructive step, and the ruling says what it destroys.** Deleting an
 * organization deletes the directory with it — no trash, nothing left for a caller to clean up
 * later. So the order is chosen for the failure, not the success: the index is written *first*.
 * A crash between the two leaves a directory no row points at, which is data nobody can reach;
 * the other order would leave a row pointing at a store that is gone, which the app opens as an
 * empty world and seeds as a brand new one.
 *
 * Nothing else is touched: the other organizations, the weights, and the index's own file are as
 * they were, and the last organization is refused before anything is deleted.
 */
async function deleteOrganization(root, id) {
  const paths = layoutOf(root)
  const read = await readIndex(paths.indexPath)
  if (read.refusal) return { index: null, refusal: read.refusal }
  const removed = removeOrganization(read.index, id)
  if (removed.refusal) return { index: read.index, refusal: removed.refusal }
  await writeIndex(paths.indexPath, removed.index)
  await rm(paths.orgDir(id), { recursive: true, force: true })
  return { index: removed.index, refusal: null }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

module.exports = {
  INDEX_FILE,
  UNTITLED,
  STORE_FILE,
  adoptLegacyStore,
  createOrganization,
  deleteOrganization,
  directoryOf,
  layoutOf,
  openOrganizations,
  readIndex,
  removeOrganization,
  renameOrganization,
  switchOrganization,
  writeIndex,
}
