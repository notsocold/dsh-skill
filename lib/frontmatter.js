/**
 * Dependency-free YAML-subset frontmatter parsing and tolerant skill-frontmatter
 * normalization.
 *
 * The parser understands the subset ecosystem skill files actually use: `key: value`
 * lines, single/double-quoted strings (including folded continuation lines), booleans,
 * numbers, null, inline arrays/maps, simple `- item` lists, one level of nested maps,
 * block scalars (`|`, `>`, with `+`/`-` chomping) and comments. Anything outside that
 * subset is ignored, and malformed documents return `undefined` instead of throwing.
 *
 * Normalization is deliberately more tolerant than the Agent Skills specification:
 * missing or invalid names/descriptions fall back to directory/body facts and every
 * tolerated deviation is reported in `diagnostics` so the UI can explain it.
 *
 * @module dsh-skill/lib/frontmatter
 */

const MAX_SKILL_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 200
const MAX_YAML_DEPTH = 8

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const RESERVED_METADATA_KEYS = new Set([
  'name',
  'description',
  'when_to_use',
  'whenToUse',
  'when-to-use',
  'disable-model-invocation',
  'user-invocable',
  'disableModelInvocation',
  'modelInvocable',
  'userInvocable',
])

const BLOCK_SCALAR_HEADER = /^([|>])(?:(?:([1-9])([+-])?|([+-])([1-9])?))?$/u
const PLAIN_NUMBER = /^[-+]?\d+(?:\.\d+)?$/u
const SAFE_KEY = /^[^\s:#[\]{},]+$/u
const LIST_ITEM = /^-(?:[ \t]|$)/u
const DOUBLE_QUOTE_ESCAPES = Object.freeze({
  0: '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\u0085',
  _: '\u00a0',
  L: '\u2028',
  P: '\u2029',
})

/**
 * Parse leading YAML frontmatter without dependencies. Handles the common subset:
 * key: value, quoted strings, booleans/numbers, inline arrays, block scalars (|, >),
 * simple lists (- item), nested maps one level, comments. Unknown constructs are
 * ignored, never throws.
 *
 * @param {string} raw - full skill/prompt Markdown text.
 * @returns {{ data: Record<string, unknown>, body: string } | undefined} parsed
 *   frontmatter and the body after the closing fence, or `undefined` when the text
 *   has no frontmatter or the YAML block is not a mapping.
 */
export function parseFrontmatter(raw) {
  if (typeof raw !== 'string') return undefined
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
  try {
    const lines = splitLines(text)
    if (lines.length === 0) return undefined
    if (!isFence(lineText(text, lines[0]))) return undefined
    let closing
    for (let index = 1; index < lines.length; index += 1) {
      const line = lineText(text, lines[index]).trimEnd()
      if (line === '---' || line === '...') {
        closing = lines[index]
        break
      }
    }
    if (closing === undefined) return undefined
    const yaml = text.slice(lines[1].start, closing.start)
    const data = parseYamlMapping(yaml)
    if (data === undefined) return undefined
    return { data, body: text.slice(closing.next) }
  } catch {
    // The subset parser is written not to throw; this is a last-resort guard for
    // pathological input (for example enormous nesting) so callers never crash.
    return undefined
  }
}

/**
 * Kebab-case normalize a skill name (lowercase a-z0-9 + single dashes), max 64 chars.
 *
 * @param {unknown} value - candidate name (strings are the normal input; finite
 *   numbers are coerced so `name: 42` survives tolerantly).
 * @returns {string} normalized name, or `''` when nothing usable remains.
 */
export function slugifySkillName(value) {
  let text
  if (typeof value === 'string') text = value
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value)
  else return ''
  const ascii = text.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '')
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .slice(0, MAX_SKILL_NAME_LENGTH)
  return slug.replace(/-+$/u, '')
}

/**
 * Normalize frontmatter + directory/file facts into a record identity.
 *
 * Tolerant across ecosystems: a missing name falls back to `dirName`; an invalid name
 * is slugified; a missing description falls back to the first non-empty body line
 * truncated to 200 characters; both `whenToUse` and `when_to_use` are accepted;
 * invocation comes from `disable-model-invocation` / `user-invocable` (boolean or
 * string forms) plus the legacy Claude aliases (`disableModelInvocation`,
 * `modelInvocable`, `userInvocable`), which are mapped with a diagnostic rather than
 * rejected.
 *
 * @param {{ data?: Record<string, unknown>, dirName?: string, filePath?: string, body?: string }} input -
 *   parsed frontmatter plus the facts discovery knows about the file.
 * @returns {{
 *   name: string,
 *   originalName: string,
 *   description: string,
 *   whenToUse?: string,
 *   invocation: { modelInvocable: boolean, userInvocable: boolean },
 *   metadata: Record<string, unknown>,
 *   diagnostics: string[],
 * }} normalized record identity.
 */
