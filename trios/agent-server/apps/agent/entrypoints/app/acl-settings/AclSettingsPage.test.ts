/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The ACL settings page, held against its contract
 * (gHashTag/trios#1644): the single export of
 * entrypoints/app/acl-settings/AclSettingsPage.tsx - AclSettingsPage -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * renderToStaticMarkup never runs effects, so the page answers in its
 * initial state - an empty rule list - and that is the whole static
 * surface: the header, the Add Rule button, and the empty state with
 * its guidance and the first-rule button. Not pinned: the rule list
 * (it arrives through the storage watch the effect installs), the
 * server bootstrap, the save/toggle/delete handlers, and the toast -
 * effects and event handlers do not run in a static render.
 *
 * The seams, each registered before this suite imports anything, so the
 * file order of the group cannot change what the subject binds:
 * - the virtual `#imports` module (WXT's bundler alias, which bun does
 *   not resolve) is stubbed with the storage item factory the
 *   repository's other store shims use;
 * - the agent-server URL hook answers the same null base the
 *   NewProviderDialog and file-preview-sheet suites stub it with
 *   (isLoading false is falsy the same way their absent field is);
 * - the dialog kit, because the group's other suites register their own
 *   stand-ins whose closed root swallows the trigger's subtree with it
 *   (open ? children : null), and in the CI readdir order this page
 *   bound one of those and both Add buttons vanished - measured in the
 *   first push of this PR. This suite's own stand-in keeps the trigger
 *   visible (the root and trigger pass children through) and the
 *   content empty (a static render never opens a controlled dialog).
 */
import { describe, expect, it, mock } from 'bun:test'
import {
  Children,
  createElement,
  type FC,
  isValidElement,
  type ReactNode,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const passChildren =
  (): FC<{ children?: ReactNode }> =>
  ({ children }) =>
    createElement('div', null, children)

const values = new Map<string, unknown>()

mock.module('#imports', () => ({
  storage: {
    defineItem: (
      key: string,
      options?: { fallback?: unknown } & Record<string, unknown>,
    ) => ({
      getValue: async () => {
        if (values.has(key)) return values.get(key)
        return options && 'fallback' in options ? options.fallback : null
      },
      setValue: async (value: unknown) => {
        values.set(key, value)
      },
      watch: () => () => {},
    }),
  },
}))

mock.module('@/lib/browseros/useBrowserOSProviders', () => ({
  useAgentServerUrl: () => ({ baseUrl: null, isLoading: false }),
}))

mock.module('@/components/ui/dialog', () => {
  const pass = passChildren()
  const Trigger = pass
  const Portal = pass
  const Overlay = () => null
  // The root keeps the trigger's subtree alive while the dialog is
  // closed - the group's other stand-ins answer open ? children : null,
  // which swallows the page's Add buttons with it - and hides
  // everything else, so a closed dialog without a trigger still
  // answers nothing for every consumer of this registration.
  const Root = ({
    open,
    children,
  }: {
    open?: boolean
    children?: ReactNode
  }) => {
    const keep = Children.toArray(children ?? []).filter(
      (child) =>
        isValidElement(child) &&
        (open === true ||
          child.type === Trigger ||
          child.type === Portal ||
          child.type === Overlay),
    )
    return keep.length ? createElement('div', null, keep) : null
  }
  return {
    Dialog: Root,
    DialogClose: pass,
    DialogContent: () => null,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogOverlay: Overlay,
    DialogPortal: Portal,
    DialogTitle: pass,
    DialogTrigger: Trigger,
  }
})

const { AclSettingsPage } = await import('./AclSettingsPage')

const markup = () => renderToStaticMarkup(createElement(AclSettingsPage))

describe('aclSettingsPageContract', () => {
  it('answers the page header with its description', () => {
    const m = markup()
    expect(m).toContain('ACL Rules')
    expect(m).toContain(
      'Describe what the agent should avoid on a site and BrowserOS will block matching actions.',
    )
  })

  it('answers the empty state with its guidance and both add buttons', () => {
    const m = markup()
    expect(m).toContain('No ACL rules defined')
    expect(m).toContain('payments and checkout')
    expect(m).toContain('send email')
    expect(m).toContain('Add your first rule')
    expect(m).toContain('lucide-shield-alert')
    expect((m.match(/lucide-plus/g) ?? []).length).toBe(2)
  })

  it('answers the empty state in its dashed frame', () => {
    const m = markup()
    expect(m).toContain('rounded-xl border border-dashed p-12 text-center')
  })
})
