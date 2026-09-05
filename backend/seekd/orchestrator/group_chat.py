"""Pure group-chat algorithms, ported from grok-bot's GroupChatOrchestrator.

These are the deterministic, dependency-free pieces: mention parsing, responder
resolution, round-robin ordering, pass detection, and turn-prompt building. The
async driver (orchestrator.py) wires these to the agent runner.

Constants mirror grok-bot's group-chat.ts. Comments cite the TS origin where the
behavior is subtle.
"""

from __future__ import annotations

import re

# Bounds (grok-bot: GROUP_MAX_* / SHARED_ROOM_HISTORY_LIMIT).
GROUP_MAX_ROUNDS = 3
GROUP_MAX_MEMBER_TURNS = 10
GROUP_MAX_MESSAGES_PER_TURN = 2
GROUP_PROMPT_HISTORY_LIMIT = 24
SHARED_ROOM_HISTORY_LIMIT = 24

_IS_PASS_RE = re.compile(r"^\(?\s*pass\s*\)?\.?$", re.IGNORECASE)
_MENTION_HANDLE_RE = re.compile(r"@(everyone|all)\b")


def order_round_speakers(member_ids: list[str], round_: int) -> list[str]:
    """Rotate the starting member each round: ``offset = round % len(member_ids)``."""
    n = len(member_ids)
    if n == 0:
        return []
    offset = (round_ % n + n) % n
    return member_ids[offset:] + member_ids[:offset]


def is_pass_content(content: str) -> bool:
    """True if a member explicitly declines to speak (grok-bot ``isPassContent``)."""
    return not content.strip() or bool(_IS_PASS_RE.match(content.strip()))


def member_mention_handles(name: str) -> list[str]:
    """Variants of a member's name to match for @mentions (grook-bot ``memberMentionHandles``)."""
    lower = name.strip().lower()
    if not lower:
        return []
    handles = {lower, re.sub(r"\s+", "", lower)}
    first = lower.split()[0]
    if first:
        handles.add(first)
    return list(handles)


def _is_word_char(char: str | None) -> bool:
    return char is not None and re.match(r"[a-z0-9]", char) is not None


def _has_mention_at(lower: str, handle: str) -> bool:
    needle = f"@{handle}"
    index = lower.find(needle)
    while index >= 0:
        before_ok = index == 0 or not _is_word_char(lower[index - 1])
        after = index + len(needle)
        after_ok = after >= len(lower) or not _is_word_char(lower[after])
        if before_ok and after_ok:
            return True
        index = lower.find(needle, index + 1)
    return False


def parse_group_mentions(text: str, members: list[tuple[str, str]]) -> tuple[bool, list[str]]:
    """Return ``(isEveryone, mentioned_member_ids)`` for a message text.

    ``members`` is a list of ``(id, name)``. This mirrors grok-bot's
    ``parseGroupMentions``.
    """
    lower = text.lower()
    mentioned: list[str] = []
    seen: set[str] = set()
    for mid, name in members:
        if mid in seen:
            continue
        if any(_has_mention_at(lower, h) for h in member_mention_handles(name)):
            mentioned.append(mid)
            seen.add(mid)
    is_everyone = bool(_MENTION_HANDLE_RE.search(lower))
    return is_everyone, mentioned


def resolve_responders(
    members: list[tuple[str, str]],
    history: list[dict],
) -> list[tuple[str, str]]:
    """Who responds to the latest user message? (grok-bot ``resolveResponders``).

    Scan backward from the last ``speaker == 'user'`` message, parse @mentions in
    that tail; respond to the mentioned members, or everyone if no one is
    mentioned or @everyone/@all appears.
    """
    # history entries: { speaker, text } — speaker 'user' = the human.
    start = 0
    for i in range(len(history) - 1, -1, -1):
        if history[i].get("speaker") == "user":
            start = i
            break
    everyone = False
    mentioned: set[str] = set()
    for msg in history[start:]:
        targets = parse_group_mentions(msg.get("text", ""), members)
        everyone = everyone or targets[0]
        for mid in targets[1]:
            mentioned.add(mid)
    if everyone or not mentioned:
        return members
    return [m for m in members if m[0] in mentioned]


def messages_since_member_last_spoke(history: list[dict], member_id: str) -> list[dict]:
    """New messages after the member's last turn (grok-bot ``messagesSinceMemberLastSpoke``)."""
    for i in range(len(history) - 1, -1, -1):
        sp = history[i].get("speaker")
        if sp == member_id or (isinstance(sp, dict) and sp.get("id") == member_id):
            return history[i + 1:]
    return history


# ---- prompt builders -----------------------------------------------------

_GROUP_TAG_PREFIX = "[Group chat: "


def format_group_chat_tag(group_name: str, peers: list[str]) -> str:
    name = group_name.strip() or "the group"
    if peers:
        return f'{_GROUP_TAG_PREFIX}"{name}" - with {", ".join(peers)}]'
    return f'{_GROUP_TAG_PREFIX}"{name}"]'


def describe_group(group_name: str, description: str) -> str:
    name = group_name.strip() or "the group"
    desc = description.strip()
    return f'"{name}" — {desc}' if desc else f'"{name}"'


def build_group_member_system_prompt(
    member_name: str,
    member_desc: str,
    group_name: str,
    group_desc: str,
    peers: list[tuple[str, str]],
) -> str:
    lines = [
        f"You are {member_name}, one participant in a group chat ({describe_group(group_name, group_desc)}).",
    ]
    if member_desc.strip():
        lines.append(f"Your persona: {member_desc.strip()}")
    if peers:
        lines.append("")
        lines.append("Other participants in the room:")
        lines.extend(
            f"- {name}{f' ({desc.strip()})' if desc.strip() else ''}" for name, desc in peers
        )
    lines.append("")
    lines.append(
        f"Right now you are speaking in this group chat, with {', '.join(n for n, _ in peers)}."
        if peers
        else "Right now you are speaking in this group chat."
    )
    lines.extend([
        "You have your full toolkit in this room. Do the work first, then deliver the result.",
        "",
        f"Stay fully in character as {member_name}. The only way to say something the room can see is the SendMessage tool. Keep each message short and conversational. If you have nothing new worth adding, send exactly \"(pass)\". Never reveal private one-on-one context.",
    ])
    return "\n".join(lines)


def format_group_history(history: list[dict], viewer_id: str, limit: int = GROUP_PROMPT_HISTORY_LIMIT) -> str:
    recent = history[-limit:]
    if not recent:
        return "(no messages yet)"
    return "\n".join(_format_group_line(m, viewer_id) for m in recent)


def _format_group_line(msg: dict, viewer_id: str) -> str:
    sp = msg.get("speaker")
    content = msg.get("text", "")
    if sp == "user":
        return f"User: {content}"
    if isinstance(sp, dict):
        sid = sp.get("id")
        sname = sp.get("name", sid)
        suffix = " (you)" if sid == viewer_id else ""
        return f"{sname}{suffix}: {content}"
    name = sp or "system"
    return f"{name}: {content}"


def build_group_turn_prompt(
    member_name: str,
    group_name: str,
    peers: list[str],
    new_messages: list[dict],
) -> str:
    lines = [format_group_chat_tag(group_name, peers)]
    if not new_messages:
        lines.append("No new messages in the room since your last turn.")
    else:
        lines.append(f"New messages in the room (oldest first):\n{format_group_history(new_messages, member_name)}")
    lines.append("")
    lines.append(
        f"It's your turn, {member_name}. Reply in character with a single SendMessage if you have something worth adding, or send \"(pass)\" if you don't.")
    return "\n".join(lines)