export function normalizeSkillFrontmatter(input) {
  const source = isRecord(input) ? input : {}
  const data = isRecord(source.data) ? source.data : {}
  const dirName = typeof source.dirName === 'string' ? source.dirName : ''
  const filePath = typeof source.filePath === 'string' ? source.filePath : ''
  const body = typeof source.body === 'string' ? source.body : ''
  /** @type {string[]} */
  const diagnostics = []

  const { name, originalName } = normalizeName(data.name, dirName, filePath, diagnostics)
  const description = normalizeDescription(data.description, body, diagnostics)
  const whenToUse = normalizeWhenToUse(data, diagnostics)
  const invocation = normalizeInvocation(data, diagnostics)
  const metadata = normalizeMetadata(data)

  /** @type {{ name: string, originalName: string, description: string, whenToUse?: string,
   *           invocation: { modelInvocable: boolean, userInvocable: boolean },
   *           metadata: Record<string, unknown>, diagnostics: string[] }} */
  const result = { name, originalName, description, invocation, metadata, diagnostics }
  if (whenToUse !== undefined) result.whenToUse = whenToUse
  return result
}

// ---------------------------------------------------------------------------
// Name / description / invocation normalization
// ---------------------------------------------------------------------------

/**
 * @param {unknown} rawName - frontmatter `name` value.
 * @param {string} dirName - containing directory name.
 * @param {string} filePath - skill file path, used only for stable fallback hashes.
 * @param {string[]} diagnostics - mutable diagnostics collector.
 * @returns {{ name: string, originalName: string }}
 */
function normalizeName(rawName, dirName, filePath, diagnostics) {
  let originalName = ''
  let derived = false
  if (typeof rawName === 'string' && rawName.trim() !== '') {
    originalName = rawName.trim()
  } else if (typeof rawName === 'number' && Number.isFinite(rawName)) {
    originalName = String(rawName)
    diagnostics.push('frontmatter name is not a string; coerced to text')
  } else {
    if (rawName !== undefined && rawName !== null) {
      diagnostics.push(
        `frontmatter name has unsupported type (${describeType(rawName)}); using the directory name`,
      )
    }
    originalName = dirName
    derived = true
  }
  if (originalName === '') {
    originalName = dirName
    derived = true
  }

  let name = slugifySkillName(originalName)
  if (derived) {
    diagnostics.push(
      dirName === ''
        ? 'missing frontmatter name; generated one from the file path'
        : `missing frontmatter name; using directory name "${truncateForDiagnostic(dirName)}"`,
    )
  } else if (name === '') {
    diagnostics.push(
      `frontmatter name "${truncateForDiagnostic(originalName)}" has no usable letters or digits; using a fallback name`,
    )
  } else if (name !== originalName) {
    diagnostics.push(
      `frontmatter name "${truncateForDiagnostic(originalName)}" normalized to "${name}"`,
    )
  }

  if (name === '') name = slugifySkillName(dirName)
  if (name === '') {
    name = `skill-${hash8(originalName || dirName || filePath || 'unnamed')}`
    diagnostics.push(`could not derive a readable name; using generated name "${name}"`)
  }
  return { name, originalName }
}

/**
 * @param {unknown} rawDescription - frontmatter `description` value.
 * @param {string} body - Markdown body used by the fallback.
 * @param {string[]} diagnostics - mutable diagnostics collector.
 * @returns {string} description, possibly `''` when the body has no usable text.
 */
function normalizeDescription(rawDescription, body, diagnostics) {
  if (typeof rawDescription === 'string') return rawDescription.trim()
  if (typeof rawDescription === 'number' || typeof rawDescription === 'boolean') {
    diagnostics.push('frontmatter description is not a string; coerced to text')
    return String(rawDescription)
  }
  if (rawDescription !== undefined && rawDescription !== null) {
    diagnostics.push(
      `frontmatter description has unsupported type (${describeType(rawDescription)}); deriving from the body`,
    )
  }
  const derived = deriveDescription(body)
  if (derived !== '') {
    diagnostics.push('missing frontmatter description; derived from the first body line')
  } else {
    diagnostics.push('missing frontmatter description; body has no usable text')
  }
  return derived
}

