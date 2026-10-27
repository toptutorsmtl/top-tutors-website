# launch-video, a Claude Code skill

Makes product launch videos in code, rendered to MP4 in about 20-45 seconds. Two styles:

- **Kinetic** (the original): words land on the voiceover, keyword pills, counters, a glowing logo reveal, your
  product UI with camera moves, cursor clicks and notification toasts.
- **App ad** (new): for a mobile app. Your real screen recording plays inside a 3D iPhone the camera moves around,
  with short text cards on the beat, solid brand colours and a wordmark end card. Mostly music; a voiced hook and
  outro if you want them.

Also in this version:
- **Brand from a link:** give it your website and it pulls the logo, colours and fonts with context.dev
  (`brand.py`; an API key or the context.dev MCP).
- **Voiceover:** record yourself line by line (teleprompter), or use Fish Audio / ElevenLabs voices; optional
  Auphonic mastering. It transcribes your takes, so the captions follow what you actually said.
- **A real song:** set it as the music and it lines the drop up with the reveal and snaps cuts to the beat. You also
  get an `-upload.mp4` without the song, to post with the platform's licensed sound.
- **Desktop chat look:** the terminal beats can look like the Claude Code desktop app.

## Install

1. Put this `launch-video` folder in `~/.claude/skills/` (every project) or `<your project>/.claude/skills/` (one project).
2. Install the renderer and the Python bits once:
   ```bash
   cd ~/.claude/skills/launch-video/engine && npm install
   pip3 install numpy scipy requests sounddevice faster-whisper
   ```
   Needs Google Chrome and ffmpeg (`brew install ffmpeg`).
3. Optional keys go in `launch-video/.env` (copy `.env.example`): Fish Audio, ElevenLabs, Auphonic, context.dev.
4. In Claude Code, say "make a launch video for my product", or for a phone app, "make an app launch video from this
   screen recording" (or run `/launch-video`).

Examples: `examples/launch-skill` (the video that announced this skill) and `examples/app-ad` (an app ad; add your
own screen recording, see its README).
