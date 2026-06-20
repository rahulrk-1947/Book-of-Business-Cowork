/**
 * Project costing bridge — turns project-tagged lines on a posted document
 * (a bill or an approved expense claim) into project cost rows, so a cost is
 * captured against the project the moment it's incurred, with no re-keying.
 *
 * Kept dependency-free (only the db handle) so the document services can call
 * it without an import cycle. If the projects tables aren't present yet (an
 * older data file mid-upgrade), every function is a safe no-op.
 *
 * Imported costs default to billable at cost (markup 0); they can be marked
 * non-billable or given a markup from the project's Costs list afterwards, and
 * they flow into "on-billing" alongside manually-entered costs.
 */

export type DocCostLine = {
  project_id?: number | null;
  description?: string | null;
  amount: number;           // cents, the cost incurred on this line
  date?: string | null;
  billable?: boolean;       // defaults to true
};

/**
 * Replace a document's not-yet-invoiced project costs with a fresh set derived
 * from its current project-tagged lines. Costs already on-billed to a customer
 * (invoiced = 1) are never touched, so re-posting can't disturb past billing.
 */
export function syncProjectCostsFromDoc(
  db: any,
  doc: { source_type: string; source_id: number; date?: string | null; lines: DocCostLine[] },
): void {
  try {
    db.prepare('DELETE FROM project_expenses WHERE source_type = ? AND source_id = ? AND invoiced = 0')
      .run(doc.source_type, doc.source_id);
    const ins = db.prepare(
      `INSERT INTO project_expenses
         (project_id, source_type, source_id, date, description, cost_amount, markup_percent, charge_amount, billable, invoiced)
       VALUES (?,?,?,?,?,?,0,?,?,0)`,
    );
    for (const l of doc.lines) {
      if (!l.project_id) continue;
      const cost = Math.round(Number(l.amount) || 0);
      const billable = l.billable === false ? 0 : 1;
      ins.run(l.project_id, doc.source_type, doc.source_id, l.date ?? doc.date ?? null, l.description ?? null, cost, cost, billable);
    }
  } catch {
    /* projects tables not present yet — nothing to sync */
  }
}

/** Drop a document's not-yet-invoiced project costs (used when it's voided or reopened). */
export function removeProjectCostsForDoc(db: any, source_type: string, source_id: number): void {
  try {
    db.prepare('DELETE FROM project_expenses WHERE source_type = ? AND source_id = ? AND invoiced = 0')
      .run(source_type, source_id);
  } catch {
    /* no-op */
  }
}