/**
 * @param {string} body - Markdown body.
 * @returns {string} first non-empty line, truncated to the description limit.
 */
function deriveDescription(body) {
  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed.slice(0, MAX_DESCRIPTION_LENGTH)
  }
  return ''
}

/**
 * @param {Record<string, unknown>} data - parsed frontmatter.
 * @param {string[]} diagnostics - mutable diagnostics collector.
 * @returns {string | undefined} normalized `whenToUse` when present.
 */
function normalizeWhenToUse(data, diagnostics) {
  const keys = ['whenToUse', 'when_to_use', 'when-to-use']
  let selected
  let selectedKey
  for (const key of keys) {
    const value = data[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') {
      diagnostics.push(`frontmatter "${key}" is not a string; ignored`)
      continue
    }
    if (value.trim() === '') continue
    if (selected !== undefined) {
      if (selected !== value.trim()) {
        diagnostics.push(`both "${selectedKey}" and "${key}" are present; using "${selectedKey}"`)
      }
      continue
    }
    selected = value.trim()
    selectedKey = key
  }
  return selected
}

/**
 * Map canonical invocation keys plus legacy Claude aliases.
 *
 * Canonical: `disable-model-invocation: true` hides the skill from the model,
 * `user-invocable: false` hides it from the human command surface.
 *
 * @param {Record<string, unknown>} data - parsed frontmatter.
 * @param {string[]} diagnostics - mutable diagnostics collector.
 * @returns {{ modelInvocable: boolean, userInvocable: boolean }} resolved policy.
 */
function normalizeInvocation(data, diagnostics) {
  /** @type {{ modelInvocable: boolean, userInvocable: boolean }} */
  const invocation = { modelInvocable: true, userInvocable: true }

  const canonicalDisable = data['disable-model-invocation']
  if (canonicalDisable !== undefined && canonicalDisable !== null) {
    const value = parseFrontmatterBoolean(canonicalDisable, 'disable-model-invocation', diagnostics)
    if (value !== undefined) invocation.modelInvocable = !value
  }
  const canonicalUser = data['user-invocable']
  if (canonicalUser !== undefined && canonicalUser !== null) {
    const value = parseFrontmatterBoolean(canonicalUser, 'user-invocable', diagnostics)
    if (value !== undefined) invocation.userInvocable = value
  }

  const legacyDisable = data.disableModelInvocation
  if (legacyDisable !== undefined && legacyDisable !== null) {
    diagnostics.push(
      'legacy frontmatter key "disableModelInvocation" mapped to "disable-model-invocation"',
    )
    if (canonicalDisable !== undefined && canonicalDisable !== null) {
      diagnostics.push('ignoring legacy "disableModelInvocation" because the canonical key is present')
    } else {
      const value = parseFrontmatterBoolean(legacyDisable, 'disableModelInvocation', diagnostics)
      if (value !== undefined) invocation.modelInvocable = !value
    }
  }
  const legacyModel = data.modelInvocable
  if (legacyModel !== undefined && legacyModel !== null) {
    diagnostics.push(
      'legacy frontmatter key "modelInvocable" mapped to "disable-model-invocation" (inverted)',
    )
    if (canonicalDisable !== undefined && canonicalDisable !== null) {
      diagnostics.push('ignoring legacy "modelInvocable" because the canonical key is present')
    } else {
      const value = parseFrontmatterBoolean(legacyModel, 'modelInvocable', diagnostics)
      if (value !== undefined) invocation.modelInvocable = value
    }
  }
  const legacyUser = data.userInvocable
  if (legacyUser !== undefined && legacyUser !== null) {
    diagnostics.push('legacy frontmatter key "userInvocable" mapped to "user-invocable"')
    if (canonicalUser !== undefined && canonicalUser !== null) {
      diagnostics.push('ignoring legacy "userInvocable" because the canonical key is present')
    } else {
      const value = parseFrontmatterBoolean(legacyUser, 'userInvocable', diagnostics)
      if (value !== undefined) invocation.userInvocable = value
    }
  }
  return invocation
}

