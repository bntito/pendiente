require('dotenv').config()
const Storage = require('node-storage')
const fs = require('fs')
const moment = require('moment')
const { log, logColor, colors } = require('./utils/logger')
const client = require('./services/binance')
const { exec } = require('child_process');

function beep() {
    exec('rundll32.exe user32.dll,MessageBeep');
};

const MARKET1 = process.argv[2]
const MARKET2 = process.argv[3]
const MARKET = MARKET1 + MARKET2
const DEFAULT_BUY_AMOUNT = parseFloat(process.argv[4])
let BUY_ORDER_AMOUNT = DEFAULT_BUY_AMOUNT;
const store = new Storage(`./data/${MARKET}.json`)

const requiredVars = [
    'POSITIVE_BUY_PERCENT', 'POSITIVE_SELL_PERCENT',
    'NEGATIVE_BUY_PERCENT', 'NEGATIVE_SELL_PERCENT',
    'NEUTRAL_BUY_PERCENT',  'NEUTRAL_SELL_PERCENT'
];

for (const key of requiredVars) {
    if (!process.env[key] || isNaN(parseFloat(process.env[key]))) {
        throw new Error(`La variable ${key} no está definida correctamente en .env`);
    }
}

async function calcularPendienteDesdeVelas(symbol) {
    const candles = await client.candles({
        symbol,
        interval: '1m',
        limit: 10, // últimos 10 minutos
    });

    // console.log('DEBUG: Velas recibidas:', candles.map(c => c.close));

    if (candles.length < 2) return 0;

    const x1 = candles[0].openTime;
    const x2 = candles[candles.length - 1].closeTime;
    const y1 = parseFloat(candles[0].close);
    const y2 = parseFloat(candles[candles.length - 1].close);

    return (y2 - y1) / (x2 - x1); // pendiente cruda
}

