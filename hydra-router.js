/**
* @name Service Router
* @description This is the service entry point
*/
'use strict';

if (process.env.NEW_RELIC_LICENSE_KEY) {
  require('newrelic');
}

/**
* Router route list.
*/
let routeList = [
  '[get]/',
  '[get]/v1/router/health',
  '[get]/v1/router/list/:thing',
  '[get]/v1/router/version',
  '[get]/v1/router/clear',
  '[get]/v1/router/refresh',
  '[get]/v1/router/refresh/:service',
  '[get]/v1/router/log',
  '[get]/v1/router/stats',
  '[post]/v1/router/message'
];

const os = require('os');
const http = require('http');
const hydra = require('hydra');
const serviceRouter = require('./lib/servicerouter');
const WebSocketServer = require('ws').Server;

const HydraLogger = require('fwsp-logger').HydraLogger;
let hydraLogger = new HydraLogger();
hydra.use(hydraLogger);
let appLogger;

/**
 * Setup process exit handlers
 */
process.on('cleanup', () => {
  serviceRouter.shutdown()
    .then(() => {
      hydra.shutdown()
        .then(() => {
          process.exit(-1);
        });
    });
});

process.on('SIGTERM', () => {
  appLogger && appLogger.fatal('Received SIGTERM');
  process.emit('cleanup');
});
process.on('SIGINT', () => {
  appLogger && appLogger.fatal('Received SIGINT');
  process.emit('cleanup');
});
process.on('unhandledRejection', (reason, _p) => {
  appLogger && appLogger.fatal(reason);
  process.emit('cleanup');
});
process.on('uncaughtException', (err) => {
  let stack = err.stack;
  delete err.__cached_trace__;
  delete err.__previous__;
  delete err.domain;
  appLogger && appLogger.fatal({
    stack
  });
  process.emit('cleanup');
});

let config = {};

/**
* Initialize hydra for use by Service Router.
*/
hydra.init(`${__dirname}/config/config.json`, false)
  .then((newConfig) => {
    config = newConfig;
    return hydra.registerService();
  })
  .then((serviceInfo) => {
    let logEntry = `Starting service ${serviceInfo.serviceName}:${hydra.getInstanceVersion()} on ${serviceInfo.serviceIP}:${serviceInfo.servicePort}`;

    let banner = `
 _   _           _             ____             _
| | | |_   _  __| |_ __ __ _  |  _ \\ ___  _   _| |_ ___ _ __
| |_| | | | |/ _\` | '__/ _\` | | |_) / _ \\| | | | __/ _ \\ '__|
|  _  | |_| | (_| | | | (_| | |  _ < (_) | |_| | ||  __/ |
|_| |_|\\__, |\\__,_|_|  \\__,_| |_| \\_\\___/ \\__,_|\\__\\___|_|
       |___/`;
    console.log(banner);

    let interfaces = os.networkInterfaces();
    console.log('Detected IPv4 IPs:');
    Object.keys(interfaces).
      forEach((itf) => {
        interfaces[itf].forEach((interfaceRecord)=>{
          if (interfaceRecord.family === 'IPv4') {
            console.log(`* ${itf}: ${interfaceRecord.address} ${interfaceRecord.netmask}`);
          }
        });
      });
    console.log('');

    appLogger = hydraLogger.getLogger();
    appLogger.info({
      msg: logEntry
    });

    hydra.on('log', (entry) => {
      serviceRouter.log(entry.type, entry);
    });

    hydra.on('metric', (entry) => {
      let type = (entry.indexOf('unavailable') > -1) ? 'error' : 'info';
      serviceRouter.log(type, entry);
    });

    /**
    * @summary Start HTTP server and add request handler callback.
    * @param {object} request - Node HTTP request object
    * @param {object} response - Node HTTP response object
    */
    let server = http.createServer((request, response) => {
      serviceRouter.routeRequest(request, response)
        .catch((err) => {
          appLogger.fatal(err);
        });
    });
    if (!config.hydra.serviceInterface) {
      server.listen(serviceInfo.servicePort);
    } else {
      server.listen(serviceInfo.servicePort, serviceInfo.serviceIP);
    }

    /**
    * Setup websocket message handler.
    */
    let wss = new WebSocketServer({server: server});
    wss.on('connection', (ws, req) => {
      serviceRouter.sendConnectMessage(ws, null, req);

      ws.on('message', (message) => {
        serviceRouter.routeWSMessage(ws, message);
      });

      ws.on('close', () => {
        serviceRouter.wsDisconnect(ws);
      });

      ws.on('error', (error) => {
        try {
          appLogger.info({
            msg: `error detected from client ${ws.id} on ${ws.ipAddr}`
          });
          appLogger.fatal(error);
        } catch (e) {
          appLogger.fatal(error);
        }
      });
    });

    /**
    * Register routes.
    */
    return hydra.registerRoutes(routeList);
  })
  .then(() => {
    /**
    * Retrieve routes for all registered services.
    */
    return hydra.getAllServiceRoutes();
  })
  .then((routesObj) => {
    /**
    * Initialize service router using routes object.
    */
    routesObj = Object.assign(routesObj, config.externalRoutes);
    serviceRouter.init(config, routesObj, appLogger);

    if (global.gc) {
      global.gc();
    } else {
      console.warn('No GC hook! Start Hydra-Router using `node --expose-gc hydra-router.js`.');
    }
    return null; // to silence promise warning: http://goo.gl/rRqMUw
  })
  .catch((err) => {
    let stack = err.stack;
    console.log(stack); // console log because appLogger isn't available in this case.
    process.emit('cleanup');
  });
