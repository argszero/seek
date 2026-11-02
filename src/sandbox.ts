/**
 * The fence a `bash` call runs inside.
 *
 * **Why a fence at all.** Every other tool a bot has is bounded by a name check: `read`,
 * `write`, `edit`, `glob` and `grep` take a path relative to the bot's own directory and
 * refuse one that leaves it, so the surface is a directory and the machine is not
 * reachable from a turn. A shell is not that kind of tool — it names no path, and one
 * `cat ~/.ssh/id_rsa` would read something no file tool here can — so the bound has to be
 * the operating system's rather than this file's. `docs/host-rulings.md`, "The tools",
 * bounds an agent by its own workspace; this module is what makes that sentence true for
 * the one tool that could otherwise walk out of it.
 *
 * **What it is, and what it is not.** macOS ships `sandbox-exec`, whose profiles the
 * kernel enforces around the child and everything it spawns. Three denials, and each is
 * one ruling:
 *
 * 1. **No writing outside the bot's own directory** — an agent acts inside its workspace
 *    and nowhere else. Its directory, plus one private scratch directory it is given
 *    (that is where `mktemp` and a compiler's intermediate files go).
 * 2. **No network.** A shell with `curl` is a way off this machine entirely, and a bot
 *    whose half of the work is local is not one that reaches out from inside a tool call.
 * 3. **No reading of the person's home except the bot's own directory.** Running a program
 *    reads thousands of files — `/bin`, `/usr/lib`, the dynamic loader — so reads cannot be
 *    denied wholesale; what can be denied is the one place the person's own things live.
 *    A bot's directory sits inside it, so it is re-allowed after the denial.
 *
 * **A missing fence is a refusal, never a fallback.** `sandbox-exec` is part of macOS, but
 * a machine where it is gone must not answer by running the shell unconfined: that would be
 * a tool whose promise quietly depends on the host. `fenceFor` answers with what is missing
 * and the call is refused in words rather than spent.
 *
 * **A platform that never had it is a second fact, not the same one.** `bash` is offered on
 * every platform this build ships to, so where the kernel cannot fence a shell the call is
 * refused with the rest — but the sentence has to be about the platform. Telling a bot on
 * Windows that `/usr/bin/sandbox-exec` "is not on this machine" describes a broken install,
 * and a model reading it goes looking for a file that will never be there; what is true is
 * that this build knows one fence, the fence is macOS's, and this host has no way to bound
 * the call. Read as one fact, the two sentences are the same refusal; read by the model they
 * differ in the only way that matters, which is whether trying again could ever help.
 *
 * **What a profile means is the kernel's answer, not this file's.** The text is checked as
 * text below; that the denials actually deny was measured on the machine this ships to and
 * is recorded in `docs/host-rulings.md` beside the ruling it serves. A denial that reads
 * correctly and does nothing is the failure this module exists to avoid.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where the profile is enforced from. Part of macOS; absent is a refusal. */
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/**
 * The platform whose kernel applies that profile — the same fact as the path above, stated
 * separately because the two absences are not the same absence: `sandbox-exec` missing from
 * macOS is a machine that has lost something, and on any other platform there is nothing to
 * lose. Named as the one platform it holds for rather than as the one it does not, so a
 * platform this build was never measured on reads as unfenced instead of as excluded.
 */
const FENCED_PLATFORM = 'darwin';

/** The shell a call runs in: no login files, so nothing a person aliased is in reach. */
const SHELL = '/bin/bash';

/**
 * What the child is given to find programs with.
 *
 * A login shell is deliberately not used: `~/.zprofile` is the person's, and a bot whose
 * shell read it would be running somebody else's setup. The path is the system's own —
 * no `~/.asdf`, no `~/bin`, no Homebrew — because each of those is a directory of the
 * person's, and the fence below refuses to read it anyway.
 */
const PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** A path, escaped for the one place seatbelt takes text. */
function quoted(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface FenceRequest {
  /** The bot's own directory: what it may read, and the only place it may write. */
  home: string;
  /** The private scratch directory, so `TMPDIR` has somewhere to point. */
  scratch: string;
  /**
   * The person's home, denied for reading except where the bot's own directory sits inside
   * it. Passed in rather than read here, so that a test says which home it means.
   */
  person: string;
  /** The one command this fence is around. */
  command: string;
}

/**
 * The profile, as the text the kernel is handed.
 *
 * Order matters, and it is the reason this is a list and not a set: `(allow default)` puts
 * everything on, the three denials take their three things away, and the re-allows hand
 * back what a working shell needs inside them. Read top to bottom it says what the ruling
 * says — a bot acts in its own directory — and every line after the denials is an exception
 * with its own reason.
 */
export function profileFor(request: FenceRequest): string {
  return [
    '(version 1)',
    "; Everything a program needs to run is allowed. The three lines after it are the three",
    "; things a bot is not: somebody else's disk to write, a network, and the person's files.",
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${quoted(request.home)}) (subpath ${quoted(request.scratch)}))`,
    '(deny network*)',
    `(deny file-read-data (subpath ${quoted(request.person)}))`,
    `(allow file-read-data (subpath ${quoted(request.home)}) (subpath ${quoted(request.scratch)}))`,
    '',
  ].join('\n');
}

export interface Fence {
  /** What to spawn, and the arguments that put the shell inside the profile. */
  file: string;
  args: string[];
  /** The directory the shell starts in, and what `HOME` means to it. */
  cwd: string;
  env: Record<string, string>;
}

/**
 * The fence for one call, or the sentence saying what this machine cannot do.
 *
 * The profile travels on the command line (`-p`) rather than in a file: it is a few hundred
 * bytes, it holds no secret — the paths are ones the bot already knows — and a file would be
 * a second thing to write, race over and clean up per call.
 *
 * **The platform is a parameter for the same reason `probe` is one.** A test cannot run this
 * suite on Windows, so a suite that could only ever see macOS would leave the sentence a
 * Windows bot reads unpinned — and that sentence is the whole of what this branch exists to
 * get right. The default is the machine the call is really on.
 */
export function fenceFor(
  request: FenceRequest,
  platform: string = process.platform,
): Fence | { refusal: string } {
  // Two facts, asked in this order because the first one explains the second: a platform this
  // build cannot fence is not a machine that has lost its fence, and only the second of those
  // is something a person could ever put right.
  if (platform !== FENCED_PLATFORM) {
    return {
      refusal:
        'this platform is not one this build can fence a shell on: the fence it knows is ' +
        "macOS's `sandbox-exec`, and a bot's shell runs only inside a fence — this build " +
        'will not run one outside it, so the call is refused rather than answered without ' +
        'the bound every other tool here has',
    };
  }
  if (!existsSync(SANDBOX_EXEC)) {
    return {
      refusal:
        `${SANDBOX_EXEC} is not on this machine, and a bot's shell runs only inside a ` +
        'fence: this build will not run one outside it, so the call is refused rather than ' +
        'answered without the bound every other tool here has',
    };
  }
  if (request.home === '') {
    return {
      refusal:
        'this bot has no directory on this machine, so there is nothing to fence a shell ' +
        'inside: its home is what the roster row names, and every tool is bounded by it',
    };
  }
  return {
    file: SANDBOX_EXEC,
    args: ['-p', profileFor(request), SHELL, '-c', request.command],
    cwd: request.home,
    env: {
      // The system path, a private scratch, and nothing of the person's environment: an
      // exported key in the app's own process would otherwise be readable by `env`.
      PATH,
      HOME: request.home,
      TMPDIR: request.scratch,
      LANG: 'en_US.UTF-8',
      TERM: 'dumb',
    },
  };
}

export interface FenceResult {
  /** The exit status, or `null` when nothing ran or a signal ended it. */
  code: number | null;
  /** True when this runtime ended the call rather than the command ending itself. */
  timedOut: boolean;
  /** stdout and then stderr, as one reading, cut to the limit when it is longer. */
  output: string;
  /** True when the limit cut something away, so the turn can say so rather than imply more. */
  cut: boolean;
}

/**
 * One command, run inside the fence and read back as words.
 *
 * The runner is a parameter rather than a module-level import so the layer above can be
 * tested without spawning a shell — the same seam as `workFetch`, and for the same reason:
 * what is pinned one layer up is that a call reaches a runner with the right command, not
 * that this machine has a working `/bin/bash`.
 */
export interface BashSpec {
  home: string;
  command: string;
  person: string;
  scratch: string;
  timeoutMs: number;
  outputLimit: number;
  /**
   * Whether this machine can apply a fence at all.
   *
   * The real one is `fenceUsable` below, and it is a seam for the same reason the runner
   * itself is: a test on a machine that already runs this suite inside a sandbox cannot ask
   * the kernel a second time, so the layer above hands in the answer it is testing against.
   */
  probe?: FenceProbe;
}

export interface FenceResult {
  /** The exit status, or `null` when nothing ran. */
  code: number | null;
  /** True when this runtime ended the call rather than the command ending itself. */
  timedOut: boolean;
  /** stdout and then stderr, as one reading, cut to the limit when it is longer. */
  output: string;
  /** True when the limit cut something away, so the turn can say so rather than imply more. */
  cut: boolean;
  /**
   * True when no command ran at all — the machine has no fence, or would not apply one.
   *
   * Kept apart from a non-zero exit because the two are different facts to a model: one says
   * the command failed, the other says there is no shell here and nothing it types will run.
   */
  refused?: boolean;
}

