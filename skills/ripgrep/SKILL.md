---
name: ripgrep
description: Master reference for using ripgrep (rg) optimally from the command line and in scripts. Use this skill whenever you need to search file contents, find patterns across codebases, filter by file types, use advanced regex, search compressed files, build complex grep pipelines, or optimize search performance. Trigger on: 'rg', 'ripgrep', 'search for pattern', 'find in files', 'grep across', 'search codebase', 'content search', 'regex search', 'find all occurrences', 'search logs', or any task involving searching text across files. Also use when building CLI tools or scripts that need fast file content search, or when the user asks how to find something in their filesystem.
---


# Ripgrep (rg) — Master Skill

ripgrep 14.1.0 is installed at `/usr/bin/rg` with PCRE2 + JIT support.

## Mental Model

rg is a recursive regex search tool that:
1. **Respects .gitignore** by default — it skips what git skips
2. **Skips hidden files and binary files** by default
3. **Uses parallelism** by default — results are fast but unordered
4. **Uses Rust's regex engine** by default — fast, safe, no backtracking, but no lookaround

The core command: `rg PATTERN [PATH]` — searches PATH (default: `.`) recursively for PATTERN.

## Quick Reference — Most Useful Flags

### Filtering WHAT to search
| Flag | Purpose |
|------|---------|
| `-t TYPE` | Only search files of TYPE (e.g., `-tpy`, `-tjs`, `-tmd`) |
| `-T TYPE` | Exclude files of TYPE |
| `-g 'GLOB'` | Only search files matching glob (e.g., `-g '*.toml'`) |
| `-g '!GLOB'` | Exclude files matching glob |
| `--type-list` | Show all built-in file types and their globs |
| `--type-add 'name:*.ext'` | Define a custom file type for this invocation |

