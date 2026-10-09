import { describe, expect, it } from 'vitest';
import { CsvParseError, barsToCsv, parseDate, parseOhlcvCsv } from './csv';
import { looksLikeCrypto, parseYahooChart, toBinanceSymbol } from './providers';

const utc = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / 1000;

describe('parseDate', () => {
  it('handles ISO, compact, epoch and regional formats', () => {
    expect(parseDate('2024-03-05')).toBe(utc(2024, 3, 5));
    expect(parseDate('2024/03/05')).toBe(utc(2024, 3, 5));
    expect(parseDate('20240305')).toBe(utc(2024, 3, 5));
    expect(parseDate('03/05/2024', 'mdy')).toBe(utc(2024, 3, 5));
    expect(parseDate('05/03/2024', 'dmy')).toBe(utc(2024, 3, 5));
    expect(parseDate('05.03.2024')).toBe(utc(2024, 3, 5));
    expect(parseDate(String(utc(2024, 3, 5)))).toBe(utc(2024, 3, 5));
    expect(parseDate(String(utc(2024, 3, 5) * 1000))).toBe(utc(2024, 3, 5));
    expect(parseDate('2024-03-05T14:30:00Z')).toBe(utc(2024, 3, 5) + 14.5 * 3600);
    expect(parseDate('2024-03-05T14:30:00+02:00')).toBe(utc(2024, 3, 5) + 12.5 * 3600);
  });

  it('rejects impossible dates', () => {
    expect(parseDate('2024-02-31')).toBeNaN();
    expect(parseDate('not a date')).toBeNaN();
  });
});

describe('parseOhlcvCsv', () => {
  it('parses, sorts and keeps standard columns', () => {
    const csv = ['Date,Open,High,Low,Close,Adj Close,Volume', '2024-01-03,3,4,2,3.5,3.4,300', '2024-01-02,2,3,1,2.5,2.4,200'].join('\n');
    const r = parseOhlcvCsv(csv);
    expect(r.bars.map((b) => b.close)).toEqual([2.5, 3.5]);
    expect(r.bars[0]).toEqual({ time: utc(2024, 1, 2), open: 2, high: 3, low: 1, close: 2.5, volume: 200 });
    expect(r.warnings).toEqual([]);
  });

  it('understands Nasdaq-style exports with currency symbols and US dates', () => {
    const csv = ['Date,Close/Last,Volume,Open,High,Low', '01/31/2024,$184.40,55467800,$187.04,$187.10,$184.35'].join('\n');
    const r = parseOhlcvCsv(csv);
    expect(r.bars[0]).toMatchObject({ time: utc(2024, 1, 31), close: 184.4, open: 187.04, volume: 55467800 });
  });

  it('detects day-first dates and semicolon delimiters', () => {
    const csv = ['date;open;high;low;close;volume', '25/12/2023;1;2;0.5;1.5;10', '02/01/2024;1;2;0.5;1.5;10'].join('\n');
    const r = parseOhlcvCsv(csv);
    expect(r.bars.map((b) => b.time)).toEqual([utc(2023, 12, 25), utc(2024, 1, 2)]);
  });

  it('derives candles from close-only data and reports skipped rows', () => {
    const csv = ['timestamp,price', '2024-01-01,10', 'garbage,11', '2024-01-02,abc', '2024-01-03,12'].join('\n');
    const r = parseOhlcvCsv(csv);
    expect(r.bars).toHaveLength(2);
    expect(r.rowsSkipped).toBe(2);
    expect(r.bars[0]).toMatchObject({ open: 10, high: 10, low: 10, close: 10, volume: 0 });
    expect(r.warnings.some((w) => w.includes('Skipped 2'))).toBe(true);
  });

  it('repairs inconsistent candles and merges duplicate dates', () => {
    const csv = ['Date,Open,High,Low,Close,Volume', '2024-01-01,10,9,8,11,1', '2024-01-01,10,12,9,11,2'].join('\n');
    const r = parseOhlcvCsv(csv);
    expect(r.bars).toHaveLength(1);
    expect(r.bars[0].volume).toBe(2);
    expect(r.warnings.some((w) => w.startsWith('Repaired 1'))).toBe(true);
    expect(r.warnings.some((w) => w.startsWith('Merged 1'))).toBe(true);
  });

  it('throws a descriptive error when required columns are missing', () => {
    expect(() => parseOhlcvCsv('foo,bar\n1,2')).toThrow(CsvParseError);
    expect(() => parseOhlcvCsv('Date,Volume\n2024-01-01,2')).toThrow(/close price/);
  });

  it('round-trips through barsToCsv', () => {
    const csv = 'Date,Open,High,Low,Close,Volume\n2024-01-02,2,3,1,2.5,200';
    expect(parseOhlcvCsv(barsToCsv(parseOhlcvCsv(csv).bars)).bars).toEqual(parseOhlcvCsv(csv).bars);
  });
});

describe('provider parsers', () => {
  it('parses the Yahoo chart payload onto exchange-local dates', () => {
    const body = JSON.stringify({
      chart: {
        result: [
          {
            meta: { symbol: 'SPY', longName: 'SPDR S&P 500', gmtoffset: -14400 },
            // 2024-01-02 14:30 UTC (09:30 New York)
            timestamp: [utc(2024, 1, 2) + 14.5 * 3600, utc(2024, 1, 3) + 14.5 * 3600],
            indicators: { quote: [{ open: [1, null], high: [2, 3], low: [0.5, 1], close: [1.5, 2], volume: [10, 20] }] },
          },
        ],
        error: null,
      },
    });
    const r = parseYahooChart(body);
    expect(r.name).toBe('SPDR S&P 500');
    expect(r.bars).toEqual([{ time: utc(2024, 1, 2), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]);
  });

  it('surfaces Yahoo error descriptions', () => {
    const body = JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } });
    expect(() => parseYahooChart(body)).toThrow('No data found');
  });

  it('maps crypto symbols to Binance pairs', () => {
    expect(toBinanceSymbol('BTC-USD')).toBe('BTCUSDT');
    expect(toBinanceSymbol('eth/usdt')).toBe('ETHUSDT');
    expect(toBinanceSymbol('SOL')).toBe('SOLUSDT');
    expect(toBinanceSymbol('ETHBTC')).toBe('ETHBTC');
    expect(looksLikeCrypto('BTC-USD')).toBe(true);
    expect(looksLikeCrypto('AAPL')).toBe(false);
  });
});
