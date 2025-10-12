import React, { useEffect, useMemo, useRef, useState } from "react";

/** ===== 小工具 ===== */
const fmt = (n) => Number(n || 0).toLocaleString();
const isoToDeribitTag = (iso) => {
  try {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map((v) => parseInt(v, 10));
    const MMM = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][m - 1];
    return `${String(d).padStart(2,"0")}${MMM}${String(y).slice(-2)}`; // 25OCT25
  } catch { return ""; }
};
async function withConcurrency(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const cur = items[i++]; try { out.push(await fn(cur)); } catch {}
    }
  });
  await Promise.all(workers); return out;
}

/** ===== 样式 ===== */
const S = {
  page: { minHeight:"100vh", background:"#000", color:"#fff", display:"flex", flexDirection:"column", alignItems:"center", fontFamily:"Inter, -apple-system, Segoe UI, Roboto, sans-serif", padding:"6vh 3vw" },
  price: { fontSize:"14vw", fontWeight:800, lineHeight:1, letterSpacing:"-0.02em" },
  top: { display:"flex", gap:12, alignItems:"center", marginTop:12, flexWrap:"wrap", justifyContent:"center" },
  select: { fontSize:"1.05rem", padding:"10px 14px", background:"#111", color:"#fff", border:"1px solid #333", borderRadius:10 },
  btn: { fontSize:"1rem", padding:"10px 14px", background:"#1b1b1b", color:"#fff", border:"1px solid #333", borderRadius:10, cursor:"pointer" },
  hint: { fontSize:13, color:"#9aa0a6" },
  pills: { display:"flex", gap:16, marginTop:10, flexWrap:"wrap", justifyContent:"center" },
  pill: { background:"#121212", border:"1px solid #222", borderRadius:999, padding:"8px 12px", fontSize:14 },
  wall: { fontSize:"4.8vw", marginTop:"1.6vh" },
  red: { color:"#ff6161" }, green: { color:"#61d861" },
  status: { marginTop:10, fontSize:12, color:"#ffa940", opacity:0.9 },
  section: { width:"100%", maxWidth:980, marginTop:18, color:"#9aa0a6", fontSize:14 },
  tableWrap: { width:"100%", maxWidth:980, marginTop:8 },
  table: { width:"100%", borderCollapse:"collapse", fontSize:"1.05rem" },
  th: { borderBottom:"1px solid #222", padding:"10px 12px", textAlign:"right", color:"#9aa0a6" },
  thL: { textAlign:"left" }, td: { borderBottom:"1px solid #161616", padding:"10px 12px", textAlign:"right" },
  tdL: { textAlign:"left" },
};

