import { readFile } from "node:fs/promises"

type Totals = {
  readonly linesFound: number
  readonly linesHit: number
  readonly functionsFound: number
  readonly functionsHit: number
}

const threshold = 95

const emptyTotals = (): Totals => ({
  linesFound: 0,
  linesHit: 0,
  functionsFound: 0,
  functionsHit: 0
})

const isSourceRecord = (record: string): boolean => {
  const source = record
    .split("\n")
    .find((line) => line.startsWith("SF:"))
    ?.slice(3)

  if (source === undefined) return false
  if (!source.startsWith("src/") && !source.includes("/src/")) return false
  if (source.includes(".test.ts")) return false
  if (source.endsWith("Port.ts")) return false
  return true
}

const numberAfter = (record: string, prefix: string): number => {
  const match = new RegExp(`^${prefix}:(\\d+)$`, "m").exec(record)
  return match?.[1] === undefined ? 0 : Number(match[1])
}

const collect = (lcov: string): Totals =>
  lcov
    .split("end_of_record")
    .filter(isSourceRecord)
    .reduce(
      (totals, record) => ({
        linesFound: totals.linesFound + numberAfter(record, "LF"),
        linesHit: totals.linesHit + numberAfter(record, "LH"),
        functionsFound: totals.functionsFound + numberAfter(record, "FNF"),
        functionsHit: totals.functionsHit + numberAfter(record, "FNH")
      }),
      emptyTotals()
    )

const percent = (hit: number, found: number): number => (found === 0 ? 100 : (hit / found) * 100)

const failUnderThreshold = (label: string, value: number): boolean => {
  if (value >= threshold) return false
  console.error(`${label} coverage ${value.toFixed(2)}% is below ${threshold}%`)
  return true
}

const totals = collect(await readFile("coverage/lcov.info", "utf8"))
const lineCoverage = percent(totals.linesHit, totals.linesFound)
const functionCoverage = percent(totals.functionsHit, totals.functionsFound)

console.log(`line coverage: ${lineCoverage.toFixed(2)}%`)
console.log(`function coverage: ${functionCoverage.toFixed(2)}%`)

if (failUnderThreshold("Line", lineCoverage) || failUnderThreshold("Function", functionCoverage)) {
  process.exitCode = 1
}
