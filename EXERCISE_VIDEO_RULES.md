# Exercise video generation rules (Ajay, 2026-10-29)

Every exercise clip must be generated to this rule, no exceptions:

- Camera: straight, level, front view, facing the character. Never tilted, angled, sideways, or zoomed/cropping the body.
- Framing: full body, head to toe, in frame for the whole clip. No close-ups, no crops below the waist, no cut-off feet or head.
- Clarity: the exercise motion must be large, slow, and unmistakable — a viewer must be able to tell what exercise it is from the clip alone, with no text.
- Motion per exercise (examples): calf raises = heels clearly lifting off the ground and lowering back down, repeated; squats = bending knees and lowering, then standing; shoulder rolls = shoulders visibly rolling in a circle.
- Character: same teal-hoodie full-body 3D cartoon character as the app's default, consistent outfit and face across clips.
- Background: plain light grey, except squats which use green screen for chromakey.
- No text, no captions, no other people, no props that hide the movement.
- FOCUS / SIZE RULE (Ajay, 2026-10-29): vertical portrait video (720x1280), character LARGE and focused, filling most of the frame — exercise must be visible large, never a small character in a wide empty frame. The app canvas is portrait (170x340), so landscape videos shrink the character — always generate portrait.
- Check before shipping: extract a frame at 2-3s and verify it is straight, full-body, and the motion is clear. If it is tilted, cropped, or unclear, regenerate — do not ship it.
- APPLYING THIS RULE TO ALL CHANGES (repo skill): do not fix videos one-by-one by hand — apply this rule file to every exercise clip, every code change that touches videos, and every upload, in one batch: regenerate, frame-check, wire the new filenames into renderer.js, push code once, upload media once, then report the run. No separate manual steps per clip.
