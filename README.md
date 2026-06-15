# pi-tool-swap

Pi extension that transparently swaps `grep → rg` and `find → fd` on every bash tool call, with automatic fallback when the faster tool fails.

## How it works

- **`tool_call`**: rewrites bash commands at command-start boundaries, `grep` becomes `(rg <args> 2>/dev/null) || (grep <args>)`, `find` becomes `(fd <args> 2>/dev/null) || (find <args>)`
- **`tool_result`**: injects `[tool-swap: grep → rg]` or `[tool-swap: find → fd]` annotation so LLMs learn the preferred tool
- **Skips**: piped-to/from greps, `find -exec`/`-execdir` (not translatable)
- **Startup**: logs whether `fd`/`rg` on PATH; disables silently if missing

## Fallback on failure

If `rg` exits 2 (regex parse error) or exits 1 with no output (Rust regex mismatch), the original `grep` runs as the right side of `||`. Same for `fd` → `find`.