export default function App() {
  /** 价格（Binance WebSocket） */
  const [price, setPrice] = useState(null);
  useEffect(() => {
    const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@trade");
    ws.onmessage = (e) => {
      const p = parseFloat(JSON.parse(e.data)?.p);
      if (!Number.isNaN(p)) setPrice(p);
    };
    return () => ws.close();
  }, []);

  /** 到期日选择 */
  const [expiries, setExpiries] = useState([]); // ["2025-10-25", ...]
  const [expiry, setExpiry] = useState("");

  /** OI 数据与墙 */
  const [rows, setRows] = useState([]); // [{strike, putOIbtc, callOIbtc, totalBtc}]
  const [sumPut, setSumPut] = useState(0);
  const [sumCall, setSumCall] = useState(0);
  const [putWall, setPutWall] = useState(null); // {strike, oiBtc}
  const [callWall, setCallWall] = useState(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");   // 页面内错误/提示
  const [dbg, setDbg] = useState({ total:0, matched:0, strikes:0, fallback:false });

  const timerRef = useRef(null);

  /** 拉取到期日（公开接口，无需密钥） */
  const fetchExpiries = async () => {
    try {
      const r = await fetch("https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false");
      const j = await r.json();
      const uniq = [
        ...new Set(
          (j.result || [])
            .map(it => {
              try { return new Date(it.expiry_timestamp).toISOString().split("T")[0]; }
              catch { return null; }
            })
            .filter(Boolean)
        )
      ].sort();
      setExpiries(uniq);
      if (!expiry && uniq.length) setExpiry(uniq[0]);
    } catch (e) {
      console.error("fetchExpiries error:", e);
      setNote("到期日获取失败（Network/CORS）");
    }
  };

  /** 当前到期日的 instrument_name 精确集合 */
  const getNameSet = async (iso) => {
    const r = await fetch("https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false");
    const j = await r.json();
    return new Set(
      (j.result || [])
        .filter(it => {
          try { return new Date(it.expiry_timestamp).toISOString().split("T")[0] === iso; }
          catch { return false; }
        })
        .map(it => it.instrument_name)
    );
  };

  /** 拉取 OI：先用全量 summary 过滤，再不足则兜底逐合约（全部公开接口） */
  const fetchOI = async (iso) => {
    if (!iso) return;
    setLoading(true); setNote("");
    const tag = isoToDeribitTag(iso);
    try {
      const nameSet = await getNameSet(iso);

      // 快速路径：全市场期权 summary
      const r = await fetch("https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option");
      const j = await r.json();
      const all = j.result || [];
      const totalCount = all.length;

      // 先按到期标签粗筛，再用 nameSet 精筛
      const rough = all.filter(x => String(x.instrument_name || "").includes(tag));
      let cur = rough.filter(x => nameSet.has(x.instrument_name));

      // 少则兜底：逐合约 summary（限速并发）
      let fallback = false;
      if (cur.length < 3 && nameSet.size) {
        fallback = true;
        const names = Array.from(nameSet);
        const res = await withConcurrency(names, 10, async (nm) => {
          const rr = await fetch(
            `https://www.deribit.com/api/v2/public/get_book_summary_by_instrument?instrument_name=${encodeURIComponent(nm)}`
          );
          const jj = await rr.json();
          return (jj.result && jj.result[0]) ? jj.result[0] : null;
        });
        cur = res.filter(Boolean);
      }

      // 聚合到行权价（单位：BTC；BTC 期权通常 1 张 = 1 BTC，这里按 open_interest 计入 BTC）
      const map = new Map();
      let pSum = 0, cSum = 0;

      for (const it of cur) {
        const nm = String(it.instrument_name || ""); // BTC-25OCT25-60000-P
        const parts = nm.split("-");
        if (parts.length < 4) continue;
        const strike = Number(parts[2]);
        if (!Number.isFinite(strike)) continue;
        const side = parts[3]; // P / C
        const oiContracts = Number(it.open_interest || 0) || 0; // 作为 BTC 计
        const rec = map.get(strike) || { putOIbtc: 0, callOIbtc: 0 };
        if (side === "P") { rec.putOIbtc += oiContracts; pSum += oiContracts; }
        if (side === "C") { rec.callOIbtc += oiContracts; cSum += oiContracts; }
        map.set(strike, rec);
      }

      const table = Array.from(map.entries())
        .map(([strike, v]) => ({
          strike: Number(strike),
          putOIbtc: v.putOIbtc,
          callOIbtc: v.callOIbtc,
          totalBtc: v.putOIbtc + v.callOIbtc
        }))
        .sort((a,b) => a.strike - b.strike);

      setRows(table);
      setSumPut(pSum);
      setSumCall(cSum);
      setDbg({ total: totalCount, matched: cur.length, strikes: table.length, fallback });

      const maxPut = table.reduce((m, x) => (x.putOIbtc > (m?.oiBtc || 0) ? { strike:x.strike, oiBtc:x.putOIbtc } : m), null);
      const maxCall = table.reduce((m, x) => (x.callOIbtc > (m?.oiBtc || 0) ? { strike:x.strike, oiBtc:x.callOIbtc } : m), null);
      setPutWall(maxPut);
      setCallWall(maxCall);

      if (table.length === 0) setNote("该到期日暂无可聚合数据（稍后再试或切换日期）");
    } catch (e) {
      console.error("fetchOI error:", e);
      setNote("OI 获取失败（网络/限频/结构变化），已保留上次数据");
    } finally {
      setLoading(false);
    }
  };

  /** 初始化：到期日 */
  useEffect(() => { fetchExpiries(); }, []);

  /** 切换到期日：拉 OI + 30s 定时 */
  useEffect(() => {
    if (!expiry) return;
    fetchOI(expiry);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => fetchOI(expiry), 30000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [expiry]);

  /** Top 3（按总量） */
  const top3 = useMemo(() => {
    const copy = [...rows].sort((a,b)=>b.totalBtc - a.totalBtc);
    return copy.slice(0,3);
  }, [rows]);

  const ratio = useMemo(() => {
    const p = sumPut||0, c = sumCall||0;
    if (p===0 && c===0) return "—";
    if (c===0) return "∞";
    return (p/c).toFixed(2);
  }, [sumPut, sumCall]);

  return (
    <div style={S.page}>
      {/* 现价（整数） */}
      <div style={S.price}>{price!=null ? Math.floor(price).toLocaleString() : "--"}</div>

      {/* 控件 */}
      <div style={S.top}>
        <select value={expiry} onChange={e=>setExpiry(e.target.value)} style={S.select}>
          {expiries.map(iso => <option key={iso} value={iso}>{iso}</option>)}
        </select>
        <span style={S.hint}>到期标识：{isoToDeribitTag(expiry) || "--"} ｜ 期权数据 30s 自动刷新</span>
        <button style={S.btn} onClick={()=>fetchOI(expiry)}>手动刷新</button>
      </div>

      {/* 汇总胶囊 */}
      <div style={S.pills}>
        <div style={S.pill}>Total Put OI：<b>{fmt(sumPut)}</b> BTC</div>
        <div style={S.pill}>Total Call OI：<b>{fmt(sumCall)}</b> BTC</div>
        <div style={S.pill}>Put/Call 比：<b>{ratio}</b></div>
        <div style={S.pill}>当前到期合约：<b>{dbg.matched}</b> ｜ 行权价档：<b>{dbg.strikes}</b>（{dbg.fallback ? "兜底" : "快速"}）</div>
      </div>

      {/* 墙（大字） */}
      <div style={{...S.wall, ...S.red}}>
        PUT WALL：{putWall ? `${putWall.strike}（${fmt(putWall.oiBtc)} BTC）` : (loading ? "加载中…" : "暂无数据")}
      </div>
      <div style={{...S.wall, ...S.green}}>
        CALL WALL：{callWall ? `${callWall.strike}（${fmt(callWall.oiBtc)} BTC）` : (loading ? "加载中…" : "暂无数据")}
      </div>

      {!!note && <div style={S.status}>{note}</div>}
      <div style={S.status}>
        数据：全市场 {dbg.total} ｜ 匹配 {dbg.matched} ｜ 聚合 {dbg.strikes}
      </div>

      {/* 表格 */}
      <div style={S.section}>Top 3 OI（按 Put+Call 总量排序，单位：BTC）</div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={{...S.th, ...S.thL}}>Strike</th>
              <th style={S.th}>Put OI (BTC)</th>
              <th style={S.th}>Call OI (BTC)</th>
              <th style={S.th}>Total (BTC)</th>
            </tr>
          </thead>
          <tbody>
            {top3.length===0 && !loading && (
              <tr><td style={{...S.td, ...S.tdL}} colSpan={4}>暂无数据</td></tr>
            )}
            {top3.map(r=>(
              <tr key={r.strike}>
                <td style={{...S.td, ...S.tdL}}>{r.strike}</td>
                <td style={{...S.td, color:"#ff7875"}}>{fmt(r.putOIbtc)}</td>
                <td style={{...S.td, color:"#95de64"}}>{fmt(r.callOIbtc)}</td>
                <td style={S.td}>{fmt(r.totalBtc)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
