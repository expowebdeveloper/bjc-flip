import React, { useState, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Area, AreaChart } from 'recharts';

// ---------- Formatting helpers ----------
const fmt$ = (n) => {
  if (!isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(Math.round(n));
  return sign + '$' + abs.toLocaleString();
};
const fmtPct = (n, digits = 1) => isFinite(n) ? (n * 100).toFixed(digits) + '%' : '—';
const fmtNum = (n) => isFinite(n) ? Math.round(n).toLocaleString() : '—';

// ---------- The model (mirrors the spreadsheet) ----------
function computeModel(i) {
  const purchase = +i.purchase || 0;
  const reno = +i.reno || 0;
  const arv = +i.arv || 0;
  const months = Math.max(1, Math.min(13, +i.months || 0));

  // Section 2 — Loan sizing (smallest of 3)
  const ltc90 = 0.9 * (purchase + reno);
  const lp85 = 0.85 * purchase + reno;
  const arv70 = 0.7 * arv;
  const loan = Math.min(ltc90, lp85, arv70);

  const budgetEscrow = reno;
  const releasedAtClose = loan - budgetEscrow;
  const downPayment = purchase - releasedAtClose;

  const intRate = +i.intRate || 0;

  // Section 3 — Holding cost schedule (% drawn: 25/50/75/100/100/100... up to month)
  const drawPct = (m) => {
    if (m === 1) return 0.25;
    if (m === 2) return 0.50;
    if (m === 3) return 0.75;
    return 1.0;
  };
  const schedule = [];
  let cum = 0;
  for (let m = 1; m <= 13; m++) {
    let pmt = 0;
    if (m <= months) {
      pmt = (intRate / 12) * (releasedAtClose + drawPct(m) * budgetEscrow);
    }
    cum += pmt;
    schedule.push({ month: m, drawPct: m <= months ? drawPct(m) : 0, payment: pmt, cumulative: cum });
  }
  const holdingCost = schedule[months - 1]?.cumulative ?? 0;

  // Section 4 — Buy-side costs
  const buyRealtor = (+i.buyRealtorRate || 0) * purchase;
  const buyTaxesTitle = (+i.buyTaxesTitleRate || 0) * purchase;
  const lenderProcessing = +i.lenderProcessing || 0;
  const lenderOrig = (+i.lenderOrigRate || 0) * loan;
  const appraisal = +i.appraisal || 0;
  const buySide = buyRealtor + buyTaxesTitle + lenderProcessing + lenderOrig + appraisal;

  // Section 5 — Sell-side costs
  const sellRealtor = (+i.sellRealtorRate || 0) * arv;
  const sellTaxesTitle = (+i.sellTaxesTitleRate || 0) * arv;
  const sellSide = sellRealtor + sellTaxesTitle;

  // Section 6 — GAP loan
  const useGap = !!i.useGap;
  const gapPoints = +i.gapPoints || 0;
  const gapRate = +i.gapRate || 0;
  const gapType = i.gapType || 'Straight';
  const useGapEquity = !!i.useGapEquity;
  const gapEquityPct = +i.gapEquityPct || 0;
  const gapLoan = useGap ? downPayment + buySide : 0;
  const gapCost = useGap
    ? gapLoan * gapPoints +
      (gapType === 'Straight' ? gapLoan * gapRate : (gapLoan * gapRate) / 12 * months)
    : 0;

  // Section 7 — Profitability  (spreadsheet F32 = F26 - SUM(F27:F31): buy + holding + sell + lender + gap)
  const salePrice = arv;
  const returnedAtSale = salePrice - buySide - holdingCost - sellSide - loan - gapCost;
  const netProfitGross = returnedAtSale - downPayment;
  const gapEquityShare = useGap && useGapEquity ? netProfitGross * gapEquityPct : 0;
  const yourProfit = netProfitGross - gapEquityShare;
  const cashIn = downPayment + buySide;
  const roi = cashIn > 0 ? yourProfit / cashIn : 0;

  // Section 8 — Deal check
  const profitMinPct = +i.profitMinPct || 0;
  const profitMinFloor = +i.profitMinFloor || 0;
  const profitMin = Math.max(profitMinPct * arv, profitMinFloor);
  const dealOk = yourProfit >= profitMin;

  // Section 5c — MAO
  const mao65 = arv * 0.65 - reno;
  const mao70 = arv * 0.70 - reno;
  const mao75 = arv * 0.75 - reno;
  const desiredProfitPct = +i.desiredProfitPct || 0;
  const desiredProfit$ = arv * desiredProfitPct;
  const detailedMAO = arv - reno - buySide - holdingCost - sellSide - desiredProfit$;
  const maoVsCurrent = detailedMAO - purchase;

  // Section 9 — Sensitivity table (-50k..+50k step 10k around ARV)
  const sensitivity = [];
  for (let delta = -50000; delta <= 50000; delta += 10000) {
    const sale = arv + delta;
    const afterSell = sale - sale * ((+i.sellRealtorRate || 0) + (+i.sellTaxesTitleRate || 0));
    const netGross = afterSell - buySide - holdingCost - loan - gapCost - downPayment;
    const eq = useGap && useGapEquity ? Math.max(0, netGross) * gapEquityPct : 0;
    const yours = netGross - eq;
    const r = cashIn > 0 ? yours / cashIn : 0;
    sensitivity.push({ sale, afterSell, netGross, yours, roi: r, delta });
  }

  return {
    ltc90, lp85, arv70, loan, budgetEscrow, releasedAtClose, downPayment,
    schedule, holdingCost,
    buyRealtor, buyTaxesTitle, lenderProcessing, lenderOrig, appraisal, buySide,
    sellRealtor, sellTaxesTitle, sellSide,
    gapLoan, gapCost,
    salePrice, returnedAtSale, netProfitGross, gapEquityShare, yourProfit, cashIn, roi,
    profitMin, dealOk,
    mao65, mao70, mao75, desiredProfit$, detailedMAO, maoVsCurrent,
    sensitivity,
  };
}

// ---------- BJC Brand Tokens ----------
// #0741AD = deep royal blue (primary)
// #3590D6 = light sky blue (accent, the "b" loop)

// ---------- BJC Logo (inline SVG, scales cleanly) ----------
const BJCLogo = ({ height = 44 }) => (
  <svg viewBox="0 0 340 100" height={height} xmlns="http://www.w3.org/2000/svg" aria-label="Bluejacket Capital Partners">
    {/* outer royal blue bar */}
    <rect x="0" y="0" width="340" height="100" fill="#0741AD" />
    {/* white knockout box for the b mark */}
    <rect x="8" y="8" width="68" height="84" fill="#FFFFFF" />
    {/* the b: thin stem + open circle, light blue */}
    <g stroke="#3590D6" strokeWidth="3.5" fill="none" strokeLinecap="round">
      <line x1="36" y1="22" x2="36" y2="62" />
      <circle cx="44" cy="68" r="14" />
    </g>
    {/* wordmark */}
    <text
      x="92" y="62"
      fill="#FFFFFF"
      style={{ fontFamily: '"Quicksand", "Comfortaa", sans-serif', fontWeight: 300, fontSize: '24px', letterSpacing: '0.02em' }}
    >
      bluejacket capital partners
    </text>
  </svg>
);

// ---------- UI primitives ----------
const NumInput = ({ value, onChange, prefix, suffix, step = 1, className = '' }) => (
  <div className={`relative ${className}`}>
    {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm font-medium select-none">{prefix}</span>}
    <input
      type="number"
      value={value}
      step={step}
      onChange={(e) => onChange(e.target.value === '' ? 0 : parseFloat(e.target.value))}
      className={`w-full bg-sky-50/40 border border-slate-300 rounded py-2 text-right text-slate-900 font-mono text-sm focus:outline-none focus:border-[#0741AD] focus:ring-1 focus:ring-[#0741AD]/30 focus:bg-white transition-all ${prefix ? 'pl-7' : 'pl-3'} ${suffix ? 'pr-7' : 'pr-3'}`}
    />
    {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm font-medium select-none">{suffix}</span>}
  </div>
);

const PctInput = ({ value, onChange, className = '' }) => (
  <div className={`relative ${className}`}>
    <input
      type="number"
      step="0.01"
      value={(value * 100).toFixed(2)}
      onChange={(e) => {
        const v = e.target.value === '' ? 0 : parseFloat(e.target.value) / 100;
        onChange(v);
      }}
      className="w-full bg-sky-50/40 border border-slate-300 rounded pl-3 pr-7 py-2 text-right text-slate-900 font-mono text-sm focus:outline-none focus:border-[#0741AD] focus:ring-1 focus:ring-[#0741AD]/30 focus:bg-white transition-all"
    />
    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm font-medium select-none">%</span>
  </div>
);

const Select = ({ value, onChange, options, className = '' }) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className={`w-full bg-sky-50/40 border border-slate-300 rounded px-3 py-2 text-slate-900 text-sm focus:outline-none focus:border-[#0741AD] focus:ring-1 focus:ring-[#0741AD]/30 focus:bg-white transition-all ${className}`}
  >
    {options.map((o) => <option key={o} value={o}>{o}</option>)}
  </select>
);

const Field = ({ label, children, hint }) => (
  <div className="grid grid-cols-[1fr_auto] items-center gap-3 py-1.5">
    <label className="text-sm text-slate-700">
      {label}
      {hint && <span className="block text-xs text-slate-500 mt-0.5">{hint}</span>}
    </label>
    <div className="w-40">{children}</div>
  </div>
);

const SectionCard = ({ num, title, children, accent = 'primary' }) => {
  const accentClass = {
    primary: 'border-t-[#0741AD]',
    sky: 'border-t-[#3590D6]',
  }[accent];
  return (
    <section className={`bg-white border border-slate-200 border-t-4 ${accentClass} rounded shadow-[0_2px_8px_rgba(7,65,173,0.06)]`}>
      <header className="px-5 pt-4 pb-3 border-b border-slate-100">
        <div className="flex items-baseline gap-3">
          <span className="text-xs font-mono text-[#3590D6] tracking-widest font-medium">§{num}</span>
          <h2 className="text-base font-semibold text-slate-900 tracking-tight bjc-display">{title}</h2>
        </div>
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
};

const StatRow = ({ label, value, emphasis = false, indent = false }) => (
  <div className={`flex items-baseline justify-between py-1 ${indent ? 'pl-4' : ''} ${emphasis ? 'border-t border-slate-300 pt-2 mt-1' : ''}`}>
    <span className={`text-sm ${emphasis ? 'font-semibold text-slate-900' : 'text-slate-700'}`}>{label}</span>
    <span className={`font-mono text-sm tabular-nums ${emphasis ? 'font-bold text-[#0741AD]' : 'text-slate-800'}`}>{value}</span>
  </div>
);

// ---------- Main App ----------
export default function FlipCalculator() {
  const [inp, setInp] = useState({
    address: '4527 Main Street',
    purchase: 742500,
    reno: 200000,
    arv: 1250000,
    months: 6,
    intRate: 0.1025,
    buyRealtorRate: 0,
    buyTaxesTitleRate: 0.0125,
    lenderProcessing: 1475,
    lenderOrigRate: 0.0125,
    appraisal: 650,
    sellRealtorRate: 0.05,
    sellTaxesTitleRate: 0.0125,
    useGap: false,
    gapPoints: 0,
    gapRate: 0,
    gapType: 'Straight',
    useGapEquity: false,
    gapEquityPct: 0.5,
    desiredProfitPct: 0.15,
    profitMinPct: 0.10,
    profitMinFloor: 50000,
  });
  const upd = (k) => (v) => setInp((s) => ({ ...s, [k]: v }));

  const [comps, setComps] = useState([
    { addr: '123 Main Street', price: 80000, sqft: 4000, date: '2025-10-31' },
    { addr: '1234 Main Street', price: 90000, sqft: 5000, date: '2025-11-02' },
    { addr: '12345 Main Street', price: 180000, sqft: 8000, date: '2025-11-03' },
    { addr: '123456 Main Street', price: 200000, sqft: 9000, date: '2026-11-05' },
    { addr: '1234567 Main Street', price: 30000, sqft: 800, date: '2026-11-06' },
  ]);
  const updComp = (idx, k, v) => setComps((c) => c.map((x, i) => i === idx ? { ...x, [k]: v } : x));

  const m = useMemo(() => computeModel(inp), [inp]);

  const compStats = useMemo(() => {
    const ppsf = comps.map(c => (c.price && c.sqft) ? c.price / c.sqft : null).filter(x => x != null);
    const prices = comps.map(c => +c.price).filter(x => x > 0);
    const median = (a) => {
      const s = [...a].sort((x, y) => x - y);
      const n = s.length; if (!n) return 0;
      return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    };
    const avg = (a) => a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0;
    return {
      medianPrice: median(prices), avgPrice: avg(prices),
      medianPpsf: median(ppsf), avgPpsf: avg(ppsf),
    };
  }, [comps]);

  // ---------- Render ----------
  return (
    <div className="min-h-screen bg-slate-50" style={{ fontFamily: '"Inter", system-ui, sans-serif' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Quicksand:wght@300;400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        body { font-family: 'Inter', system-ui, sans-serif; }
        .bjc-display { font-family: 'Quicksand', sans-serif; font-weight: 500; letter-spacing: -0.01em; }
        .bjc-wordmark { font-family: 'Quicksand', sans-serif; font-weight: 300; letter-spacing: 0.02em; }
        .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
      `}</style>

      {/* BJC header — royal blue bar with logo */}
      <header className="bg-[#0741AD] text-white">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between gap-6 flex-wrap">
          <div className="flex items-center gap-5">
            {/* Logo: white square with light-blue "b", followed by wordmark */}
            <div className="bg-white px-3 py-2.5 rounded-sm shadow-sm">
              <svg viewBox="0 0 60 70" width="36" height="42" xmlns="http://www.w3.org/2000/svg" aria-label="BJC">
                <g stroke="#3590D6" strokeWidth="3" fill="none" strokeLinecap="round">
                  <line x1="22" y1="8" x2="22" y2="42" />
                  <circle cx="30" cy="48" r="14" />
                </g>
              </svg>
            </div>
            <div>
              <div className="bjc-wordmark text-xl text-white leading-tight">bluejacket capital partners</div>
              <div className="text-[10px] tracking-[0.3em] text-sky-200 mono mt-0.5">FLIP DEAL ANALYZER  ·  v5</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] tracking-[0.25em] text-sky-200 mono">SUBJECT PROPERTY</div>
            <input
              value={inp.address}
              onChange={(e) => upd('address')(e.target.value)}
              className="bg-transparent border-b border-sky-300/40 text-white text-right text-base bjc-display focus:outline-none focus:border-sky-200 mt-1 min-w-[260px] placeholder:text-sky-200/50"
            />
          </div>
        </div>
        {/* thin accent stripe */}
        <div className="h-1 bg-[#3590D6]" />
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">

        {/* HERO: Deal verdict */}
        <div className={`relative overflow-hidden rounded border-2 ${m.dealOk ? 'border-emerald-600 bg-emerald-50' : 'border-rose-600 bg-rose-50'} p-6`}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-center">
            <div>
              <div className="text-xs tracking-widest mono text-slate-600">DEAL VERDICT</div>
              <div className={`bjc-display text-6xl font-semibold leading-none mt-2 ${m.dealOk ? 'text-emerald-700' : 'text-rose-700'}`}>
                {m.dealOk ? 'YES.' : 'NOPE.'}
              </div>
              <div className="text-xs text-slate-600 mt-2">{m.dealOk ? 'Profit clears your minimum threshold.' : 'Profit falls short of your minimum threshold.'}</div>
            </div>
            <div>
              <div className="text-xs tracking-widest mono text-slate-600">YOUR PROFIT</div>
              <div className="bjc-display text-3xl font-semibold text-slate-900 mt-2">{fmt$(m.yourProfit)}</div>
              <div className="text-xs text-slate-600 mt-1">vs. minimum of {fmt$(m.profitMin)}</div>
            </div>
            <div>
              <div className="text-xs tracking-widest mono text-slate-600">ROI</div>
              <div className="bjc-display text-3xl font-semibold text-slate-900 mt-2">{fmtPct(m.roi, 1)}</div>
              <div className="text-xs text-slate-600 mt-1">on {fmt$(m.cashIn)} cash in</div>
            </div>
            <div>
              <div className="text-xs tracking-widest mono text-slate-600">LOAN AMOUNT</div>
              <div className="bjc-display text-3xl font-semibold text-slate-900 mt-2">{fmt$(m.loan)}</div>
              <div className="text-xs text-slate-600 mt-1">{m.loan === m.ltc90 ? '90% LTC' : m.loan === m.lp85 ? '85% Purchase+Reno' : '70% ARV'} (binding)</div>
            </div>
          </div>
        </div>

        {/* Row 1: Inputs */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <SectionCard num="1" title="Property & Project" accent="primary">
            <Field label="Purchase Price"><NumInput value={inp.purchase} onChange={upd('purchase')} prefix="$" step={1000} /></Field>
            <Field label="Renovation Budget"><NumInput value={inp.reno} onChange={upd('reno')} prefix="$" step={1000} /></Field>
            <Field label="ARV (After-Repair Value)"><NumInput value={inp.arv} onChange={upd('arv')} prefix="$" step={1000} /></Field>
            <Field label="Project Months"><NumInput value={inp.months} onChange={upd('months')} step={1} /></Field>
          </SectionCard>

          <SectionCard num="2" title="Loan Sizing (auto)" accent="sky">
            <StatRow label="90% Total Cost (LTC)" value={fmt$(m.ltc90)} />
            <StatRow label="85% Purchase + Reno" value={fmt$(m.lp85)} />
            <StatRow label="70% ARV" value={fmt$(m.arv70)} />
            <StatRow label="Loan Amount (min)" value={fmt$(m.loan)} emphasis />
            <div className="mt-3 pt-3 border-t border-slate-200 space-y-1">
              <StatRow label="Budget Escrow (Reno)" value={fmt$(m.budgetEscrow)} />
              <StatRow label="Released at Close" value={fmt$(m.releasedAtClose)} />
              <StatRow label="Down Payment" value={fmt$(m.downPayment)} emphasis />
            </div>
            <Field label="Interest Rate (annual)"><PctInput value={inp.intRate} onChange={upd('intRate')} /></Field>
          </SectionCard>

          <SectionCard num="3" title="Holding Cost (monthly)" accent="sky">
            <div className="text-xs text-slate-500 mb-2">Accrues on drawn balance · default draw 25/50/75/100%</div>
            <div className="grid grid-cols-4 gap-1 text-xs mono">
              <div className="text-slate-500 pb-1 border-b border-slate-200">Mo</div>
              <div className="text-slate-500 pb-1 border-b border-slate-200 text-right">Draw</div>
              <div className="text-slate-500 pb-1 border-b border-slate-200 text-right">Pmt</div>
              <div className="text-slate-500 pb-1 border-b border-slate-200 text-right">Cum</div>
              {m.schedule.slice(0, inp.months).map((r) => (
                <React.Fragment key={r.month}>
                  <div className="text-slate-700">{r.month}</div>
                  <div className="text-right text-slate-700">{(r.drawPct * 100).toFixed(0)}%</div>
                  <div className="text-right text-slate-700">{fmt$(r.payment)}</div>
                  <div className="text-right text-slate-900 font-medium">{fmt$(r.cumulative)}</div>
                </React.Fragment>
              ))}
            </div>
            <div className="mt-3 pt-3 border-t border-slate-300">
              <StatRow label="Total Holding Cost" value={fmt$(m.holdingCost)} emphasis />
            </div>
          </SectionCard>
        </div>

        {/* Row 2: Costs */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SectionCard num="4" title="Buy-Side Costs" accent="primary">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center text-xs text-slate-500 mono pb-1 border-b border-slate-200">
              <div>Item</div><div className="w-28 text-right">Rate</div><div className="w-28 text-right">$</div>
            </div>
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-1.5">
              <span className="text-sm text-slate-700">Realtor Commissions</span>
              <div className="w-28"><PctInput value={inp.buyRealtorRate} onChange={upd('buyRealtorRate')} /></div>
              <div className="w-28 text-right mono text-sm text-slate-800">{fmt$(m.buyRealtor)}</div>
            </div>
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-1.5">
              <span className="text-sm text-slate-700">Taxes & Title</span>
              <div className="w-28"><PctInput value={inp.buyTaxesTitleRate} onChange={upd('buyTaxesTitleRate')} /></div>
              <div className="w-28 text-right mono text-sm text-slate-800">{fmt$(m.buyTaxesTitle)}</div>
            </div>
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-1.5">
              <span className="text-sm text-slate-700">Lender Processing Fee</span>
              <div className="w-28"><NumInput value={inp.lenderProcessing} onChange={upd('lenderProcessing')} prefix="$" /></div>
              <div className="w-28 text-right mono text-sm text-slate-800">{fmt$(m.lenderProcessing)}</div>
            </div>
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-1.5">
              <span className="text-sm text-slate-700">Lender Origination</span>
              <div className="w-28"><PctInput value={inp.lenderOrigRate} onChange={upd('lenderOrigRate')} /></div>
              <div className="w-28 text-right mono text-sm text-slate-800">{fmt$(m.lenderOrig)}</div>
            </div>
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-1.5">
              <span className="text-sm text-slate-700">Appraisal</span>
              <div className="w-28"><NumInput value={inp.appraisal} onChange={upd('appraisal')} prefix="$" /></div>
              <div className="w-28 text-right mono text-sm text-slate-800">{fmt$(m.appraisal)}</div>
            </div>
            <StatRow label="Total Buy-Side" value={fmt$(m.buySide)} emphasis />
          </SectionCard>

          <SectionCard num="5" title="Sell-Side Costs" accent="primary">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center text-xs text-slate-500 mono pb-1 border-b border-slate-200">
              <div>Item</div><div className="w-28 text-right">Rate</div><div className="w-28 text-right">$</div>
            </div>
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-1.5">
              <span className="text-sm text-slate-700">Realtor Commissions</span>
              <div className="w-28"><PctInput value={inp.sellRealtorRate} onChange={upd('sellRealtorRate')} /></div>
              <div className="w-28 text-right mono text-sm text-slate-800">{fmt$(m.sellRealtor)}</div>
            </div>
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-1.5">
              <span className="text-sm text-slate-700">Taxes & Title</span>
              <div className="w-28"><PctInput value={inp.sellTaxesTitleRate} onChange={upd('sellTaxesTitleRate')} /></div>
              <div className="w-28 text-right mono text-sm text-slate-800">{fmt$(m.sellTaxesTitle)}</div>
            </div>
            <StatRow label="Total Sell-Side" value={fmt$(m.sellSide)} emphasis />

            <div className="mt-6 pt-4 border-t border-slate-200">
              <div className="text-xs tracking-widest mono text-slate-500 mb-2">DEAL CHECK PARAMETERS</div>
              <Field label="Profit Min %" hint="of ARV"><PctInput value={inp.profitMinPct} onChange={upd('profitMinPct')} /></Field>
              <Field label="Profit Min Floor"><NumInput value={inp.profitMinFloor} onChange={upd('profitMinFloor')} prefix="$" step={1000} /></Field>
              <StatRow label="Profit Min $ = MAX(% × ARV, Floor)" value={fmt$(m.profitMin)} emphasis />
            </div>
          </SectionCard>
        </div>

        {/* Row 3: GAP loan */}
        <SectionCard num="6" title="GAP Loan (optional second-position)" accent="sky">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <Field label="Use GAP loan?">
                <Select value={inp.useGap ? 'Yes' : 'No'} onChange={(v) => upd('useGap')(v === 'Yes')} options={['No', 'Yes']} />
              </Field>
              <Field label="GAP Points (% of GAP loan)"><PctInput value={inp.gapPoints} onChange={upd('gapPoints')} /></Field>
              <Field label="GAP Interest Rate (annual)"><PctInput value={inp.gapRate} onChange={upd('gapRate')} /></Field>
              <Field label="GAP Interest Type">
                <Select value={inp.gapType} onChange={upd('gapType')} options={['Straight', 'Monthly']} />
              </Field>
              <Field label="GAP Equity Share?">
                <Select value={inp.useGapEquity ? 'Yes' : 'No'} onChange={(v) => upd('useGapEquity')(v === 'Yes')} options={['No', 'Yes']} />
              </Field>
              <Field label="GAP Equity % of Net Profit"><PctInput value={inp.gapEquityPct} onChange={upd('gapEquityPct')} /></Field>
            </div>
            <div className={`p-4 rounded ${inp.useGap ? 'bg-sky-50 border border-sky-200' : 'bg-slate-100 border border-slate-200 opacity-60'}`}>
              <div className="text-xs tracking-widest mono text-slate-500 mb-3">GAP LOAN — COMPUTED</div>
              <StatRow label="GAP Loan Amount" value={fmt$(m.gapLoan)} />
              <StatRow label="GAP Cost (Points + Interest)" value={fmt$(m.gapCost)} emphasis />
              <p className="text-xs text-slate-600 mt-4 leading-relaxed">
                A GAP loan covers your <em>Down Payment + Buy-Side</em> so you can close with little or no cash. In exchange, the GAP lender takes points, interest, and—if equity share is on—a slice of your back-end profit. Off by default.
              </p>
            </div>
          </div>
        </SectionCard>

        {/* Row 4: Deal Profitability */}
        <SectionCard num="7" title="Deal Profitability" accent="primary">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <StatRow label="Sale Price (ARV)" value={fmt$(m.salePrice)} />
              <StatRow label="− Buy-Side Cost" value={fmt$(-m.buySide)} indent />
              <StatRow label="− Holding Cost" value={fmt$(-m.holdingCost)} indent />
              <StatRow label="− Sell-Side Cost" value={fmt$(-m.sellSide)} indent />
              <StatRow label="− Lender Payoff" value={fmt$(-m.loan)} indent />
              <StatRow label="− GAP Cost" value={fmt$(-m.gapCost)} indent />
              <StatRow label="= Returned at Sale" value={fmt$(m.returnedAtSale)} emphasis />
              <StatRow label="− Down Payment" value={fmt$(-m.downPayment)} indent />
              <StatRow label="= Net Profit (Gross)" value={fmt$(m.netProfitGross)} emphasis />
              <StatRow label="− GAP Equity Share" value={fmt$(-m.gapEquityShare)} indent />
            </div>
            <div className="flex flex-col justify-center gap-4">
              <div className="bg-gradient-to-br from-[#0741AD] to-[#0a4fc8] text-white p-5 rounded shadow-lg">
                <div className="text-xs tracking-widest text-sky-200 mono">YOUR PROFIT</div>
                <div className="bjc-display text-5xl font-semibold mt-1">{fmt$(m.yourProfit)}</div>
              </div>
              <div className="bg-sky-50 border border-[#3590D6] p-5 rounded">
                <div className="text-xs tracking-widest text-slate-600 mono">ROI · YOUR $ ÷ CASH IN</div>
                <div className="bjc-display text-4xl font-semibold text-[#0741AD] mt-1">{fmtPct(m.roi, 1)}</div>
                <div className="text-xs text-slate-600 mt-1 mono">Cash In = {fmt$(m.cashIn)}</div>
              </div>
            </div>
          </div>
        </SectionCard>

        {/* Row 5: Comps + MAO */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SectionCard num="5b" title="Comparables — Top 5" accent="sky">
            <div className="text-xs text-slate-500 mb-2 mono">$/SqFt auto-calculates</div>
            <div className="space-y-2">
              {comps.map((c, i) => {
                const ppsf = c.price && c.sqft ? c.price / c.sqft : 0;
                return (
                  <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center border-b border-slate-100 pb-2">
                    <input
                      value={c.addr}
                      onChange={(e) => updComp(i, 'addr', e.target.value)}
                      className="bg-sky-50/40 border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#0741AD]"
                    />
                    <input
                      type="number"
                      value={c.price}
                      onChange={(e) => updComp(i, 'price', +e.target.value || 0)}
                      className="w-24 bg-sky-50/40 border border-slate-300 rounded px-2 py-1 text-sm text-right mono focus:outline-none focus:border-[#0741AD]"
                    />
                    <input
                      type="number"
                      value={c.sqft}
                      onChange={(e) => updComp(i, 'sqft', +e.target.value || 0)}
                      className="w-20 bg-sky-50/40 border border-slate-300 rounded px-2 py-1 text-sm text-right mono focus:outline-none focus:border-[#0741AD]"
                    />
                    <div className="w-16 text-right mono text-sm text-slate-700">${ppsf.toFixed(0)}/sf</div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 pt-3 border-t border-slate-300 space-y-1">
              <StatRow label="Median $/SqFt" value={`$${compStats.medianPpsf.toFixed(2)}`} />
              <StatRow label="Average $/SqFt" value={`$${compStats.avgPpsf.toFixed(2)}`} />
              <StatRow label="Median Sale Price" value={fmt$(compStats.medianPrice)} />
              <StatRow label="Average Sale Price" value={fmt$(compStats.avgPrice)} />
            </div>
          </SectionCard>

          <SectionCard num="5c" title="MAO — Maximum Allowable Offer" accent="primary">
            <div className="text-xs tracking-widest mono text-slate-500 mb-2">QUICK RULES (% of ARV − Reno)</div>
            <StatRow label="65% Rule" value={fmt$(m.mao65)} />
            <StatRow label="70% Rule (industry standard)" value={fmt$(m.mao70)} />
            <StatRow label="75% Rule" value={fmt$(m.mao75)} />

            <div className="mt-5 pt-4 border-t border-slate-200">
              <div className="text-xs tracking-widest mono text-slate-500 mb-2">DETAILED MAO (using your costs)</div>
              <Field label="Desired Profit (% of ARV)"><PctInput value={inp.desiredProfitPct} onChange={upd('desiredProfitPct')} /></Field>
              <StatRow label="ARV" value={fmt$(inp.arv)} />
              <StatRow label="− Renovation Budget" value={fmt$(-inp.reno)} indent />
              <StatRow label="− Buy-Side Costs (est.)" value={fmt$(-m.buySide)} indent />
              <StatRow label="− Holding Costs (est.)" value={fmt$(-m.holdingCost)} indent />
              <StatRow label="− Sell-Side Costs (est.)" value={fmt$(-m.sellSide)} indent />
              <StatRow label="− Desired Profit" value={fmt$(-m.desiredProfit$)} indent />
              <StatRow label="= DETAILED MAO" value={fmt$(m.detailedMAO)} emphasis />
              <div className={`mt-2 p-3 rounded ${m.maoVsCurrent >= 0 ? 'bg-emerald-50 border border-emerald-200' : 'bg-rose-50 border border-rose-200'}`}>
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-slate-700">vs Current Purchase Price</span>
                  <span className={`mono font-bold ${m.maoVsCurrent >= 0 ? 'text-emerald-800' : 'text-rose-800'}`}>{fmt$(m.maoVsCurrent)}</span>
                </div>
                <div className="text-xs text-slate-600 mt-1">
                  {m.maoVsCurrent >= 0 ? '✓ At or under MAO — good.' : '✗ Over MAO — negotiate price down.'}
                </div>
              </div>
            </div>
          </SectionCard>
        </div>

        {/* Row 6: Sensitivity */}
        <SectionCard num="9" title="Sensitivity — Profit vs Sale Price" accent="primary">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-6">
            <div>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={m.sensitivity} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                  <defs>
                    <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0741AD" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#3590D6" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="sale"
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                    tick={{ fontSize: 11, fill: '#64748b', fontFamily: 'JetBrains Mono' }}
                  />
                  <YAxis
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                    tick={{ fontSize: 11, fill: '#64748b', fontFamily: 'JetBrains Mono' }}
                  />
                  <Tooltip
                    formatter={(v) => fmt$(v)}
                    labelFormatter={(v) => `Sale: ${fmt$(v)}`}
                    contentStyle={{ background: '#ffffff', border: '1px solid #0741AD', borderRadius: 4, fontSize: 12 }}
                  />
                  <ReferenceLine y={m.profitMin} stroke="#3590D6" strokeDasharray="4 4" label={{ value: 'Min', fill: '#3590D6', fontSize: 11 }} />
                  <ReferenceLine x={inp.arv} stroke="#64748b" strokeDasharray="2 2" label={{ value: 'ARV', fill: '#64748b', fontSize: 11, position: 'top' }} />
                  <Area type="monotone" dataKey="yours" stroke="#0741AD" strokeWidth={2.5} fill="url(#profitGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs mono">
                <thead>
                  <tr className="border-b-2 border-[#0741AD] text-slate-500">
                    <th className="text-right py-2 px-2">Sale</th>
                    <th className="text-right py-2 px-2">After Sell</th>
                    <th className="text-right py-2 px-2">Net Gross</th>
                    <th className="text-right py-2 px-2">Your $</th>
                    <th className="text-right py-2 px-2">ROI</th>
                  </tr>
                </thead>
                <tbody>
                  {m.sensitivity.map((r) => (
                    <tr key={r.sale} className={`border-b border-slate-100 ${r.delta === 0 ? 'bg-sky-50 font-bold' : ''} ${r.yours >= m.profitMin ? 'text-slate-800' : 'text-rose-700'}`}>
                      <td className="text-right py-1.5 px-2">{fmt$(r.sale)}</td>
                      <td className="text-right py-1.5 px-2">{fmt$(r.afterSell)}</td>
                      <td className="text-right py-1.5 px-2">{fmt$(r.netGross)}</td>
                      <td className="text-right py-1.5 px-2">{fmt$(r.yours)}</td>
                      <td className="text-right py-1.5 px-2">{fmtPct(r.roi)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </SectionCard>

        <footer className="border-t-2 border-[#0741AD] pt-5 mt-8 space-y-1.5">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div className="bjc-wordmark text-[#0741AD] text-sm">bluejacket capital partners</div>
            <div className="text-[10px] tracking-[0.25em] text-slate-400 mono">CONFIDENTIAL · INTERNAL DEAL ANALYSIS</div>
          </div>
          <div className="text-xs text-slate-500 leading-relaxed space-y-1.5">
            <p>•&nbsp; Loan Sizing picks the smaller of 90% LTC, 85% Purchase+Reno, or 70% ARV.</p>
            <p>•&nbsp; Holding Cost accrues monthly: rate/12 × (Released-at-Close + % Reno drawn). Default draw 25/50/75/100%.</p>
            <p>•&nbsp; MAO 70% Rule is the industry standard quick check. Detailed MAO uses YOUR actual cost estimates + desired profit %.</p>
            <p>•&nbsp; GAP Loan covers Down Payment + Buy-Side. Equity Share splits Net Profit at chosen %.</p>
            <p>•&nbsp; Deal? = NOPE → Negotiate price down (see Detailed MAO), trim rehab, shorten hold, or sharpen ARV with comps.</p>
          </div>
        </footer>
      </main>
    </div>
  );
}
