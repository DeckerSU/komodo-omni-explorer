const config = require('../../config');
const request = require('request');
const fs = require('fs-extra');
const path = require('path');
const Promise = require('bluebird');
const async = require('async');

const PRICES_UPDATE_INTERVAL = 20000; // every 20s
const ORDERS_UPDATE_INTERVAL = 30000; // every 30s
const RATES_UPDATE_INTERVAL = 60000; // every 60s
let electrumServers = [];

const tempElectrumCoins = Object.keys(config.electrumServers).concat(Object.keys(config.electrumServersExtend));
let _electrumCoins = JSON.parse(JSON.stringify(tempElectrumCoins));
let electrumCoins = {};
delete _electrumCoins.KMD;

for (let i = 0; i< _electrumCoins.length; i++) {
  electrumCoins[_electrumCoins[i].toUpperCase()] = true;
}

let kmdPairs = [];

for (let key in electrumCoins) {
  kmdPairs.push(`KMD/${key}`);
  kmdPairs.push(`${key}/KMD`);
}

console.log(`total orderbook pairs ${kmdPairs.length}`);

const getRandomIntInclusive = (min, max) => {
  min = Math.ceil(min);
  max = Math.floor(max);

  return Math.floor(Math.random() * (max - min + 1)) + min; // the maximum is inclusive and the minimum is inclusive
}

for (let key in config.electrumServers) {
  if (electrumCoins[key.toUpperCase()]) {
    electrumServers.push({
      coin: key,
      serverList: config.electrumServers[key].serverList,
    });
  }
}

for (let key in config.electrumServersExtend) {
  if (electrumCoins[key.toUpperCase()]) {
    electrumServers.push({
      coin: key,
      serverList: config.electrumServersExtend[key].serverList,
    });
  }
}

