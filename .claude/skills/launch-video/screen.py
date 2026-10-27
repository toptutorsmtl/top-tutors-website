#!/usr/bin/env python3
"""Prepare a phone screen recording for the phone scene (app-ad style).

  python3 screen.py ~/Downloads/ScreenRecording.MP4 launches/<name>/assets/app.mp4
  python3 screen.py rec.MP4 assets/app.mp4 --blur 22.5-24 --blur 25.8-     blur other people (names, faces, goals)
  python3 screen.py rec.MP4 assets/app.mp4 --blur 30- --below 0.07         ...everything under the top 7% (keeps the header)

iPhone recordings are HEVC at 60 fps, which headless Chrome may not decode and which seeks slowly. This writes H.264 at
30 fps at the recording's full resolution (close-ups magnify the screen 2-3x, so a downscaled copy looks soft), with a
keyframe every 8 frames so every frame the renderer asks for is quick to reach. --blur takes from-to seconds ("25.8-" = to the end) and blurs the screen below
--below (fraction of the height) in those spans: use it for anything showing people other than the user.
"""
import argparse, subprocess


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--blur", action="append", default=[], help="from-to seconds to blur (repeatable); 'from-' = to the end")
    ap.add_argument("--below", type=float, default=0.07, help="blur only below this fraction of the height (default 0.07)")
    ap.add_argument("--width", type=int, default=0, help="output width (default: the recording's own)")
    a = ap.parse_args()
    spans = []
    for b in a.blur:
        f, _, t = b.partition("-")
        spans.append(f"gte(t,{float(f)})" if not t else f"between(t,{float(f)},{float(t)})")
    if spans:
        sc = f"scale={a.width}:-2," if a.width else ""
        fc = (f"[0:v]fps=30,{sc}split[a][b];[b]crop=iw:ih*{1 - a.below:.3f}:0:ih*{a.below:.3f},boxblur=22:3[bl];"
              f"[a][bl]overlay=0:H*{a.below:.3f}:enable='{'+'.join(spans)}'[v]")
        vf = ["-filter_complex", fc, "-map", "[v]"]
    else:
        vf = ["-vf", "fps=30" + (f",scale={a.width}:-2" if a.width else "")]
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", a.src, *vf, "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "14",
                    "-pix_fmt", "yuv420p", "-g", "8", "-keyint_min", "8", a.dst], check=True)
    print("wrote", a.dst, "(blurred: " + ", ".join(a.blur) + ")" if a.blur else "")


if __name__ == "__main__":
    main()
