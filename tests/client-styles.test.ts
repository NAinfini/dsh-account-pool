import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PAGE_CSS } from '../src/client/styles.ts'

/** Selectors of every rule, including those nested in @media blocks. */
function selectors(css: string): string[] {
  const found: string[] = []
  const rule = /([^{}@]+)\{[^{}]*\}/g
  for (const match of css.matchAll(rule)) {
    for (const selector of (match[1] ?? '').split(',')) found.push(selector.trim())
  }
  return found
}

test('every selector is scoped to the dap- prefix so nothing leaks into the host app', () => {
  const all = selectors(PAGE_CSS)
  assert.ok(all.length > 50)
  const stray = all.filter((selector) => !/^\.dap-[A-Za-z]+/.test(selector))
  assert.deepEqual(stray, [])
})

test('no rule restyles global elements or sets colours outside the harness tokens', () => {
  assert.doesNotMatch(PAGE_CSS, /(^|[,{}\s])(html|body|:root)\s*[{,]/)
  assert.doesNotMatch(PAGE_CSS, /position:\s*fixed/)
})
