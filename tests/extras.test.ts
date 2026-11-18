// Runs with `bun test tests/extras.test.ts`: these helpers are pure, so they need no engine.
import { describe, expect, test } from 'bun:test'

import {
  dayOf, detectPlatform, parseNumber, parseSwitch, redactPrivate, shouldSpeak, stdinHeaders,
  unixPlayer, usageText, usedToday, windowsBatch, winPath, withinBudget,
} from '../hooks/extras'

describe('platform', () => {
  test('Windows by its OS variable, macOS by /usr/bin/open, otherwise Linux', () => {
    expect(detectPlatform('Windows_NT', false)).toBe('windows')
    expect(detectPlatform('Windows_NT', true)).toBe('windows')
    expect(detectPlatform(undefined, true)).toBe('mac')
    expect(detectPlatform(undefined, false)).toBe('linux')
  })
  test('macOS keeps the audiotoolbox line; Linux plays through ffplay', () => {
    expect(unixPlayer('mac', 44100)).toContain('-f audiotoolbox -')
    expect(unixPlayer('mac', 44100)).toContain('-ac 1 -i pipe:0')
    expect(unixPlayer('linux', 44100)).toContain('-nodisp -autoexit')
    expect(unixPlayer('linux', 44100)).toContain('-window_title "$6"')
    expect(unixPlayer('linux', 44100)).not.toContain('audiotoolbox')
  })
  test('the Windows batch file pipes curl into ffplay and never holds the key', () => {
    const bat = windowsBatch({ curl: 'curl.exe', ffplay: 'C:\\Program Files\\ffmpeg\\bin\\ffplay.exe', url: 'https://api.fish.audio/v1/tts', bodyPath: 'C:\\Temp\\claudespeak-1.json', tag: 'claudespeak-1', sampleRate: 44100 })
    expect(bat).toContain('"curl.exe" -sSfN --max-time 60 -H @-')
    expect(bat).toContain('| "C:\\Program Files\\ffmpeg\\bin\\ffplay.exe" -nodisp')
    expect(bat).toContain('--data-binary "@C:\\Temp\\claudespeak-1.json"')
    expect(bat).toContain('taskkill /F /IM ffplay.exe')
    expect(bat).not.toContain('Bearer')
    expect(bat.split('\r\n').length).toBe(4)
  })
  test('quotes and percent signs cannot break out of a batch argument', () => {
    const bat = windowsBatch({ curl: 'curl.exe', ffplay: 'ffplay.exe', url: 'https://x/"&calc&"', bodyPath: 'C:\\T\\%PATH%.json', tag: 't', sampleRate: 44100 })
    expect(bat).toContain('"https://x/&calc&"')
    expect(bat).toContain('%%PATH%%')
  })
  test('headers go to curl on stdin; a line break in a value cannot add a header', () => {
    expect(stdinHeaders('k', 'drama-3', false)).toBe('Authorization: Bearer k\n')
    expect(stdinHeaders('k', 'drama-3', true)).toBe('Authorization: Bearer k\nContent-Type: application/json\nmodel: drama-3\n')
    expect(stdinHeaders('k\nX-Evil: 1', 'm', false).split('\n').length).toBe(2)
  })
  test('winPath', () => {
    expect(winPath('C:/Users/ben/.claude/claudespeak')).toBe('C:\\Users\\ben\\.claude\\claudespeak')
  })
})

describe('privacy', () => {
  test('email addresses, phone numbers and money amounts are never spoken', () => {
    expect(redactPrivate('I emailed pat@example.com about it.')).toBe('I emailed an email address about it.')
    expect(redactPrivate('Call (555) 010-4477 or 555-010-4477.')).toBe('Call a phone number or a phone number.')
    expect(redactPrivate('The quote came in at $1,234,567.89 today.')).toBe('The quote came in at an amount today.')
    expect(redactPrivate('That is $4.5M, or 1,200 dollars a day.')).toBe('That is an amount, or an amount a day.')
  })
  test('ordinary numbers and words are left alone', () => {
    const plain = 'Three of the 12 tests failed on line 482 in 2026.'
    expect(redactPrivate(plain)).toBe(plain)
  })
})

describe('when to speak', () => {
  test('0 speaks every reply; an unknown start time speaks', () => {
    expect(shouldSpeak(0, 0)).toBe(true)
    expect(shouldSpeak(undefined, 20)).toBe(true)
  })
  test('only turns at least minSeconds long are spoken', () => {
    expect(shouldSpeak(19_999, 20)).toBe(false)
    expect(shouldSpeak(20_000, 20)).toBe(true)
  })
})

describe('daily limit', () => {
  test('usage counts only today', () => {
    expect(usedToday(usageText('2026-11-18', 900), '2026-11-18')).toBe(900)
    expect(usedToday(usageText('2026-11-17', 900), '2026-11-18')).toBe(0)
    expect(usedToday(undefined, '2026-11-18')).toBe(0)
    expect(usedToday('not json', '2026-11-18')).toBe(0)
  })
  test('a limit of 0 is no limit', () => {
    expect(withinBudget(1_000_000, 300, 0)).toBe(true)
    expect(withinBudget(19_800, 200, 20_000)).toBe(true)
    expect(withinBudget(19_800, 201, 20_000)).toBe(false)
  })
  test('dayOf', () => {
    expect(dayOf(Date.UTC(2026, 10, 18, 6, 30))).toBe('2026-11-18')
  })
})

describe('options', () => {
  test('numbers', () => {
    expect(parseNumber('20', 0, 0, 3600)).toBe(20)
    expect(parseNumber(45.9, 0, 0, 3600)).toBe(45)
    expect(parseNumber('', 7, 0, 3600)).toBe(7)
    expect(parseNumber('-1', 7, 0, 3600)).toBe(7)
    expect(parseNumber('abc', 7, 0, 3600)).toBe(7)
    expect(parseNumber(undefined, 7, 0, 3600)).toBe(7)
  })
  test('switches', () => {
    expect(parseSwitch('off', true)).toBe(false)
    expect(parseSwitch('On', false)).toBe(true)
    expect(parseSwitch(undefined, true)).toBe(true)
    expect(parseSwitch('maybe', true)).toBe(true)
    expect(parseSwitch(false, true)).toBe(false)
  })
})
