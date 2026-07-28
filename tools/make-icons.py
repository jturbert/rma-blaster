#!/usr/bin/env python3
"""
Regenerate the PNG app icons from favicon.svg.

    python3 tools/make-icons.py

Writes favicon-32.png and apple-touch-icon.png next to favicon.svg.

The bolt path is made entirely of straight line segments, so it can be
rasterised directly rather than going through a browser. Drawing happens
at 8x and is then scaled down, which antialiases the diagonals cleanly.

Only PIL is required.
"""

import re
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---- geometry, kept in step with favicon.svg -------------------------------
BOLT = ("M206,540.5l40.5-127.5-.5-3.5-34,8-.5-1.5,48-121-6.5-1.5-32,6h-6l.5-4.5,"
        "47.5-98.5,67-3-44.5,66.5,3.5.5,43-17,2.5,1.5-64,128,1.5,1.5,48-28,2.5.5-116.5,193.5Z")
SCALE      = 0.1549          # path units -> 64-unit icon space
OFFSET     = (-9.88, -24.86)
STROKE     = 18              # in path units, thickens the bolt's limbs
NAVY       = (0x11, 0x49, 0x7e)
WHITE      = (0xff, 0xff, 0xff)
CORNER     = 12 / 64         # rounded-corner radius as a fraction of the side
SS         = 8               # supersampling factor

NUM = re.compile(r'[-+]?(?:\d*\.\d+|\d+)')


def parse_path(d):
    """Turn the bolt's path data into a list of absolute (x, y) points.

    Handles only the commands this path uses: M, l, h and Z. Anything else
    would be silently mis-drawn, so it raises instead.
    """
    points, x, y = [], 0.0, 0.0
    for cmd, body in re.findall(r'([MmLlHhVvZz])([^MmLlHhVvZz]*)', d):
        nums = [float(n) for n in NUM.findall(body)]
        if cmd in 'Mm':
            # A moveto's trailing coordinate pairs are implicit linetos
            for i in range(0, len(nums), 2):
                dx, dy = nums[i], nums[i + 1]
                x, y = (dx, dy) if (cmd == 'M' and i == 0) else (x + dx, y + dy)
                points.append((x, y))
        elif cmd in 'Ll':
            for i in range(0, len(nums), 2):
                dx, dy = nums[i], nums[i + 1]
                x, y = (dx, dy) if cmd == 'L' else (x + dx, y + dy)
                points.append((x, y))
        elif cmd in 'Hh':
            for dx in nums:
                x = dx if cmd == 'H' else x + dx
                points.append((x, y))
        elif cmd in 'Vv':
            for dy in nums:
                y = dy if cmd == 'V' else y + dy
                points.append((x, y))
        elif cmd in 'Zz':
            pass
        else:
            raise ValueError(f'unsupported path command: {cmd}')
    return points


def render(size, rounded):
    """Draw one icon. `rounded` is False for iOS, which applies its own mask."""
    big = size * SS
    img = Image.new('RGB', (big, big), NAVY)
    draw = ImageDraw.Draw(img)

    k = (big / 64.0)
    pts = [((px * SCALE + OFFSET[0]) * k, (py * SCALE + OFFSET[1]) * k)
           for px, py in parse_path(BOLT)]

    # Fill, then trace the outline to reproduce the SVG's stroke, which is
    # what gives the bolt enough weight to survive at 16px.
    draw.polygon(pts, fill=WHITE)
    draw.line(pts + [pts[0]], fill=WHITE,
              width=max(1, round(STROKE * SCALE * k)), joint='curve')

    img = img.resize((size, size), Image.LANCZOS)

    if rounded:
        mask = Image.new('L', (big, big), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, big - 1, big - 1], radius=int(CORNER * big), fill=255)
        img = img.convert('RGBA')
        img.putalpha(mask.resize((size, size), Image.LANCZOS))

    return img


def main():
    for name, size, rounded in [('favicon-32.png', 32, True),
                                ('apple-touch-icon.png', 180, False)]:
        path = os.path.join(HERE, name)
        icon = render(size, rounded)
        icon.save(path, 'PNG', optimize=True)
        print(f'{name}: {icon.size[0]}x{icon.size[1]} {icon.mode}')


if __name__ == '__main__':
    main()
