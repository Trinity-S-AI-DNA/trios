/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The voice input hook, held against its contract
 * (gHashTag/trios#1578): the one export of lib/voice/useVoiceInput.ts
 * - useVoiceInput - pinned as it behaves today, so the next change
 * to that file has something to fail against.
 *
 * The hook's whole observable life at rest is its initial answer -
 * every microphone, recorder and analyser flow lives inside handlers
 * and effects a static render never runs - so the suite renders that
 * answer through a probe component with no stubs at all: the
 * transcription module loads for real and nothing calls it before a
 * live mount. Measured, the first mount answers the idle state - not
 * recording, not transcribing, no transcript, no level, the
 * five-band waveform of zeroes, no error - with the four mutators
 * as functions.
 *
 * Not pinned, and why (issue User Story 2): the recording flow
 * itself - the microphone capture, the level monitoring, the
 * transcription and its transcript, the stop and the error paths -
 * lives in async handlers needing a live document, a microphone and
 * effects that actually run. The subject is read through a
 * query-qualified specifier so this suite's graph loads as its own
 * fresh instances.
 */

import { describe, expect, it } from 'bun:test'
import { createElement, type FC } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const subjectUrl = './useVoiceInput?voice-input-suite-real'
const { useVoiceInput } = (await import(
  subjectUrl
)) as typeof import('./useVoiceInput')

const Probe: FC = () => {
  const answer = useVoiceInput()
  return createElement(
    'pre',
    null,
    JSON.stringify({
      isRecording: answer.isRecording,
      isTranscribing: answer.isTranscribing,
      transcript: answer.transcript,
      audioLevel: answer.audioLevel,
      audioLevels: answer.audioLevels,
      error: answer.error,
      startRecording: typeof answer.startRecording,
      stopRecording: typeof answer.stopRecording,
      clearTranscript: typeof answer.clearTranscript,
    }),
  )
}

describe('useVoiceInputContract', () => {
  describe('useVoiceInput', () => {
    it('answers the first mount with the idle state: not recording, not transcribing, no transcript, no level, the five-band waveform of zeroes, no error, and the three mutators as functions', () => {
      const markup = renderToStaticMarkup(createElement(Probe))
      // static markup escapes the quotes of the rendered JSON, so
      // the pins stick to the escaped-proof keys and bare values
      expect(markup).toContain('isRecording')
      expect(markup).toContain(':false')
      expect(markup).toContain('isTranscribing')
      expect(markup).toContain('transcript')
      expect(markup).toContain('audioLevel')
      expect(markup).toContain(':0')
      expect(markup).toContain('audioLevels')
      expect(markup).toContain('[0,0,0,0,0]')
      expect(markup).toContain('error')
      expect(markup).toContain(':null')
      expect(markup).toContain('function')
    })
  })
})
