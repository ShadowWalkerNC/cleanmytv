// The transaction engine: every meaningful write runs PLAN -> SNAPSHOT -> APPLY -> VERIFY ->
// COMMIT, and a failure in apply or verify rolls the finished operations back in reverse order.
// Callers keep their own return shapes; this only standardises the safety spine. Rollback is
// best-effort per operation (each failure is logged, the rest still run) and its outcome is
// always reported, never silent.
import { log } from './log'

export interface TxOp<S = unknown> {
  /** One line for the log, e.g. "disable 20 packages". */
  label: string
  /** Human-readable preview of what apply will do. Shown before anything changes. */
  plan: string[]
  /** Read the before-state. Runs before apply; its value feeds apply/verify/rollback. */
  snapshot(): Promise<S>
  apply(snap: S): Promise<void>
  /** Throws when the TV did not converge (re-reads, never trusts the apply output). */
  verify(snap: S): Promise<void>
  /** Puts the before-state back. Must not throw past the engine (it catches and logs). */
  rollback(snap: S): Promise<void>
}

export interface TxResult {
  ok: boolean
  /** Labels that applied and verified, in order. */
  applied: string[]
  /** Labels that were rolled back, in rollback order. Empty unless something failed. */
  rolledBack: string[]
  /** The failure that stopped the transaction, if any. */
  error?: string
  /** A rollback step failed too: the TV may hold a mix of old and new state. */
  rollbackError?: string
}

export async function runTx<S>(task: string, title: string, ops: Array<TxOp<S>>): Promise<TxResult> {
  const applied: Array<{ op: TxOp<S>; snap: S }> = []
  const rolledBack: string[] = []
  log(task, 'info', `${title} (${ops.length} step${ops.length === 1 ? '' : 's'})`)
  for (const op of ops) for (const line of op.plan) log(task, 'info', `plan: ${line}`)
  try {
    for (const op of ops) {
      const snap = await op.snapshot()
      await op.apply(snap)
      await op.verify(snap)
      applied.push({ op, snap })
      log(task, 'ok', `${op.label}: applied and verified`)
    }
    return { ok: true, applied: applied.map((a) => a.op.label), rolledBack }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log(task, 'error', `${title} failed: ${error}`)
    let rollbackError: string | undefined
    for (const { op, snap } of applied.reverse()) {
      try {
        await op.rollback(snap)
        rolledBack.push(op.label)
        log(task, 'warn', `${op.label}: rolled back`)
      } catch (re) {
        const msg = re instanceof Error ? re.message : String(re)
        rollbackError = `${op.label}: ${msg}`
        log(task, 'error', `${op.label}: rollback failed (${msg}); the TV may hold a mix of old and new state`)
      }
    }
    return { ok: false, applied: [], rolledBack, error, ...(rollbackError ? { rollbackError } : {}) }
  }
}
