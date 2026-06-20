import { describe, it, expect } from 'vitest';
import { parseCsv, parseOfx, detectDateOrder, previewStatement } from '../src/backend/services/banking';

describe('bank statement parsing', () => {
  it('detects day-first vs month-first from the whole column', () => {
    expect(detectDateOrder(['13/02/2026', '01/03/2026'])).toBe('DMY'); // 13 can't be a month
    expect(detectDateOrder(['02/13/2026', '03/01/2026'])).toBe('MDY'); // 13 in 2nd slot
    expect(detectDateOrder(['2026-02-13'])).toBe('YMD');
    expect(detectDateOrder(['05/06/2026'])).toBe('DMY'); // ambiguous → day-first default
  });

  it('reads a single signed Amount column', () => {
    const csv = 'Date,Amount,Description\n13/02/2026,-45.50,Coffee\n14/02/2026,1200.00,Invoice paid\n';
    const r = parseCsv(csv);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ date: '2026-02-13', amount: -4550, description: 'Coffee' });
    expect(r[1].amount).toBe(120000);
  });

  it('reads separate Debit and Credit columns (debit negative, credit positive)', () => {
    const csv = 'Date,Description,Debit,Credit\n03/01/2026,Rent,2000.00,\n05/01/2026,Sale,,3500.00\n';
    const r = parseCsv(csv);
    expect(r[0]).toMatchObject({ date: '2026-01-03', amount: -200000 });
    expect(r[1]).toMatchObject({ date: '2026-01-05', amount: 350000 });
  });

  it('honours a month-first column without corrupting the day', () => {
    // 02/13 proves MDY for the column; 03/04 must then be 4 March, not 3 April
    const csv = 'Date,Amount,Memo\n02/13/2026,-10.00,A\n03/04/2026,-20.00,B\n';
    const r = parseCsv(csv);
    expect(r[0].date).toBe('2026-02-13');
    expect(r[1].date).toBe('2026-03-04');
  });

  it('handles alternate headers and written-out month dates', () => {
    const csv = 'Transaction Date,Particulars,Money Out,Money In\n12 Mar 2026,Power bill,150.00,\n';
    const r = parseCsv(csv);
    expect(r[0]).toMatchObject({ date: '2026-03-12', amount: -15000, description: 'Power bill' });
  });

  it('still parses OFX', () => {
    const ofx = '<OFX><STMTTRN><DTPOSTED>20260213<TRNAMT>-45.50<NAME>Coffee<FITID>X1</STMTTRN></OFX>';
    const r = parseOfx(ofx);
    expect(r[0]).toMatchObject({ date: '2026-02-13', amount: -4550, payee: 'Coffee', reference: 'X1' });
  });

  it('previews totals and date range without saving', () => {
    const csv = 'Date,Amount\n01/02/2026,1000.00\n15/02/2026,-300.00\n28/02/2026,-200.00\n';
    const p = previewStatement('feb.csv', csv);
    expect(p.total).toBe(3);
    expect(p.money_in).toBe(100000);
    expect(p.money_out).toBe(-50000);
    expect(p.net).toBe(50000);
    expect(p.from).toBe('2026-02-01');
    expect(p.to).toBe('2026-02-28');
    expect(p.sample.length).toBe(3);
  });
});
