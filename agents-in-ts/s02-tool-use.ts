import Anthropic from "@anthropic-ai/sdk"
import dotenv from "dotenv"
import { execSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

dotenv.config({ path: "../.env" })

const WORKDIR = process.cwd()
const DANGEROUS = ["rm -rf", "sudo", "shutdown", "reboot", "> /dev/"]

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  apiKey: process.env.ANTHROPIC_API_KEY || "",
})
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use bash to solve tasks. Act, don't explain.`

const TOOL_HANDLERS = {
  bash: (kw: any) => runBash(kw.command),
  read_file: (kw: any) => runRead(kw.path, kw.limit),
  write_file: (kw: any) => runWrite(kw.path, kw.content),
  edit_file: (kw: any) => runEdit(kw.path, kw.old_text, kw.new_text),
}

async function safePath(p: string) {
  const resolved = path.resolve(WORKDIR, p)
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workdir: ${p}; resolve: ${resolved}; WORKDIR: ${WORKDIR}`)
  }

  return resolved
}

async function runRead(p: string, limit: number) {
  const text = (await readFile(await safePath(p))).toString()
  let lines = text.split(/\n|\r\n/)

  if (limit && lines.length > limit) {
    lines = lines.slice(0, limit)
  }

  return lines.join("\n").slice(0, 50000)
}

async function runBash(command: string) {
  if (DANGEROUS.some((d) => command.includes(d))) {
    return `Dangerous command: ${command}`
  }

  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    })

    return output ? output.slice(0, 50000) : "(no output)"
  } catch (err) {
    const output = ((err.stdout || "") + (err.stderr || "")).trim()
    return (output || `Error: ${err.message}`).slice(0, 50000)
  }
}

async function runWrite(p: string, content: string): Promise<string> {
  try {
    const fp = await safePath(p)
    await mkdir(path.dirname(fp), { recursive: true })
    await writeFile(fp, content)
    return `Wrote ${content.length} bytes to ${p}`
  } catch (err) {
    return `Error when runWrite: ${err}`
  }
}

async function runEdit(p: string, oldText: string, newText: string): Promise<string> {
  try {
    const fp = await safePath(p)
    const content = await readFile(fp, { encoding: "utf-8" })
    if (!content.includes(oldText)) {
      return `Err when runEdit: Old text not included`
    }
    await writeFile(fp, content.replace(oldText, newText))
    return `Edited ${p}`
  } catch (err) {
    return `Err when runEdit: ${err}`
  }
}
