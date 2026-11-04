#!/usr/bin/env python3
"""Generate Gaze's original source icon without external image dependencies."""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

SIZE = 1024
OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons" / "source.png"


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    t = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def mix(a: tuple[float, ...], b: tuple[float, ...], t: float) -> tuple[float, ...]:
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(4))


def rounded_box(x: float, y: float) -> float:
    half = 420.0
    radius = 205.0
    dx = abs(x - 512.0) - (half - radius)
    dy = abs(y - 512.0) - (half - radius)
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    inside = min(max(dx, dy), 0.0)
    distance = outside + inside - radius
    return 1.0 - smoothstep(-1.2, 1.2, distance)


def eye_mask(x: float, y: float) -> float:
    nx = (x - 512.0) / 355.0
    if abs(nx) >= 1.0:
        return 0.0
    half_height = 192.0 * (1.0 - nx * nx) ** 0.72
    return 1.0 - smoothstep(half_height - 1.2, half_height + 1.2, abs(y - 525.0))


def circle(x: float, y: float, cx: float, cy: float, radius: float) -> float:
    distance = math.hypot(x - cx, y - cy) - radius
    return 1.0 - smoothstep(-1.2, 1.2, distance)


def pixel(x: float, y: float) -> tuple[int, int, int, int]:
    transparent = (0.0, 0.0, 0.0, 0.0)
    color = mix(transparent, (15.0, 31.0, 30.0, 255.0), rounded_box(x, y))

    # A subtle inner edge keeps the mark crisp at small sizes.
    rim = rounded_box(x, y) - rounded_box(x * 1.004, y * 1.004)
    color = mix(color, (42.0, 73.0, 68.0, 255.0), max(0.0, min(1.0, rim)) * 0.55)

    eye = eye_mask(x, y)
    color = mix(color, (236.0, 240.0, 231.0, 255.0), eye)

    iris = circle(x, y, 512.0, 525.0, 169.0) * eye
    color = mix(color, (229.0, 158.0, 62.0, 255.0), iris)
    iris_ring = (circle(x, y, 512.0, 525.0, 153.0) - circle(x, y, 512.0, 525.0, 139.0)) * eye
    color = mix(color, (186.0, 113.0, 37.0, 255.0), max(0.0, iris_ring) * 0.65)

    pupil = circle(x, y, 512.0, 525.0, 72.0) * eye
    color = mix(color, (15.0, 31.0, 30.0, 255.0), pupil)
    glint = circle(x, y, 480.0, 492.0, 26.0) * eye
    color = mix(color, (255.0, 250.0, 232.0, 240.0), glint)
    return tuple(round(max(0.0, min(255.0, value))) for value in color)


def chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def main() -> None:
    raw = bytearray()
    for y in range(SIZE):
        raw.append(0)
        for x in range(SIZE):
            raw.extend(pixel(float(x) + 0.5, float(y) + 0.5))
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(png)
    print(OUT)


if __name__ == "__main__":
    main()
