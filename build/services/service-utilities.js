"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const TypedError = require("typed-error");
const Promise = require("bluebird");
const bodyParser = require("body-parser");
const express = require("express");
const worker_1 = require("../framework/worker");
const worker_client_1 = require("../framework/worker-client");
const logger_1 = require("../utils/logger");
class ServiceUtilities extends worker_client_1.WorkerClient {
    constructor(data, listen) {
        super();
        this._logger = new logger_1.Logger();
        this.eventListeners = {};
        this.listening = false;
        this.queueData = (data) => {
            if (this.verify(data)) {
                super.queueEvent({
                    data,
                    workerMethod: this.handleEvent
                });
            }
            else {
                this.logger.log(logger_1.LogLevel.WARN, `Event failed verification.`);
            }
        };
        this.getWorker = (event) => {
            const context = event.data.cookedEvent.context;
            const retrieved = this.workers.get(context);
            if (retrieved) {
                return retrieved;
            }
            const created = new worker_1.Worker(context, this.removeWorker);
            this.workers.set(context, created);
            return created;
        };
        this.handleEvent = (data) => {
            const listeners = this.eventListeners[data.cookedEvent.event] || [];
            return Promise.map(listeners, (listener) => {
                return listener.listenerMethod(listener, data);
            }).return();
        };
        this.listen = () => {
            if (!this.listening) {
                this.listening = true;
                this.startListening();
                this.logger.log(logger_1.LogLevel.INFO, `---> '${this.serviceName}' listening.`);
            }
        };
        this.connect(data);
        this.logger.log(logger_1.LogLevel.INFO, `---> '${this.serviceName}' connected.`);
        if (listen) {
            this.listen();
        }
    }
    registerEvent(registration) {
        for (const event of registration.events) {
            if (!this.eventListeners[event]) {
                this.eventListeners[event] = [];
            }
            this.eventListeners[event].push(registration);
        }
    }
    sendData(data) {
        try {
            const context = data.contexts[this.serviceName];
            if (context) {
                return new Promise((resolve) => {
                    this.emitData(context)
                        .then((response) => {
                        resolve({
                            response,
                            source: this.serviceName,
                        });
                    })
                        .catch((err) => {
                        resolve({
                            err,
                            source: this.serviceName,
                        });
                    });
                });
            }
            else {
                return Promise.resolve({
                    err: new TypedError(`No ${this.serviceName} context`),
                    source: this.serviceName,
                });
            }
        }
        catch (err) {
            return Promise.resolve({
                err,
                source: this.serviceName,
            });
        }
    }
    get expressApp() {
        if (!ServiceUtilities._expressApp) {
            const port = process.env.MESSAGE_SERVICE_PORT || process.env.PORT;
            if (!port) {
                throw new Error('No inbound port specified for express server.');
            }
            ServiceUtilities._expressApp = express();
            ServiceUtilities._expressApp.use(bodyParser.json());
            ServiceUtilities._expressApp.listen(port);
            this.logger.log(logger_1.LogLevel.INFO, `---> Started ServiceUtility shared web server on port '${port}'.`);
        }
        return ServiceUtilities._expressApp;
    }
    get logger() {
        return this._logger;
    }
}
exports.ServiceUtilities = ServiceUtilities;

//# sourceMappingURL=service-utilities.js.map