/**
 * Print da tela do bot.
 *
 * A imagem do computador não traz ImageMagick nem scrot, e instalar pacote na hora do
 * pedido é lento e depende de rede. O que ela já tem é `python3-xlib` — então o print é
 * lido direto do X e escrito como PNG à mão. Só a biblioteca padrão participa: `zlib`
 * comprime e `struct` monta os pedaços.
 *
 * A conversão de BGRX para RGB é feita por fatias (`buf[2::4]`), não pixel a pixel, senão
 * um milhão de pixels em Python puro levaria segundos.
 */
const CAPTURE_PY = `
import struct, sys, zlib
from Xlib import display, X

screen = display.Display().screen()
root = screen.root
geometry = root.get_geometry()
width, height = geometry.width, geometry.height
raw = bytearray(root.get_image(0, 0, width, height, X.ZPixmap, 0xffffffff).data)

rgb = bytearray(width * height * 3)
rgb[0::3] = raw[2::4]
rgb[1::3] = raw[1::4]
rgb[2::3] = raw[0::4]

stride = width * 3
lines = bytearray()
for y in range(height):
    lines.append(0)
    lines += rgb[y * stride:(y + 1) * stride]

def chunk(tag, payload):
    body = tag + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)

png = b"\\x89PNG\\r\\n\\x1a\\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(bytes(lines), 6))
png += chunk(b"IEND", b"")

with open(sys.argv[1], "wb") as handle:
    handle.write(png)
print("%dx%d" % (width, height))
`;

/**
 * O script viaja em base64 para não brigar com aspas nem quebras de linha ao atravessar
 * o shell do container.
 */
export function screenshotCommand(target: string): string[] {
  const encoded = Buffer.from(CAPTURE_PY, "utf8").toString("base64");
  return [
    "bash",
    "-lc",
    `set -e; printf %s "${encoded}" | base64 -d > /tmp/quibt-shot.py; DISPLAY=\${DISPLAY:-:1} python3 /tmp/quibt-shot.py "$1"`,
    "quibt-screenshot",
    target,
  ];
}

/** Um nome por vez, para dois prints seguidos não se sobrescreverem. */
export function screenshotPath(stamp: number): string {
  return `/tmp/quibt-screenshot-${stamp}.png`;
}