export type FenceRunner = (spec: BashSpec) => Promise<FenceResult>;

/**
 * Whether a fence can be applied on this machine, asked once by running one.
 *
 * **A profile that parses is not a fence that applies.** `sandbox-exec` fails at
 * `sandbox_apply` — a build that will not let this process nest a sandbox, a host policy
 * that refuses it — and when it does, the child never runs and `sandbox-exec` is what speaks.
 * Asking by doing is the only reading that distinguishes the two, and the answer is cached
 * for the life of the process: it is a fact about the machine, not about the call.
 */
export type FenceProbe = (scratch: string) => Promise<boolean>;

let askedOnce: Promise<boolean> | null = null;

export const fenceUsable: FenceProbe = (scratch) => {
  askedOnce ??= (async () => {
    try {
      mkdirSync(scratch, { recursive: true });
    } catch {
      return false;
    }
    const fence = fenceFor({ home: scratch, scratch, person: scratch, command: '/usr/bin/true' });
    if ('refusal' in fence) return false;
    const ran = await spawnReading(fence, 5_000, 2_000);
    return ran.code === 0 && ran.output.trim() === '';
  })();
  return askedOnce;
};

/** The two bounds, and why they are these two numbers. */
export const BASH_TIMEOUT_MS = 20_000;
export const BASH_OUTPUT_LIMIT = 6_000;

/** One spawn, read back as the two streams and the status that ended it. */
function spawnReading(
  fence: Fence,
  timeoutMs: number,
  outputLimit: number,
): Promise<{ code: number | null; timedOut: boolean; output: string; cut: boolean }> {
  return new Promise((resolve) => {
    const child = nodeSpawn(fence.file, fence.args, {
      cwd: fence.cwd,
      env: fence.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let cut = false;
    const append = (chunk: Buffer): void => {
      if (cut) return;
      output += chunk.toString('utf8');
      if (output.length > outputLimit) {
        output = output.slice(0, outputLimit);
        cut = true;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let timedOut = false;
    const clock = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (error: Error) => {
      clearTimeout(clock);
      resolve({ code: null, timedOut: false, output: `${error.message}`, cut: false });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(clock);
      resolve({ code, timedOut, output, cut });
    });
  });
}

/**
 * The default runner: `sandbox-exec`, a shell, and a clock.
 *
 * **Both streams are read and both are capped.** A command's most useful line is usually on
 * stderr, and a command that prints a hundred thousand lines would spend the turn's whole
 * window on its own output — the box is re-sent with every look, so an unbounded answer is
 * not one long message but the same long message again on every round after it.
 *
 * **A timeout is an answer, not an error.** The child is killed and the reading says so; a
 * turn that threw here would lose what the command did manage to say, which is usually the
 * reason it was slow in the first place.
 *
 * **No fence, no command.** When the probe says the machine will not apply one, the command
 * is not started: a bot's shell has exactly one way to be run here, and this is the branch
 * that keeps a machine's policy from quietly turning into an unfenced shell.
 */
export const runFenced: FenceRunner = async (spec) => {
  const fence = fenceFor(spec);
  if ('refusal' in fence) {
    return { code: null, timedOut: false, output: fence.refusal, cut: false, refused: true };
  }
  // The scratch directory has to exist before the child is fenced into it: `TMPDIR`
  // pointing at nothing is how a compiler fails with a sentence about `/var/folders`.
  try {
    mkdirSync(spec.scratch, { recursive: true });
  } catch {
    // A scratch that could not be made is still a fence: the denials hold, and a command
    // that needs somewhere to write says so in its own words.
  }

  const usable = await (spec.probe ?? fenceUsable)(spec.scratch);
  if (!usable) {
    return {
      code: null,
      timedOut: false,
      cut: false,
      refused: true,
      output:
        'this machine will not apply the fence a shell here runs inside, so the command ' +
        'was not started. Nothing about that is fixable from inside a turn: the tool is ' +
        'offered, and this host has no way to bound it.',
    };
  }

  return spawnReading(fence, spec.timeoutMs, spec.outputLimit);
};

/**
 * The three places one fence names, given the bot's own directory.
 *
 * The scratch directory is one per agent and lives outside the bot's directory on purpose:
 * `glob` and `grep` show what the bot filed, and a scratch the runtime made would be a row
 * in that listing the bot never wrote and cannot explain.
 */
export function placesFor(home: string): { home: string; person: string; scratch: string } {
  return {
    home,
    person: homedir(),
    scratch: join(tmpdir(), 'seek-shell', createHash('sha1').update(home).digest('hex').slice(0, 16)),
  };
}
