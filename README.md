# claudespeak (escape-velocity-hq fork)

This is a fork of [albertshiney/claudespeak](https://github.com/albertshiney/claudespeak), which has all the original work. The upstream repository carries no license file, so this fork is for personal use and its changes are offered back to the author; ask him before redistributing it.

## What this fork changes

| Change | Why |
| --- | --- |
| **Windows and Linux playback** | Upstream plays only on macOS. Here Linux and WSL play through `ffplay`, and Windows runs a small batch file (`curl.exe` piped into `ffplay.exe`). macOS is unchanged. |
| **Speak only after long turns** (`minSeconds`) | Upstream reads every reply. A quick answer arrives while you are still looking; the voice earns its credits when a long job finishes and you have looked away. |
| **Daily limit** (`dailyCharLimit`) | Caps Fish Audio credits. It tells you once when the day's limit is reached, then stays quiet until tomorrow. |
| **Private details are not spoken** (`redact`) | Email addresses, phone numbers and money amounts are replaced before the text is sent to Fish Audio, so they are not sent to a third party or read out in a meeting. |

The plugin settings default to `minSeconds` 20, `dailyCharLimit` 20000 and `redact` on. Without those settings the code falls back to upstream's behavior (every reply, no limit) with `redact` on.

**Tested:** the new logic has unit tests (`bun test tests/extras.test.ts`, 15 passing). **Not tested:** playback on a real Windows or Linux machine, and the upstream suite in `tests/speak.test.ts`, which needs Claude Code's own test runner. Treat Windows and Linux playback as a first draft until you have heard it work.

On Windows, stopping speech ends every `ffplay.exe` on the machine, not only this plugin's.

## Use your own voice

1. Sign in at <https://fish.audio> and create a voice from a clean recording of yourself. Record only your own voice.
2. Open the new voice's page and copy its id (the long code at the end of the address).
3. Paste it into the plugin's **Fish voice id** setting, or tell Claude in the Code tab: "For the voice, use this Fish voice id: ...".

---

The original README follows, with the install commands pointed at this fork.


A mod for Claude Code. When Claude finishes a reply, it reads a 1-3 sentence summary out loud with [Fish Audio](https://fish.audio). Short plain replies are read as they are. It streams, so speech starts as the audio arrives.

Only one voice plays at a time, even with several sessions open: a new reply cuts off the one before it. It stays quiet in sub-agents, `claude -p`, scheduled desktop routines, and a `claude` started from inside another session.

## Requirements

- **macOS, Linux or Windows.** Upstream tested macOS only; see the fork notes above for Linux and Windows.
- **ffmpeg** (which includes `ffplay`): `brew install ffmpeg`, `sudo apt install ffmpeg`, or `winget install Gyan.FFmpeg`
- **A Fish Audio account and API key.** Get a key at <https://fish.audio/app/api-keys/>.
- **Claude Code** with a build that loads hooks modules. Tested on 2.1.309.

## Install

```
claude plugin marketplace add escape-velocity-hq/claudespeak
claude plugin install claudespeak@claudespeak
```

Then restart Claude Code, or run `/reload-plugins` in an open session.

### Add your Fish Audio key

Open the .env at `~/.claude/claudespeak/.env`, paste your Fish Audio API key after `FISH_API_KEY=`, save.

The file does not exist until claudespeak makes it, so run `/speak key` to create it and open it. If you skip this, your first finished reply does the same thing and tells you the path. The file is created readable only by you, and it lives outside the plugin folder so updates don't wipe it. A `FISH_API_KEY` environment variable takes priority over the file.

## Commands

It is **on by default**. `/speak on` and `/speak off` apply to every session on the machine.

| Command | What it does |
| --- | --- |
| `/speak` | Says whether it is on, and whether this session can speak |
| `/speak on` | Reads replies aloud in every session |
| `/speak off` | Stops reading aloud in every session |
| `/speak stop` | Cuts off the current speech in any session, and leaves the setting alone |
| `/speak key` | Creates the .env if needed and opens it |

## Voice and speed

Both are constants at the top of `hooks/register.ts`:

- `DEFAULTS.voiceId`: the Fish voice, Sawyer by default. It is also an option in the plugin's settings.
- `SPEECH_SPEED`: 1.1 by default, Fish's `prosody.speed` (0.5 to 2.0).

## Cost

Every spoken reply uses Fish Audio credits, and because it is on by default that means every reply in every session a person is attached to. Long replies also use one Haiku call on your Claude account to write the summary. Use `/speak off` to stop both.

## Status

Tested on macOS with scripted Claude Code sessions. Not yet confirmed by hand in the desktop app's Code tab, and sessions the app starts in the background may behave differently there.
