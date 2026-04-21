import { shellQuote } from "@/common/utils/shell";

// Keep the frontend's synthetic-server detection and the backend's synthesized
// MCP command string on the exact same quoting path.
export function buildSyntheticCustomToolCommand(command: string, args?: string[]): string {
  return [command, ...(args ?? [])].map((arg) => shellQuote(arg)).join(" ");
}