/**
 * @param {unknown} value - raw frontmatter boolean.
 * @param {string} key - key name for diagnostics.
 * @param {string[]} diagnostics - mutable diagnostics collector.
 * @returns {boolean | undefined} parsed boolean, or `undefined` when invalid.
 */
function parseFrontmatterBoolean(value, key, diagnostics) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    diagnostics.push(`frontmatter "${key}" has invalid boolean value ${String(value)}; using the default`)
    return undefined
  }
  if (typeof value === 'string') {
    switch (value.trim().toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
      case '1':
        return true
      case 'false':
      case 'no':
      case 'off':
      case '0':
        return false
      default:
        diagnostics.push(
          `frontmatter "${key}" has invalid boolean value "${truncateForDiagnostic(value)}"; using the default`,
        )
        return undefined
    }
  }
  diagnostics.push(`frontmatter "${key}" has unsupported type (${describeType(value)}); using the default`)
  return undefined
}

/**
 * Keep every frontmatter key that is not record identity/invocation so the UI can
 * display ecosystem extras (`license`, `allowed-tools`, `argument-hint`, nested
 * `metadata`, ...). The result is JSON-safe and prototype-pollution keyed values are
 * dropped by {@link toJsonSafe}.
 *
 * @param {Record<string, unknown>} data - parsed frontmatter.
 * @returns {Record<string, unknown>} JSON-safe metadata.
 */
function normalizeMetadata(data) {
  /** @type {Record<string, unknown>} */
  const metadata = {}
  for (const [key, value] of Object.entries(data)) {
    if (RESERVED_METADATA_KEYS.has(key)) continue
    const safe = toJsonSafe(value)
    if (safe !== undefined) setKey(metadata, key, safe)
  }
  return metadata
}

// ---------------------------------------------------------------------------
// YAML subset parser
// ---------------------------------------------------------------------------

/**
 * @typedef {{ start: number, end: number, next: number }} LineSpan
 */

/**
 * @param {string} text - full source text.
 * @returns {LineSpan[]} line spans (without the trailing newline).
 */
function splitLines(text) {
  /** @type {LineSpan[]} */
  const lines = []
  let start = 0
  for (;;) {
    const newline = text.indexOf('\n', start)
    if (newline < 0) {
      lines.push({ start, end: text.length, next: text.length })
      return lines
    }
    lines.push({ start, end: newline, next: newline + 1 })
    start = newline + 1
  }
}

/**
 * @param {string} text - full source text.
 * @param {LineSpan} line - span to extract.
 * @returns {string} line text without a trailing carriage return.
 */
function lineText(text, line) {
  return text.slice(line.start, line.end).replace(/\r$/u, '')
}

/**
 * @param {string} line - a candidate fence line.
 * @returns {boolean} whether the line is a frontmatter fence.
 */
function isFence(line) {
  return /^---[ \t]*$/u.test(line)
}

/**
 * Parse a frontmatter YAML source into a mapping.
 *
 * @param {string} source - YAML text between the fences.
 * @returns {Record<string, unknown> | undefined} mapping, `{}` for an empty block,
 *   or `undefined` when the top level is not a mapping.
 */
function parseYamlMapping(source) {
  const lines = source
    .split(/\r?\n/u)
    .map(line => line.replace(/^[ \t]+/u, prefix => prefix.replace(/\t/gu, '  ')))
  const index = skipIgnorable(lines, 0)
  if (index >= lines.length) return {}
  const first = lines[index]
  const content = sliceIndent(first)
  if (content.startsWith('{')) {
    const flow = parseFlowMapping(lines.slice(index).join(' ').trim())
    return isRecord(flow) ? flow : undefined
  }
  if (content.startsWith('[') || LIST_ITEM.test(content)) return undefined
  const mapping = parseMapping(lines, index, indentOf(first), 0)
  if (mapping.count === 0) return undefined
  return mapping.value
}

/**
 * @param {string[]} lines - normalized YAML lines.
 * @param {number} index - start index.
 * @returns {number} index of the next non-blank, non-comment line.
 */
function skipIgnorable(lines, index) {
  let current = index
  while (current < lines.length) {
    const line = lines[current]
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      current += 1
      continue
    }
    break
  }
  return current
}

/**
 * @param {string} line - normalized line.
 * @returns {number} number of leading spaces.
 */
function indentOf(line) {
  return /^ */u.exec(line)[0].length
}

