const Binance = require('binance-api-node').default

let timeOffset = 0;

const client = Binance({
  apiKey: process.env.APIKEY,
  apiSecret: process.env.SECRET,
  getTime: () => Date.now() + timeOffset, // ← esto ajusta el reloj local
});

(async () => {
  try {
    const serverTime = await client.time();
    const localTime = Date.now();
    timeOffset = serverTime - localTime;
    console.log(`Tiempo ajustado: offset de ${timeOffset} ms`);
  } catch (err) {
    console.error('Error al sincronizar el tiempo con Binance:', err.message);
  }
})();

module.exports = client;
