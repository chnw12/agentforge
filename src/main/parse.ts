/** Extract displayable text + final answer from one JSONL line of either CLI. */
export function parseEvent(agent: 'claude' | 'codex', line: string): { show?: string; final?: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let j: any
  try {
    j = JSON.parse(line)
  } catch {
    return { show: line }
  }
  if (agent === 'claude') {
    if (j.type === 'assistant') {
      const parts = (j.message?.content ?? []) as { type: string; text?: string; name?: string }[]
      const text = parts.map((c) => (c.type === 'text' ? c.text : c.type === 'tool_use' ? `[tool] ${c.name}` : '')).filter(Boolean).join('\n')
      return text ? { show: text } : {}
    }
    if (j.type === 'result') return { final: typeof j.result === 'string' ? j.result : '', show: j.is_error ? '[error] ' + (j.result ?? '') : undefined }
    return {}
  }
  const item = j.item
  if (j.type === 'item.completed' && item?.type === 'agent_message') return { show: item.text, final: item.text }
  if (j.type === 'item.completed' && item?.type === 'command_execution') return { show: `[cmd] ${item.command}` }
  if (j.type === 'error' || j.type === 'turn.failed') return { show: '[error] ' + JSON.stringify(j.error ?? j.message ?? j).slice(0, 400) }
  return {}
}

/** Last explicit verdict in an agent answer, or null. Anything ambiguous must be treated as not-PASS by callers. */
export function verdictOf(text: string): 'PASS' | 'FAIL' | null {
  const all = [...text.matchAll(/VERDICT:\s*\**\s*(PASS|FAIL)\b/gi)]
  const last = all[all.length - 1]
  return last ? (last[1]!.toUpperCase() as 'PASS' | 'FAIL') : null
}