function ajustarParametrosSegunPendiente(pendiente) {
    const pNorm = pendiente * 1e7;

    const posBuy  = parseFloat(process.env.POSITIVE_BUY_PERCENT);
    const posSell = parseFloat(process.env.POSITIVE_SELL_PERCENT);
    const negBuy  = parseFloat(process.env.NEGATIVE_BUY_PERCENT);
    const negSell = parseFloat(process.env.NEGATIVE_SELL_PERCENT);
    const neutBuy = parseFloat(process.env.NEUTRAL_BUY_PERCENT);
    const neutSell= parseFloat(process.env.NEUTRAL_SELL_PERCENT);

    logColor(colors.gray, `************************************************************`);
    logColor(colors.blue, `*************** EL BOT DE TRADING DE BRUNO T ***************`);
    logColor(colors.gray, `************************************************************`);

    if (pNorm > 0.01) {
        process.env.BUY_PERCENT  = posBuy;
        process.env.SELL_PERCENT = posSell;
        logColor(colors.cyan,
            `↑ Tendencia positiva (pend=${pNorm.toFixed(6)}) ➜ BUY ${posBuy}% | SELL ${posSell}%`
        );
    } else if (pNorm < -0.01) {
        process.env.BUY_PERCENT  = negBuy;
        process.env.SELL_PERCENT = negSell;
        logColor(colors.cyan,
            `↓ Tendencia negativa (pend=${pNorm.toFixed(6)}) ➜ BUY ${negBuy}% | SELL ${negSell}%`
        );
    } else {
        process.env.BUY_PERCENT  = neutBuy;
        process.env.SELL_PERCENT = neutSell;
        logColor(colors.cyan,
            `→ Tendencia lateral (pend=${pNorm.toFixed(6)}) ➜ BUY ${neutBuy}% | SELL ${neutSell}%`
        );
    }

    // 🔄 Actualizar precio de venta de la última orden si existe
    const orders = store.get('orders') || [];

    if (orders.length > 0) {
        const orden = orders[orders.length - 1];

        // Solo si la orden fue comprada y aún no se vendió
        if ((orden.status === 'pending' || orden.status === 'bought') && orden.buy_price > 0) {
            const nuevoSellPrice = orden.buy_price * (1 + parseFloat(process.env.SELL_PERCENT) / 100);
            
            // Solo si cambia significativamente (opcional)
            if (!orden.sell_price || Math.abs(nuevoSellPrice - orden.sell_price) > orden.buy_price * 0.001) {
                orden.sell_price = parseFloat(nuevoSellPrice.toFixed(6));
                store.put('orders', orders); // guardar el array actualizado
                logColor(colors.yellow, `Precio de venta actualizado a ${orden.sell_price}`);
            }
        }
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function ajustarBuyOrderAmount() {
    const balances = await getBalances();
    const saldoDisponible = balances[MARKET2];
    const minBuy = await getMinBuy();
    const margenFees = saldoDisponible * 0.01;
    let buyAmount = saldoDisponible - margenFees;
    if (buyAmount < minBuy) {
        logColor(colors.red, `Saldo insuficiente para operar. Mínimo: ${minBuy}, disponible: ${saldoDisponible}`);
        return null;
    }
    buyAmount = Math.floor(buyAmount * 100) / 100;
    BUY_ORDER_AMOUNT = buyAmount; // ✅ ACTUALIZA LA VARIABLE GLOBAL
    logColor(colors.gray, `BUY_ORDER_AMOUNT ajustado automáticamente a ${buyAmount} ${MARKET2}`);
    return buyAmount;
}

/* Cálculo de tiempo transcurrido */
function elapsedTime() {
    const diff = Date.now() - store.get('start_time')
    var diffDays = diff / 86400000
    diffDays = diffDays < 1 ? '' : diffDays
    return diffDays + '' + moment.utc(diff).format('HH:mm:ss')
}

/* Establecer precio de entrada */
function _newPriceReset(_market, balance, price) {
    const market = _market == 1 ? MARKET1 : MARKET2
    if (!(parseFloat(store.get(`${market.toLowerCase()}_balance`)) > balance))
        store.put('start_price', price)
}

/* Obtener balances */
async function _updateBalances() {
    const balances = await getBalances()
    store.put(`${MARKET1.toLowerCase()}_balance`, balances[MARKET1])
    store.put(`${MARKET2.toLowerCase()}_balance`, balances[MARKET2])
}

/* Calcular ganancias totales */
async function _calculateProfits() {
    const orders = store.get('orders')
    const sold = orders.filter(order => {
        return order.status === 'sold'
    })

    const totalSoldProfits = sold.length > 0 ?
        sold.map(order => order.profit).reduce((prev, next) =>
            parseFloat(prev) + parseFloat(next)) : 0

    store.put('profits', totalSoldProfits + parseFloat(store.get('profits')))
}

/* Cálculo de ganancias reales con balance inicial y los dos mercados */
function getRealProfits(price) {
    const m1Balance = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`))
    const m2Balance = parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`))

    const initialBalance1 = parseFloat(store.get(`initial_${MARKET1.toLowerCase()}_balance`))
    const initialBalance2 = parseFloat(store.get(`initial_${MARKET2.toLowerCase()}_balance`))

    return parseFloat(parseFloat((m1Balance - initialBalance1) * price + m2Balance) - initialBalance2).toFixed(4)
}

/* Registrar e imprimir ganancias */
function _logProfits(price) {
    const profits = parseFloat(store.get('profits'))
    var isGainerProfit = profits > 0 ?
        1 : profits < 0 ? 2 : 0

    logColor(isGainerProfit == 1 ?
        colors.green : isGainerProfit == 2 ?
            colors.red : colors.gray,
        `Beneficio de la red (Incluidas tarifas): ${parseFloat(store.get('profits')).toFixed(4)} ${MARKET2}`)

    const m1Balance = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`))
    const m2Balance = parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`))

    const initialBalance = parseFloat(store.get(`initial_${MARKET2.toLowerCase()}_balance`))

    logColor(colors.yellow,
        `Saldos actuales: ${m1Balance} ${MARKET1}, ${m2Balance.toFixed(2)} ${MARKET2}`)
    logColor(colors.yellow,
        `Saldo en función del precio actual: ${parseFloat(m1Balance * price + m2Balance).toFixed(2)} ${MARKET2}, Saldo inicial: ${initialBalance.toFixed(2)} ${MARKET2}`)
}

