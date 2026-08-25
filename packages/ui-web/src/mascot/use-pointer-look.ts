import { useEffect, useRef, useState } from "react";
import { onPointerMove } from "./pointer-tracker.js";
import { onVisibilityChange } from "./visibility.js";

/** Resting glance: slightly up, no head turn (turning foreshortens eyes into dashes). */
export const RESTING_GAZE = { x: 0.1, y: -0.22 };
export const RESTING_ORIENTATION = { x: 0, y: 0, z: 0 };

/**
 * Eyes follow the pointer. The body stays facing camera so the silhouette does not stretch.
 *
 * The `pointermove` listener is shared by every mascot and throttled to one delivery per
 * frame, and an avatar scrolled out of view stops listening — a page with many bots costs
 * one listener, not one per bot.
 */
export function usePointerLook(enabled: boolean) {
  const ref = useRef<HTMLSpanElement>(null);
  const [gaze, setGaze] = useState(RESTING_GAZE);
  const [orientation, setOrientation] = useState(RESTING_ORIENTATION);
  const [visible, setVisible] = useState(true);

  useEffect(() => onVisibilityChange(ref.current, setVisible), []);

  useEffect(() => {
    if (!enabled || !visible) {
      setGaze(RESTING_GAZE);
      setOrientation(RESTING_ORIENTATION);
      return;
    }

    return onPointerMove((pointer) => {
      const el = ref.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const reachX = Math.max(200, window.innerWidth * 0.4);
      const reachY = Math.max(200, window.innerHeight * 0.4);
      const nx = Math.max(-1, Math.min(1, (pointer.x - cx) / reachX));
      const ny = Math.max(-1, Math.min(1, (pointer.y - cy) / reachY));
      setGaze({ x: nx * 0.55, y: ny * 0.48 - 0.16 });
    });
  }, [enabled, visible]);

  return { ref, gaze, orientation, visible };
}
