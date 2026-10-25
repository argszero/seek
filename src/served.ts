/**
 * One roster claim meeting one server: which model this half is supposed to be.
 *
 * `agents.yml` lets a row declare `model` (defaults 15), `Agent.model` carries it, and
 * **until this module nothing read it** — so a person could write a model name, get no
 * complaint, and be served by whatever was in front of the port. That is the failure
 * this repository keeps writing about in another form: a number that looks like a
 * verdict. The shipped cut is `0.600` calibrated *against a model*, so a judgement
 * taken from a different one is not the same measurement, and a report would say stage
 * 1 was a real model read without saying which model did the reading.
 *
 * **It takes a role now, and that is the whole reason it is a module.** The check was
 * written for the watch seam, which is the half the cut was measured for, and
 * `docs/decisions.md` row 24 recorded the tension by hand: the `work` row's model
 * belongs to *another server*. That server now exists (`work-server.ts`), so the same
 * claim has to be compared twice, against two different ports — and comparing the work
 * row against the watch server would refuse every correct roster. A copy of this
 * function in the second seam is the shape that drifts, so the role is a parameter.
 *
 * **`unset` is not a claim, so nothing is compared.** It is the roster's default and
 * the shipped row's state: the file has no standing to pick a model (line 26 of the
 * checklist), and inventing a requirement here would refuse every store that never
 * mentioned one. A bot with no row of that role declares nothing to compare, which is
 * the same case.
 *
 * **The comparison is exact, against the two strings the server reports** — its
 * `--alias` and its weights path (`ServerShape`, measured on the real binary). No
 * basename stripping, no extension trimming, no substring: each of those is this
 * function deciding which model a caller meant, and the whole point is that the server
 * is the one who knows. A short name works exactly when the server was started with
 * `--alias`, which is what that flag is for.
 *
 * **A server that names itself not at all cannot confirm a claim, and that is a
 * refusal rather than a pass.** It is the same direction `visionOf` reads `modalities`
 * in: silence is not agreement.
 */

import type { ServerShape } from './llama.ts';
import type { SeekStore } from './store.ts';
import type { Id } from './types.ts';

/**
 * Refuse a roster row that names one model while this server serves another.
 *
 * `role` is which row of the roster the claim lives on — `watch` for the half that
 * reads the cut, `work` for the half that writes. It is a plain string because a
 * roster's roles are open (`identity.ts`: "`watch`, `work`, and whatever comes later"),
 * and a caller that adds one gets the same comparison rather than a type error.
 */
export function requireServedModel(
  store: SeekStore,
  botId: Id,
  role: string,
  shape: ServerShape,
): void {
  const declared = store.agentsOf(botId).find((agent) => agent.role === role)?.model;
  if (declared === undefined || declared === 'unset') return;

  const served = [shape.modelAlias, shape.modelPath].filter((name) => name !== '');
  if (served.length === 0) {
    throw new Error(
      `the roster's ${role} row declares model '${declared}' and this server names no ` +
        'model at all, so it cannot confirm the claim: /props carried neither ' +
        'model_alias nor model_path. Silence is not agreement — restart the server with ' +
        `--alias '${declared}', or say 'unset' in the ${role} row and claim no model`,
    );
  }
  if (served.includes(declared)) return;

  throw new Error(
    `the roster's ${role} row declares model '${declared}' but this server serves ` +
      `${served.map((name) => `'${name}'`).join(' / ')}: the shipped cut was measured ` +
      'against one model, so a judgement taken from another is a different ' +
      'measurement wearing the same number. Restart the server with ' +
      `--alias '${declared}', write the server's own name in the ${role} row, or say ` +
      "'unset' and claim no model",
  );
}
