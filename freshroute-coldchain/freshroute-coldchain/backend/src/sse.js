// Tiny Server-Sent-Events hub. One-way server -> browser push is all the dashboard needs,
// works through proxies, and the browser reconnects automatically.
export function createHub() {
  const clients = new Set();
  return {
    add(res) {
      clients.add(res);
      res.on('close', () => clients.delete(res));
    },
    publish({ type, data }) {
      const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) res.write(frame);
    },
    get size() {
      return clients.size;
    },
  };
}
