import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SWAP_DISPLAY_PREFIX = "[tool-swap: ";

const pendingSwaps = new Map<string, string>();

interface BinaryStatus {
  fd: boolean;
  rg: boolean;
}

function checkBinaries(): BinaryStatus {
  const fdOk = spawnSync("which", ["fd"], { stdio: "ignore" }).status === 0;
  const rgOk = spawnSync("which", ["rg"], { stdio: "ignore" }).status === 0;
  return { fd: fdOk, rg: rgOk };
}

let binaries: BinaryStatus = { fd: false, rg: false };

let swapCount = 0;

export default function toolSwapExtension(pi: ExtensionAPI) {
  binaries = checkBinaries();

  const available = [binaries.fd ? "fd" : null, binaries.rg ? "rg" : null]
    .filter(Boolean)
    .join(", ");

  if (!available) {
    console.error(
      "[tool-swap] WARNING: neither fd nor rg found on PATH — extension disabled",
    );
    return;
  }

  console.error(`[tool-swap] active: swapping for ${available}`);

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;

    const original = event.input.command as string;
    const result = rewriteCommand(event.toolCallId, original);

    if (!result) return;

    event.input.command = result.command;
    pendingSwaps.set(event.toolCallId, result.label);
    swapCount++;
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash") return;

    const label = pendingSwaps.get(event.toolCallId);
    if (!label) return;
    pendingSwaps.delete(event.toolCallId);

    const annotation = `${SWAP_DISPLAY_PREFIX}${label}]`;
    const taggedContent = event.content.map((block) => {
      if (block.type !== "text") return block;
      return { ...block, text: `${annotation}\n${block.text}` };
    });

    return { content: taggedContent };
  });

  pi.on("session_start", async (_event, ctx) => {
    const summary = Object.entries(binaries)
      .filter(([, ok]) => ok)
      .map(([name]) => name)
      .join(", ");
    ctx.ui.notify(`[tool-swap] active: ${summary}`, "info");
  });
}

interface RewriteResult {
  command: string;
  label: string;
}

function rewriteCommand(toolCallId: string, command: string): RewriteResult | null {
  const grepResult = rewriteGrep(command);
  if (grepResult) return grepResult;

  const findResult = rewriteFind(command);
  if (findResult) return findResult;

  return null;
}

function rewriteGrep(command: string): RewriteResult | null {
  if (!binaries.rg) return null;

  const trimmed = command.trimStart();

  const grepIdx = findCommandStart(trimmed, "grep");
  if (grepIdx < 0) return null;

  if (isPipedFromOrTo(trimmed, grepIdx, "grep")) return null;

  const before = command.slice(0, command.length - trimmed.length + grepIdx);
  const grepArgs = trimmed.slice(grepIdx + "grep".length);
  const rest = grepArgs.startsWith(" ") ? grepArgs.slice(1) : grepArgs;

  return {
    command: `${before} (rg ${rest} 2>/dev/null) || (grep ${rest})`,
    label: "grep → rg",
  };
}

function rewriteFind(command: string): RewriteResult | null {
  if (!binaries.fd) return null;

  const trimmed = command.trimStart();

  const findIdx = findCommandStart(trimmed, "find");
  if (findIdx < 0) return null;

  if (isPipedFromOrTo(trimmed, findIdx, "find")) return null;

  if (trimmed.includes("-exec")) return null;
  if (trimmed.includes("-execdir")) return null;

  const before = command.slice(0, command.length - trimmed.length + findIdx);
  const findArgs = trimmed.slice(findIdx + "find".length);
  const rest = findArgs.startsWith(" ") ? findArgs.slice(1) : findArgs;

  const translated = translateFindToFd(rest);

  return {
    command: `${before} (${translated} 2>/dev/null) || (find ${rest})`,
    label: "find → fd",
  };
}

function translateFindToFd(args: string): string {
  const parts = parseShellWords(args);
  const paths: string[] = [];
  const fdArgs: string[] = ["fd"];

  let hasType = false;

  let i = 0;
  while (i < parts.length) {
    const part = parts[i];

    if (part === "-name") {
      i++;
      if (i < parts.length) {
        const glob = stripShellQuotes(parts[i]);
        fdArgs.push("--glob");
        fdArgs.push(glob);
      }
      i++;
      continue;
    }

    if (part === "-iname") {
      i++;
      if (i < parts.length) {
        const glob = stripShellQuotes(parts[i]);
        fdArgs.push("--glob");
        fdArgs.push(glob);
        fdArgs.push("--ignore-case");
      }
      i++;
      continue;
    }

    if (part === "-type") {
      hasType = true;
      i++;
      if (i < parts.length) {
        fdArgs.push("--type");
        fdArgs.push(parts[i]);
      }
      i++;
      continue;
    }

    if (part === "-maxdepth") {
      i++;
      if (i < parts.length) {
        fdArgs.push("--max-depth");
        fdArgs.push(parts[i]);
      }
      i++;
      continue;
    }

    if (part === "-mindepth") {
      i++;
      if (i < parts.length) {
        fdArgs.push("--min-depth");
        fdArgs.push(parts[i]);
      }
      i++;
      continue;
    }

    if (!part.startsWith("-") && !hasPathFlag(part)) {
      paths.push(part);
    }

    i++;
  }

  if (!hasType) {
    fdArgs.push("--type");
    fdArgs.push("f");
  }

  if (paths.length === 0) paths.push(".");

  return [...fdArgs, ...paths].join(" ");
}

function findCommandStart(cmd: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\s)${escaped}(?=\\s|/.|$)`);
  const match = cmd.match(re);
  return match ? match.index! + match[0].indexOf(name) : -1;
}

function isPipedFromOrTo(cmd: string, cmdStart: number, name: string): boolean {
  if (cmdStart > 0 && cmd.slice(0, cmdStart).trimEnd().endsWith("|")) return true;
  const after = cmd.slice(cmdStart + name.length);
  const nextPipe = after.indexOf("|");
  if (nextPipe >= 0 && after.slice(0, nextPipe).trim() === "") return true;
  return false;
}

function parseShellWords(args: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (const ch of args) {
    if (inSingle) {
      if (ch === "'") { inSingle = false; continue; }
      current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') { inDouble = false; continue; }
      current += ch;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === " ") {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function stripShellQuotes(s: string): string {
  if (s.length >= 2) {
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function hasPathFlag(part: string): boolean {
  return part.startsWith("-");
}