/**
 * @param {string} line - normalized line.
 * @returns {string} line without leading indentation.
 */
function sliceIndent(line) {
  return line.slice(indentOf(line))
}

/**
 * @param {string} line - normalized line.
 * @returns {boolean} whether the line is blank or a comment.
 */
function isIgnorable(line) {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

/**
 * Recursively parse the block nested under a key or list item.
 *
 * @param {string[]} lines - normalized YAML lines.
 * @param {number} start - first candidate line index.
 * @param {number} parentIndent - indentation of the owning mapping key.
 * @param {number} depth - recursion depth guard.
 * @returns {{ value: unknown, next: number }} parsed child node; `next` stays at
 *   `start` when there is no nested content.
 */
function parseNode(lines, start, parentIndent, depth) {
  const index = skipIgnorable(lines, start)
  if (index >= lines.length) return { value: null, next: start }
  const indent = indentOf(lines[index])
  if (depth > MAX_YAML_DEPTH) return { value: null, next: start }
  const content = sliceIndent(lines[index])
  const indentlessSequence = indent === parentIndent && LIST_ITEM.test(content)
  if (indent < parentIndent || (indent === parentIndent && !indentlessSequence)) {
    return { value: null, next: start }
  }
  if (LIST_ITEM.test(content)) return parseSequence(lines, index, indent, depth)
  const mapping = parseMapping(lines, index, indent, depth)
  return { value: mapping.value, next: mapping.next }
}

/**
 * @param {string[]} lines - normalized YAML lines.
 * @param {number} start - first line index.
 * @param {number} baseIndent - indentation shared by mapping entries.
 * @param {number} depth - recursion depth guard.
 * @returns {{ value: Record<string, unknown>, next: number, count: number }} mapping.
 */
function parseMapping(lines, start, baseIndent, depth) {
  /** @type {Record<string, unknown>} */
  const value = {}
  let count = 0
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (isIgnorable(line)) {
      index += 1
      continue
    }
    const indent = indentOf(line)
    if (indent < baseIndent) break
    if (indent > baseIndent) {
      // A stray deeper line outside a known nested block: ignore it.
      index += 1
      continue
    }
    const content = sliceIndent(line)
    if (LIST_ITEM.test(content)) {
      const skipped = skipList(lines, index, baseIndent)
      index = skipped > index ? skipped : index + 1
      continue
    }
    const entry = splitKeyValue(content)
    if (entry === undefined) {
      index += 1
      continue
    }
    index += 1
    const parsed = parseMappingValue(lines, index, indent, entry.rest, depth)
    index = parsed.next
    setKey(value, entry.key, parsed.value)
    count += 1
  }
  return { value, next: index, count }
}

/**
 * @param {string[]} lines - normalized YAML lines.
 * @param {number} start - first line index after the owning key/value line.
 * @param {number} keyIndent - indentation of the owning mapping entry.
 * @param {string} rest - value text after the colon.
 * @param {number} depth - recursion depth guard.
 * @returns {{ value: unknown, next: number }} parsed value and next line index.
 */
function parseMappingValue(lines, start, keyIndent, rest, depth) {
  if (rest === '') {
    const nested = parseNode(lines, start, keyIndent, depth + 1)
    return { value: nested.value, next: nested.next }
  }
  if (isBlockScalarHeader(rest)) {
    return parseBlockScalar(lines, start, keyIndent, rest)
  }
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const quoted = readQuotedValue(rest, lines, start)
    return { value: quoted.value, next: quoted.next }
  }
  if (rest.startsWith('[') || rest.startsWith('{')) {
    const structured = readStructuredValue(rest, lines, start)
    return { value: structured.value, next: structured.next }
  }
  return { value: parseScalar(rest), next: start }
}

/**
 * Skip a `- item` sequence encountered where a mapping entry was expected.
 *
 * @param {string[]} lines - normalized YAML lines.
 * @param {number} start - list marker line index.
 * @param {number} baseIndent - expected mapping indentation.
 * @returns {number} index after the sequence.
 */
function skipList(lines, start, baseIndent) {
  let index = start + 1
  while (index < lines.length) {
    const line = lines[index]
    if (isIgnorable(line)) {
      index += 1
      continue
    }
    if (indentOf(line) < baseIndent) break
    index += 1
  }
  return index
}

