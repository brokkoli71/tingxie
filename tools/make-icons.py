"""Regenerate the app icons. Run only when the icon design changes:

    python3 tools/make-icons.py

Design follows the app's "Chinese exercise-book" system: a seal-stamp red
square with the character 听 ("listen") cut out in paper white, matching the
rotated seal badge used on the cards. Simplified (SC) glyph form, to match the
Noto Serif SC used for Hanzi in the UI.

Two shapes are produced:
  - normal   rounded square, for platforms that show the icon as-is
  - maskable full-bleed square with the glyph inside the safe zone, so
    Android can crop it to whatever shape the launcher uses without
    clipping the character
"""

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/noto-cjk/NotoSerifCJK-Regular.ttc"
FONT_INDEX = 2  # Noto Serif CJK SC

SEAL_RED = (179, 53, 42, 255)   # #b3352a
PAPER = (241, 237, 226, 255)    # #f1ede2

GLYPH = "听"


def draw_icon(size, maskable):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if maskable:
        # Full bleed: the launcher crops this, so no transparent margin.
        d.rectangle([0, 0, size, size], fill=SEAL_RED)
        # Android's safe zone is the central 80%; keep the glyph well inside.
        glyph_frac = 0.46
    else:
        radius = int(size * 0.18)
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=SEAL_RED)
        glyph_frac = 0.62

    font = ImageFont.truetype(FONT, int(size * glyph_frac), index=FONT_INDEX)
    # Centre on the glyph's actual ink, not the font's line box, which carries
    # asymmetric CJK side bearings and would sit visibly off-centre.
    box = d.textbbox((0, 0), GLYPH, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), GLYPH, font=font, fill=PAPER)
    return img


for size in (192, 512):
    draw_icon(size, maskable=False).save("icons/icon-%d.png" % size)
draw_icon(512, maskable=True).save("icons/icon-maskable-512.png")
# iOS ignores the manifest and has no maskable concept: it needs an opaque
# square it can round off itself.
draw_icon(180, maskable=True).save("icons/apple-touch-icon.png")
draw_icon(32, maskable=False).save("icons/favicon-32.png")

print("wrote icons/")
