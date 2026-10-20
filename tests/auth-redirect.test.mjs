import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Studio usa su propio retorno de autenticación y no el dominio de ProMax', async () => {
  const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
  assert.match(source, /VITE_STUDIO_AUTH_REDIRECT_URL/)
  assert.match(source, /https:\/\/bingopromaxstudio\.pages\.dev/)
  assert.match(source, /emailRedirectTo: STUDIO_AUTH_REDIRECT_URL/)
  assert.doesNotMatch(source, /emailRedirectTo: window\.location\.origin/)
})