/* Cálculo de tarifas de transacción */
async function getFees({ commission, commissionAsset }) {
    if (commissionAsset === MARKET2) return commission
    const price = await getPrice(MARKET)
    return price * commission
}

/* Función de comprar */
async function _buy(price, amount) {
    if (parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`)) >= BUY_ORDER_AMOUNT) {
        var orders = store.get('orders')
        var sellFactor = process.env.SELL_PERCENT * price / 100
        var slFactor = process.env.STOP_LOSS_GRID * price / 100

        const order = {
            buy_price: price,
            sell_price: price + sellFactor,
            sl_price: price - slFactor,
            sold_price: 0,
            status: 'pending',
            profit: 0,
            buy_fee: 0,
            sell_fee: 0,
        }

        log(`
            Comprando en ${MARKET1}
            ==================
            Monto a invertir: ${parseFloat(BUY_ORDER_AMOUNT).toFixed(2)} ${MARKET2}
            Cantidad a recibir: ${BUY_ORDER_AMOUNT / price} ${MARKET1}
        `)
        beep();

        const res = await marketBuy(amount, true)
        if (res && res.status === 'FILLED') {
            order.status = 'bought'
            order.id = res.orderId
            order.buy_fee = parseFloat((await getFees(res.fills[0])))
            order.amount = res.executedQty - res.fills[0].commission
            store.put('fees', parseFloat(store.get('fees')) + order.buy_fee)
            order.buy_price = parseFloat(res.fills[0].price)

            orders.push(order)
            store.put('orders', orders)

            store.put('start_price', order.buy_price)
            await _updateBalances()

            logColor(colors.green, '=============================')
            logColor(colors.green, `Compra realizada ${order.amount} ${MARKET1} por ${parseFloat(BUY_ORDER_AMOUNT).toFixed(2)} ${MARKET2}, Precio: ${order.buy_price}\n`)
            logColor(colors.green, '=============================')

            await _calculateProfits()

        } else _newPriceReset(2, BUY_ORDER_AMOUNT, price)
    } else _newPriceReset(2, BUY_ORDER_AMOUNT, price)
}

/* Realización de orden de compra */
async function marketBuy(amount, quoted) {
    return await marketOrder('BUY', amount, quoted)
}

/* Ejecución de la orden */
async function marketOrder(side, amount, quoted) {
    const orderObject = {
        symbol: MARKET,
        side: side,
        type: 'MARKET',
    }

    if (quoted)
        orderObject['quoteOrderQty'] = amount
    else
        orderObject['quantity'] = amount

    return await client.order(orderObject)
}

/* Realizacion de orden de venta */
async function marketSell(amount) {
    return await marketOrder('SELL', amount)
}

/* Iniciación, cerrar posición y vender todo el saldo disponible */
async function clearStart() {
    await _closeBot()
    const balances = await getBalances()
    const totalAmount = balances[MARKET1]
    const price = await getPrice(MARKET)
    const minSell = (await getMinBuy()) / price
    if (totalAmount >= parseFloat(minSell)) {
        try {
            const lotQuantity = await getQuantity(totalAmount)
            const res = await marketSell(lotQuantity)
            if (res && res.status === 'FILLED') {
                logColor(colors.green, 'Iniciando en modo limpio...')
                beep();
                await sleep(3000)
            } else {
                logFail()
            }
        } catch (err) {
            logFail()
        }
    }
}

/* Manejar caso en que la venta de saldo inicial no sea posible */
function logFail() {
    logColor(colors.red, 'No se ha podido vender el saldo inicial.')
    logColor(colors.red, 'Debes venderlo manualmente en Binance.')
    process.exit()
}

/* Vender todas las posiciones activas */
async function _sellAll() {
    await sleep(3000)
    const balances = await getBalances()
    const totalAmount = balances[MARKET1]
    if (totalAmount > 0) {
        try {
            const lotQuantity = await getQuantity(totalAmount)
            const res = await marketSell(lotQuantity)
            if (res && res.status === 'FILLED') {
                logColor(colors.green, 'Bot detenido correctamente: Todo vendido')
            } else {
                logFail()
            }
        } catch (err) { }
    }
}

/* Eliminar archivo de datos JSON */
async function _closeBot() {
    try {
        fs.unlinkSync(`./data/${MARKET}.json`)
    } catch (ee) { }
}

/* Obtener ID de la orden más antigua o más reciente */
function getOrderId() {
    const fifoStrategy = process.env.STOP_LOSS_GRID_IS_FIFO
    const orders = store.get('orders')
    const index = fifoStrategy ? 0 : orders.length - 1

    return store.get('orders')[index].id
}

/* Identificar órdenes que están listas para ser vendidas */
function getToSold(price, changeStatus) {
    const orders = store.get('orders')
    const toSold = []

    for (var i = 0; i < orders.length; i++) {
        var order = orders[i]
        if (price >= order.sell_price ||
            (process.env.USE_STOP_LOSS_GRID
                && getOrderId() === order.id
                && store.get(`${MARKET2.toLowerCase()}_balance`) < BUY_ORDER_AMOUNT
                && price < order.sl_price)) {
            if (changeStatus) {
                order.sold_price = price
                order.status = 'selling'
            }
            toSold.push(order)
        }
    }

    return toSold
}

/* Función de venta */
async function _sell(price) {
    const orders = store.get('orders')
    const toSold = getToSold(price, true)

    if (toSold.length > 0) {
        var totalAmount = parseFloat(toSold.map(order => order.amount).reduce((prev, next) => parseFloat(prev) + parseFloat(next)))
        const balance = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`))
        totalAmount = totalAmount > balance ? balance : totalAmount
        if (totalAmount > 0) {
            log(`
                Venta en ${MARKET1}
                =================
                Cantidad a vender: ${totalAmount.toFixed(2)} ${MARKET1}
                Cantidad a recibir: ${parseFloat(totalAmount * price).toFixed(2)} ${MARKET2}
            `)
            beep();

            const lotQuantity = await getQuantity(totalAmount)
            const res = await marketSell(lotQuantity)
            if (res && res.status === 'FILLED') {
                const _price = parseFloat(res.fills[0].price)

                for (var i = 0; i < orders.length; i++) {
                    var order = orders[i]
                    for (var j = 0; j < toSold.length; j++) {
                        if (order.id == toSold[j].id) {
                            toSold[j].profit = (parseFloat(toSold[j].amount) * _price)
                                - (parseFloat(toSold[j].amount) * parseFloat(toSold[j].buy_price))

                            toSold[j].profit -= order.sell_fee + order.buy_fee
                            toSold[j].sell_fee = parseFloat((await getFees(res.fills[0])))
                            toSold[j].status = 'sold'
                            orders[i] = toSold[j]
                            store.put('fees', parseFloat(store.get('fees')) + orders[i].sell_fee)
                            store.put('sl_losses', parseFloat(store.get('sl_losses')) + orders[i].profit)
                        }
                    }
                }

                store.put('start_price', _price)
                await _updateBalances()

                logColor(colors.red, '=============================')
                logColor(colors.red,
                    `Venta realizada ${totalAmount} ${MARKET1} por ${parseFloat(totalAmount * _price).toFixed(2)} ${MARKET2}, Precio: ${_price}\n`)
                logColor(colors.red, '=============================')

                await _calculateProfits()

                var i = orders.length
                while (i--)
                    if (orders[i].status === 'sold')
                        orders.splice(i, 1)

            } else store.put('start_price', price)
        } else store.put('start_price', price)
    }

    return toSold.length > 0
}

