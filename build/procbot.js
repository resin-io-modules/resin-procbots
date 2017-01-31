"use strict";
var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["WARN"] = 0] = "WARN";
    LogLevel[LogLevel["INFO"] = 1] = "INFO";
    LogLevel[LogLevel["DEBUG"] = 2] = "DEBUG";
})(LogLevel = exports.LogLevel || (exports.LogLevel = {}));
;
var AlertLevel;
(function (AlertLevel) {
    AlertLevel[AlertLevel["CRITICAL"] = 0] = "CRITICAL";
    AlertLevel[AlertLevel["ERROR"] = 1] = "ERROR";
})(AlertLevel = exports.AlertLevel || (exports.AlertLevel = {}));
;
class ProcBot {
    constructor(name = 'ProcBot') {
        this._botname = 'Procbot';
        this._logLevel = process.env.PROCBOT_LOG_LEVEL || LogLevel.WARN;
        this._alertLevel = process.env.PROCBOT_ALERT_LEVEL || AlertLevel.CRITICAL;
        this.workers = new Map();
        this.logLevelStrings = [
            'WARNING',
            'INFO',
            'DEBUG'
        ];
        this.alertLevelStrings = [
            'CRITICAL',
            'ERROR'
        ];
        this.removeWorker = (context) => {
            this.workers.delete(context);
        };
        this._botname = name;
    }
    get botName() {
        return this._botname;
    }
    get logLevel() {
        return this._logLevel;
    }
    set logLevel(level) {
        this._logLevel = level;
    }
    get alertLevel() {
        return this._alertLevel;
    }
    set alertLevel(level) {
        this._alertLevel = level;
    }
    log(level, message) {
        this.output(level, this._logLevel, this.logLevelStrings, message);
    }
    alert(level, message) {
        this.output(level, this._alertLevel, this.alertLevelStrings, message);
    }
    queueEvent(event) {
        let entry;
        if (!event.workerMethod) {
            this.log(LogLevel.WARN, `WorkerMethod must be passed into the Githubbot.firedEvent() method`);
            return;
        }
        if (!event.data) {
            this.log(LogLevel.WARN, 'Could not find a payload for the event');
            return;
        }
        entry = this.getWorker(event);
        entry.addEvent(event);
    }
    output(level, classLevel, levelStrings, message) {
        if (level >= classLevel) {
            console.log(`${levelStrings[level]} - ${message}`);
        }
    }
}
exports.ProcBot = ProcBot;

//# sourceMappingURL=procbot.js.map
