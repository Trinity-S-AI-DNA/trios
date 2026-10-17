/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The run result dialog, held against its contract
 * (gHashTag/trios#1632): the single export of
 * components/ai-elements/run-result-dialog.tsx - RunResultDialog -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The dialog is controlled (open is derived from run !== null), so a
 * static render reaches both answers; the Radix kit is stubbed with the
 * group's stand-in shape (the root honours the open flag, everything
 * else a passthrough), so a null run answers nothing. Pinned: the null
 * answer; the header's status icon dispatch (completed on the green
 * check, failed on the destructive X, everything else on the spinning
 * loader); the job name with the fallback; the timestamp and duration
 * lines (the measured formats, Still running without a completedAt);
 * the failed card (Task failed, the result in destructive color); the
 * no-result note; the footer gating (Cancel on a running run with the
 * handler, Retry on a failed run with the handler, Copy whenever a
 * result exists, Close always). Not pinned: the clipboard write and
 * the copied flip (handlers), and the MessageResponse markdown
 * rendering of a completed result (that renderer's machinery is the
 * ai-elements suites' own subject).
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement, type FC, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const passChildren =
  (): FC<{ children?: ReactNode }> =>
  ({ children }) =>
    createElement('div', null, children)

mock.module('@/components/ui/dialog', () => {
  const pass = passChildren()
  return {
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? children : null,
    DialogClose: pass,
    DialogContent: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogOverlay: () => null,
    DialogPortal: pass,
    DialogTitle: pass,
    DialogTrigger: pass,
  }
})

const { RunResultDialog } = await import('./run-result-dialog')

const run = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  jobId: 'job-1',
  startedAt: '2026-10-14T10:00:00Z',
  status: 'completed',
  ...over,
})

const markup = (
  over: Record<string, unknown> = {},
  props: Record<string, unknown> = {},
) =>
  renderToStaticMarkup(
    createElement(
      RunResultDialog as never,
      {
        run: run(over),
        onOpenChange: () => {},
        ...props,
      } as never,
    ),
  )

describe('runResultDialogContract', () => {
  it('answers nothing for a null run', () => {
    const m = renderToStaticMarkup(
      createElement(
        RunResultDialog as never,
        {
          run: null,
          onOpenChange: () => {},
        } as never,
      ),
    )
    expect(m).toBe('')
  })

  it('answers the header with the status icon, the job name or its fallback, the timestamp and the duration', () => {
    const completed = markup({}, { jobName: 'Morning digest' })
    expect(completed).toContain('lucide-circle-check')
    expect(completed).toContain('text-green-500')
    expect(completed).toContain('Morning digest')
    expect(completed).toContain('Oct 14, 2026, 10:00 AM')

    const failed = markup({ status: 'failed' })
    expect(failed).toContain('lucide-circle-x')
    expect(failed).toContain('text-destructive')

    const live = markup({ status: 'running' }, {})
    expect(live).toContain('lucide-loader-circle')
    expect(live).toContain('Run Result')
    expect(live).toContain('Still running')

    const timed = markup({ completedAt: '2026-10-14T10:02:05Z' })
    expect(timed).toContain('2m 5s')
  })

  it('answers the failed card, the rendered result and the no-result note by branch', () => {
    const failed = markup({ status: 'failed', result: 'The tool crashed' })
    expect(failed).toContain('Task failed')
    expect(failed).toContain('The tool crashed')
    expect(failed).toContain('lucide-circle-alert')

    // The completed result renders through the MessageResponse markdown
    // machinery, whose content arrives async - only the branch itself is
    // statically visible, pinned by its wrapper class.
    const done = markup({ result: 'All done' })
    expect(done).toContain('prose prose-sm')

    const bare = markup({ result: undefined })
    expect(bare).toContain('No result available')
  })

  it('answers the footer gated: Cancel on running, Retry on failed, Copy on any result, Close always', () => {
    const live = markup(
      { status: 'running' },
      { onCancelRun: () => {}, onRetryRun: () => {} },
    )
    expect(live).toContain('Cancel')
    expect(live).toContain('lucide-square')
    expect(live).not.toContain('Retry')

    const failed = markup(
      { status: 'failed' },
      { onCancelRun: () => {}, onRetryRun: () => {} },
    )
    expect(failed).toContain('Retry')
    expect(failed).toContain('lucide-rotate-ccw')
    expect(failed).not.toContain('Cancel')

    const noHandlers = markup({ status: 'running' })
    expect(noHandlers).not.toContain('Cancel')
    expect(noHandlers).not.toContain('Retry')

    const withResult = markup({ result: 'x' })
    expect(withResult).toContain('Copy')
    expect(withResult).not.toContain('Copied')
    const bare = markup({})
    expect(bare).not.toContain('Copy')
    expect(bare).toContain('Close')
  })
})
