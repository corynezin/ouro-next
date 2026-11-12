// Static health of a source tree: size, function complexity, type-safety escapes, duplication, import cycles and tests.
// Pure: it reads the files it is given, so the same numbers come from a checkout, an attempt or a test fixture.
import ts from 'typescript'
import { dirname, join, normalize } from 'node:path'

export interface SourceFile { path: string, text: string }

export const thresholds = {
  complexFunction: 10,
  veryComplexFunction: 20,
  longFunctionLines: 60,
  largeFileLines: 400,
  duplicateWindowLines: 8,
} as const

export function isTestPath(path: string): boolean {
  return /\.(test|journey|live)\.tsx?$/.test(path) || /(^|\/)journeys\//.test(path) || /(^|\/)__tests__\//.test(path)
}

// The part of the system a file belongs to, used to break the numbers down: server layers and app folders split finer.
export function componentOf(path: string): string {
  const parts = path.split('/')
  if (parts[0] === 'server' && parts[1] === 'src' && parts.length > 3) return `server/${parts[2]}`
  if (parts[0] === 'apps' && parts[2] === 'src' && parts.length > 4) return `mobile/${parts[3]}`
  if (parts[0] === 'apps' && parts[2] === 'journeys') return 'mobile/journeys'
  if (parts[0] === 'apps') return `mobile/${parts.length > 3 ? parts[2] : 'root'}`
  if (parts[0] === 'packages') return `packages/${parts[1]}`
  return parts.length > 1 ? parts[0]! : 'root'
}

export interface FunctionMetric { path: string, name: string, line: number, lines: number, complexity: number }

export interface FileMetric {
  path: string
  component: string
  test: boolean
  codeLines: number
  functions: FunctionMetric[]
  anyTypes: number
  nonNullAssertions: number
  doubleCasts: number
  suppressions: number
  markers: number
  relativeImports: string[]
}

function codeLineCount(text: string): number {
  let count = 0
  let inBlock = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (inBlock) {
      if (line.includes('*/')) inBlock = false
      continue
    }
    if (!line || line.startsWith('//')) continue
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true
      continue
    }
    count += 1
  }
  return count
}

const decisionKinds = new Set([
  ts.SyntaxKind.IfStatement, ts.SyntaxKind.ConditionalExpression, ts.SyntaxKind.CaseClause, ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
])
const decisionOperators = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
])

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)
    || ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
}

function functionName(node: ts.FunctionLikeDeclaration, source: ts.SourceFile): string {
  if (node.name) return node.name.getText(source)
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return parent.name.getText(source)
  if (ts.isCallExpression(parent)) return `${parent.expression.getText(source).slice(0, 40)}(…)`
  return '(anonymous)'
}

// Cyclomatic complexity of one function body, not counting the functions nested inside it: they are measured on their own.
function complexityOf(fn: ts.FunctionLikeDeclaration): number {
  let complexity = 1
  const visit = (node: ts.Node): void => {
    if (node !== fn && isFunctionLike(node)) return
    if (decisionKinds.has(node.kind)) complexity += 1
    if (ts.isBinaryExpression(node) && decisionOperators.has(node.operatorToken.kind)) complexity += 1
    ts.forEachChild(node, visit)
  }
  visit(fn)
  return complexity
}

function lineOf(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1
}

export function measureFile(file: SourceFile): FileMetric {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true,
    file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const metric: FileMetric = {
    path: file.path,
    component: componentOf(file.path),
    test: isTestPath(file.path),
    codeLines: codeLineCount(file.text),
    functions: [],
    anyTypes: 0,
    nonNullAssertions: 0,
    doubleCasts: 0,
    suppressions: (file.text.match(/@ts-(ignore|expect-error|nocheck)|eslint-disable/g) ?? []).length,
    markers: (file.text.match(/\b(TODO|FIXME|HACK|XXX)\b/g) ?? []).length,
    relativeImports: [],
  }
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && node.body) {
      const start = lineOf(source, node.getStart(source))
      metric.functions.push({
        path: file.path,
        name: functionName(node, source),
        line: start,
        lines: lineOf(source, node.getEnd()) - start + 1,
        complexity: complexityOf(node),
      })
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) metric.anyTypes += 1
    if (ts.isNonNullExpression(node)) metric.nonNullAssertions += 1
    if (ts.isAsExpression(node) && ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) metric.doubleCasts += 1
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text.startsWith('.')) metric.relativeImports.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (argument && ts.isStringLiteral(argument) && argument.text.startsWith('.')) metric.relativeImports.push(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return metric
}