/**
 * @param {string[]} lines - normalized YAML lines.
 * @param {number} start - first list item line index.
 * @param {number} baseIndent - indentation of the list item markers.
 * @param {number} depth - recursion depth guard.
 * @returns {{ value: unknown[], next: number }} sequence value and next line index.
 */
function parseSequence(lines, start, baseIndent, depth) {
  /** @type {unknown[]} */
  const value = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (isIgnorable(line)) {
      index += 1
      continue
    }
    const indent = indentOf(line)
    if (indent < baseIndent) break
    if (indent > baseIndent) {
      index += 1
      continue
    }
    const content = sliceIndent(line)
    if (!LIST_ITEM.test(content)) break
    index += 1
    const item = content.replace(/^-[ \t]?/u, '')
    if (item === '') {
      const nested = parseNode(lines, index, indent, depth + 1)
      index = nested.next
      value.push(nested.value)
    } else if (isBlockScalarHeader(item)) {
      const block = parseBlockScalar(lines, index, indent, item)
      index = block.next
      value.push(block.value)
    } else {
      value.push(parseScalar(item))
    }
  }
  return { value, next: index }
}

/**
 * Split a mapping line into key and raw value text.
 *
 * @param {string} content - line content without indentation.
 * @returns {{ key: string, rest: string } | undefined} entry parts, or `undefined`
 *   when the line is not a `key: value` entry.
 */
function splitKeyValue(content) {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]*:(.*)$/u.exec(content)
  if (quoted !== null) {
    const key = quoted[1].startsWith('"') ? parseDoubleQuoted(quoted[1]).value : parseSingleQuoted(quoted[1])
    return { key, rest: quoted[2].trim() }
  }
  const colon = content.indexOf(':')
  if (colon <= 0) return undefined
  const key = content.slice(0, colon).trim()
  if (key === '' || !SAFE_KEY.test(key)) return undefined
  return { key, rest: content.slice(colon + 1).trim() }
}

/**
 * @param {string} rest - value text.
 * @returns {boolean} whether the value starts a block scalar.
 */
function isBlockScalarHeader(rest) {
  return BLOCK_SCALAR_HEADER.test(rest)
}

/**
 * Parse a block scalar (`|`, `>`, optional chomping/indentation indicators).
 *
 * @param {string[]} lines - normalized YAML lines.
 * @param {number} start - first content line index.
 * @param {number} parentIndent - indentation of the owning mapping key.
 * @param {string} header - block scalar header (for example `|-`).
 * @returns {{ value: string, next: number }} parsed text and next line index.
 */
function parseBlockScalar(lines, start, parentIndent, header) {
  const match = BLOCK_SCALAR_HEADER.exec(header)
  const folded = match !== null && match[1] === '>'
  const indicatorText = match === null ? '' : match[2] ?? match[5] ?? ''
  const chomp = match === null ? '' : match[3] ?? match[4] ?? ''
  const indicator = indicatorText === '' ? undefined : Number(indicatorText)

  /** @type {string[]} */
  const collected = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      collected.push('')
      index += 1
      continue
    }
    if (indentOf(line) <= parentIndent) break
    collected.push(line)
    index += 1
  }

  let baseIndent = indicator === undefined ? undefined : parentIndent + indicator
  if (baseIndent === undefined) {
    for (const line of collected) {
      if (line.trim() === '') continue
      baseIndent = indentOf(line)
      break
    }
  }
  if (baseIndent === undefined) baseIndent = parentIndent + 1
  const contentLines = collected.map(line => (line.trim() === '' ? '' : line.slice(baseIndent)))
  let text = folded ? foldBlockLines(contentLines) : contentLines.join('\n')
  if (chomp === '-') {
    text = text.replace(/\n+$/u, '')
  } else if (chomp === '+') {
    // Keep the source's trailing newlines unchanged.
  } else {
    text = text.replace(/\n+$/u, '')
    if (text !== '') text += '\n'
  }
  return { value: text, next: index }
}

/**
 * YAML folded block scalar: line breaks between ordinary lines become spaces while
 * blank lines and more-indented lines keep hard breaks.
 *
 * @param {string[]} lines - content lines with the block indentation removed.
 * @returns {string} folded text.
 */
