import { setTimeout as sleep } from 'node:timers/promises'
import type pg from 'pg'
import { createPool, migrate } from '../db/database.ts'
import { seed } from '../db/seed.ts'

// With --wait, retries the connection while a freshly started Postgres is still booting
async function waitForDatabase(pool: pg.Pool, timeout = 30_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      await pool.query('select 1')
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(500)
    }
  }
}

const pool = createPool(process.env.DATABASE_URL)
try {
  if (process.argv.includes('--wait')) await waitForDatabase(pool)
  await migrate(pool)
  const inserted = await seed(pool)
  console.log(
    inserted.length ? `CV importés : ${inserted.join(', ')}.` : 'aucun nouveau CV à importer.',
  )
} finally {
  await pool.end()
}
