"""Regenerate the Tether mark: docs/images/logo-{light,dark}.svg and icon.svg.

Run from the repo root: python3 scripts/logo.py; then render the PNG icons
with scripts/render-icons.mjs. src/components/brand/tether-mark.tsx uses the
same geometry.
"""
import math, sys
cx1, cx2, cy, r, sw = 49, 79, 64, 25, 10
d = (cx2 - cx1) / 2
dy = math.sqrt(r*r - d*d)
top, bot = (64, cy - dy), (64, cy + dy)
gap = sw / 2 + 3
def mark(color, pre):
    return f'''<defs>
    <mask id="{pre}a"><rect width="128" height="128" fill="#fff"/><circle cx="{bot[0]}" cy="{bot[1]:.2f}" r="{gap}" fill="#000"/></mask>
    <mask id="{pre}b"><rect width="128" height="128" fill="#fff"/><circle cx="{top[0]}" cy="{top[1]:.2f}" r="{gap}" fill="#000"/></mask>
  </defs>
  <g fill="none" stroke="{color}" stroke-width="{sw}" stroke-linecap="round">
    <circle cx="{cx1}" cy="{cy}" r="{r}" mask="url(#{pre}a)"/>
    <circle cx="{cx2}" cy="{cy}" r="{r}" mask="url(#{pre}b)"/>
  </g>'''
hdr = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">'
open('docs/images/logo-light.svg','w').write(f'{hdr}\n  <title>Tether</title>\n  {mark("#0d0d0d","l")}\n</svg>\n')
open('docs/images/logo-dark.svg','w').write(f'{hdr}\n  <title>Tether</title>\n  {mark("#ececec","d")}\n</svg>\n')
open('docs/images/icon.svg','w').write(f'''{hdr}
  <rect x="2" y="2" width="124" height="124" rx="28" fill="#0d0d0d"/>
  <g transform="translate(64 64) scale(0.82) translate(-64 -64)">
  {mark("#ffffff","i")}
  </g>
</svg>
''')
print(f"top={top} bot={bot} gap={gap} r={r} d={d}")
