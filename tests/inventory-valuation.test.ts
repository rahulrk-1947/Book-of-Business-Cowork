import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as items from '../src/backend/services/items';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => (getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c) as any).id as number;

beforeEach(() => {
  initDatabase(':memory:');
});

function trackedItem(reorder: number | null) {
  return items.save({
    code: 'WIDGET', name: 'Widget', is_tracked: true, i_purchase: true, i_sell: true,
    inventory_asset_account_id: acc('620'), cogs_account_id: acc('310'), reorder_point: reorder,
  } as any);
}

describe('inventory valuation report', () => {
  it('values tracked stock at weighted-average cost with a grand total', () => {
    const it = trackedItem(10);
    items.recordMovement(it.id, '2026-03-01', 'BILL', 1, 20, 500); // 20 @ $5.00 = $100

    const r = reports.inventoryValuation();
    const row = r.rows.find((x: any) => x.code === 'WIDGET')!;
    expect(row.quantity).toBe(20);
    expect(row.average_cost).toBe(500);
    expect(row.total_value).toBe(10000);
    expect(row.low).toBe(false); // 20 >= 10
    expect(r.total_value).toBe(10000);
    expect(r.total_quantity).toBe(20);
    expect(r.low_count).toBe(0);
  });

  it('flags an item below its reorder point', () => {
    const it = trackedItem(10);
    items.recordMovement(it.id, '2026-03-01', 'BILL', 1, 20, 500);
    items.recordMovement(it.id, '2026-03-05', 'INVOICE', 2, -15); // down to 5

    const r = reports.inventoryValuation();
    const row = r.rows.find((x: any) => x.code === 'WIDGET')!;
    expect(row.quantity).toBe(5);
    expect(row.low).toBe(true); // 5 < 10
    expect(r.low_count).toBe(1);
  });

  it('does not flag items with no reorder point set', () => {
    const it = trackedItem(null);
    items.recordMovement(it.id, '2026-03-01', 'BILL', 1, 1, 500); // just 1 on hand
    const r = reports.inventoryValuation();
    expect(r.rows.find((x: any) => x.code === 'WIDGET')!.low).toBe(false);
    expect(r.low_count).toBe(0);
  });

  it('excludes untracked items from the valuation', () => {
    items.save({ code: 'SVC', name: 'Consulting', is_tracked: false, i_sell: true, sales_account_id: acc('200') } as any);
    trackedItem(5);
    const r = reports.inventoryValuation();
    expect(r.rows.some((x: any) => x.code === 'SVC')).toBe(false);
    expect(r.rows.some((x: any) => x.code === 'WIDGET')).toBe(true);
  });

  it('persists the reorder point on the item', () => {
    const it = trackedItem(12);
    expect((items.get(it.id) as any).reorder_point).toBe(12);
  });
});

const acctBalance = (code: string) => {
  const id = acc(code);
  return Number((getDb().prepare('SELECT COALESCE(SUM(debit - credit), 0) AS bal FROM journal_lines WHERE account_id = ?').get(id) as any).bal);
};

describe('stock adjustments', () => {
  it('an increase adds stock and posts inventory asset vs the offset account', () => {
    const it = trackedItem(null);
    items.recordMovement(it.id, '2026-03-01', 'BILL', 1, 10, 500); // 10 @ $5 = $50
    const invBefore = acctBalance('620');
    const cogsBefore = acctBalance('310');
    items.adjustStock({ item_id: it.id, date: '2026-03-10', quantity_delta: 5, unit_cost: 600, account_id: acc('310') }); // +5 @ $6 = $30

    const after = items.get(it.id) as any;
    expect(after.quantity_on_hand).toBe(15);
    expect(after.total_value).toBe(8000); // 5000 + 3000
    expect(after.average_cost).toBe(Math.round(8000 / 15));
    expect(acctBalance('620') - invBefore).toBe(3000);  // inventory asset debited
    expect(acctBalance('310') - cogsBefore).toBe(-3000); // offset credited (reduces COGS)
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('a decrease relieves stock at average cost and posts the offset vs inventory', () => {
    const it = trackedItem(null);
    items.recordMovement(it.id, '2026-03-01', 'BILL', 1, 10, 500); // 10 @ $5 = $50
    items.adjustStock({ item_id: it.id, date: '2026-03-10', quantity_delta: -4, account_id: acc('310') }); // relieve 4 @ $5 = $20

    const after = items.get(it.id) as any;
    expect(after.quantity_on_hand).toBe(6);
    expect(after.total_value).toBe(3000);
    expect(acctBalance('310')).toBe(2000); // shrinkage debited to COGS
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('refuses to reduce stock below zero', () => {
    const it = trackedItem(null);
    items.recordMovement(it.id, '2026-03-01', 'BILL', 1, 3, 500);
    expect(() => items.adjustStock({ item_id: it.id, date: '2026-03-10', quantity_delta: -5, account_id: acc('310') })).toThrow(/Insufficient/i);
    // nothing changed
    expect((items.get(it.id) as any).quantity_on_hand).toBe(3);
  });

  it('rejects a zero-quantity adjustment', () => {
    const it = trackedItem(null);
    expect(() => items.adjustStock({ item_id: it.id, date: '2026-03-10', quantity_delta: 0, account_id: acc('310') })).toThrow(/non-zero/i);
  });
});

describe('as-at-date inventory valuation', () => {
  it('reports the stock position as at a past date', () => {
    const it = trackedItem(10);
    items.recordMovement(it.id, '2026-03-01', 'BILL', 1, 20, 500); // +20 on 1 Mar
    items.recordMovement(it.id, '2026-04-01', 'INVOICE', 2, -15); // −15 on 1 Apr → 5 now

    const march = reports.inventoryValuation({ as_at: '2026-03-15' });
    const mrow = march.rows.find((x: any) => x.code === 'WIDGET')!;
    expect(march.historical).toBe(true);
    expect(mrow.quantity).toBe(20);      // before the April sale
    expect(mrow.total_value).toBe(10000);
    expect(mrow.low).toBe(false);        // 20 >= 10 on that date

    const april = reports.inventoryValuation({ as_at: '2026-04-15' });
    const arow = april.rows.find((x: any) => x.code === 'WIDGET')!;
    expect(arow.quantity).toBe(5);       // after the sale
    expect(arow.low).toBe(true);         // 5 < 10
  });

  it('shows nothing on hand before the first movement', () => {
    const it = trackedItem(null);
    items.recordMovement(it.id, '2026-03-01', 'BILL', 1, 20, 500);
    const r = reports.inventoryValuation({ as_at: '2026-01-01' });
    const row = r.rows.find((x: any) => x.code === 'WIDGET');
    // tracked-but-zero items may be present with 0, or filtered; either way value is 0
    expect(row ? row.total_value : 0).toBe(0);
  });
});