### Controlling HOW to match
| Flag | Purpose |
|------|---------|
| `-i` | Case-insensitive |
| `-S` / `--smart-case` | Case-insensitive if pattern is all lowercase, sensitive otherwise |
| `-w` | Match whole words only (`\bPATTERN\b`) |
| `-F` | Treat pattern as fixed/literal string (no regex) |
| `-x` | Match entire lines only |
| `-v` | Invert match (lines that DON'T match) |
| `-e PATTERN` | Explicit pattern (use when pattern starts with `-`) |
| `-f FILE` | Read patterns from file, one per line |
| `-P` | Use PCRE2 engine (enables lookaround, backreferences) |
| `-U` | Multiline mode (patterns can span line boundaries) |

### Controlling WHAT to output
| Flag | Purpose |
|------|---------|
| `-l` | List filenames only (files with matches) |
| `-c` / `--count` | Count of matching lines per file |
| `--count-matches` | Count of individual matches per file (not lines) |
| `-o` | Show only the matched text, not the full line |
| `-r 'REPLACEMENT'` | Replace matched text in output (does NOT modify files) |
| `-A N` | Show N lines after each match |
| `-B N` | Show N lines before each match |
| `-C N` | Show N lines before and after each match |
| `-n` | Show line numbers (default when output is a terminal) |
| `-N` | Suppress line numbers |
| `-H` | Show filenames (default in multi-file search) |
| `--no-filename` | Suppress filenames |
| `--json` | Machine-readable JSON output |
| `-m N` / `--max-count N` | Stop searching a file after N matches |
| `--max-columns N` | Truncate lines longer than N columns |
| `--max-columns-preview` | Show `[... snip]` for truncated lines |
| `--passthru` | Print all lines, highlighting matches |
| `--vimgrep` | Output in vim-compatible format (file:line:col:match) |

### Controlling search scope
| Flag | Purpose |
|------|---------|
| `-u` | Unrestricted: don't respect .gitignore |
| `-uu` | Also search hidden files |
| `-uuu` | Also search binary files (fully unrestricted) |
| `--hidden` / `-H` (no, use `--hidden`) | Search hidden files/dirs |
| `-L` / `--follow` | Follow symbolic links |
| `-z` / `--search-zip` | Search inside compressed files (gz, bz2, xz, lz4, zstd, br) |
| `--no-ignore` | Ignore all ignore files (.gitignore, .ignore, .rgignore) |
| `--max-depth N` | Limit directory recursion depth |
| `--max-filesize SIZE` | Skip files larger than SIZE (e.g., `1M`, `500K`) |
| `--one-file-system` | Don't cross filesystem boundaries |
| `--binary` | Search binary files (but still stop at first match) |
| `-a` / `--text` | Treat binary files as text (search everything) |

### Performance & ordering
| Flag | Purpose |
|------|---------|
| `-j N` / `--threads N` | Number of threads (default: auto) |
| `--sort path` | Sort results by path (disables parallelism) |
| `--sortr path` | Reverse sort by path |
| `--sort modified` | Sort by modification time |
| `--dfa-size-limit SIZE` | Increase DFA cache for large pattern files |

## Regex Syntax (Default Engine)

The default engine is Rust's `regex` crate — fast, safe, guaranteed O(m*n).

### Basics
```
.           any char (except \n unless -U or (?s))
\d \D       digit / non-digit (Unicode-aware)
\w \W       word char / non-word (Unicode-aware)
\s \S       whitespace / non-whitespace (Unicode-aware)
\b \B       word boundary / non-boundary
^ $         start / end of line (with -U or (?m), per-line)
\A \z       absolute start / end of input
```

### Quantifiers
```
*  +  ?           greedy (zero+, one+, zero-or-one)
*? +? ??          lazy variants
{n} {n,m} {n,}    exact, range, minimum
```

### Groups & alternation
```
(expr)            capturing group
(?:expr)          non-capturing group
(?P<name>expr)    named capture group
a|b               alternation
```

### Character classes
```
[abc]       union
[^abc]      negation
[a-z]       range
[a-z&&[^q]] intersection (a-z except q)
[[:alpha:]] POSIX class (ASCII)
\p{Greek}   Unicode script
\p{Lu}      Unicode category (uppercase letter)
```

### Inline flags
```
(?i)        case-insensitive
(?m)        multiline (^ $ match line boundaries)
(?s)        dotall (. matches \n)
(?x)        verbose mode (whitespace ignored, # comments)
(?-u:expr)  disable Unicode for this group (match raw bytes)
```

### What the default engine CANNOT do
- No lookahead/lookbehind (`(?=...)`, `(?!...)`, `(?<=...)`, `(?<!...)`)
- No backreferences (`\1`)
- Use `-P` (PCRE2) for these — see PCRE2 section below

## PCRE2 Mode (`-P`)

Enables full Perl-compatible regex:
```
(?=expr)    positive lookahead
(?!expr)    negative lookahead
(?<=expr)   positive lookbehind
(?<!expr)   negative lookbehind
\1          backreference to group 1
(?(1)y|n)   conditional pattern
```

**Performance notes for PCRE2:**
- Slower than default engine — only use when you need lookaround/backreferences
- Forces line-by-line search (can't use literal optimizations as aggressively)
- Requires valid UTF-8 (transcodes files, adding overhead)
- For speed with `-P`: combine with `-U` (multiline) and `--no-pcre2-unicode`
- JIT is available on this system, which helps significantly

## Replacement (`-r`)

Replacement modifies **output only** — never modifies files.

```bash
# Simple replacement
rg 'foo' -r 'bar'

# Show only matched text, replaced
rg 'foo' -or 'bar'

# Capture group references
rg '(\w+)@(\w+)' -r '$1 AT $2'
rg '(?P<user>\w+)@(?P<domain>\w+)' -r '$user AT $domain'

# Whole match reference
rg 'pattern' -r 'found: $0'
```

## Common Patterns & Recipes

### Search patterns
```bash
# Literal string (no regex interpretation)
rg -F 'function(x, y)'

# Case-insensitive whole word
rg -iw 'error'

# Multiple patterns (OR logic)
rg -e 'pattern1' -e 'pattern2'

# Patterns from file
rg -f patterns.txt

# Fixed strings from file (one per line)
rg -Ff strings.txt

# Multiline pattern (e.g., function spanning lines)
rg -U 'fn \w+\(.*\n.*\{' -trs

# Negated search (lines NOT matching)
rg -v 'DEBUG'
```

### File filtering
```bash
# Python files only
rg 'import' -tpy

# Multiple types
rg 'TODO' -tpy -tjs -tts

# Exclude test files
rg 'class' -g '!*test*' -g '!*spec*'

# Only in specific directory
rg 'pattern' src/

# Files matching multiple globs
rg 'pattern' -g '*.{ts,tsx,js,jsx}'
```

### Output shaping
```bash
# Just filenames
rg -l 'TODO'

# Count per file
rg -c 'TODO' --sort-files

# Only the matched text
rg -o '\b\w+Error\b'

# With context
rg -C3 'panic'

# JSON output for scripting
rg --json 'pattern' | jq '.data.lines.text'

# Pipe-friendly: no color, no line numbers
rg --no-line-number --no-filename --color never 'pattern'
```

### Advanced recipes
```bash
# Search compressed log files
rg -z 'ERROR' /var/log/*.gz

# Search with preprocessor (PDFs)
rg --pre 'pdftotext' --pre-glob '*.pdf' 'search term'

# Unicode: find non-ASCII characters
rg '[^\x00-\x7F]'

# Find files that do NOT contain a pattern
rg -L 'pattern'   # --files-without-match

# Lookahead with PCRE2: word followed by specific word
rg -P 'error(?=.*critical)'

# Search stdin
echo "hello world" | rg 'world'
cat file.txt | rg 'pattern'

# Sorted results (deterministic, but slower)
rg --sort path 'pattern'

# Limit search depth
rg --max-depth 2 'pattern'

# Debug: see which files are searched/skipped and why
rg --debug 'pattern' 2>&1 | head -50
```

## Ignore File Hierarchy

Precedence (highest to lowest):
1. Command-line flags (`-g`, `-t`, `-u`)
2. `.rgignore` (ripgrep-specific)
3. `.ignore` (universal)
4. `.gitignore` (git-specific)

Each directory can have its own ignore files. Child directory ignore files override parent.

Use `!pattern` in any ignore file to un-ignore (whitelist) a previously ignored pattern.

## Configuration File

Set `RIPGREP_CONFIG_PATH` to a file path. Format:
```
# One flag per line
--smart-case
--hidden
--glob=!.git/*
--max-columns=150
--max-columns-preview
```

Command-line flags always override config. Use `--no-config` to disable.

## Performance Tips

1. **Let rg choose threads** — the default is already optimal for most systems
2. **Use literal strings when possible** — `rg -F 'exact string'` is fastest
3. **Narrow scope early** — `-t`, `-g`, and path arguments reduce work
4. **Avoid `-P` unless needed** — PCRE2 is 2-10x slower than default engine
5. **Use `--max-count 1`** when you only need to know IF a pattern exists
6. **Use `-l`** when you only need filenames, not matched content
7. **Large pattern files** — increase `--dfa-size-limit` (e.g., `--dfa-size-limit 1G`)
8. **Sorted output costs parallelism** — only use `--sort` when order matters
9. **Memory-mapped I/O** — rg auto-selects; use `--no-mmap` if searching huge files with binary detection issues

## Gotchas & Edge Cases

- **Results are unordered by default** — parallelism means different runs may show files in different order
- **`-u` flags stack**: `-u` = ignore .gitignore, `-uu` = +hidden, `-uuu` = +binary
- **`--hidden` is NOT `-H`** — `-H` is `--with-filename` (confusing overlap with other tools)
- **Glob `-g` uses gitignore syntax**, not shell glob syntax (e.g., `**/` for recursive)
- **`-z` only decompresses single files**, not archives (no `.tar.gz` directory walking)
- **Empty pattern matches every line** — be careful with `-f` files containing blank lines
- **`.` does NOT match `\n`** unless you use `-U` (multiline) or `(?s)` flag
- **Word boundary `\b` is Unicode-aware** — may not match what you expect at ASCII boundaries; use `(?-u:\b)` for ASCII-only word boundaries

## Reference Files

For deeper dives, read the reference files in this skill's `references/` directory:
- `references/file-types.md` — Complete list of built-in file types and their glob patterns
- `references/regex-deep-dive.md` — Full regex syntax with Unicode categories and advanced patterns