function foldBlockLines(lines) {
  let result = ''
  let pendingBlank = 0
  let hasText = false
  for (const line of lines) {
    if (line === '') {
      pendingBlank += 1
      continue
    }
    if (hasText) {
      if (pendingBlank > 0) result += '\n'.repeat(pendingBlank)
      else if (line.startsWith(' ')) result += '\n'
      else result += ' '
    }
    result += line
    pendingBlank = 0
    hasText = true
  }
  return result
}

/**
 * Read a quoted scalar, folding continuation lines until the closing quote is found.
 *
 * @param {string} rest - value text that starts with a quote.
 * @param {string[]} lines - normalized YAML lines.
 * @param {number} start - first continuation line index.
 * @returns {{ value: string, next: number }} parsed text and next line index.
 */
function readQuotedValue(rest, lines, start) {
  const doubleQuoted = rest.startsWith('"')
  let text = rest
  let index = start
  let parsed = doubleQuoted ? parseDoubleQuoted(text) : parseSingleQuoted(text)
  while (!parsed.closed && index < lines.length) {
    text += ` ${lines[index].trim()}`
    index += 1
    parsed = doubleQuoted ? parseDoubleQuoted(text) : parseSingleQuoted(text)
  }
  return { value: parsed.value, next: index }
}

/**
 * Read an inline array/map, folding continuation lines until brackets balance.
 *
 * @param {string} rest - value text that starts with `[` or `{`.
 * @param {string[]} lines - normalized YAML lines.
 * @param {number} start - first continuation line index.
 * @returns {{ value: unknown, next: number }} parsed value and next line index.
 */
function readStructuredValue(rest, lines, start) {
  let text = rest
  let index = start
  while (!isFlowBalanced(text) && index < lines.length) {
    text += ` ${lines[index].trim()}`
    index += 1
  }
  return { value: parseScalar(text), next: index }
}

/**
 * @param {string} text - candidate inline flow value.
 * @returns {boolean} whether all `[]`/`{}` pairs are closed.
 */
function isFlowBalanced(text) {
  let depth = 0
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      if (char === '\\' && quote === '"') {
        index += 1
      } else if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") index += 1
        else quote = ''
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
    } else if (char === '[' || char === '{') {
      depth += 1
    } else if (char === ']' || char === '}') {
      depth -= 1
    }
  }
  return depth <= 0 && quote === ''
}

// ---------------------------------------------------------------------------
// Scalar parsing
// ---------------------------------------------------------------------------

/**
 * Parse a YAML scalar (or a single-line flow collection).
 *
 * @param {string} text - raw value text.
 * @returns {unknown} string, number, boolean, null, array or mapping.
 */
function parseScalar(text) {
  const value = text.trim()
  if (value === '') return null
  if (value.startsWith('"')) return parseDoubleQuoted(value).value
  if (value.startsWith("'")) return parseSingleQuoted(value).value
  if (value.startsWith('[')) return parseFlowSequence(value)
  if (value.startsWith('{')) return parseFlowMapping(value)
  const plain = stripInlineComment(value).trim()
  if (plain === '') return null
  if (/^(?:~|null|Null|NULL)$/u.test(plain)) return null
  if (/^(?:true|True|TRUE)$/u.test(plain)) return true
  if (/^(?:false|False|FALSE)$/u.test(plain)) return false
  if (PLAIN_NUMBER.test(plain)) {
    const number = Number(plain)
    if (Number.isFinite(number)) return number
  }
  return plain
}

/**
 * @param {string} text - double-quoted scalar text (possibly unterminated).
 * @returns {{ value: string, closed: boolean }} unescaped text and closed flag.
 */
function parseDoubleQuoted(text) {
  let value = ''
  let index = 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      const next = text[index + 1]
      if (next === undefined) {
        index += 1
        break
      }
      if (next === 'x' || next === 'u' || next === 'U') {
        const length = next === 'x' ? 2 : next === 'u' ? 4 : 8
        const digits = text.slice(index + 2, index + 2 + length)
        if (new RegExp(`^[0-9a-fA-F]{${String(length)}}$`, 'u').test(digits)) {
          value += String.fromCodePoint(Number.parseInt(digits, 16))
          index += 2 + length
          continue
        }
      }
      value += DOUBLE_QUOTE_ESCAPES[next] ?? next
      index += 2
      continue
    }
    if (char === '"') return { value, closed: true }
    value += char
    index += 1
  }
  return { value, closed: false }
}

/**
 * @param {string} text - single-quoted scalar text (possibly unterminated).
 * @returns {{ value: string, closed: boolean }} unescaped text and closed flag.
 */
