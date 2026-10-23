import { useId } from 'react';

/**
 * The Tether mark: two interlocked links, drawn in the current text colour
 * so it follows the theme. Same geometry as docs/images/logo-*.svg
 * (scripts/logo.py): rings at x 49 / 79, r 25, the crossings at x 64 masked
 * so each link passes over the other once.
 */
export function TetherMark({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId();
  const a = `${id}-a`;
  const b = `${id}-b`;
  return (
    <svg
      viewBox="0 0 128 128"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Tether"
    >
      <defs>
        <mask id={a}>
          <rect width="128" height="128" fill="#fff" />
          <circle cx="64" cy="84" r="8" fill="#000" />
        </mask>
        <mask id={b}>
          <rect width="128" height="128" fill="#fff" />
          <circle cx="64" cy="44" r="8" fill="#000" />
        </mask>
      </defs>
      <g fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round">
        <circle cx="49" cy="64" r="25" mask={`url(#${a})`} />
        <circle cx="79" cy="64" r="25" mask={`url(#${b})`} />
      </g>
    </svg>
  );
}
