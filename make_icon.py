"""
Generates images/icon.png (128x128) — Ollama for Copilot extension icon.

Design: dark background (#1e1e2e), purple circle (#7c6af5), white "O" lettermark.
Uses only stdlib (struct + zlib) — no Pillow required.
Anti-aliasing via 4x supersampling.
"""
import struct, zlib, math, os

# ---------------------------------------------------------------------------
# PNG helpers
# ---------------------------------------------------------------------------

def png_chunk(ctype: bytes, data: bytes) -> bytes:
    c = ctype + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

def write_png(path: str, pixels: list[list[tuple[int,int,int,int]]], w: int, h: int):
    raw = b''.join(b'\x00' + bytes(ch for px in row for ch in px) for row in pixels)
    sig  = b'\x89PNG\r\n\x1a\n'
    ihdr = png_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    idat = png_chunk(b'IDAT', zlib.compress(raw, 9))
    iend = png_chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(sig + ihdr + idat + iend)

# ---------------------------------------------------------------------------
# Pixel renderer (4x supersampling for smooth edges)
# ---------------------------------------------------------------------------

def render(out_w: int, out_h: int) -> list[list[tuple[int,int,int,int]]]:
    S = 4  # supersampling factor
    W, H = out_w * S, out_h * S
    cx, cy = W / 2, H / 2

    # Scaled geometry
    R_CIRCLE = 46 * S      # filled circle radius
    R_RING   = 38 * S      # inner cutout radius (makes it a ring)
    LETTER_STROKE = 7 * S  # stroke width of the "O" lettermark
    LETTER_R = 22 * S      # radius of letter "O" centre path

    BG     = (30,  30,  46,  255)   # #1e1e2e
    PURPLE = (124, 106, 245, 255)   # #7c6af5
    WHITE  = (255, 255, 255, 255)

    buf = [[BG] * W for _ in range(H)]

    for y in range(H):
        for x in range(W):
            dx, dy = x - cx, y - cy
            d = math.sqrt(dx*dx + dy*dy)

            # Purple filled circle
            if d <= R_CIRCLE:
                # "O" lettermark: ring shape centred in circle
                d_letter = abs(d - LETTER_R)
                if d_letter <= LETTER_STROKE / 2:
                    buf[y][x] = WHITE
                else:
                    buf[y][x] = PURPLE

    # Downsample S×S → 1px by averaging
    out = []
    for oy in range(out_h):
        row = []
        for ox in range(out_w):
            r = g = b = a = 0
            for sy in range(S):
                for sx in range(S):
                    px = buf[oy*S + sy][ox*S + sx]
                    r += px[0]; g += px[1]; b += px[2]; a += px[3]
            n = S * S
            row.append((r//n, g//n, b//n, a//n))
        out.append(row)
    return out

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

os.makedirs('images', exist_ok=True)

pixels = render(128, 128)
write_png('images/icon.png', pixels, 128, 128)
print('Written images/icon.png (128x128)')

