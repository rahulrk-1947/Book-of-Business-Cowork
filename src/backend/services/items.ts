/**
 * Products & services (spec §8). Untracked items just carry defaults;
 * tracked items maintain quantity-on-hand and value at average cost.
 * Average cost recomputes on each inward movement; outward movements
 * relieve inventory at the current average cost (the COGS amount).
 */
import { getDb } from '../db';
import { assertUniqueName } from './uniqueness';
import { audit, postJournal, assertValidDate, assertDateUnlocked } from '../engine';
import { roundCents } from '../money';

export function list(opts: { search?: string } = {}) {
  const db = getDb();
  const where = opts.search ? `WHERE (code LIKE ? OR name LIKE ?) AND status='ACTIVE'` : `WHERE status='ACTIVE'`;
  const params = opts.search ? [`%${opts.search}%`, `%${opts.search}%`] : [];
  return db.prepare(`SELECT * FROM items ${where} ORDER BY code`).all(...params);
}

export function get(id: number) {
  return getDb().prepare('SELECT * FROM items WHERE id = ?').get(id);
}

export function movements(itemId: number) {
  return getDb().prepare('SELECT * FROM inventory_movements WHERE item_id = ? ORDER BY date DESC, id DESC LIMIT 200').all(itemId);
}

export function save(input: any, user_id = 1) {
  const db = getDb();
  const itemId = input.id as number | undefined;
  if (input.code) assertUniqueName({ table: 'items', column: 'code', value: input.code, excludeId: itemId, statuses: ['ACTIVE'], label: 'An item with code' });
  if (input.name) assertUniqueName({ table: 'items', column: 'name', value: input.name, excludeId: itemId, statuses: ['ACTIVE'], label: 'An item named' });
  const vals = [
    input.code, input.name, input.is_tracked ? 1 : 0, input.i_sell ? 1 : 0, input.i_purchase ? 1 : 0,
    input.sales_unit_price ?? null, input.sales_account_id ?? null, input.sales_tax_rate_id ?? null, input.description_sales ?? null,
    input.purchase_unit_price ?? null, input.purchase_account_id ?? null, input.purchase_tax_rate_id ?? null, input.description_purchase ?? null,
    input.inventory_asset_account_id ?? null, input.cogs_account_id ?? null,
    input.is_tracked ? (input.reorder_point ?? null) : null,
  ];
  if (input.is_tracked && !input.inventory_asset_account_id) throw new Error('Tracked items need an inventory asset account');
  let id = input.id;
  if (id) {
    const before = get(id);
    if (before.is_tracked && !input.is_tracked && before.quantity_on_hand !== 0) {
      throw new Error('Cannot untrack an item with stock on hand');
    }
    db.prepare(`UPDATE items SET code=?, name=?, is_tracked=?, i_sell=?, i_purchase=?, sales_unit_price=?, sales_account_id=?, sales_tax_rate_id=?, description_sales=?, purchase_unit_price=?, purchase_account_id=?, purchase_tax_rate_id=?, description_purchase=?, inventory_asset_account_id=?, cogs_account_id=?, reorder_point=? WHERE id=?`).run(...vals, id);
    audit('item', id, 'UPDATE', before, input, user_id);
  } else {
    id = Number(db.prepare(`INSERT INTO items (code, name, is_tracked, i_sell, i_purchase, sales_unit_price, sales_account_id, sales_tax_rate_id, description_sales, purchase_unit_price, purchase_account_id, purchase_tax_rate_id, description_purchase, inventory_asset_account_id, cogs_account_id, reorder_point) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...vals).lastInsertRowid);
    audit('item', id, 'CREATE', null, input, user_id);
  }
  return get(id);
}

export function archive(id: number, user_id = 1) {
  const item = get(id);
  if (item?.is_tracked && item.quantity_on_hand !== 0) throw new Error('Item has stock on hand');
  getDb().prepare("UPDATE items SET status='ARCHIVED' WHERE id = ?").run(id);
  audit('item', id, 'ARCHIVE', null, null, user_id);
}

/**
 * Apply a stock movement and return the inventory value relieved (positive
 * cents) for outward movements — i.e. the COGS amount — or 0 for inward.
 *
 * qtyDelta > 0 = stock in (unitCost required); qtyDelta < 0 = stock out at
 * average cost. Negative-stock attempts throw (configurable later).
 */
export function recordMovement(itemId: number, date: string, sourceType: string, sourceId: number, qtyDelta: number, unitCost?: number): number {
  const db = getDb();
  return db.transaction(() => {
    const item = get(itemId);
    if (!item?.is_tracked) return 0;
    if (unitCost != null && unitCost < 0) {
      throw new Error(`Cannot move ${item.code} at a negative unit cost (${unitCost})`);
    }
    let valueDelta: number;
    if (qtyDelta > 0) {
      const cost = unitCost ?? item.average_cost;
      if (cost < 0) throw new Error(`Cannot receive ${item.code} at a negative unit cost (${cost})`);
      valueDelta = roundCents(qtyDelta * cost);
    } else if (qtyDelta < 0) {
      if (item.quantity_on_hand + qtyDelta < -1e-9) {
        throw new Error(`Insufficient stock of ${item.code}: have ${item.quantity_on_hand}, need ${-qtyDelta}`);
      }
      if (unitCost != null) {
        // Outward at an explicit cost (e.g. a purchase return credited at the
        // credit-note price): relieve the ledger by the same amount the GL
        // posts so the inventory asset account and the stock ledger stay in step.
        valueDelta = -roundCents(-qtyDelta * unitCost);
      } else {
        // Sales COGS: relieve a proportional slice of the carrying value so the
        // value stays in step with quantity. Relieving at the rounded average
        // cost drifted by a cent or two until the item next emptied. If this
        // empties the item, take the whole remaining value.
        const emptying = Math.abs(item.quantity_on_hand + qtyDelta) < 1e-9;
        valueDelta = emptying ? -item.total_value : -roundCents(item.total_value * (-qtyDelta) / item.quantity_on_hand);
      }
    } else {
      return 0;
    }
    const newQty = item.quantity_on_hand + qtyDelta;
    const newValue = item.total_value + valueDelta;
    const newAvg = newQty > 1e-9 ? Math.round(newValue / newQty) : 0;
    db.prepare('UPDATE items SET quantity_on_hand=?, total_value=?, average_cost=? WHERE id=?').run(newQty, newValue, newAvg, itemId);
    db.prepare('INSERT INTO inventory_movements (item_id, date, source_type, source_id, qty_delta, unit_cost, value_delta, balance_qty, balance_value) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(itemId, date, sourceType, sourceId, qtyDelta, unitCost ?? item.average_cost, valueDelta, newQty, newValue);
    return qtyDelta < 0 ? -valueDelta : 0;
  });
}

/**
 * Stock adjustment (stocktake / shrinkage / write-on). Moves quantity on hand
 * by `quantity_delta` and posts the matching journal between the item's
 * inventory asset account and an offset account (defaults to the item's COGS
 * account — increases credit it, decreases debit it). Increases value at the
 * given unit cost (or the current average); decreases relieve at average cost.
 *
 * Forward-only: a mistaken adjustment is corrected with another adjustment, so
 * the average-cost history is never rewound. Records an ADJUSTMENT movement, so
 * it shows in the item's history and the as-at inventory valuation.
 */
export function adjustStock(
  input: { item_id: number; date: string; quantity_delta: number; unit_cost?: number; account_id?: number; reason?: string },
  user_id = 1,
) {
  const db = getDb();
  return db.transaction(() => {
    const item: any = get(input.item_id);
    if (!item) throw new Error('Item not found');
    if (!item.is_tracked) throw new Error('Only tracked items can have their stock adjusted');
    const delta = Number(input.quantity_delta);
    if (!Number.isFinite(delta) || delta === 0) throw new Error('Enter a non-zero quantity change');
    assertValidDate(input.date, 'date');
    assertDateUnlocked(input.date);
    const inventoryAcct = item.inventory_asset_account_id;
    if (!inventoryAcct) throw new Error('This item has no inventory asset account');
    const offset = input.account_id ?? item.cogs_account_id;
    if (!offset) throw new Error('Choose an account to post the adjustment against');

    // Value moving (positive cents) — mirrors recordMovement's average-cost logic
    // so the journal amount and the inventory value change agree exactly.
    let value: number;
    if (delta > 0) {
      const cost = input.unit_cost ?? item.average_cost ?? 0;
      if (!cost) throw new Error('Enter a unit cost for a stock increase (the item has no average cost yet)');
      value = roundCents(delta * cost);
    } else {
      if (item.quantity_on_hand + delta < -1e-9) {
        throw new Error(`Insufficient stock of ${item.code}: have ${item.quantity_on_hand}, adjusting by ${delta}`);
      }
      const emptying = Math.abs(item.quantity_on_hand + delta) < 1e-9;
      // Proportional slice of carrying value (matches recordMovement) so the
      // posted journal amount and the ledger value change agree to the cent.
      value = emptying ? item.total_value : roundCents(item.total_value * (-delta) / item.quantity_on_hand);
    }

    const narration = `Stock adjustment: ${item.code} ${delta > 0 ? '+' : ''}${delta}${input.reason ? ` — ${input.reason}` : ''}`;
    const lines = delta > 0
      ? [{ account_id: inventoryAcct, debit: value, credit: 0 }, { account_id: offset, debit: 0, credit: value }]
      : [{ account_id: offset, debit: value, credit: 0 }, { account_id: inventoryAcct, debit: 0, credit: value }];
    const journalId = postJournal({ date: input.date, narration, source_type: 'STOCK_ADJUSTMENT', source_id: item.id, lines, user_id });

    recordMovement(item.id, input.date, 'ADJUSTMENT', journalId, delta, delta > 0 ? (input.unit_cost ?? item.average_cost) : undefined);
    audit('item', item.id, 'STOCK_ADJUSTMENT', null, { quantity_delta: delta, value, journal_id: journalId, reason: input.reason ?? null }, user_id);
    return { item_id: item.id, quantity_delta: delta, value, journal_id: journalId, on_hand: get(item.id).quantity_on_hand };
  });
}
