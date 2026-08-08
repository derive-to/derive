#!/usr/bin/env python3
"""Generate the HDR brand assets in apps/web/public/brand/hdr/.

An "HDR" image here is an ordinary PNG whose pixels are encoded for the
BT.2100 PQ system (BT.2020 primaries, SMPTE ST 2084 transfer) and tagged
with a PNG `cICP` chunk. On a display with HDR headroom, browsers that
honor cICP (Chrome 117+, Safari 17+) render the asset's white above SDR
reference white — the mark glows. Anything that ignores the chunk decodes
the PQ pixels as sRGB and shows a washed-out gray mark instead, so HDR
files are for byte-preserving surfaces where the viewer is known to be
capable (Slack custom emoji, GitHub READMEs, logo uploads on platforms
that keep original bytes) — never a default asset. The SVG/SDR assets in
apps/web/public/brand/ remain what the site itself uses.

Each master in brand/masters/ with bright pixels gets two variants: white
scaled to 400 nits (SDR reference white is ~203, so a gentle lift — the
choice for large renders) and 1000 nits (the look-at-me one, right at
small sizes). The dark-ink masters (icon-dark, wordmark-dark) are
skipped on purpose: dark pixels can't glow, so an HDR encode of them
changes nothing visible.

The pipeline: decode sRGB to linear light, scale white to the target
luminance, convert primaries BT.709 -> BT.2020, PQ-encode, write 16-bit
RGBA PNG with the cICP chunk spliced between IHDR and IDAT (Pillow can
write neither 16-bit RGBA nor cICP, hence the manual encoder). Alpha
passes through untouched.

Needs Pillow + numpy (dev-machine one-off; nothing at build or runtime
depends on this). Run from the repo root:

    python3 scripts/make-hdr-brand.py
"""

import struct
import zlib

import numpy as np
from PIL import Image

MASTERS = "apps/web/public/brand/masters"
OUT = "apps/web/public/brand/hdr"

PEAKS = (400, 1000)

# Masters with bright pixels worth boosting; the dark-ink masters
# (icon-dark, wordmark-dark) are omitted — dark pixels can't glow.
SOURCES = [
    "icon-square-dark",  # white glyph on dark tile
    "icon-square-light",  # dark glyph on light tile (the tile glows, glyph reads as cutout)
    "icon-light",  # white glyph on transparency
    "wordmark-light",  # light glyph + wordmark on transparency
]

M_709_TO_2020 = np.array(
    [
        [0.6274039, 0.3292830, 0.0433131],
        [0.0690973, 0.9195404, 0.0113623],
        [0.0163914, 0.0880133, 0.8955953],
    ]
)

PQ_M1 = 2610 / 16384
PQ_M2 = 2523 / 4096 * 128
PQ_C1 = 3424 / 4096
PQ_C2 = 2413 / 4096 * 32
PQ_C3 = 2392 / 4096 * 32


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def pq_encode(nits):
    y = np.clip(nits / 10000.0, 0.0, 1.0)
    y_m1 = np.power(y, PQ_M1)
    return np.power((PQ_C1 + PQ_C2 * y_m1) / (1.0 + PQ_C3 * y_m1), PQ_M2)


def png_chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png16_cicp(path, rgba16):
    h, w, _ = rgba16.shape
    rows = rgba16.astype(">u2").tobytes()
    stride = w * 4 * 2
    raw = b"".join(b"\x00" + rows[y * stride : (y + 1) * stride] for y in range(h))
    ihdr = struct.pack(">IIBBBBB", w, h, 16, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(png_chunk(b"IHDR", ihdr))
        # BT.2020 primaries (9), PQ transfer (16), RGB / identity matrix (0), full range (1)
        f.write(png_chunk(b"cICP", bytes([9, 16, 0, 1])))
        f.write(png_chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(png_chunk(b"IEND", b""))


def to_hdr(src, dst, peak_nits):
    px = np.asarray(Image.open(src).convert("RGBA")).astype(np.float64) / 255.0
    lin = srgb_to_linear(px[..., :3]) * peak_nits
    lin2020 = np.clip(lin @ M_709_TO_2020.T, 0.0, None)
    out = np.empty(px.shape)
    out[..., :3] = pq_encode(lin2020)
    out[..., 3] = px[..., 3]
    write_png16_cicp(dst, np.round(out * 65535.0).astype(np.uint16))
    print(f"{dst}  white -> {peak_nits} nits")


if __name__ == "__main__":
    for name in SOURCES:
        for peak in PEAKS:
            to_hdr(f"{MASTERS}/{name}.png", f"{OUT}/{name}-hdr-{peak}.png", peak)
