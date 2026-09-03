/**
 * Pick a colour, then claim the seat.
 *
 * **Character select has to come before the seat, not after it.** `skin_id` reaches the
 * chain inside `claim_seat`, which the Worker sends from `POST /api/session/init`, and
 * there is no route that edits a seat afterwards — so a select screen that ran after the
 * loader could only ever have sent `skinId: 0`. That is also why this screen owns the
 * `join()` call. The join puts the marker on file (`store.ts::skinChosen`), and from then
 * on the shell shows the loader in this screen's place: the select is seen once, and
 * again only through the results panel's `Change marker`.
 *
 * The three archers are the sheet's, left to right, and `skin_id` indexes both this table
 * and the generated `KNIGHT_SKINS` the renderer draws from. `SKIN_COLORS` is separate on
 * purpose: it is the crowd marker — the dot on the roster and the ring under your own
 * archer — and it stays a flat colour precisely because a figure at sprite size does not
 * read at a glance in a crowd of twenty.
 */

import { useLogout } from '@privy-io/react-auth';

import { useSelect, useStore } from '../state/store';

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
  { name: 'Cobalt', note: 'Blue.' },
  { name: 'Nocturne', note: 'Amber on black.' },
  { name: 'Argent', note: 'Green-silver.' },
] as const;

export function CharacterSelect() {
  const store = useStore();
  const { logout } = useLogout();
  const skinId = useSelect((s) => s.skinId);

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

      <p className="fine">Colour is cosmetic.</p>

      <button className="btn btn-primary" onClick={() => void store.join()}>
        Take a seat
      </button>

      {/* The only screen where a wallet can be swapped without abandoning a live seat:
          `authenticated && !match` holds here and nowhere else. `store.signOut` releases
          any held seat first, because a different wallet is a different Privy DID, a
          different on-chain identity and a different seat — switching without releasing
          would strand the old arena, which is the leak this release exists to close.
          `logout` goes in rather than after: the store runs it before it forgets, or the
          landing signs the same wallet straight back in (`store.ts::signOut`). */}
      <button
        className="btn btn-quiet"
        onClick={() => {
          void store.signOut(logout);
        }}
      >
        Use a different wallet
      </button>
    </section>
  );
}
