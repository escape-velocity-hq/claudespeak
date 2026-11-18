import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import {
  dayOf, detectPlatform, parseNumber, parseSwitch, redactPrivate, shouldSpeak, stdinHeaders,
  unixPlayer, usageText, usedToday, windowsBatch, winPath, withinBudget,
} from './extras'
import type { Platform } from './extras'

// claudespeak: each finished reply is cut to 1-3 spoken sentences by a
// small model and read aloud by Fish TTS, streamed so it starts on the first chunk.
// One machine-wide switch (/speak on|off, read at every reply) and one voice at a time
// across all sessions. (/voice is a built-in's name: the engine refuses it.)

type $ = EngineInterface

const FISH = 'https://api.fish.audio'
const CURL = '/usr/bin/curl'
const PKILL = '/usr/bin/pkill'
const FFMPEG_PATHS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
const MAX_SPOKEN = 300

/** How fast it talks: Fish's prosody.speed, 0.5 to 2.0. Raise or lower this one number. */
export const SPEECH_SPEED = 1.1
/** Fish buffers the whole clip under `normal`; `balanced` streams from the first chunk. */
const TTS_LATENCY = 'balanced'
const SAMPLE_RATE = 44100
const SUMMARY_TIMEOUT_MS = 6000

// Outside the plugin folder, so an update never wipes the key or the setting.
const DATA_DIR = '.claude/claudespeak'
const ENV_FILE = '.env'
const SETTING_FILE = 'setting.json'
const CURRENT_FILE = 'current-speech'
const USAGE_FILE = 'usage.json'
const TAG_PREFIX = 'claudespeak-'
/** Any session's player and download, and nothing else: their own argv starts with the binary. */
export const ANY_SPEECH = `^(${CURL}|[^ ]*/ff(mpeg|play)) .*${TAG_PREFIX}[0-9]+`

// One pipeline, so nothing waits for the whole clip: Fish's raw PCM goes straight into
// the default output. $6 tags curl and ffmpeg so they can be found again.
// One voice at a time, with no lock to go stale: claim the file, kill every other player,
// start, and give way if a newer speaker claimed it while this one was starting.
const streamScript = (platform: Platform): string =>
  'exec 3<&0; printf %s "$6" > "$7"; "$8" -KILL -f "$9"; [ "$(cat "$7")" = "$6" ] || exit 0; ' +
  '"$1" -sSfN --max-time 60 -H @- -A "$6" -H "Content-Type: application/json" -H "model: $4" --data-binary "@$5" "$3" <&3 | ' +
  `${unixPlayer(platform, SAMPLE_RATE)} & ` +
  'P=$!; sleep 0.1; [ "$(cat "$7")" = "$6" ] || "$8" -KILL -f "$6"; wait $P'

export type VoiceConfig = {
  voiceId: string
  ttsModel: string
  summaryModel: string
  /** Speak only replies whose turn ran at least this many seconds. 0 speaks every reply. */
  minSeconds: number
  /** Stop speaking for the day after this many characters. 0 means no limit. */
  dailyCharLimit: number
  /** Replace email addresses, phone numbers and money amounts before anything is spoken. */
  redact: boolean
}

export const DEFAULTS: VoiceConfig = {
  voiceId: 'fa4c9eb3dccc4806b382b40d61c6b10a', // Sawyer, a Fish Official voice
  ttsModel: 'drama-3',
  summaryModel: 'haiku',
  minSeconds: 0,
  dailyCharLimit: 0,
  redact: true,
}

const SUMMARY_SYSTEM = [
  "You turn a coding assistant's reply into what a voice assistant says out loud.",
  'Write one to three short sentences, under 280 characters in total, in plain conversational English, speaking to the user as "you".',
  'Say what was done or found, and anything the user has to decide or do next.',
  'Never include code, commands, file paths, URLs, markdown, lists, emoji or long numbers.',
  'You may add at most one or two short delivery directions in square brackets before the words they affect, such as [calm], [upbeat] or [laughs].',
  'Output only the words to speak.',
].join('\n')

