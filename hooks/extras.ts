// Additions in the escape-velocity-hq fork. Everything here is pure (no engine calls),
// so it can be unit-tested with any runner: see tests/extras.test.ts.

export type Platform = 'mac' | 'linux' | 'windows'

/** Windows sets OS=Windows_NT; macOS has /usr/bin/open; everything else is treated as Linux. */
export const detectPlatform = (osEnv: string | undefined, hasMacOpen: boolean): Platform =>
  osEnv === 'Windows_NT' ? 'windows' : hasMacOpen ? 'mac' : 'linux'

/** A whole number from a plugin option, or the fallback when it is missing or out of range. */
export const parseNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback
}

/** "off", "false", "no" and "0" turn a switch off; anything else, or nothing, leaves the fallback. */
export const parseSwitch = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return fallback
  const v = value.trim().toLowerCase()
  if (['off', 'false', 'no', '0'].includes(v)) return false
  if (['on', 'true', 'yes', '1'].includes(v)) return true
  return fallback
}

/**
 * Private details never go to the speech service or out of the speaker:
 * email addresses, phone numbers and money amounts are replaced with a neutral phrase.
 */
export const redactPrivate = (text: string): string =>
  text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, 'an email address')
    .replace(/(?:US)?\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|mm|bn|b|thousand|million|billion)\b)?/gi, 'an amount')
    .replace(/\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|usd|euros|eur|lei|ron)\b/gi, 'an amount')
    .replace(/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, 'a phone number')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Speak only when the turn ran long enough that the person has probably looked away.
 * minSeconds 0 speaks every reply; an unknown start time speaks, so nothing is lost.
 */
export const shouldSpeak = (elapsedMs: number | undefined, minSeconds: number): boolean =>
  minSeconds <= 0 || elapsedMs === undefined || elapsedMs >= minSeconds * 1000

/** The UTC day of a millisecond timestamp, as YYYY-MM-DD. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** Characters already spoken today, from the usage file's text. Another day's count is zero. */
export const usedToday = (text: string | undefined, day: string): number => {
  try {
    const parsed = JSON.parse(text ?? '{}') as { day?: unknown; chars?: unknown }
    return parsed.day === day && typeof parsed.chars === 'number' && parsed.chars > 0 ? Math.floor(parsed.chars) : 0
  } catch {
    return 0
  }
}

/** True when speaking `add` more characters stays inside the day's limit. A limit of 0 means no limit. */
export const withinBudget = (used: number, add: number, limit: number): boolean => limit <= 0 || used + add <= limit

export const usageText = (day: string, chars: number): string => JSON.stringify({ day, chars })

/** Forward slashes to backslashes, for cmd.exe built-ins that do not accept "/". */
export const winPath = (path: string): string => path.replace(/\//g, '\\')

const SILENCE = 'silenceremove=start_periods=1:start_threshold=-50dB'

/**
 * The player half of the macOS and Linux pipeline. $2 is the player binary and $6 the tag
 * that lets one session find and stop another's speech.
 * macOS keeps upstream's ffmpeg + audiotoolbox line unchanged. Linux (and WSL) has no
 * audiotoolbox, so it plays through ffplay, which ships with ffmpeg.
 */
export const unixPlayer = (platform: Platform, sampleRate: number): string =>
  platform === 'mac'
    ? '"$2" -nostdin -hide_banner -loglevel error -fflags nobuffer -probesize 32 -analyzeduration 0 ' +
      `-f s16le -ar ${sampleRate} -ac 1 -i pipe:0 -af ${SILENCE} -metadata title="$6" -f audiotoolbox -`
    : '"$2" -nodisp -autoexit -hide_banner -loglevel error -fflags nobuffer -probesize 32 -analyzeduration 0 ' +
      `-f s16le -ar ${sampleRate} -ch_layout mono -window_title "$6" -af ${SILENCE} -i pipe:0`

/**
 * Windows has no /bin/sh or pkill, so the pipeline is a small batch file run by cmd.exe,
 * whose pipes are binary-safe (PowerShell 5 pipes are not). The API key is not in the file:
 * curl reads every header from stdin (-H @-). Only one voice plays: any ffplay already
 * running is stopped first.
 */
export const windowsBatch = (a: { curl: string; ffplay: string; url: string; bodyPath: string; tag: string; sampleRate: number }): string => {
  const q = (s: string): string => `"${s.replace(/"/g, '').replace(/%/g, '%%')}"`
  return [
    '@echo off',
    'taskkill /F /IM ffplay.exe >nul 2>&1',
    `${q(a.curl)} -sSfN --max-time 60 -H @- -A ${q(a.tag)} --data-binary ${q(`@${a.bodyPath}`)} ${q(a.url)} | ` +
      `${q(a.ffplay)} -nodisp -autoexit -hide_banner -loglevel error -fflags nobuffer -probesize 32 -analyzeduration 0 ` +
      `-f s16le -ar ${a.sampleRate} -ch_layout mono -af ${SILENCE} -i pipe:0`,
    '',
  ].join('\r\n')
}

/** Every header curl needs, one per line, for -H @-. Line breaks in a value would add headers, so they are dropped. */
export const stdinHeaders = (key: string, model: string, withBodyHeaders: boolean): string => {
  const one = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim()
  const lines = [`Authorization: Bearer ${one(key)}`]
  if (withBodyHeaders) lines.push('Content-Type: application/json', `model: ${one(model)}`)
  return `${lines.join('\n')}\n`
}
