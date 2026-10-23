// One local Queen actor: load the spec catalog, print the scheduler view.
// Verifiable: prints real card counts read from the real t27 spec corpus
// through the t27 compiler wasm — the same code path the deployed Queen uses.
import { loadSpecCatalog } from './inngest/spec-catalog'

async function main() {
  const cat = await loadSpecCatalog()
  console.log('=== T27 OS local Queen actor (verifiable run) ===')
  console.log(`scheduler pin: ${cat.pin || '(none)'}`)
  console.log(`cron cards:    ${cat.crons.length} served, ${cat.refused.length} refused`)
  console.log(`skill cards:   ${cat.skills.length} served, ${cat.refused.length} refused total`)
  const hosts = new Map<string, number>()
  for (const c of cat.crons) hosts.set(c.host, (hosts.get(c.host) ?? 0) + 1)
  console.log('hosts:', [...hosts.entries()].map(([h, n]) => `${h}=${n}`).join(' '))
  const first = cat.crons[0]
  if (first) console.log(`first card: ${first.id} host=${first.host} schedule=${first.schedule}`)
  if (cat.refused.length) console.log('refused:', cat.refused.map((r: any) => r.file).join(', '))
  console.log('=== OK: the Queen reads the real spec corpus through the t27 wasm compiler ===')
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
