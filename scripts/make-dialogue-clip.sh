#!/usr/bin/env bash
# Generates the dialogue fixture: a ~35 s scene with two synthetic voices
# (macOS `say`: Daniel as Red, Samantha as Blue) over synthetic shots at
# 24 fps. Rights-free real speech, so speech-to-text and the Analyst can be
# exercised (and their responses recorded) without copyrighted footage.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/../fixtures/dialogue/source.mp4}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

lines=(
  "Daniel|Blue, this place gives me the creeps. Let's split up and cover more ground."
  "Samantha|Split up? Red, have you never seen a horror movie?"
  "Daniel|Fine. I'll take the basement. You check the kitchen."
  "Samantha|I'm locking the back door first. Nobody gets in behind us."
  "Daniel|Did you hear that? Something moved upstairs."
  "Samantha|Leave the lights on, and walk slowly back to the car."
  "Daniel|Forget the car. I'm going up there to see what it is."
  "Samantha|Red, wait!"
)

# Speech, with a pause before each line.
list="$work/audio.txt"
: > "$list"
ffmpeg -hide_banner -loglevel error -f lavfi -i "anullsrc=r=48000:cl=mono" -t 1.0 "$work/lead.wav"
ffmpeg -hide_banner -loglevel error -f lavfi -i "anullsrc=r=48000:cl=mono" -t 0.7 "$work/gap.wav"
echo "file '$work/lead.wav'" >> "$list"
i=0
for entry in "${lines[@]}"; do
  voice="${entry%%|*}"
  text="${entry#*|}"
  say -v "$voice" -o "$work/line$i.aiff" "$text"
  ffmpeg -hide_banner -loglevel error -i "$work/line$i.aiff" -ar 48000 -ac 1 "$work/line$i.wav"
  echo "file '$work/line$i.wav'" >> "$list"
  echo "file '$work/gap.wav'" >> "$list"
  i=$((i + 1))
done
ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i "$list" -c:a pcm_s16le "$work/speech.wav"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$work/speech.wav")

# Shots that alternate every ~4.5 s, like coverage of a conversation.
size=1280x720
rate=24
shot=4.5
n=$(python3 -c "import math; print(math.ceil($dur / $shot))")
inputs=()
filters=""
for ((s = 0; s < n; s++)); do
  case $((s % 3)) in
    0) src="testsrc=size=$size:rate=$rate:duration=$shot" ;;
    1) src="mandelbrot=size=$size:rate=$rate,trim=duration=$shot" ;;
    2) src="testsrc2=size=$size:rate=$rate:duration=$shot" ;;
  esac
  inputs+=(-f lavfi -i "$src")
  filters+="[$s:v]setsar=1,format=yuv420p[v$s];"
done
concat=""
for ((s = 0; s < n; s++)); do concat+="[v$s]"; done
ffmpeg -hide_banner -loglevel error -y "${inputs[@]}" -i "$work/speech.wav" \
  -filter_complex "${filters}${concat}concat=n=$n:v=1:a=0[v]" \
  -map "[v]" -map "$n:a" -t "$dur" \
  -c:v libx264 -preset slow -crf 32 -g "$rate" -keyint_min "$rate" -sc_threshold 0 \
  -c:a aac -b:a 96k -ac 1 -movflags +faststart "$out"
echo "wrote $out ($dur s)"