const readConfig = (options: PluginOptions): VoiceConfig => {
  const text = (key: keyof VoiceConfig, fallback: string): string => {
    const value = options[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  return {
    voiceId: text('voiceId', DEFAULTS.voiceId),
    ttsModel: text('ttsModel', DEFAULTS.ttsModel),
    summaryModel: text('summaryModel', DEFAULTS.summaryModel),
    minSeconds: parseNumber(options['minSeconds'], DEFAULTS.minSeconds, 0, 3600),
    dailyCharLimit: parseNumber(options['dailyCharLimit'], DEFAULTS.dailyCharLimit, 0, 10_000_000),
    redact: parseSwitch(options['redact'], DEFAULTS.redact),
  }
}

// ---------- pure helpers (exported for the tests) ----------

/** FISH_API_KEY's value from .env text, quotes and a trailing comment dropped. */
export const parseEnvKey = (envText: string): string | undefined => {
  const match = /^[ \t]*(?:export[ \t]+)?FISH_API_KEY[ \t]*=[ \t]*(.*)$/m.exec(envText)
  if (!match) return undefined
  let value = (match[1] ?? '').trim()
  const quoted = /^(['"])(.*)\1/.exec(value)
  value = quoted ? (quoted[2] ?? '') : value.replace(/\s+#.*$/, '')
  value = value.trim()
  return value === '' ? undefined : value
}

/** True when a reply is already short plain prose that can be spoken as is. */
export const isSpeakable = (answer: string): boolean => {
  const text = answer.trim()
  if (text === '' || text.length > MAX_SPOKEN) return false
  if (text.split('\n').filter(line => line.trim() !== '').length > 2) return false
  if (/[`*#|<>_{}\\]|^\s*[-+]\s|^\s*\d+\.\s/m.test(text)) return false
  if (/https?:\/\/|www\./i.test(text)) return false
  if (/(^|\s)[~.]?\/?[\w.-]+\/[\w./-]+/.test(text)) return false
  return true
}

/** Makes model or reply text safe to speak: no markdown, paths, URLs; ≤ 300 chars. */
export const cleanSpoken = (raw: string): string => {
  let text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(^|\s)[~.]?\/?[\w.-]+\/[\w./-]+/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_#>|`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  let tags = 0
  text = text.replace(/\[[^\]]{1,40}\]/g, tag => (++tags <= 2 ? tag : '')).replace(/\s+/g, ' ').trim()
  if (text.length <= MAX_SPOKEN) return text
  const cut = text.slice(0, MAX_SPOKEN)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return end > 40 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' ')).trim()}.`
}

/** Fallback when the summary model gives nothing: the reply's first sentences. */
export const firstSentences = (answer: string): string => {
  const prose = answer
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .filter(line => line.trim() !== '' && !/^\s*(?:#|\||[-*+]\s|\d+\.\s)/.test(line))
    .join(' ')
  const sentences = prose.match(/[^.!?]+[.!?]+/g) ?? [prose]
  return cleanSpoken(sentences.slice(0, 2).join(' '))
}

const fishDetail = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; detail?: unknown }
    const detail = parsed.message ?? parsed.detail
    if (typeof detail === 'string' && detail.trim() !== '') return `: ${detail.trim().slice(0, 80)}`
  } catch {
    // not JSON
  }
  return ''
}

/** The TTS request. */
export const ttsBody = (text: string, voiceId: string): string =>
  JSON.stringify({
    text,
    reference_id: voiceId,
    format: 'pcm',
    sample_rate: SAMPLE_RATE,
    latency: TTS_LATENCY,
    prosody: { speed: SPEECH_SPEED },
  })

/** A missing or unreadable setting means on. */
export const parseSetting = (text: string | undefined): boolean => {
  try {
    return (JSON.parse(text ?? '{}') as { isOn?: unknown }).isOn !== false
  } catch {
    return true
  }
}

const ENV_TEMPLATE = '# Get a key at https://fish.audio/app/api-keys/ and paste it after the = below.\nFISH_API_KEY=\n'

const fishError = (what: string, status: number, body: string): string =>
  status === 401 || status === 403
    ? `Fish ${what}: the API key was refused (${status})`
    : status === 402
      ? `Fish ${what}: out of credits (402)`
      : status === 0
        ? `Fish ${what}: no response (network?)`
        : `Fish ${what} failed (${status})${fishDetail(body)}`

// ---------- the mod ----------

const st: {
  speechGen: number
  streamTag: string | undefined
  hasWarnedKey: boolean
  isInteractive: boolean
  turnStartedAt: number | undefined
  platform: Platform | undefined
} = {
  speechGen: 0,
  streamTag: undefined,
  hasWarnedKey: false,
  isInteractive: false,
  turnStartedAt: undefined,
  platform: undefined,
}

let cfg: VoiceConfig = DEFAULTS

function stopSpeech($: $): void {
  st.speechGen += 1
  // KILL, not TERM: on TERM ffmpeg plays out everything it has already queued.
  if (st.streamTag !== undefined) {
    const argv = st.platform === 'windows' ? WIN_KILL : [PKILL, '-KILL', '-f', st.streamTag]
    void $.process.run(argv).catch(() => undefined)
  }
  st.streamTag = undefined
}

/** Windows: stops the player by image name. That is every ffplay on the machine, not only ours. */
const WIN_KILL = ['taskkill', '/F', '/IM', 'ffplay.exe']

/** Worked out once per session: Windows by its OS variable, macOS by /usr/bin/open, else Linux. */
async function platformOf($: $): Promise<Platform> {
  if (st.platform !== undefined) return st.platform
  const osEnv = await $.env.get('OS')
  const hasMacOpen = osEnv === 'Windows_NT' ? false : await $.fs.exists('/usr/bin/open').catch(() => false)
  st.platform = detectPlatform(osEnv, hasMacOpen)
  return st.platform
}

async function makeDataDir($: $): Promise<void> {
  const dir = await homeData($)
  if ((await platformOf($)) === 'windows') {
    // mkdir fails when the folder is already there, which is fine.
    await $.process.run(['cmd.exe', '/d', '/c', 'mkdir', winPath(dir)]).catch(() => undefined)
    return
  }
  await $.process.run(['/bin/mkdir', '-p', '-m', '700', dir])
}

async function dataPath($: $, file: string): Promise<string> {
  return `${await homeData($)}/${file}`
}

async function writeData($: $, file: string, text: string): Promise<void> {
  await makeDataDir($)
  await $.fs.write(await dataPath($, file), text)
}

/** Read from the file at every reply, so a change reaches sessions already open. */
async function isSettingOn($: $): Promise<boolean> {
  const text = await $.fs.read(await dataPath($, SETTING_FILE)).catch(() => undefined)
  return parseSetting(text)
}

/** Cuts speech in every session, and tells a reply still being summarised to stay quiet. */
async function stopEverySpeech($: $): Promise<void> {
  stopSpeech($)
  const killAll = (await platformOf($)) === 'windows' ? WIN_KILL : [PKILL, '-KILL', '-f', ANY_SPEECH]
  await $.process.run(killAll).catch(() => undefined)
  await writeData($, CURRENT_FILE, `stopped ${await $.clock.now()}`)
}

async function tmpDir($: $): Promise<string> {
  if ((await platformOf($)) === 'windows') {
    return winPath((await $.env.get('TEMP')) ?? (await $.env.get('TMP')) ?? 'C:/Windows/Temp').replace(/\\+$/, '')
  }
  const dir = (await $.env.get('TMPDIR')) ?? '/tmp'
  return dir.replace(/\/+$/, '') || '/tmp'
}

async function rm($: $, ...paths: string[]): Promise<void> {
  if ((await platformOf($)) === 'windows') {
    for (const path of paths) await $.process.run(['cmd.exe', '/d', '/c', 'del', '/q', winPath(path)]).catch(() => undefined)
    return
  }
  await $.process.run(['/bin/rm', '-f', ...paths]).catch(() => undefined)
}

async function homeData($: $): Promise<string> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  return `${home}/${DATA_DIR}`
}

/** The environment first, then the one .env. Read fresh, so a pasted key works at once. */
async function apiKey($: $): Promise<string | undefined> {
  const fromEnv = (await $.env.get('FISH_API_KEY'))?.trim()
  if (fromEnv) return fromEnv
  const text = await $.fs.read(await dataPath($, ENV_FILE)).catch(() => undefined)
  return text === undefined ? undefined : parseEnvKey(text)
}

/** Makes the .env from the template, owner-only from its first byte. True when it made it. */
async function ensureEnvFile($: $): Promise<boolean> {
  const path = await dataPath($, ENV_FILE)
  if (await $.fs.exists(path).catch(() => false)) return false
  await makeDataDir($)
  const isWindows = (await platformOf($)) === 'windows'
  // Windows keeps the file private through the user profile folder's own permissions.
  if (!isWindows) await $.process.run(['/bin/sh', '-c', 'umask 077; : > "$1"', 'claudespeak', path])
  const template = await $.fs.read(`${$.plugin.root}/.env.example`).catch(() => ENV_TEMPLATE)
  await $.fs.write(path, template)
  if (!isWindows) await $.process.run(['/bin/chmod', '600', path])
  return true
}

/** Opens the .env in the default text editor where the platform has a way to. */
async function openEnvFile($: $): Promise<boolean> {
  const path = await dataPath($, ENV_FILE)
  if ((await platformOf($)) === 'windows') {
    const shown = await $.process.run(['cmd.exe', '/d', '/c', 'start', 'notepad.exe', winPath(path)]).catch(() => undefined)
    return shown?.exitCode === 0
  }
  const opened = (await $.fs.exists('/usr/bin/open').catch(() => false))
    ? await $.process.run(['/usr/bin/open', '-t', path]).catch(() => undefined)
    : await $.process.run(['/usr/bin/env', 'xdg-open', path]).catch(() => undefined)
  return opened?.exitCode === 0
}

const keyHelp = (path: string, isOpen: boolean): string =>
  `claudespeak needs a Fish Audio API key. ${isOpen ? 'Opened' : 'Open'} ${path}, paste your key after FISH_API_KEY= and save. Get a key at https://fish.audio/app/api-keys/`

/** First reply with no key: makes and opens the file once, and says so once per session. */
async function askForKey($: $): Promise<void> {
  if (st.hasWarnedKey) return
  st.hasWarnedKey = true
  const isOpen = (await ensureEnvFile($)) && (await openEnvFile($))
  const help = keyHelp(await dataPath($, ENV_FILE), isOpen)
  $.ui.toast(help, { timeoutMs: 15000 })
  await $.session
    .append({ message: { type: 'system', content: [{ type: 'text', text: help }] } })
    .catch(() => undefined)
}

/** The player: ffmpeg on macOS (as upstream), ffplay on Linux and Windows. */
async function findPlayer($: $): Promise<string | undefined> {
  const platform = await platformOf($)
  if (platform === 'windows') {
    const where = await $.process.run(['where', 'ffplay']).catch(() => undefined)
    const first = where?.exitCode === 0 ? (where.stdout.split(/\r?\n/)[0] ?? '').trim() : ''
    return first === '' ? undefined : first
  }
  const name = platform === 'mac' ? 'ffmpeg' : 'ffplay'
  for (const path of FFMPEG_PATHS) {
    const candidate = path.replace(/ffmpeg$/, name)
    if (await $.fs.exists(candidate).catch(() => false)) return candidate
  }
  const which = await $.process.run(['/usr/bin/which', name]).catch(() => undefined)
  const found = which?.exitCode === 0 ? which.stdout.trim() : ''
  return found === '' ? undefined : found
}

const playerHelp = (platform: Platform): string =>
  platform === 'mac'
    ? 'ffmpeg not found: brew install ffmpeg'
    : platform === 'windows'
      ? 'ffplay not found: install ffmpeg (winget install Gyan.FFmpeg) and restart Claude Code'
      : 'ffplay not found: install ffmpeg (sudo apt install ffmpeg)'

async function summarize($: $, answer: string): Promise<string> {
  if (isSpeakable(answer)) return cleanSpoken(answer)
  const ask = (model: string) =>
    $.model.complete({
      model,
      system: SUMMARY_SYSTEM,
      prompt: `The reply to turn into speech:\n<reply>\n${answer.slice(0, 6000)}\n</reply>`,
      maxTokens: 120,
      effort: 'low',
      timeoutMs: SUMMARY_TIMEOUT_MS,
    })
  const reply = await ask(cfg.summaryModel).catch(() => undefined)
  const spoken = reply?.isAnswered ? cleanSpoken(reply.text) : ''
  return spoken !== '' ? spoken : firstSentences(answer)
}

/** Plays while Fish generates. Resolves when the clip ends or something cuts it. */
async function streamSpeech($: $, key: string, ffmpeg: string, text: string): Promise<void> {
  const tag = `${TAG_PREFIX}${await $.clock.now()}`
  const bodyPath = `${await tmpDir($)}${(await platformOf($)) === 'windows' ? '\\' : '/'}${tag}.json`
  await $.fs.write(bodyPath, ttsBody(text, cfg.voiceId))
  await makeDataDir($)
  st.streamTag = tag
  const platform = await platformOf($)
  const batPath = `${await tmpDir($)}\\${tag}.cmd`
  try {
    let ran
    if (platform === 'windows') {
      await $.fs.write(batPath, windowsBatch({ curl: 'curl.exe', ffplay: ffmpeg, url: `${FISH}/v1/tts`, bodyPath, tag, sampleRate: SAMPLE_RATE }))
      ran = await $.process.run(['cmd.exe', '/d', '/c', batPath], {
        stdin: stdinHeaders(key, cfg.ttsModel, true),
        timeoutMs: 180_000,
      })
    } else {
      ran = await $.process.run(
        [
          '/bin/sh', '-c', streamScript(platform), 'voice',
          CURL, ffmpeg, `${FISH}/v1/tts`, cfg.ttsModel, bodyPath, tag,
          await dataPath($, CURRENT_FILE), PKILL, ANY_SPEECH,
        ],
        { stdin: stdinHeaders(key, cfg.ttsModel, false), timeoutMs: 180_000 },
      )
    }
    const status = /returned error: (\d+)/.exec(ran.stderr)?.[1]
    if (status !== undefined) $.ui.toast(fishError('text-to-speech', Number(status), ''), { timeoutMs: 8000 })
    else if (platform !== 'windows' && ran.exitCode !== 0 && ran.exitCode !== 137) {
      // 137 is another reply taking over. Anything else is the player failing.
      $.ui.toast(`claudespeak: playback failed: ${ran.stderr.trim().split('\n').pop()?.slice(0, 80) ?? ''}`, { timeoutMs: 8000 })
    }
  } finally {
    if (st.streamTag === tag) st.streamTag = undefined
    await rm($, bodyPath, ...(platform === 'windows' ? [batPath] : []))
  }
}

/**
 * Counts the characters about to be spoken against the day's limit. False when the limit
 * is used up: it says so once, at the reply that crosses it, then stays quiet until tomorrow.
 */
async function spendBudget($: $, chars: number, now: number): Promise<boolean> {
  if (cfg.dailyCharLimit <= 0) return true
  const day = dayOf(now)
  const used = usedToday(await $.fs.read(await dataPath($, USAGE_FILE)).catch(() => undefined), day)
  if (!withinBudget(used, chars, cfg.dailyCharLimit)) {
    if (used <= cfg.dailyCharLimit) {
      $.ui.toast(`claudespeak: today's limit of ${cfg.dailyCharLimit} spoken characters is reached. Quiet until tomorrow.`, { timeoutMs: 8000 })
      await writeData($, USAGE_FILE, usageText(day, cfg.dailyCharLimit + 1))
    }
    return false
  }
  await writeData($, USAGE_FILE, usageText(day, used + chars))
  return true
}

async function speak($: $, answer: string): Promise<void> {
  stopSpeech($)
  const gen = st.speechGen
  const startedAt = await $.clock.now()
  const key = await apiKey($)
  if (key === undefined) return askForKey($)
  const summary = await summarize($, answer)
  const line = cfg.redact ? redactPrivate(summary) : summary
  if (line === '' || gen !== st.speechGen) return
  if (!(await spendBudget($, line.length, startedAt))) return
  const current = await $.fs.read(await dataPath($, CURRENT_FILE)).catch(() => '')
  if (current.startsWith('stopped ') && Number(current.slice(8)) > startedAt) return
  const ffmpeg = await findPlayer($)
  if (ffmpeg === undefined) {
    $.ui.toast(playerHelp(await platformOf($)), { timeoutMs: 8000 })
    return
  }
  await streamSpeech($, key, ffmpeg, line)
}

/**
 * Whether a reply here may be read aloud: a person's session, never a scheduled run,
 * a claude started from inside another session's tools, Cowork, -p or an SDK host.
 */
async function mayTalkHere($: $): Promise<boolean> {
  if (await $.env.get('CLAUDE_CODE_CHILD_SESSION')) return false
  if (await $.env.get('CLAUDE_CODE_HOST_SCHEDULED_RUN')) return false
  if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'local-agent') return false
  if (st.isInteractive) return true
  return ((await $.session.surfaces().catch(() => [])) ?? []).length > 0
}

export const register: Register = (on, options) => {
  cfg = readConfig(options)
  st.hasWarnedKey = false

  on('session.start', async ($, e, next) => {
    st.isInteractive = e.isInteractive
    await $.command.register({
      name: 'speak',
      description: 'Read replies aloud, in every session: /speak on, off, stop, key; /speak alone says which',
      argumentHint: '[on|off|stop|key]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'speak' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'stop') {
      await stopEverySpeech($)
      return { text: 'Stopped speaking.' }
    }
    if (arg === 'key') {
      await ensureEnvFile($)
      const isOpen = (await mayTalkHere($)) && (await openEnvFile($))
      const path = await dataPath($, ENV_FILE)
      return {
        text: isOpen
          ? `Opened ${path}. Paste your Fish Audio key after FISH_API_KEY= and save.`
          : `Open ${path}, paste your Fish Audio key after FISH_API_KEY= and save.`,
      }
    }
    if (arg === 'on' || arg === 'off') {
      await writeData($, SETTING_FILE, JSON.stringify({ isOn: arg === 'on' }))
      if (arg === 'off') await stopEverySpeech($)
      $.ui.toast(arg === 'on' ? `Spoken replies on everywhere (${cfg.ttsModel})` : 'Spoken replies off everywhere')
      return { text: `Spoken replies are ${arg} in every session.` }
    }
    const isOn = await isSettingOn($)
    const quiet = isOn && !(await mayTalkHere($)) ? ' This session stays quiet: no person is attached to it.' : ''
    const noKey = (await apiKey($)) === undefined ? ' No Fish Audio key yet: run /speak key.' : ''
    return { text: `Spoken replies are ${isOn ? 'on' : 'off'} in every session.${quiet}${noKey}` }
  }).catch(() => ({ text: 'claudespeak: /speak failed.' }))

  // A new prompt means the person has moved on: cut the old reply's speech.
  on('prompt.submit', async ($, e, next) => {
    stopSpeech($)
    try {
      st.turnStartedAt = await $.clock.now()
    } catch {
      st.turnStartedAt = undefined
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isMainAnswer = e.agentId === undefined && e.reason === 'answer' && e.answer.trim() !== ''
    if (!isMainAnswer) return result
    if (!(await mayTalkHere($)) || !(await isSettingOn($))) return result
    // Quick replies arrive while the person is still looking: only long turns are worth hearing.
    let finishedAt: number | undefined
    try {
      finishedAt = cfg.minSeconds > 0 ? await $.clock.now() : undefined
    } catch {
      finishedAt = undefined
    }
    const elapsed = finishedAt !== undefined && st.turnStartedAt !== undefined ? finishedAt - st.turnStartedAt : undefined
    if (!shouldSpeak(elapsed, cfg.minSeconds)) return result
    void speak($, e.answer).catch(err => {
      $.ui.toast(`claudespeak: ${err instanceof Error ? err.message.slice(0, 100) : 'speech failed'}`)
    })
    return result
  })

  on('session.end', ($, e, next) => {
    stopSpeech($)
    return next(e)
  })
}
