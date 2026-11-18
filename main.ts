// btc-race-24h-20261118-1444: flush dip-buy bot (bars-replay/v1).
//
// Strategy: buy a sharp flush (close >= 1.5% below the trailing 240-bar high)
// only after a bounce bar (close > open); ride to +1.2% over average cost,
// cut at -1.5%, or exit after 360 bars. At most 2 round trips, then cash.
// Cash is the strongest position in a choppy downtrend: the bot sits out
// unless a real flush appears, so it avoids the ~26 bps round-trip friction
// that grinds aggressive bots down. Entry 80% of equity, TWAP-split 40% +
// 40% across two bars (slice 2 only if the price has not run more than 0.4%
// above the first fill) because the pool resets at each bar's open.
// Hard guardrails: a 15% equity-drawdown circuit breaker (liquidate + lock,
// never near the 25% disqualification line) and a $15 failsafe round trip in
// the last hour if zero filled orders. Final exit staggered T-2 (sell half)
// / T-1 (sell rest), keyed to remaining window time so missing bars cannot
// strand a position into the forced flatten.
import { runBars } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';
const H = 240; // trailing-high lookback, bars
const DIP_BPS = -150; // entry dip vs trailing high, bps
const TP_BPS = 120; // take profit over average cost, bps
const SL_BPS = -150; // stop loss vs average cost, bps
const MAX_HOLD = 360; // bars
const MAX_RT = 2; // max round trips, then cash only
const SLICE_BPS = 4000; // each TWAP slice, bps of equity (40% + 40% = 80%)
const TOL_BPS = 40; // slice-2 tolerance above fill 1, bps
const BREAKER_BPS = 1500; // 15% equity drawdown -> liquidate + lock
const FAILSAFE_NOTIONAL = 15_000_000n; // $15 in quote units
const FAILSAFE_MS = 3_600_000; // last 60 minutes
const EXIT1_MS = 180_000; // T-2: sell half when <= 3 min remain
const EXIT2_MS = 120_000; // T-1: sell rest when <= 2 min remain
const WINDOW_MS = 1440 * 60_000; // 24h window
const SLIP_BPS = 100; // max slippage per order, bps
const MIN_NOTIONAL = 1_000_000n; // $1 in quote units

const closes: number[] = [];
let peak = 0n;
let roundtrips = 0;
let locked = false;
let entrySeq = -1;
let filled = 0;
let slice2Amt = 0n;
let slice2Seq = -1;
let slice1Id = '';
let failsafe = 0; // 0 idle, 1 bought, 2 done
let exitStage = 0;
let n = 0;
const cid = () => `o${++n}`;

await runBars({
  onBatch(state, batch) {
    if (state.warmingUp) return [];
    for (const f of batch.fills) if (f.status === 'filled') filled++;
    const bar = state.latest.get(SYM);
    const close = state.close(SYM);
    if (bar === undefined || close === null) return [];
    const ps = state.symbols.get(SYM)?.price_scale ?? 5;
    const scale = 10 ** ps;
    const closeN = Number(close) / scale;
    const openN = Number(bar.o) / scale;
    closes.push(closeN);
    const eq = state.equity;
    if (peak === 0n || eq > peak) peak = eq;
    const ddBps = peak > 0n ? Number(((peak - eq) * 10_000n) / peak) : 0;
    const pos = state.positions.get(SYM);
    const qty = pos?.qty ?? 0n;
    const cost = pos?.cost ?? 0n;
    const endMs = state.hello.first_close_ms + WINDOW_MS;
    const remainMs = endMs - batch.t;
    const sellAll = () => {
      if (qty > 0n) return [{ side: 'sell' as const, symbol: SYM, qty, max_slippage_bps: SLIP_BPS, client_id: cid() }];
      return [];
    };

    // 1) Circuit breaker: 15% equity drawdown -> liquidate everything, lock.
    if (!locked && qty > 0n && ddBps >= BREAKER_BPS) {
      locked = true;
      roundtrips++;
      return sellAll();
    }
    // 2) Staggered final exit, keyed to remaining time (robust to missing bars).
    if (qty > 0n && remainMs <= EXIT2_MS) {
      exitStage = 2;
      return sellAll();
    }
    if (qty > 0n && exitStage === 0 && remainMs <= EXIT1_MS) {
      exitStage = 1;
      return [{ side: 'sell' as const, symbol: SYM, qty: qty / 2n, max_slippage_bps: SLIP_BPS, client_id: cid() }];
    }
    // 3) Failsafe: zero filled orders by the last hour -> one $15 round trip.
    if (failsafe === 0 && filled === 0 && remainMs <= FAILSAFE_MS && !locked) {
      failsafe = 1;
      return [{ side: 'buy' as const, symbol: SYM, notional_quote_units: FAILSAFE_NOTIONAL, max_slippage_bps: SLIP_BPS, client_id: cid() }];
    }
    if (failsafe === 1 && qty > 0n) {
      failsafe = 2;
      return sellAll();
    }
    // 4) TWAP slice 2: only if the price has not run past tolerance.
    if (slice2Amt > 0n && state.seq === slice2Seq) {
      const amt = slice2Amt;
      slice2Amt = 0n;
      const f1 = batch.fills.find((f) => f.client_id === slice1Id && f.status === 'filled');
      if (f1 !== undefined) {
        const fill1N = Number(f1.price) / scale;
        if (closeN <= fill1N * (1 + TOL_BPS / 10_000)) {
          return [{ side: 'buy' as const, symbol: SYM, notional_quote_units: amt, max_slippage_bps: SLIP_BPS, client_id: cid() }];
        }
      }
      // slice 2 skipped: fall through to the exit check below.
    }
    // 5) Normal exit: take profit, stop loss, or max hold.
    if (qty > 0n && failsafe === 0 && exitStage === 0) {
      const unr = Number(state.value(SYM, qty)) / Number(cost) - 1;
      if (unr >= TP_BPS / 10_000 || unr <= SL_BPS / 10_000 || state.seq - entrySeq >= MAX_HOLD) {
        roundtrips++;
        return sellAll();
      }
    }
    // 6) Normal entry: sharp flush + bounce bar, at most MAX_RT round trips.
    if (qty === 0n && failsafe === 0 && !locked && roundtrips < MAX_RT) {
      const lo = Math.max(0, closes.length - H);
      let hi = 0;
      for (let i = lo; i < closes.length; i++) if (closes[i]! > hi) hi = closes[i]!;
      const dip = closeN / hi - 1;
      const bounced = closeN > openN;
      if (dip <= DIP_BPS / 10_000 && bounced) {
        const slice = (eq * BigInt(SLICE_BPS)) / 10_000n;
        if (slice >= MIN_NOTIONAL) {
          const id = cid();
          slice1Id = id;
          slice2Amt = slice;
          slice2Seq = state.seq + 1;
          entrySeq = state.seq;
          return [{ side: 'buy' as const, symbol: SYM, notional_quote_units: slice, max_slippage_bps: SLIP_BPS, client_id: id }];
        }
      }
    }
    return [];
  },
});
