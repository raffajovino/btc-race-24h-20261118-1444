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
// Exits split too: any exit of a position above 40% of equity sells half,
// then the rest on the next bar (EXIT_1 -> EXIT_2 -> FLAT), so a profitable
// mid-day position never waits for T-2 and never pays a full-size exit impact.
// Hard guardrails: a 15% equity-drawdown circuit breaker (liquidate + lock,
// never near the 25% disqualification line) and an isolated $15 failsafe round
// trip at ~20 minutes remaining if zero filled orders (single buy, single
// sell, no split paths — its impact is ~0.1 bps). Final exit staggered T-2
// (sell half) / T-1 (sell rest), keyed to remaining window time so missing
// bars cannot strand a position into the forced flatten.
// Warmup: this kit carries no warmup_bars (dataset holds exactly the 1440
// scored bars), so the buffer starts empty. The entry filter needs no warmup:
// the -150 bps dip is an ABSOLUTE threshold vs the running trailing high, not
// a percentile, so it cannot be biased by a thin early sample — the -150 bps
// level is itself the absolute floor (3x the 40-50 bps ATR floor a percentile
// filter would need). A 10-bar minimum history guard blocks degenerate
// first-minutes artifacts.
import { runBars } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';
const H = 240; // trailing-high lookback, bars
const DIP_BPS = -150; // entry dip vs trailing high, bps (absolute floor)
const TP_BPS = 120; // take profit over average cost, bps
const SL_BPS = -150; // stop loss vs average cost, bps
const MAX_HOLD = 360; // bars
const MAX_RT = 2; // max round trips, then cash only
const SLICE_BPS = 4000; // each TWAP slice, bps of equity (40% + 40% = 80%)
const TOL_BPS = 40; // slice-2 tolerance above fill 1, bps
const SPLIT_MIN_BPS = 4000; // split an exit when position > 40% of equity
const BREAKER_BPS = 1500; // 15% equity drawdown -> liquidate + lock
const FAILSAFE_NOTIONAL = 15_000_000n; // $15 in quote units
const FAILSAFE_MS = 1_200_000; // failsafe at ~20 minutes remaining
const ENTRY_CUTOFF_MS = 1_800_000; // no normal entries in the last 30 min
const EXIT1_MS = 180_000; // T-2: sell half when <= 3 min remain
const EXIT2_MS = 120_000; // T-1: sell rest when <= 2 min remain
const WINDOW_MS = 1440 * 60_000; // 24h window
const MIN_HISTORY = 10; // bars of closes before the first entry
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
let exitStage = 0; // 0 not exiting, 1 half sold, rest pending next bar
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

    // 1) Circuit breaker: 15% equity drawdown -> liquidate all at once, lock.
    if (!locked && qty > 0n && ddBps >= BREAKER_BPS) {
      locked = true;
      roundtrips++;
      exitStage = 0;
      return sellAll();
    }
    // 2) Complete a split exit: sell the remaining half on the next bar.
    if (exitStage === 1 && qty > 0n) {
      roundtrips++;
      exitStage = 0;
      return sellAll();
    }
    // 3) T-1: sell everything left (covers jumps from missing bars too).
    if (qty > 0n && remainMs <= EXIT2_MS) {
      if (failsafe === 0) roundtrips++;
      exitStage = 0;
      return sellAll();
    }
    // 4) T-2: sell half (strategy positions only; failsafe never splits).
    if (qty > 0n && failsafe === 0 && exitStage === 0 && remainMs <= EXIT1_MS) {
      exitStage = 1;
      return [{ side: 'sell' as const, symbol: SYM, qty: qty / 2n, max_slippage_bps: SLIP_BPS, client_id: cid() }];
    }
    // 5) Failsafe buy, isolated: one $15 order at ~20 min remaining.
    if (failsafe === 0 && filled === 0 && remainMs <= FAILSAFE_MS && !locked) {
      failsafe = 1;
      return [{ side: 'buy' as const, symbol: SYM, notional_quote_units: FAILSAFE_NOTIONAL, max_slippage_bps: SLIP_BPS, client_id: cid() }];
    }
    // 6) Failsafe sell, isolated: single sell on the next bar, flat before T-1.
    if (failsafe === 1 && qty > 0n) {
      failsafe = 2;
      return sellAll();
    }
    // 7) TWAP slice 2: only if the price has not run past tolerance.
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
    // 8) Normal exit: take profit, stop loss, or max hold; split when large.
    if (qty > 0n && failsafe === 0 && exitStage === 0) {
      const value = Number(state.value(SYM, qty));
      const unr = value / Number(cost) - 1;
      if (unr >= TP_BPS / 10_000 || unr <= SL_BPS / 10_000 || state.seq - entrySeq >= MAX_HOLD) {
        if (value > (Number(eq) * SPLIT_MIN_BPS) / 10_000) {
          exitStage = 1;
          return [{ side: 'sell' as const, symbol: SYM, qty: qty / 2n, max_slippage_bps: SLIP_BPS, client_id: cid() }];
        }
        roundtrips++;
        return sellAll();
      }
    }
    // 9) Normal entry: sharp flush + bounce bar, at most MAX_RT round trips,
    // not in the last 30 minutes, at least MIN_HISTORY bars of closes.
    if (qty === 0n && failsafe === 0 && !locked && roundtrips < MAX_RT && remainMs > ENTRY_CUTOFF_MS && closes.length >= MIN_HISTORY) {
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