// Share of non-trivial source lines that sit in a run of `window` normalized lines found more than once.
export function duplication(files: readonly SourceFile[], window: number = thresholds.duplicateWindowLines): { lines: number, duplicatedLines: number, ratio: number } {
  const normalized = files.map((file) => file.text.split('\n')
    .map((line, index) => ({ line: line.trim().replace(/\s+/g, ' '), index }))
    .filter(({ line }) => line.length > 2 && !line.startsWith('//') && !line.startsWith('import ') && !/^[\])}]+[;,]?$/.test(line)))
  const occurrences = new Map<string, Array<{ file: number, start: number }>>()
  normalized.forEach((lines, file) => {
    for (let start = 0; start + window <= lines.length; start += 1) {
      const key = lines.slice(start, start + window).map(({ line }) => line).join('\n')
      const list = occurrences.get(key) ?? []
      list.push({ file, start })
      occurrences.set(key, list)
    }
  })
  const duplicated = normalized.map((lines) => new Uint8Array(lines.length))
  for (const list of occurrences.values()) {
    if (list.length < 2) continue
    for (const { file, start } of list) duplicated[file]!.fill(1, start, start + window)
  }
  const lines = normalized.reduce((sum, list) => sum + list.length, 0)
  const duplicatedLines = duplicated.reduce((sum, marks) => sum + marks.reduce((a, b) => a + b, 0), 0)
  return { lines, duplicatedLines, ratio: lines ? round(duplicatedLines / lines, 4) : 0 }
}

function resolveImport(from: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  const base = normalize(join(dirname(from), specifier))
  const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  return candidates.find((candidate) => known.has(candidate))
}

// Files that take part in an import cycle (strongly connected components larger than one file, or importing themselves).
export function importCycles(files: readonly FileMetric[]): string[][] {
  const known = new Set(files.map((file) => file.path))
  const edges = new Map(files.map((file) => [file.path, [...new Set(file.relativeImports
    .map((specifier) => resolveImport(file.path, specifier, known)).filter((path): path is string => !!path))]]))
  let counter = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cycles: string[][] = []
  const connect = (node: string): void => {
    index.set(node, counter)
    low.set(node, counter)
    counter += 1
    stack.push(node)
    onStack.add(node)
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        connect(next)
        low.set(node, Math.min(low.get(node)!, low.get(next)!))
      } else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!))
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = []
      let member: string
      do {
        member = stack.pop()!
        onStack.delete(member)
        component.push(member)
      } while (member !== node)
      if (component.length > 1 || edges.get(node)!.includes(node)) cycles.push(component.sort())
    }
  }
  for (const file of known) if (!index.has(file)) connect(file)
  return cycles.sort((a, b) => b.length - a.length)
}

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (sorted.length - 1) * p
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  return round(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower), 3)
}

export function round(value: number, places = 3): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

export interface ComponentSummary {
  files: number
  codeLines: number
  testFiles: number
  testCodeLines: number
  functions: number
  complexFunctions: number
}

// The headline numbers. Each has a direction (see `indicators`), so two reports can be compared line by line.
export interface StaticHealth {
  sourceFiles: number
  sourceCodeLines: number
  testFiles: number
  testCodeLines: number
  testToSourceRatio: number
  largeFiles: number
  functions: number
  complexityP50: number
  complexityP90: number
  complexityMax: number
  complexFunctions: number
  veryComplexFunctions: number
  longFunctions: number
  anyTypes: number
  nonNullAssertions: number
  doubleCasts: number
  suppressions: number
  markers: number
  duplicatedLineRatio: number
  importCycleFiles: number
  importCycles: number
}

export interface StaticReport {
  health: StaticHealth
  components: Record<string, ComponentSummary>
  worst: {
    complexFunctions: FunctionMetric[]
    longFunctions: FunctionMetric[]
    largeFiles: Array<{ path: string, codeLines: number }>
    importCycles: string[][]
  }
}

