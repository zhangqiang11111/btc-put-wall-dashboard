import React, { useEffect, useState } from "react";

// Deribit 的公共 HTTP 接口地址
const DERIBIT_API = "https://www.deribit.com/api/v2";

function App() {
  const [spotPrice, setSpotPrice] = useState(null);
  const [putWall, setPutWall] = useState(null);

  // 拉 Binance 或其他交易所的 BTC 现价
  useEffect(() => {
    const fetchSpot = async () => {
      try {
        const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
        const j = await res.json();
        if (j && j.price) {
          setSpotPrice(parseFloat(j.price).toLocaleString());
        }
      } catch (err) {
        console.error("获取现价失败:", err);
      }
    };
    fetchSpot();
    const iv = setInterval(fetchSpot, 5000);
    return () => clearInterval(iv);
  }, []);

  // 拉 Deribit 获取 Put 墙（近似：所有 Put 的 OI 总和 / 或某档最大 Put OI）
  useEffect(() => {
    const fetchPutWall = async () => {
      try {
        // 接口：public / get_book_summary_by_currency
        const url = `${DERIBIT_API}/public/get_book_summary_by_currency?currency=BTC&kind=option`;
        const res = await fetch(url);
        const j = await res.json();
        // j.result 是一个列表，每个条目是某个 instrument 的 summary，包括 open_interest 等字段
        // 我们要筛选出 option 的 Put 类型，并把每个行权价的 OI 相加，或者找某个最厚 Put 行权价
        if (j && Array.isArray(j.result)) {
          // 筛选 Put
          const putSummaries = j.result.filter(item => item.option_type === "put");
          // 累加所有 Put 的 open_interest
          let totalPutOI = putSummaries.reduce((acc, it) => {
            const oi = it.open_interest || 0;
            return acc + oi;
          }, 0);
          // 找一个 “最大单一 strike 的 Put OI” 作为墙值
          let maxSingle = 0;
          putSummaries.forEach(it => {
            if (it.open_interest && it.open_interest > maxSingle) {
              maxSingle = it.open_interest;
            }
          });
          // 你可以自己决定要显示哪一种 “墙”：总和 / 最大单档 / 两者都显示
          setPutWall({
            total: totalPutOI,
            single: maxSingle,
          });
        }
      } catch (err) {
        console.error("获取 Put 墙失败:", err);
      }
    };

    fetchPutWall();
    const iv2 = setInterval(fetchPutWall, 30000);
    return () => clearInterval(iv2);
  }, []);

  return (
    <div
      style={{
        background: "black",
        color: "white",
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        userSelect: "none",
        padding: "0 5vw",
      }}
    >
      <div style={{ fontSize: "10vw", fontWeight: "bold", marginBottom: "2vh" }}>
        ₿ BTC: {spotPrice ? `$${spotPrice}` : "Loading..."}
      </div>

      <div style={{ fontSize: "8vw", color: "#00ff9c" }}>
        {putWall
          ? `Put 墙（总 OI）: ${putWall.total.toLocaleString()}  |  单档最大: ${putWall.single.toLocaleString()}`
          : "Loading Put Wall..."}
      </div>
    </div>
  );
}

export default App;