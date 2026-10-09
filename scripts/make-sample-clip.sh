#!/usr/bin/env bash
# Generates the synthetic fixture clip: 10 s, 1280x720 @ 30 fps, H.264 + AAC,
# three visually distinct shots (hard cuts at 3.5 s and 7 s), a different tone
# per shot, and a keyframe every second so it scrubs like a proxy.
set -euo pipefail
out="${1:-$(dirname "$0")/../fixtures/sample/source.mp4}"
size=1280x720
rate=30

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=$size:rate=$rate:duration=3.5" \
  -f lavfi -i "mandelbrot=size=$size:rate=$rate,trim=duration=3.5" \
  -f lavfi -i "testsrc2=size=$size:rate=$rate:duration=3" \
  -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=3.5" \
  -f lavfi -i "sine=frequency=330:sample_rate=48000:duration=3.5" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" \
  -filter_complex "[0:v]setsar=1,format=yuv420p[v0];[1:v]setsar=1,format=yuv420p[v1];[2:v]setsar=1,format=yuv420p[v2];[v0][3:a][v1][4:a][v2][5:a]concat=n=3:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" \
  -c:v libx264 -preset slow -crf 30 -g "$rate" -keyint_min "$rate" -sc_threshold 0 \
  -c:a aac -b:a 96k -ac 1 -movflags +faststart \
  "$out"
echo "wrote $out"