/* Monitoreo del mercado, tomar decisiones de compra, venta y gestión de órdenes */
async function broadcast() {
    while (true) {
        try {
            const mPrice = await getPrice(MARKET);
            if (mPrice) {
                const pendiente = await calcularPendienteDesdeVelas(MARKET);
                ajustarParametrosSegunPendiente(pendiente);

                const startPrice = store.get('start_price');
                const marketPrice = mPrice;

                // console.clear();
                
                log(`Tiempo de ejecución: ${elapsedTime()}`);
                log('===========================================================');
                const totalProfits = getRealProfits(marketPrice);

                if (!isNaN(totalProfits)) {
                    const totalProfitsPercent = parseFloat(100 * totalProfits / store.get(`initial_${MARKET2.toLowerCase()}_balance`)).toFixed(3);
                    log(`Retiros de ganancias: ${parseFloat(store.get('withdrawal_profits')).toFixed(2)} ${MARKET2}`);
                    logColor(totalProfits < 0 ? colors.red : totalProfits == 0 ? colors.gray : colors.green,
                        `Ganancias reales: ${totalProfitsPercent}% ==> ${totalProfits <= 0 ? '' : '+'}${parseFloat(totalProfits).toFixed(3)} ${MARKET2}`);

                    if (totalProfitsPercent >= parseFloat(process.env.TAKE_PROFIT_BOT)) {
                        logColor(colors.green, 'Cerrando bot en ganancias....');
                        if (process.env.SELL_ALL_ON_CLOSE) {
                            if (process.env.WITHDRAW_PROFITS && totalProfits >= parseFloat(process.env.MIN_WITHDRAW_AMOUNT)) {
                                await withdraw(totalProfits, marketPrice);
                                if (process.env.START_AGAIN) {
                                    await sleep(5000);
                                    await _updateBalances();
                                } else {
                                    await _closeBot();
                                    return;
                                }
                            } else {
                                await _sellAll();
                                await _closeBot();
                                return;
                            }
                        } else {
                            return;
                        }
                    } else if (totalProfitsPercent <= -1 * process.env.STOP_LOSS_BOT) {
                        logColor(colors.red, 'Cerrando bot en pérdidas....');
                        if (process.env.SELL_ALL_ON_CLOSE) await _sellAll();
                        await _closeBot();
                        return;
                    }
                }

                _logProfits(marketPrice);
                const entryPrice = store.get('entry_price');
                const entryFactor = marketPrice - entryPrice;
                const entryPercent = parseFloat(100 * entryFactor / entryPrice).toFixed(2);
                log(`Precio de entrada: ${entryPrice} ${MARKET2} (${entryPercent <= 0 ? '' : '+'}${entryPercent}%)`);
                log('===========================================================');
                log(`Precio anterior: ${startPrice} ${MARKET2}`);

                if (marketPrice < startPrice) {
                    const factor = startPrice - marketPrice;
                    const percent = parseFloat(100 * factor / startPrice).toFixed(2);
                    logColor(colors.red, `Nuevo precio: ${marketPrice} ${MARKET2} ==> -${percent}%`);
                    store.put('percent', `-${percent}`);
                    if (percent >= process.env.BUY_PERCENT) {
                        const adjustedAmount = await ajustarBuyOrderAmount();
                        if (adjustedAmount) {
                            await _buy(marketPrice, adjustedAmount);
                        }
                    }
                } else {
                    const factor = marketPrice - startPrice;
                    const percent = parseFloat(100 * factor / marketPrice).toFixed(2);
                    logColor(colors.green, `Nuevo precio: ${marketPrice} ${MARKET2} ==> +${percent}%`);
                    store.put('percent', `+${percent}`);
                    const toSold = getToSold(marketPrice);
                    if (toSold.length === 0) store.put('start_price', marketPrice);
                }

                await _sell(marketPrice);
                /* ... resto de la impresión de órdenes ... */
            }
        } catch (err) { 
            console.error('ERROR en broadcast():', err);
        }
        await sleep(process.env.SLEEP_TIME);
    }
}