export function measureTree(files: readonly SourceFile[]): StaticReport {
  const metrics = files.map(measureFile)
  const source = metrics.filter((file) => !file.test)
  const tests = metrics.filter((file) => file.test)
  const functions = source.flatMap((file) => file.functions)
  const complexities = functions.map((fn) => fn.complexity)
  const sum = (list: readonly FileMetric[], key: 'codeLines' | 'anyTypes' | 'nonNullAssertions' | 'doubleCasts' | 'suppressions' | 'markers'): number =>
    list.reduce((total, file) => total + file[key], 0)
  const cycles = importCycles(source)
  const sourceCodeLines = sum(source, 'codeLines')
  const testCodeLines = sum(tests, 'codeLines')
  const components: Record<string, ComponentSummary> = {}
  for (const file of metrics) {
    const entry = components[file.component] ??= { files: 0, codeLines: 0, testFiles: 0, testCodeLines: 0, functions: 0, complexFunctions: 0 }
    if (file.test) {
      entry.testFiles += 1
      entry.testCodeLines += file.codeLines
    } else {
      entry.files += 1
      entry.codeLines += file.codeLines
      entry.functions += file.functions.length
      entry.complexFunctions += file.functions.filter((fn) => fn.complexity > thresholds.complexFunction).length
    }
  }
  return {
    health: {
      sourceFiles: source.length,
      sourceCodeLines,
      testFiles: tests.length,
      testCodeLines,
      testToSourceRatio: sourceCodeLines ? round(testCodeLines / sourceCodeLines) : 0,
      largeFiles: source.filter((file) => file.codeLines > thresholds.largeFileLines).length,
      functions: functions.length,
      complexityP50: percentile(complexities, 0.5),
      complexityP90: percentile(complexities, 0.9),
      complexityMax: complexities.length ? Math.max(...complexities) : 0,
      complexFunctions: complexities.filter((value) => value > thresholds.complexFunction).length,
      veryComplexFunctions: complexities.filter((value) => value > thresholds.veryComplexFunction).length,
      longFunctions: functions.filter((fn) => fn.lines > thresholds.longFunctionLines).length,
      anyTypes: sum(source, 'anyTypes'),
      nonNullAssertions: sum(source, 'nonNullAssertions'),
      doubleCasts: sum(source, 'doubleCasts'),
      suppressions: sum(metrics, 'suppressions'),
      markers: sum(source, 'markers'),
      duplicatedLineRatio: duplication(files.filter((file) => !isTestPath(file.path))).ratio,
      importCycleFiles: cycles.reduce((total, cycle) => total + cycle.length, 0),
      importCycles: cycles.length,
    },
    components: Object.fromEntries(Object.entries(components).sort(([a], [b]) => a.localeCompare(b))),
    worst: {
      complexFunctions: [...functions].sort((a, b) => b.complexity - a.complexity).slice(0, 15),
      longFunctions: [...functions].sort((a, b) => b.lines - a.lines).slice(0, 15),
      largeFiles: [...source].sort((a, b) => b.codeLines - a.codeLines).slice(0, 15).map(({ path, codeLines }) => ({ path, codeLines })),
      importCycles: cycles.slice(0, 10),
    },
  }
}

// Which way is better for each headline number. Size numbers are context, not good or bad.
export const indicators: Record<keyof StaticHealth, 'higher' | 'lower' | 'context'> = {
  sourceFiles: 'context',
  sourceCodeLines: 'context',
  testFiles: 'context',
  testCodeLines: 'context',
  testToSourceRatio: 'higher',
  largeFiles: 'lower',
  functions: 'context',
  complexityP50: 'lower',
  complexityP90: 'lower',
  complexityMax: 'lower',
  complexFunctions: 'lower',
  veryComplexFunctions: 'lower',
  longFunctions: 'lower',
  anyTypes: 'lower',
  nonNullAssertions: 'lower',
  doubleCasts: 'lower',
  suppressions: 'lower',
  markers: 'lower',
  duplicatedLineRatio: 'lower',
  importCycleFiles: 'lower',
  importCycles: 'lower',
}

export interface HealthDelta { indicator: keyof StaticHealth, before: number, after: number, change: number, verdict: 'better' | 'worse' | 'same' | 'context' }

export function compareHealth(before: StaticHealth, after: StaticHealth): HealthDelta[] {
  return (Object.keys(indicators) as Array<keyof StaticHealth>).map((indicator) => {
    const change = round(after[indicator] - before[indicator], 4)
    const direction = indicators[indicator]
    const verdict = direction === 'context' ? 'context'
      : change === 0 ? 'same'
        : (change < 0) === (direction === 'lower') ? 'better' : 'worse'
    return { indicator, before: before[indicator], after: after[indicator], change, verdict }
  })
}
