/**
 * Pick a colour, then claim the seat.
 *
 * **Character select has to come before the seat, not after it.** `skin_id` reaches the
 * chain inside `claim_seat`, which the Worker sends from `POST /api/session/init`, and
 * there is no route that edits a seat afterwards — so a select screen that ran after the
 * loader could only ever have sent `skinId: 0`. That is also why this screen owns the
 * `join()` call and renders onboarding's second card while it runs.
 *
 * The three knights are the reference sheet's, left to right, and `skin_id` indexes both
 * this table and the generated `KNIGHT_SKINS` the renderer draws from. `SKIN_COLORS` is
 * separate on purpose: it is the crowd marker — the dot on the roster and the ring under
 * your own knight — and it stays a flat colour precisely because armour at 33x42 does not
 * read at a glance in a crowd of twenty.
 */

import { CLASS_DAMAGE, CLASS_PERIOD_MS, N_CLASSES } from '@heartrot/client';

import { useSelect, useStore } from '../state/store';
import { SeatLoader } from './Onboarding';

/**
 * Index **is** `skin_id` — the program stores the number and never range-checks it, so the
 * length of this array and the Worker's `SKIN_COUNT` (3, `worker/src/routes.ts`) are the
 * only bound there is, and they have to agree. Adding a fourth here without raising that
 * constant gets the seat claim rejected with `invalid skin`.
 *
 * ponytail: the renderer needs these same three colours to draw the dots, so it imports
 * `SKIN_COLORS` from here rather than keeping a second copy that can drift. If a third
 * consumer ever appears, move the array into `@heartrot/client` next to the map table.
 */
export const SKIN_COLORS = ['#5aa9e6', '#e6a25a', '#7fd48b'] as const;

const SKINS = [
  { name: 'Cobalt', note: 'Blue crest, horned helm, kite shield.' },
  { name: 'Nocturne', note: 'Black mantle, gold trim, raised sword.' },
  { name: 'Argent', note: 'Silver plate, cross-emblem round shield.' },
] as const;

/**
 * Index **is** the class byte, the same way `SKINS`'s index is `skin_id`. The numbers are
 * never typed here: they come from `CLASS_DAMAGE` / `CLASS_PERIOD_MS`, which the program's
 * own table mirrors, so a balance change moves one place. `N_CLASSES` is the bound the
 * Worker and the program both enforce, and this array has to be as long as it.
 */
const CLASSES = [
  { name: 'Knight', note: 'Steady trigger.' },
  { name: 'Archer', note: 'Slower draw, heavier arrow.' },
] as const;

if (CLASSES.length !== N_CLASSES) {
  throw new Error(`CharacterSelect lists ${CLASSES.length} classes, the wire has ${N_CLASSES}`);
}

export function CharacterSelect() {
  const store = useStore();
  const skinId = useSelect((s) => s.skinId);
  const classId = useSelect((s) => s.classId);
  const joining = useSelect((s) => s.status === 'joining');

  // Onboarding card 2. The seat claim is the slow half of onboarding and it starts here.
  if (joining) return <SeatLoader />;

  return (
    <section className="card">
      <p className="eyebrow">Choose a marker</p>
      <h2>Character select</h2>

      <div className="skins">
        {SKINS.map((skin, index) => (
          <button
            key={skin.name}
            className="skin"
            aria-pressed={index === skinId}
            onClick={() => store.setSkin(index)}
          >
            {/* The chip is the colour, full stop — the same fill the renderer gives your
                circle. `aria-pressed` above is what announces the selection; this is
                decorative. */}
            <span
              className="skin-chip"
              style={{ background: SKIN_COLORS[index] }}
              role="presentation"
            />
            <b>
              {index + 1}. {skin.name}
            </b>
            <span className="fine">{skin.note}</span>
          </button>
        ))}
      </div>

      <p className="eyebrow">Choose a weapon</p>

      <div className="skins">
        {CLASSES.map((cls, index) => (
          <button
            key={cls.name}
            className="skin"
            aria-pressed={index === classId}
            onClick={() => store.setClass(index)}
          >
            <b>
              {index + 1}. {cls.name}
            </b>
            <span className="fine">
              {CLASS_DAMAGE[index]} damage every {(CLASS_PERIOD_MS[index]! / 1000).toFixed(1)} s
              &middot; {cls.note}
            </span>
          </button>
        ))}
      </div>

      <p className="fine">
        The two weapons deal the same damage per second — {CLASS_DAMAGE[0]}&times;
        {CLASS_PERIOD_MS[1]! / CLASS_PERIOD_MS[0]!} is {CLASS_DAMAGE[1]}, by construction —
        so neither is the stronger pick. The archer trades cadence for weight. The armour is
        cosmetic: every raider has the same reach, the same speed and the same health, and
        what changes the fight is which part of the boss the raid agrees to break first.
        Your own knight carries a marker above it so you can find yourself in a crowd, and
        the colour above is what the roster shows.
      </p>

      <button className="btn btn-primary" onClick={() => void store.join()}>
        Take a seat
      </button>
    </section>
  );
}