/* Obtener saldos de las monedas */
const getBalances = async () => {
    const assets = [MARKET1, MARKET2]
    const { balances } = await client.accountInfo()
    const _balances = balances.filter(coin => assets.includes(coin.asset))
    var parsedBalnaces = {}
    assets.forEach(asset => {
        parsedBalnaces[asset] = parseFloat(_balances.find(coin => coin.asset === asset).free)
    })
    return parsedBalnaces
}

/* Obtener precio actual del par */
const getPrice = async (symbol) => {
    return parseFloat((await client.prices({ symbol }))[symbol])
}

/* Cálculo de la cantidad adecuada para comprar o vender */
const getQuantity = async (amount) => {
    const { symbols } = await client.exchangeInfo({ symbol: MARKET })
    const { stepSize } = symbols[0].filters.find(filter => filter.filterType === 'LOT_SIZE')
    let quantity = (amount / stepSize).toFixed(symbols[0].baseAssetPrecision)

    if (amount % stepSize !== 0) {
        quantity = (parseInt(quantity) * stepSize).toFixed(symbols[0].baseAssetPrecision)
    }

    return quantity
}

/* Requisito mínimo para la compra */
async function getMinBuy() {
    const { symbols } = await client.exchangeInfo({ symbol: MARKET })
    const { minNotional } = symbols[0].filters.find(filter => filter.filterType === 'NOTIONAL')

    return parseFloat(minNotional)
}