function parseSingleQuoted(text) {
  let value = ''
  let index = 1
  while (index < text.length) {
    const char = text[index]
    if (char === "'") {
      if (text[index + 1] === "'") {
        value += "'"
        index += 2
        continue
      }
      return { value, closed: true }
    }
    value += char
    index += 1
  }
  return { value, closed: false }
}

/**
 * @param {string} text - inline array text (`[a, b]`).
 * @returns {unknown[]} parsed items; tolerant of unterminated input.
 */
function parseFlowSequence(text) {
  const inner = stripFlowWrappers(text, '[', ']')
  return splitFlowItems(inner).map(item => parseScalar(item))
}

/**
 * @param {string} text - inline map text (`{a: b}`).
 * @returns {Record<string, unknown>} parsed mapping; tolerant of unterminated input.
 */
function parseFlowMapping(text) {
  const inner = stripFlowWrappers(text, '{', '}')
  /** @type {Record<string, unknown>} */
  const result = {}
  for (const item of splitFlowItems(inner)) {
    if (item.trim() === '') continue
    const entry = splitKeyValue(item.trim())
    if (entry === undefined) continue
    setKey(result, entry.key, parseScalar(entry.rest))
  }
  return result
}

/**
 * @param {string} text - flow collection text.
 * @param {string} open - opening bracket.
 * @param {string} close - closing bracket.
 * @returns {string} text without its outer brackets when present.
 */
function stripFlowWrappers(text, open, close) {
  let start = 0
  let end = text.length
  if (text.startsWith(open)) start = 1
  if (text.endsWith(close)) end -= 1
  return text.slice(start, Math.max(start, end))
}

/**
 * Split flow collection items on top-level commas, honoring quotes and nesting.
 *
 * @param {string} text - content between the flow brackets.
 * @returns {string[]} raw item texts.
 */
function splitFlowItems(text) {
  /** @type {string[]} */
  const items = []
  let current = ''
  let depth = 0
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      current += char
      if (char === '\\' && quote === '"' && index + 1 < text.length) {
        current += text[index + 1]
        index += 1
      } else if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          current += text[index + 1]
          index += 1
        } else {
          quote = ''
        }
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '{') depth += 1
    if (char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      items.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() !== '') items.push(current)
  return items
}

/**
 * @param {string} text - plain scalar text.
 * @returns {string} text without a trailing YAML comment.
 */
function stripInlineComment(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '#') continue
    if (index === 0 || /\s/u.test(text[index - 1])) return text.slice(0, index)
  }
  return text
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value - candidate object.
 * @returns {boolean} whether the value is a plain record.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Set an own property while refusing prototype-polluting keys.
 *
 * @param {Record<string, unknown>} target - destination object.
 * @param {string} key - property name.
 * @param {unknown} value - property value.
 */
function setKey(target, key, value) {
  if (key === '' || UNSAFE_KEYS.has(key)) return
  target[key] = value
}

/**
 * Convert parsed frontmatter values into JSON-safe data for the browser.
 *
 * @param {unknown} value - value to sanitize.
 * @param {number} [depth] - recursion guard.
 * @returns {unknown} JSON-safe value, or `undefined` when the value is not serializable.
 */
function toJsonSafe(value, depth = 0) {
  if (depth > MAX_YAML_DEPTH) return undefined
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    /** @type {unknown[]} */
    const items = []
    for (const item of value) {
      const safe = toJsonSafe(item, depth + 1)
      if (safe !== undefined) items.push(safe)
    }
    return items
  }
  if (isRecord(value)) {
    /** @type {Record<string, unknown>} */
    const record = {}
    for (const key of Object.keys(value)) {
      const safe = toJsonSafe(value[key], depth + 1)
      if (safe !== undefined) setKey(record, key, safe)
    }
    return record
  }
  return undefined
}

/**
 * @param {string} value - raw diagnostic subject.
 * @param {number} [maxLength] - maximum length.
 * @returns {string} shortened value for diagnostics.
 */
function truncateForDiagnostic(value, maxLength = 80) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

/**
 * @param {unknown} value - value to classify.
 * @returns {string} human-readable type name.
 */
function describeType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Deterministic 32-bit FNV-1a hash rendered as 8 lowercase hex characters.
 *
 * @param {string} text - input text.
 * @returns {string} 8-character hex digest.
 */
function hash8(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
