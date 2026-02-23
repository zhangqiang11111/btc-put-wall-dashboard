import React, { useEffect, useState } from "react";

export default function App() {
  const [price, setPrice] = useState(null);

  useEffect(() => {
    let ws;
    let timer;

    const connect = () => {
      ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@trade");

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const raw = parseFloat(data?.p);
          if (!Number.isNaN(raw)) {
            setPrice(Math.round(raw).toLocaleString());
          }
        } catch {
          // ignore malformed tick
        }
      };

      ws.onclose = () => {
        timer = setTimeout(connect, 1200);
      };
    };

    connect();

    return () => {
      if (timer) clearTimeout(timer);
      if (ws && ws.readyState < 2) ws.close();
    };
  }, []);

  return <div className="btc-price-hammer">{price || "加载中..."}</div>;
}
