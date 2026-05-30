"""Generates images/icon.png — a 128x128 RGBA PNG with no external dependencies."""
import struct, zlib, math, os

def chunk(ctype, data):
    c = ctype + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

W = H = 128
cx, cy = W / 2, H / 2
R_OUT, R_IN = 54, 38   # ring radii

rows = []
for y in range(H):
    row = []
    for x in range(W):
        dx, dy = x - cx, y - cy
        d = math.sqrt(dx*dx + dy*dy)

        ring   = R_IN <= d <= R_OUT
        # play triangle: shifted 4 px right, ±18 px tall/wide
        tx, ty = dx + 4, dy
        tri    = -18 <= tx <= 18 and abs(ty) <= 18 - tx * 0.5

        if ring:
            row += [124, 106, 245, 255]   # #7c6af5 purple
        elif tri:
            row += [255, 255, 255, 255]   # white
        else:
            row += [30, 30, 46, 255]      # #1e1e2e dark
    rows.append(row)

raw = b''.join(b'\x00' + bytes(r) for r in rows)
compressed = zlib.compress(raw, 9)

sig       = b'\x89PNG\r\n\x1a\n'
ihdr_data = struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0)  # 8-bit RGBA
png       = sig + chunk(b'IHDR', ihdr_data) + chunk(b'IDAT', compressed) + chunk(b'IEND', b'')

os.makedirs('images', exist_ok=True)
with open('images/icon.png', 'wb') as f:
    f.write(png)
print(f'Written images/icon.png  ({len(png)} bytes)')
