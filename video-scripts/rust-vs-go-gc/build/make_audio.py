#!/usr/bin/env python3
"""Generate per-beat draft voice-over (macOS `say`) and timing.json for the animation."""
import json, subprocess, sys, pathlib

root = pathlib.Path(sys.argv[1])          # video-scripts/rust-vs-go-gc
out = pathlib.Path(sys.argv[2])           # work dir for audio
out.mkdir(parents=True, exist_ok=True)
GAP = 0.45      # silence after each beat (s)
LEAD = 0.5      # fade-in before the first beat of a scene
TAIL = 0.6      # hold after the last beat of a scene
d = json.load(open(root / "narration.json"))
timing = []
for s in d["scenes"]:
    beats = []
    for i, text in enumerate(s["beats"]):
        aiff = out / f'{s["id"]}_{i}.aiff'
        wav = out / f'{s["id"]}_{i}.wav'
        subprocess.run(["say", "-v", "Tingting", "-r", "190", "-o", str(aiff), text], check=True)
        pad = GAP + (TAIL if i == len(s["beats"]) - 1 else 0)
        pre = LEAD if i == 0 else 0
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff),
                        "-af", f"adelay={int(pre*1000)}|{int(pre*1000)},apad=pad_dur={pad}",
                        "-ar", "44100", "-ac", "2", str(wav)], check=True)
        dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                             "-of", "csv=p=0", str(wav)]).decode())
        beats.append({"text": text, "wav": str(wav), "dur": round(dur, 3), "lead": pre})
    timing.append({"id": s["id"], "name": s["name"], "beats": beats,
                   "dur": round(sum(b["dur"] for b in beats), 3)})
json.dump(timing, open(root / "build" / "timing.json", "w"), ensure_ascii=False, indent=1)
total = sum(s["dur"] for s in timing)
for s in timing: print(s["id"], s["dur"])
print("TOTAL", round(total, 1), "s =", f"{int(total//60)}:{int(total%60):02d}")

with open(root / "build" / "timing.js", "w") as f:
    f.write("window.TIMING = " + json.dumps(timing, ensure_ascii=False) + ";\n")
