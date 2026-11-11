#!/usr/bin/env python3
"""Concat scene clips -> full silent video; build draft voice track + SRT; mux preview."""
import json, subprocess, pathlib, sys
here = pathlib.Path(__file__).parent; root = here.parent; out = here / "out"
timing = json.load(open(here / "timing.json"))
def run(*a): subprocess.run(list(a), check=True)

# 1) 全片（无声）
lst = out / "clips.txt"
lst.write_text("".join(f"file '{out}/scene{i+1}.mp4'\n" for i in range(len(timing))))
run("ffmpeg","-y","-loglevel","error","-f","concat","-safe","0","-i",str(lst),"-c","copy",str(root/"rust-vs-go-gc_silent.mp4"))

# 2) 草稿配音 + 分场景音频 + SRT
wavs = [b["wav"] for s in timing for b in s["beats"]]
al = out / "audio.txt"; al.write_text("".join(f"file '{w}'\n" for w in wavs))
run("ffmpeg","-y","-loglevel","error","-f","concat","-safe","0","-i",str(al),"-c:a","aac","-b:a","192k",str(root/"draft-voice_tingting.m4a"))
def ts(x):
    h=int(x//3600); m=int(x%3600//60); s=x%60; return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".",",")
srt=[]; n=1; off=0.0
for s in timing:
    for b in s["beats"]:
        a=off+b["lead"]; e=off+b["dur"]-0.45-(0.6 if b is s["beats"][-1] else 0)
        srt.append(f"{n}\n{ts(a)} --> {ts(e)}\n{b['text']}\n"); n+=1; off+=b["dur"]
(root/"subtitles_zh.srt").write_text("\n".join(srt), encoding="utf-8")

# 3) 预览（画面 + 草稿配音）
run("ffmpeg","-y","-loglevel","error","-i",str(root/"rust-vs-go-gc_silent.mp4"),"-i",str(root/"draft-voice_tingting.m4a"),
    "-c:v","copy","-c:a","copy","-shortest",str(root/"rust-vs-go-gc_preview_with_draft_voice.mp4"))
print("total", round(off,1), "s")
