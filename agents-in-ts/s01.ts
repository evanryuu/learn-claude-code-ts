import { execSync } from "child_process"
import { Anthropic } from "@anthropic-ai/sdk"
import dotenv from "dotenv"
import { MessageParam, ToolUnion } from "@anthropic-ai/sdk/resources"
import { createInterface } from "readline/promises"
import chalk from "chalk"

dotenv.config({ path: "../.env" })

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  apiKey: process.env.ANTHROPIC_API_KEY || "",
})
const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`

const TOOLS: ToolUnion[] = [
  {
    name: "bash",
    description: "Run a bash command",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
]

const DANGEROUS = ["rm -rf", "sudo", "shutdown", "reboot", "> /dev/"]

function runBash(command: string) {
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

async function agentLoop(messages: MessageParam[] = []) {
  while (true) {
    const response = await client.messages.create({
      messages,
      system: SYSTEM,
      max_tokens: 8000,
      model: process.env.MODEL_ID as string,
      tools: TOOLS,
    })

    messages.push({ role: "assistant", content: response.content })

    if (response.stop_reason != "tool_use") {
      return
    }

    const results = []
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(chalk.yellow(`$ ${(block.input as { command: string }).command}`))
        const output = runBash((block.input as { command: string }).command)
        console.log(output.slice(0, 200))
        results.push({ type: "tool_result" as const, tool_use_id: block.id, content: output })
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
    try {
      const query = await rl.question(chalk.blue("s01: "))
      if (["q", "exit", ""].includes(query.trim().toLowerCase())) break
      history.push({ role: "user", content: query })
      await agentLoop(history)
      const response_content = history.at(-1)?.content
      if (response_content && typeof response_content !== "string") {
        for (const block of response_content) {
          if (block.type === "thinking") {
            console.log(chalk.blueBright(block.thinking))
          } else if (block.type === "text") {
            console.log(chalk.gray(block.text))
          }
        }
      }
    } catch (err) {
      console.log(err)
      break
    }
  }
}

main()
