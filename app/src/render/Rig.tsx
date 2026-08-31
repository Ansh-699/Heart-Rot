/**
 * The boss rig: one `<g>` per body part, animated by CSS transform on the group.
 *
 * The measured rule this is built on (`docs/research/svg-rendering.md` §2): a `<g>` with a
 * `transform` animation gets its own compositor layer and its paths raster once, so the
 * 7,589 rects inside cost nothing per frame — the same DOM animating `fill-opacity`
 * instead runs at half the frame rate. Path count is not the enemy; the animated property
 * is. So nothing in here ever animates a paint property, and nothing ever animates the
 * individual `translate`/`rotate`/`scale` properties either, which Blink does not
 * composite on SVG children (§4.2). Everything is the `transform` shorthand.
 */
import { useEffect, useRef, useState } from 'react';

import type { BossAccount } from '@heartrot/client';

import { BOSS_ANCHOR_X, BOSS_ANCHOR_Y, BOSS_CORE_BOX, BOSS_PARTS } from './sprites';

export interface RigProps {
  boss: BossAccount;
}

/** Must match the `@keyframes` name in `animations.css`. */
const DETACH_ANIMATION = 'hr-part-detach';

export function Rig({ boss }: RigProps) {
  // A part that has finished its detach animation stops being drawn at all. Kept as state
  // rather than a CSS end-state because `animation-fill-mode: forwards` still costs a live
  // compositor layer per destroyed part, and by the end of a raid that is most of the boss.
  const [gone, setGone] = useState<ReadonlySet<number>>(() => new Set());
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    // Parts already destroyed on the first frame never animate: the player reloaded or
    // joined mid-fight and never saw them attached, so detaching them now would read as the
    // boss losing four limbs the instant they walked in.
    const already = new Set<number>();
    boss.parts.forEach((hp, i) => {
      if (hp === 0) already.add(i);
    });
    if (already.size > 0) setGone(already);
    // Mount only — `boss` is read once, on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <g
      className="hr-boss"
      transform={`translate(${boss.x + BOSS_ANCHOR_X} ${boss.y + BOSS_ANCHOR_Y})`}
      // Read by CSS rather than by JS so the vent glow and the core's dimming are one
      // declaration each instead of two more class computations per part.
      data-vent={boss.ventOpen === 1 ? 'open' : 'sealed'}
    >
      {BOSS_PARTS.map((part) => {
        if (part.name === 'core') {
          // The glow sits behind the core, not on it: animating opacity on the core group
          // itself would fight the destroyed/hurt states it already carries.
          return (
            <g key={part.name}>
              <rect
                className="hr-vent"
                x={BOSS_CORE_BOX.x}
                y={BOSS_CORE_BOX.y}
                width={BOSS_CORE_BOX.w}
                height={BOSS_CORE_BOX.h}
                fill="#b5b56a"
              />
              <g
                className="hr-part hr-p-core"
                style={{ transformOrigin: `${part.originX}px ${part.originY}px` }}
                dangerouslySetInnerHTML={{ __html: part.inner }}
              />
            </g>
          );
        }

        const index = part.index;
        const destroyed = index !== null && (boss.parts[index] ?? 0) === 0;
        const hidden = index !== null && gone.has(index);

        return (
          <g
            key={part.name}
            className={
              `hr-part hr-p-${part.name}` +
              (destroyed ? ' hr-destroyed' : '') +
              (hidden ? ' hr-gone' : '')
            }
            // Absolute sprite units. See the `transform-box` note in `sprites.ts`.
            style={{ transformOrigin: `${part.originX}px ${part.originY}px` }}
            onAnimationEnd={
              index === null
                ? undefined
                : (e) => {
                    // The idle animations are infinite and never fire this; the name check
                    // is here so adding a second finite animation later cannot silently
                    // delete a live part.
                    if (e.animationName === DETACH_ANIMATION) {
                      setGone((prev) => (prev.has(index) ? prev : new Set(prev).add(index)));
                    }
                  }
            }
            dangerouslySetInnerHTML={{ __html: part.inner }}
          />
        );
      })}
    </g>
  );
}