/* Retirar ganancias de la cuenta */
async function withdraw(profits, price) {
    await _sellAll()
    console.log('Procesando retiro...')
    await sleep(process.env.SLEEP_TIME * 2)

    await client.withdraw({
        coin: MARKET2,
        network: process.env.DEFAULT_WITHDRAW_NETWORK,
        address: MARKET2 === 'BUSD'
            ? process.env.WITHDRAW_ADDRESS_BUSD
            : process.env.WITHDRAW_ADDRESS_USDT,
        amount: profits,
    })

    store.put('withdrawal_profits', parseFloat(store.get('withdrawal_profits')) + profits)
    console.log('Cerrando bot...')
    await sleep(process.env.SLEEP_TIME * 2)
}

/* Inicializar y comenzar la ejecución del bot */
async function init() {
    const minBuy = await getMinBuy()
    if (minBuy > DEFAULT_BUY_AMOUNT) {
        console.log(`El lote mínimo de compra es: ${minBuy} ${MARKET2}`)
        return
    }

    if (process.argv[5] !== 'resume') {
        log('Iniciando bot...')
        if (process.env.SELL_ALL_ON_START)
            await clearStart()
        const startTime = Date.now()
        store.put('start_time', startTime)
        const price = await getPrice(MARKET)
        store.put('start_price', price)
        store.put('orders', [])
        store.put('profits', 0)
        store.put('sl_losses', 0)
        store.put('withdrawal_profits', 0)
        store.put('fees', 0)
        const balances = await getBalances()
        store.put('entry_price', price)
        store.put(`${MARKET1.toLowerCase()}_balance`, balances[MARKET1])
        store.put(`${MARKET2.toLowerCase()}_balance`, balances[MARKET2])
        store.put(`initial_${MARKET1.toLowerCase()}_balance`, store.get(`${MARKET1.toLowerCase()}_balance`))
        store.put(`initial_${MARKET2.toLowerCase()}_balance`, store.get(`${MARKET2.toLowerCase()}_balance`))
    }

    broadcast()
}

init()