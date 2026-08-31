/**
 * Pick a knight, then claim the seat.
 *
 * **Character select has to come before the seat, not after it.** `skin_id` reaches the
 * chain inside `claim_seat`, which the Worker sends from `POST /api/session/init`, and
 * there is no route that edits a seat afterwards — so a select screen that ran after the
 * loader could only ever have sent `skinId: 0`. That is also why this screen owns the
 * `join()` call and renders onboarding's second card while it runs.
 *
 * The three knights are crops of the one reference sheet, taken through an SVG `viewBox`
 * rather than sliced into three files: one asset, one request, and the art on this screen
 * is provably the art the renderer will draw. The boxes are the measured ink bounds in
 * `assets/sprites/knights.svg` (216 × 140, three figures, no separators); the sheet's
 * bottom band is a palette strip and is deliberately outside every crop.
 *
 * Armour is cosmetic and the copy has to keep saying so. The design has no classes, so a
 * blurb that hints at a stat difference is a bug report waiting to be filed.
 */

import { useSelect, useStore } from '../state/store';
import { SeatLoader } from './Onboarding';
import knightsUrl from '../../../assets/sprites/knights.svg';

/** The whole sheet in its own coordinates. Every crop below indexes into this. */
const SHEET = { width: 216, height: 140 } as const;

/** A pixel of air around each measured box, so a crisp edge is not clipped by rounding. */
const BLEED = 1;

/**
 * ponytail: the boxes are the ink bounds of each figure, so each card also shows the
 * polearm that figure holds out to one side — which at card size reads as a stray line
 * more than as a weapon. Correct, not pretty. The fix belongs in the art (build-order step
 * 7 is "final art: knight skins"): give the sheet one figure per column with the weapon
 * tucked in, and these numbers get re-measured from it rather than hand-nudged here.
 */

/**
 * Index **is** `skin_id` — the program stores the number and never range-checks it, so
 * the length of this array and the Worker's `SKIN_COUNT` are the only bound there is, and
 * they have to agree.
 */
const SKINS = [
  { name: 'Vanguard', livery: 'Cobalt plate over silver mail.', x: 5, y: 24, w: 62, h: 82 },
  { name: 'Warden', livery: 'Blackened mail, copper fittings.', x: 77, y: 25, w: 62, h: 80 },
  { name: 'Reaver', livery: 'Pale steel, rust-orange sash.', x: 153, y: 29, w: 59, h: 77 },
] as const;

export function CharacterSelect() {
  const store = useStore();
  const skinId = useSelect((s) => s.skinId);
  const joining = useSelect((s) => s.status === 'joining');

  // Onboarding card 2. The seat claim is the slow half of onboarding and it starts here.
  if (joining) return <SeatLoader />;

  return (
    <section className="card">
      <p className="eyebrow">Choose a body</p>
      <h2>Character select</h2>

      <div className="skins">
        {SKINS.map((skin, index) => (
          <button
            key={skin.name}
            className="skin"
            aria-pressed={index === skinId}
            onClick={() => store.setSkin(index)}
          >
            <KnightArt skin={skin} />
            <b>{skin.name}</b>
            <span className="fine">{skin.livery}</span>
          </button>
        ))}
      </div>

      <p className="fine">
        Armour is cosmetic. Every knight has the same reach, the same speed and the same
        health — what changes the fight is which part of the boss the raid agrees to break
        first.
      </p>

      <button className="btn btn-primary" onClick={() => void store.join()}>
        Take a seat
      </button>
    </section>
  );
}

/**
 * One knight, cropped out of the sheet by `viewBox`.
 *
 * The `<image>` is always the entire sheet at its natural size; the `viewBox` is what
 * moves. The browser decodes the referenced file once and shares it across all three, so
 * this stays one asset on the wire. `image-rendering: pixelated` comes from the global
 * `svg` rule in `styles.css` — without it the browser bilinear-smooths a 62px sprite
 * scaled up and the art reads as a blurry upscale of itself.
 */
function KnightArt({ skin }: { skin: (typeof SKINS)[number] }) {
  const view = [skin.x - BLEED, skin.y - BLEED, skin.w + BLEED * 2, skin.h + BLEED * 2].join(' ');
  return (
    <svg
      viewBox={view}
      role="presentation"
      preserveAspectRatio="xMidYMax meet"
      style={{ display: 'block', width: '100%', height: 132 }}
    >
      <image href={knightsUrl} x={0} y={0} width={SHEET.width} height={SHEET.height} />
    </svg>
  );
}
