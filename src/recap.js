const WINDOW = 15 * 60 * 1000;

export function createRecap() {
  const events = [];
  let lastRecap = -Infinity;
  return {
    record(type, text) {
      const now = Date.now();
      while (events.length && now - events[0].time >= WINDOW) events.shift();
      events.push({ time: now, type, text });
    },
    getEvents() {
      const now = Date.now();
      while (events.length && now - events[0].time >= WINDOW) events.shift();
      return events.map(({ type, text }) => `${type}: ${text}`);
    },
    allow() {
      if (Date.now() - lastRecap < 60000) return false;
      lastRecap = Date.now();
      return true;
    },
  };
}
