#!/usr/bin/env node
import { main } from './cli.js'

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
