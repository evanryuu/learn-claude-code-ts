import Anthropic from "@anthropic-ai/sdk"
import { MessageParam, ToolUnion } from "@anthropic-ai/sdk/resources"
import chalk from "chalk"
import dotenv from "dotenv"
import { execSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline/promises"

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

const tools: ToolUnion[] = [
  {
    name: "bash",
    description: "Run a bash command",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read a file content",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "write_file",
    description: "Write content into a file",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
    },
  },
  {
    name: "edit_file",
    description:
      "Modify existing content with new content in existing file. If existing content does not exist or can not math, new content will not be written into the target file",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
        },
        old_text: {
          type: "string",
        },
        new_text: {
          type: "string",
        },
      },
    },
  },
]

async function safePath(p: string) {
  const resolved = path.resolve(WORKDIR, p)
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workdir: ${p}; resolve: ${resolved}; WORKDIR: ${WORKDIR}`)
  }

  return resolved
}

async function runRead(p: string, limit: number) {
  const text = (await readFile(await safePath(p))).toString()
  let lines = text.split(/\r\n|\n/)

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
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const output = ((e.stdout || "") + (e.stderr || "")).trim()
    return (output || `Error: ${e.message}`).slice(0, 50000)
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

async function agentLoop(messages: MessageParam[]) {
  while (true) {
    const response = await client.messages.create({
      messages,
      system: SYSTEM,
      model: process.env.MODEL_ID!,
      max_tokens: 8000,
      tools,
    })

    messages.push({ role: "assistant", content: response.content })

    for (const block of response.content) {
      if (block.type === "thinking") console.log(chalk.greenBright(block.thinking))
      else if (block.type === "text") console.log(chalk.gray(block.text))
    }

    if (response.stop_reason !== "tool_use") {
      return messages
    }

    const results = []
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const method = block.name as keyof typeof TOOL_HANDLERS
        const handler = TOOL_HANDLERS[method]
        console.log(chalk.yellow(`→ ${block.name}`), block.input)
        const res = await handler(block.input)
        console.log(chalk.cyan("←"), res.slice(0, 200))
        results.push({ type: "tool_result" as const, tool_use_id: block.id, content: res })
      }
    }
    messages.push({ role: "user", content: results })
  }
}

async function main() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const history: MessageParam[] = []

  while (true) {
    const question = await rl.question(chalk.blue("s02: "))
    if (["exit", "q"].includes(question.trim().toLowerCase())) break
    const message: MessageParam = {
      role: "user",
      content: question,
    }

    history.push(message)
    await agentLoop(history)
  }
}

main()
