#!/usr/bin/env node
// Stop a build before a privileged JWT is embedded in a browser bundle.
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
if (!key) process.exit(0) // CI can build the disconnected UI without credentials.
if (key.startsWith('sb_publishable_')) process.exit(0)

let role
try {
  role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role
} catch {
  role = undefined
}
if (role !== 'anon') {
  console.error('NEXT_PUBLIC_SUPABASE_ANON_KEY must be a publishable or anon key; refusing privileged/unknown key')
  process.exit(1)
}
