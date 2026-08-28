#!/usr/bin/env node
import { runWorkflowCli } from './adapters/cli/index.js'

process.exitCode = await runWorkflowCli()
