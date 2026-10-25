import os
from PIL import Image, ImageDraw

assets_dir = os.path.dirname(os.path.abspath(__file__))

def create_icon(locked=False, size=(256, 256)):
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    w, h = size

    bg_color = (20, 24, 33, 255) if not locked else (15, 30, 45, 255)
    border_color = (0, 150, 255, 255) if locked else (120, 130, 150, 200)

    pad = 12
    draw.ellipse([pad, pad, w - pad, h - pad], fill=bg_color, outline=border_color, width=8)

    cone_color = (255, 255, 255, 240) if locked else (180, 190, 200, 220)
    draw.rectangle([60, 100, 95, 156], fill=cone_color)
    draw.polygon([(95, 100), (145, 65), (145, 191), (95, 156)], fill=cone_color)

    wave_color = (0, 200, 255, 255) if locked else (140, 150, 165, 200)
    draw.arc([140, 90, 185, 166], start=-45, end=45, fill=wave_color, width=6)
    draw.arc([160, 70, 215, 186], start=-45, end=45, fill=wave_color, width=6)

    badge_color = (0, 230, 130, 255) if locked else (255, 80, 80, 255)
    badge_bg = (10, 15, 25, 255)
    bx, by = 160, 155
    bw, bh = 76, 76
    draw.ellipse([bx, by, bx + bw, by + bh], fill=badge_bg, outline=badge_color, width=4)

    draw.arc([bx + 24, by + 14, bx + 52, by + 46], start=180, end=0, fill=badge_color, width=4)
    draw.rounded_rectangle([bx + 18, by + 32, bx + 58, by + 60], radius=4, fill=badge_color)
    draw.ellipse([bx + 35, by + 40, bx + 41, by + 46], fill=badge_bg)
    draw.polygon([(bx + 37, by + 45), (bx + 39, by + 45), (bx + 40, by + 52), (bx + 36, by + 52)], fill=badge_bg)

    return img

if __name__ == "__main__":
    icon_active = create_icon(locked=True)
    icon_active.save(os.path.join(assets_dir, "icon_active.png"), format="PNG")
    icon_active.save(os.path.join(assets_dir, "icon_active.ico"), format="ICO", sizes=[(16,16), (32,32), (48,48), (64,64), (128,128), (256,256)])

    icon_inactive = create_icon(locked=False)
    icon_inactive.save(os.path.join(assets_dir, "icon_inactive.png"), format="PNG")
    icon_inactive.save(os.path.join(assets_dir, "icon_inactive.ico"), format="ICO", sizes=[(16,16), (32,32), (48,48), (64,64), (128,128), (256,256)])

    icon_active.save(os.path.join(assets_dir, "icon.png"), format="PNG")
