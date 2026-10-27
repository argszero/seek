/**
 * Who a room's people panel lists, and in what order.
 *
 * The panel does two jobs in one list: it says **who is in this room**, and it offers
 * **whoever else may be put in it**. Those are two different questions with two different
 * answers — a room's members are the kernel's `Membership` rows, and the offers are
 * `snapshot.people` — and the panel used to map only the second. That was invisible while the
 * two lists happened to agree.
 *
 * They cannot be made to agree, because `peopleOf()` offers this organization's reader and its
 * bots and nothing else (a person is never made, invited or deleted here), while a store can
 * still hold a human from the seed that wrote one. Filtered out of the offers, that member
 * would have no row — in a room whose own header still counts them, since the count reads the
 * memberships. A member nobody can see is a member nobody can take out, so the panel draws
 * them: the room's own rows first, then the offers.
 *
 * The order is the kernel's for members (the order the memberships were written) and the
 * store's for the offers, which is the order `peopleOf()` already promises — a list that
 * reorders itself between two snapshots moves under the cursor of somebody choosing.
 */
export function peopleInRoom(room, people) {
  const members = (room?.members ?? []).map((member) => ({
    id: member.id,
    name: member.name,
    bot: member.bot,
  }))
  const listed = new Set(members.map((member) => member.id))
  return [...members, ...(people ?? []).filter((person) => !listed.has(person.id))]
}
