from __future__ import annotations

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "docs" / "assets"
FRAME_DIR = ROOT / "output" / "readme-frames"

PNG_WIDTHS = {
    "readme-hero.png": 1400,
    "readme-how-to-play.png": 1400,
    "readme-room-ready.png": 1400,
    "readme-focus-overlay.png": 1400,
    "readme-live-round.png": 1400,
    "readme-level-clear.png": 1400,
    "readme-misplay.png": 1400,
    "readme-mobile-room.png": 480,
}

GIF_MANIFEST = {
    "readme-room-flow.gif": {
        "frames": [
            "room-flow-01-ready.png",
            "room-flow-02-focus.png",
            "room-flow-03-live-round.png",
            "room-flow-04-level-clear.png",
        ],
        "durations": [1200, 1000, 1100, 1400],
        "width": 1100,
    },
    "readme-misplay-flow.gif": {
        "frames": [
            "misplay-flow-01-live-round.png",
            "misplay-flow-02-life-lost.png",
        ],
        "durations": [1100, 1500],
        "width": 1100,
    },
}


def resized(image: Image.Image, max_width: int) -> Image.Image:
    if image.width <= max_width:
        return image.copy()

    ratio = max_width / image.width
    height = int(image.height * ratio)
    return image.resize((max_width, height), Image.Resampling.LANCZOS)


def optimize_pngs() -> None:
    for filename, max_width in PNG_WIDTHS.items():
        asset_path = ASSET_DIR / filename
        with Image.open(asset_path) as image:
            prepared = resized(image.convert("RGB"), max_width)
            prepared.save(asset_path, optimize=True)


def quantize_for_gif(image: Image.Image, max_width: int) -> Image.Image:
    prepared = resized(image.convert("RGB"), max_width)
    return prepared.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)


def build_gifs() -> None:
    for filename, manifest in GIF_MANIFEST.items():
        frames = []
        for frame_name in manifest["frames"]:
            frame_path = FRAME_DIR / frame_name
            with Image.open(frame_path) as image:
                frames.append(quantize_for_gif(image, manifest["width"]))

        lead, *rest = frames
        lead.save(
            ASSET_DIR / filename,
            save_all=True,
            append_images=rest,
            duration=manifest["durations"],
            loop=0,
            optimize=True,
            disposal=2,
        )


def main() -> None:
    optimize_pngs()
    build_gifs()


if __name__ == "__main__":
    main()