module.exports = (shepherd) => {
  shepherd.mm = {
    coinsStartLaunched: false,
    orderbookLaunched: false,
    pricesLaunched: false,
    prices: {},
    orders: {},
    ordersUpdateInProgress: false,
    pricesUpdateInProgress: false,
    fiatRates: null,
    coins: {},
    userpass: '470f8d83cf4389502d7cf20de971e61cbeb836365e8daca4df0131fa7e374a60',
  };

  shepherd.getRates = () => {
    function _getRates() {
      const options = {
        url: `https://min-api.cryptocompare.com/data/price?fsym=KMD&tsyms=BTC,USD`,
        method: 'GET',
      };

      // send back body on both success and error
      // this bit replicates iguana core's behaviour
      request(options, (error, response, body) => {
        if (response &&
            response.statusCode &&
            response.statusCode === 200) {
          const _parsedBody = JSON.parse(body);
          console.log(`rates ${body}`);
          shepherd.mm.fiatRates = _parsedBody;
        } else {
          console.log(`unable to retrieve KMD/BTC,USD rate`);
        }
      });
    }

    _getRates();
    shepherd.mmRatesInterval = setInterval(() => {
      _getRates();
    }, RATES_UPDATE_INTERVAL);
  }

  // get kmd rates
  shepherd.get('/rates/kmd', (req, res, next) => {
    res.end(JSON.stringify({
      msg: 'success',
      result: shepherd.mm.fiatRates,
    }));
  });

  // start coin pairs in electrum
  shepherd.get('/mm/coins/start', (req, res, next) => {
    if (!shepherd.mm.coinsStartLaunched) {
      shepherd.mm.coinsStartLaunched = true;
      const runElectrumStart = () => {
        shepherd.mm.ordersUpdateInProgress = true;
        let _callsCompleted = 0;
        let _coins = [];

        async.eachOfSeries(electrumServers, (electrumServerData, key, callback) => {
          const _server = electrumServerData.serverList[getRandomIntInclusive(0, 1)].split(':');
          const _payload = {
            method: 'electrum',
            coin: electrumServerData.coin.toUpperCase(),
            ipaddr: _server[0],
            port: _server[1],
            userpass: shepherd.mm.userpass,
          };
          const options = {
            url: `http://localhost:7783`,
            method: 'POST',
            body: JSON.stringify(_payload),
            timeout: 10000,
          };

          request(options, (error, response, body) => {
            if (response &&
                response.statusCode &&
                response.statusCode === 200) {
              const _parsedBody = JSON.parse(body);
              _coins.push({
                coin: _payload.coin,
                data: _parsedBody,
                payload: _payload,
              });
              console.log(_payload.coin + ' connected');

              callback();
              _callsCompleted++;

              if (_callsCompleted === electrumServers.length) {
                console.log('all coins connected');
                res.end(JSON.stringify({
                  msg: 'success',
                  result: _coins,
                }));
              }
            } else {
              _coins.push({
                coin: _payload.coin,
                data: _parsedBody,
                payload: _payload,
              });
              console.log(_payload.coin + ' failed to connect');
              callback();
              _callsCompleted++;

              if (_callsCompleted === electrumServers.length) {
                console.log('all coins connected');
                res.end(JSON.stringify({
                  msg: 'success',
                  result: _coins,
                }));
              }
            }
          });
        }, err => {
          if (err) console.error(err.message);
          // do some
        });
      }
      runElectrumStart();
    } else {
      res.end(JSON.stringify({
        msg: 'error',
        result: 'coins start was triggered already',
      }));
    }
  });
  // start orderbooks
  shepherd.get('/mm/orderbook/start', (req, res, next) => {
    if (!shepherd.mm.orderbookLaunched) {
      res.end(JSON.stringify({
        msg: 'succes',
        result: 'orders update is started',
      }));
      shepherd.mm.orderbookLaunched = true;

      const runOrdersUpdate = () => {
        shepherd.mm.ordersUpdateInProgress = true;
        let _orders = [];
        let _callsCompleted = 0;

        async.eachOfSeries(kmdPairs, (value, key, callback) => {
          const _pair = value.split('/');
          const _payload = {
            method: 'orderbook',
            base: _pair[0],
            rel: _pair[1],
            userpass: shepherd.mm.userpass,
            duration: 172800 // 2 days
          };
          const options = {
            url: `http://localhost:7783`,
            method: 'POST',
            body: JSON.stringify(_payload),
            timeout: 10000,
          };

          request(options, (error, response, body) => {
            if (response &&
                response.statusCode &&
                response.statusCode === 200) {
              const _parsedBody = JSON.parse(body);

              _orders.push({
                coin: value,
                data: _parsedBody,
                payload: _payload,
              });
              console.log(value + ' / ' + key);
              callback();
              _callsCompleted++;

              if (_callsCompleted === kmdPairs.length) {
                console.log('done');
                shepherd.mm.orders = shepherd.filterOrderbook(_orders);

                setTimeout(() => {
                  shepherd.mm.ordersUpdateInProgress = false;
                  runOrdersUpdate();
                }, 10000);
              }
            } else {
              _orders.push({
                pair: value,
                data: `unable to call method ${_payload.method} at port 7783`,
                payload: _payload,
              });
              console.log(value + ' / ' + key);
              callback();
              _callsCompleted++;

              if (_callsCompleted === kmdPairs.length) {
                console.log('done');
                shepherd.mm.orders = shepherd.filterOrderbook(_orders);

                setTimeout(() => {
                  shepherd.mm.ordersUpdateInProgress = false;
                  runOrdersUpdate();
                }, 10000);
              }
            }
          });
        }, err => {
          if (err) console.error(err.message);
          // do some
        });
      }
      runOrdersUpdate();
    } else {
      res.end(JSON.stringify({
        msg: 'error',
        result: 'orders update is active',
      }));
    }
  });

  shepherd.get('/mm/prices/start', (req, res, next) => {
    if (!shepherd.mm.pricesLaunched) {
      shepherd.mm.pricesLaunched = true;
      res.end(JSON.stringify({
        msg: 'succes',
        result: 'prices update is started',
      }));

      const runPricesUpdate = () => {
        const _payload = {
          method: 'getprices',
          userpass: shepherd.mm.userpass,
        };
        const options = {
          url: `http://localhost:7783`,
          method: 'POST',
          body: JSON.stringify(_payload),
        };

        request(options, (error, response, body) => {
          if (response &&
              response.statusCode &&
              response.statusCode === 200) {
            const _parsedBody = JSON.parse(body);
            console.log('prices updated');
            shepherd.mm.prices = shepherd.pricesPairs(_parsedBody);
          } else {
            shepherd.mm.prices = 'error';
          }
        });
      };

      runPricesUpdate();
      setInterval(() => {
        runPricesUpdate();
      }, PRICES_UPDATE_INTERVAL);
    } else {
      res.end(JSON.stringify({
        msg: 'error',
        result: 'prices update is active',
      }));
    }
  });

  shepherd.pricesPairs = (prices) => {
    let _prices = {};
    let _pairDiv = {};
    let _allCoinPrices = {};
    let _res = {};

    if (prices &&
        prices.length) {
      for (let i = 0; i < prices.length; i++) {
        for (let j = 0; j < prices[i].asks.length; j++) {
          if (!_prices[prices[i].asks[j][0] + '/' + prices[i].asks[j][1]]) {
            _allCoinPrices[prices[i].asks[j][0] + '/' + prices[i].asks[j][1]] = [];
            _allCoinPrices[prices[i].asks[j][0] + '/' + prices[i].asks[j][1]].push(prices[i].asks[j][2]);
            _pairDiv[prices[i].asks[j][0] + '/' + prices[i].asks[j][1]] = 1;
            _prices[prices[i].asks[j][0] + '/' + prices[i].asks[j][1]] = prices[i].asks[j][2];
          } else { // average
            _pairDiv[prices[i].asks[j][0] + '/' + prices[i].asks[j][1]] += 1;
            _prices[prices[i].asks[j][0] + '/' + prices[i].asks[j][1]] += prices[i].asks[j][2];
            _allCoinPrices[prices[i].asks[j][0] + '/' + prices[i].asks[j][1]].push(prices[i].asks[j][2]);
          }
        }
      }

      for (let key in _prices) {
        _res[key] = {
          avg: (_prices[key] / _pairDiv[key]).toFixed(8),
          low: Math.min(..._allCoinPrices[key]),
          high: Math.max(..._allCoinPrices[key]),
        };
      }
    }

    return _res;
  }

  shepherd.filterOrderbook = (orderbook) => {
    let _filteredResults = {};

    for (let i = 0; i < orderbook.length; i++) {
      if (orderbook[i].data &&
          (orderbook[i].data.numasks > 0 || orderbook[i].data.numbids > 0)) {
        _filteredResults[orderbook[i].coin] = orderbook[i].data;
      }
    }

    return _filteredResults;
  }

  // fetch orderbooks
  shepherd.get('/mm/orderbook', (req, res, next) => {
    res.end(JSON.stringify({
      msg: 'success',
      result: shepherd.mm.orders,
    }));
  });

  // fetch prices
  shepherd.get('/mm/prices', (req, res, next) => {
    res.end(JSON.stringify({
      msg: 'success',
      result: shepherd.mm.prices,
    }));
  });

  shepherd.getMMCoins = () => {
    const coinsFileLocation = path.join(__dirname, '../../coins.json');
    const coinsFile = fs.readJsonSync(coinsFileLocation, { throws: false });

    shepherd.mm.coins = coinsFile;
  }

  shepherd.get('/mm/coins', (req, res, next) => {

    res.end(JSON.stringify({
      msg: 'success',
      result: shepherd.mm.coins,
    }));
  });

  return shepherd;
};