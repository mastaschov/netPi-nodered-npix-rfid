/**************************************************************************************
 * Copyright (c) 2017 Hilscher Gesellschaft fuer Systemautomation mbH
 * See LICENSE
 ***************************************************************************************
 * Description:
 * Node-RED node communicating with NIOT-E-NPIX-RFID or NHAT 52-RFID module
 **************************************************************************************/

module.exports = function (RED) {
    "use strict";
    var logLevel = 0; // 0:show nothing, 1:show error, 2: error, warning, 3: error, warning, info

    // System libraries
    var events = require("events");
    var fs = require('fs');

    // Other libraries
    var async = require('async');
    var java = require('java');
    var locks = require('locks');
    var gpio;
    try {
        var cpu = fs.readFileSync("/proc/cpuinfo").toString();
        if (cpu.indexOf(": BCM") !== -1) {
            gpio = require('rpi-gpio');
        }
    } catch (error) {
    }
    if (typeof (gpio) === 'undefined') {
        RED.log.warn("[rfid] No gpio features available");
    }

    // load rfid methods
    var rfidPath = __dirname + "/RfidNode.jar"; // build with mercuryapi-1.29.4.22
    java.classpath.push(rfidPath);
    if (logLevel > 2) {
        RED.log.info("[rfid] libpath: " + rfidPath);
    }
    var RFID = java.import("rfidnode.RfidNode");

    function ReaderNode(n) {
        RED.nodes.createNode(this, n);
        var node = this;
        // Retrieve configuration from Node-RED html
        this.port = n.port.toString();
        this.region = getregion(n.region);
        this.power = parseInt(n.power);
        node.users = {}; //a list of all nodes using this config
        node.userRfidGpi = {}; // a list of all rfid gpi nodes
        node.userRfidGpo = {}; // a list of all rfid gpo nodes
        node.cnt = {"rfid": 0, "input": 0, "output": 0}; // a list of registered nodes
        node.connected = false;
        node.op = null;
        node.stopping = false;
        node.tasks = "read,write,start,stop,lock,kill,info,reboot,fwupdate";
        node.readInterval = null;
        node.tempInterval = null;
        node.conTimer = null;
        node.mutex = locks.createMutex();
        node.StateEnum = {UNINIT: "UNINIT", INIT: "INIT", CONNECTED: "CONNECTED", TASK: "TASK", ERROR: "ERROR", DISCONNECTED: "DISCONNECTED"};
        node.state = node.StateEnum.UNINIT;
        node.myEmitter = new events.EventEmitter;
        log("Entering state " + node.state, 3, node);

        // state init
        node.myEmitter.on('init', function () {
            node.state = node.StateEnum.INIT;
            log("Entering state " + node.state, 3, node);
            for (var id in node.users) {
                if (node.users.hasOwnProperty(id)) {
                    node.users[id].status({fill: "red", shape: "ring", text: "connecting..."});
                }
            }
            // establish connection
            node.connected = false;
            if (node.port.length === 0 || node.region === null) {
                node.myEmitter.emit('error', "no port or region selected");
            } else {
                async.series([
                    function (callback) {
                        setTimeout(function () {
                            callback();
                        }, 500);
                    },
                    function (callback) {
                        if (typeof gpio !== 'undefined') {
                            log("Enable GPIO17", 3, node);
                            gpio.setup(11, gpio.DIR_OUT, function (err) {
                                if (err)
                                    console.log(" INIT GPIO ERROR" + err);
                                callback();
                            });
                        } else {
                            callback();
                        }
                    },
                    function (callback) {
                        if (typeof gpio !== 'undefined') {
                            log("Write GPIO17", 3, node);

                            gpio.write(11, true, callback);
                        } else {
                            callback();
                        }
                    },
                    function (callback) {
                        log("Init reader", 3, node);
                        RFID.initTimeout(node.port, node.region, node.power, 2, function (ex) { // 2 seconds timeout 
                            /* check if this is a current timeout exception */ 
                            if( Object.keys(node.users).length > 0) {

                                if (ex) {
                                    var errormessage;
                                    try {
                                        errormessage = "connection " + ex.cause.getMessageSync();
                                    } catch (ex) {
                                        errormessage = "connection timeout";
                                    }
                                    callback(errormessage);
                                } else {
                                    callback("Reader initialized");
                                }
                            }
                        });
                    },
                    function (callback) {
                        RFID.getReaderTemperature(function (ex, temperature) {
                            if (ex) {
                                callback(ex);
                            } else if (temperature === "Timeout") {
                                callback("connectionTimeout");
                            } else {
                                callback("Reader initialized");
                            }
                        });
                    }
                ], function (cbmsg) {
                    if (cbmsg === "Reader initialized") {
                        node.connected = true;
                        log("Reader initialized: " + node.port + "|" + n.region + "|" + node.power + "dBm", 3, node);
                        node.myEmitter.emit('connected'); // -> state connected
                    } else {
                        log("cbmsg: " + cbmsg + " " , 3, node);
                        node.myEmitter.emit('error', cbmsg); //-> state error
                    }
                });
            }
        });

        // State connected
        node.myEmitter.on('connected', function () {
            if(node.conTimer) { 
              clearTimeout(node.conTimer);
              node.conTimer = null;   
            }
            node.state = node.StateEnum.CONNECTED;
            log("Entering state " + node.state, 3, node);
            for (var id in node.users) {
                if (node.users.hasOwnProperty(id)) {
                    node.users[id].status({fill: "blue", shape: "dot", text: "connected"});
                }
            }
            node.tempInterval = setInterval(function () { // read temperature and check connection
                RFID.getReaderTemperature(function (ex, temperature) {
                    if (ex) {
                        if(node.tempInterval) {  
                          clearInterval(node.tempInterval);
                          node.tempInterval = null;    
                        }
                        node.myEmitter.emit('error', ex);
                    } else if (temperature === "Timeout") {
                        if(node.tempInterval) {  
                          clearInterval(node.tempInterval);
                          node.tempInterval = null;    
                        }
                        node.myEmitter.emit('error', "connectionTimeout"); //-> state error
                    } else {
                        for (var id in node.users) {
                            if (node.users.hasOwnProperty(id)) {
                                node.users[id].status({fill: "blue", shape: "dot", text: "connected " + temperature + "°C"});
                            }
                        }
                    }
                });
            }, 3000);
        });

        // State task
        node.myEmitter.on('task', function (myNode, myMsg) {
            if(node.tempInterval) {  
               clearInterval(node.tempInterval);
               node.tempInterval = null;    
            }


            node.state = node.StateEnum.TASK;
            log("Entering state " + node.state, 3, node);
            if (node.mutex.tryLock()) {
                node.op = myMsg.payload;
                for (var id in node.users) {
                    if (node.users.hasOwnProperty(id)) {
                        node.users[id].status({fill: "yellow", shape: "dot", text: "task " + node.op});
                    }
                }
                if (node.op === "read") {
                    RFID.readTag(myMsg.argument, function (ex, tag) {
                        if (ex) {
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            node.myEmitter.emit('error', ex, myNode, myMsg); // -> state error
                        } else {
                            try {
                                myMsg.epc = tag.getEpcSync();
                                var mem;
                                mem = tag.getResSync();
                                if (mem !== null)
                                    myMsg.res = mem;
                                mem = tag.getTidMemSync();
                                if (mem !== null)
                                    myMsg.tid = mem;
                                mem = tag.getUserMemSync();
                                if (mem !== null)
                                    myMsg.user = mem;
                                myNode.send(myMsg);
                                if (node.mutex.isLocked) {
                                    node.mutex.unlock();
                                }
                                node.myEmitter.emit('connected');
                            } catch (exception) {
                                if (node.mutex.isLocked) {
                                    node.mutex.unlock();
                                }
                                node.myEmitter.emit('error', "getData", myNode, myMsg); // -> state error
                            }
                        }
                    });
                } else if (node.op === "start") {
                    node.op = "continuous read";
                    RFID.startRead(function (ex) {
                        if (ex) {
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            node.myEmitter.emit('error', ex, myNode, myMsg); // -> state error
                        } else {
                            node.readInterval = setInterval(function () { // Eject Tag ID's
                                try {
                                    var tags = RFID.getTagsSync();
                                    var temp = RFID.readReaderTemperatureSync();
                                } catch (ex) {
                                    if (node.mutex.isLocked) {
                                        node.mutex.unlock();
                                    }
                                    node.myEmitter.emit('error', ex); // -> state error
                                }
                                var length = tags.length;
                                var i;

                                for (i = 0; i < length; i++) {
                                    // myMsg.payload = "continuous read";
                                    // myMsg.epc = tags[i];
                                    // myNode.send(myMsg);
                                    var msg = {topic: "rfid"};
                                    msg.payload = "continuous read";
                                    msg.epc = tags[i];
                                    myNode.send(msg);
                                }
                                var tempMsg = {topic: "temp"};
                                tempMsg.payload = temp;
                                myNode.send(tempMsg);


                                if (temp !== -100) {
                                    for (var id in node.users) {
                                        if (node.users.hasOwnProperty(id)) {
                                            node.users[id].status({fill: "yellow", shape: "dot", text: "task " + node.op + " " + temp + "°C"});
                                        }
                                    }
                                } else {
                                    if (node.mutex.isLocked) {
                                        node.mutex.unlock();
                                    }
                                    node.myEmitter.emit('error', "connectionTimeout", myNode, myMsg); // -> state error
                                }
                            }, 500);
                        }
                    });
                } else if (node.op === "write") {
                    if (myMsg.filter === undefined) {
                        myMsg.filter = "";
                    }
                    if (myMsg.epc === undefined) {
                        myMsg.epc = "";
                    }
                    if (myMsg.res === undefined) {
                        myMsg.res = "";
                    }
                    if (myMsg.user === undefined) {
                        myMsg.user = "";
                    }
                    myMsg.filter = myMsg.filter.toString().toUpperCase();
                    myMsg.epc = myMsg.epc.toString().toUpperCase();
                    myMsg.res = myMsg.res.toString().toUpperCase();
                    myMsg.user = myMsg.user.toString().toUpperCase();
                    RFID.writeTag(myMsg.filter, myMsg.epc, myMsg.res, myMsg.user, function (ex) {
                        if (ex) {
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            node.myEmitter.emit('error', ex, myNode, myMsg); // -> state error
                        } else {
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            myNode.send(myMsg);
                            node.myEmitter.emit('connected');
                        }
                    });
                } else if (node.op === "lock") {
                    if (myMsg.filter === undefined) {
                        myMsg.filter = "";
                    }
                    if (myMsg.locks === undefined) {
                        myMsg.locks = "";
                    }
                    if (myMsg.password === undefined) {
                        myMsg.password = "";
                    }
                    myMsg.filter = myMsg.filter.toString().toUpperCase();
                    myMsg.locks = myMsg.locks.toString().toUpperCase();
                    myMsg.password = myMsg.password.toString().toUpperCase();
                    RFID.lockAction(myMsg.filter, myMsg.locks, myMsg.password, function (ex) {
                        if (ex) {
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            node.myEmitter.emit('error', ex, myNode, myMsg); // -> state error
                        } else {
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            myNode.send(myMsg);
                            node.myEmitter.emit('connected');
                        }
                    });
                } else if (node.op === "kill") {
                    if (myMsg.filter === undefined) {
                        myMsg.filter = "";
                    }
                    if (myMsg.password === undefined) {
                        myMsg.password = "";
                    }
                    myMsg.filter = myMsg.filter.toString().toUpperCase();
                    myMsg.password = myMsg.password.toString().toUpperCase();
                    RFID.killTag(myMsg.filter, myMsg.password, function (ex) {
                        if (ex) {
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            node.myEmitter.emit('error', ex, myNode, myMsg); // -> state error
                        } else {
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            myNode.send(myMsg);
                            node.myEmitter.emit('connected');
                        }
                    });
                } else if (node.op === "info") {
                    RFID.getInfo(function (ex, output) {
                        if (ex) {
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            node.myEmitter.emit('error', ex, myNode, myMsg); // -> state error
                        } else {
                            myMsg.payload = output;
                            myNode.send(myMsg);
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            node.myEmitter.emit('connected');
                        }
                    });
                } else if (node.op === "fwupdate") {
                    if (myMsg.path === undefined) {
                        myMsg.path = "";
                    }
                    log("Updating firmware takes a minute...", 1, node);
                    RFID.firmwareUpdate(myMsg.path, function (ex, output) {
                        if (ex) {
                            try {
                                myMsg.payload = myMsg.payload + ": " + ex.cause.getMessageSync();
                            } catch (err) {
                                myMsg.payload = myMsg.payload + ": " + err;
                            }
                            log(myMsg.payload, 1, node);
                            myNode.send(myMsg);
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            node.myEmitter.emit('error', "reboot", myNode, myMsg); // -> state error
                        } else {
                            myMsg.payload = myMsg.payload + ": " + output;
                            log(output, 1, node);

                            myNode.send(myMsg);
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            node.myEmitter.emit('error', "reboot", myNode, myMsg); // -> state error

                        }

                    });
                } else if (node.op === "reboot") {
                    if (node.mutex.isLocked) {
                        node.mutex.unlock();
                    }
                    node.myEmitter.emit('error', "reboot", myNode, myMsg); // -> state error
                } else { // no task
                    if (node.mutex.isLocked) {
                        node.mutex.unlock();
                    }
                    log("Something unrecognised is in the mutex " + node.state, 2, node);
                    node.myEmitter.emit('connected'); // -> state connected
                }
            } else {
                if (myMsg.payload === "stop" && !node.stopping) {
                    node.op = myMsg.payload;
                    for (var id in node.users) {
                        if (node.users.hasOwnProperty(id)) {
                            node.users[id].status({fill: "yellow", shape: "dot", text: "task " + node.op});
                        }
                    }
                    node.stopping = true;
                    if(node.readInterval) {
                      clearInterval(node.readInterval);
                      node.readInterval = null;  
                    }
                    RFID.stopRead(function (ex) {
                        if (ex) {
                            node.stopping = false;
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            node.myEmitter.emit('error', ex, myNode, myMsg); // -> state error
                        } else {
                            node.stopping = false;
                            if (node.mutex.isLocked) {
                                node.mutex.unlock();
                            }
                            node.myEmitter.emit('connected');
                        }
                    });
                } else {
                    if (typeof myMsg.argument !== 'undefined') {
                        myMsg.payload = myMsg.payload + ":" + myMsg.argument;// + " failed: " + "reader busy: " + node.op;
                        delete myMsg.argument;
                    }
                    myMsg.payload = myMsg.payload + " failed: " + "reader busy";
                    myNode.warn(myMsg);
                }
            }// end tryLock
        });

        // State error
        node.myEmitter.on('error', function (err, myNode, myMsg) {
            node.state = node.StateEnum.ERROR;
            log("Entering state " + node.state, 3, node);
            if(node.readInterval) {
              clearInterval(node.readInterval);
              node.readInterval = null;  
            }
            if(node.tempInterval) {  
              clearInterval(node.tempInterval);
              node.tempInterval = null;    
            }
         
  
            if(node.conTimer) { 
              clearTimeout(node.conTimer);
              node.conTimer = null;   
            }

            if (node.mutex.isLocked) { // unlock mutex
                node.mutex.unlock();
            }
            var errMessage;
            var errClass;
            try {
                errMessage = err.cause.getMessageSync().toString();
                errClass = err.cause.getClassSync().toString();
            } catch (ex) {
                errMessage = err;
                errClass = "";
            }
            if (errMessage.search("No such file or directory") >= 0) {
                errMessage = "port not found";
            }
            for (var id in node.users) {
                if (node.users.hasOwnProperty(id)) {
                    node.users[id].status({fill: "red", shape: "dot", text: "error: " + errMessage});
                }
            }
            if (typeof (myNode) !== "undefined" && errMessage !== "reboot") {
                myMsg.payload = myMsg.payload + " failed: " + errMessage;
                myNode.warn(myMsg);
            }
            if (errClass === "class com.thingmagic.ReaderCommException"
                    || errMessage === "connection timeout"
                    || errMessage === "connection null"
                    || errMessage === "port not found"
                    //|| errMessage === "no connected antenna"
                    || errMessage === "no port or region selected"
                    || errMessage === "connectionTimeout"
                    || errMessage === "reboot") {
                try {
                    if (node.op === "continuous read") {
                        RFID.stopReadSync();
                        log("Continuous Read stop", 1, node);
                    }
                    RFID.destroySync();
                } catch (ex) {
                }
                if (typeof gpio !== 'undefined') {
                    gpio.write(11, false);
                    log("Disable GPIO17", 1, node);
                }
                node.connected = false;
                log("Error message: " + errMessage, 1, node);
                //log("ErrorClass:" + errClass,1,node);
                node.myEmitter.emit('disconnected');
            } else {
                log("Warning: " + errMessage, 2, node);
                node.myEmitter.emit('connected');
            }
        });

        // State disconnected
        node.myEmitter.on('disconnected', function () {
            node.state = node.StateEnum.DISCONNECTED;
            log("Entering state " + node.state, 3, node);
            node.conTimer = setTimeout(function () {
                log("Device disconnected try reconnect...", 1, node);
                node.conTimer = null;
                node.myEmitter.emit('init');
            }, 3000);
        });

        // gpio handling
        var lastchange = 0;
        var currentchange = 0;
        var gpiState = -1;
        if (typeof gpio !== 'undefined') {
            gpio.on('change', function (channel, value) {
                if (value === true) {
                    value = 1;
                } else {
                    value = 0;
                }
                var msg = {topic: "rfid gpi"};
                //console.log(channel + " " + value);
                currentchange = new Date().getTime();
                if ((currentchange - lastchange) > 25 && gpiState !== value) {
                    //console.log('Channel ' + channel + ' value is now ' + value);
                    if (channel === 15) {
                        lastchange = currentchange;
                        gpiState = value;
                        msg.payload = value;
                        for (var id in node.userRfidGpi) {
                            if (node.userRfidGpi.hasOwnProperty(id)) {
                                node.userRfidGpi[id].status({fill: "blue", shape: "dot", text: value});
                                node.userRfidGpi[id].send(msg);
                            }
                        }
                    }
                }

            });
        }

        // register node
        node.register = function (myNode) {
            if (myNode.type === "rfid") {
                node.users[myNode.id] = myNode;
                node.cnt.rfid++;
                log("Register node: " + myNode.id.toString() + " @ Config: " + myNode.ReaderConfig.id.toString()
                        + " Node counter rfid:" + node.cnt.rfid + " input:" + node.cnt.input + " output: " + node.cnt.output, 3, node);
                for (var id in node.users) {
                    if (node.users.hasOwnProperty(id)) {
                        node.users[id].status({fill: "red", shape: "dot", text: "disconnected"});
                    }
                }
                // First user node starts init
                if (Object.keys(node.users).length === 1) {
                    node.myEmitter.emit('init'); // -> state init 
                }
            } else if (myNode.type === "rfid gpi") {
                node.userRfidGpi[myNode.id] = myNode;
                node.cnt.input++;
                if (Object.keys(node.userRfidGpi).length === 1) { // first init
                    for (var id in node.userRfidGpi) {
                        if (node.userRfidGpi.hasOwnProperty(id)) {
                            node.userRfidGpi[id].status({fill: "blue", shape: "dot", text: " "});
                        }
                    }
                    if (typeof gpio !== 'undefined') {
                        gpio.setup(15, gpio.DIR_IN, gpio.EDGE_BOTH);
                    } else {

                    }
                }
                log("Register node: " + myNode.id.toString() + " @ Config: " + myNode.ReaderConfig.id.toString()
                        + " Node counter rfid:" + node.cnt.rfid + " input:" + node.cnt.input + " output: " + node.cnt.output, 3, node);
            } else if (myNode.type === "rfid gpo") {
                node.userRfidGpo[myNode.id] = myNode;
                node.cnt.output++;
                if (Object.keys(node.userRfidGpo).length === 1) { // first init

                    if (typeof gpio !== 'undefined') {

                        gpio.setup(16, gpio.DIR_OUT);
                    }
                }
                for (var id in node.userRfidGpo) {
                    if (node.userRfidGpo.hasOwnProperty(id)) {
                        node.userRfidGpo[id].status({fill: "blue", shape: "dot", text: " "});
                    }
                }
                log("Register node: " + myNode.id.toString() + " @ Config: " + myNode.ReaderConfig.id.toString()
                        + " Node counter rfid:" + node.cnt.rfid + " input:" + node.cnt.input + " output: " + node.cnt.output, 3, node);
            }
        };
        // deregister node
        node.deregister = function (myNode, done) {
            if (myNode.type === "rfid") {
                delete node.users[myNode.id];
                node.cnt.rfid--;
                done();
            } else if (myNode.type === "rfid gpi") {
                delete node.userRfidGpi[myNode.id];
                node.cnt.input--;
                done();
            } else if (myNode.type === "rfid gpo") {
                delete node.userRfidGpo[myNode.id];
                node.cnt.output--;
                done();
            }
            log("Deregister node: " + myNode.id.toString() + " @ Config: " + myNode.ReaderConfig.id.toString()
                    + " Node counter rfid:" + node.cnt.rfid + " input:" + node.cnt.input + " output: " + node.cnt.output, 3, node);
        };
        // close node
        node.on('close', function (done) {
            log("Closing node", 3, node);
            if(node.readInterval) {
               clearInterval(node.readInterval);
               node.readInterval = null;  
            }

            if(node.tempInterval) {  
              clearInterval(node.tempInterval);
              node.tempInterval = null;    
            }
            
            if(node.conTimer) { 
              clearTimeout(node.conTimer);
              node.conTimer = null;   
            }

            if (node.myEmitter) {
                node.myEmitter.removeAllListeners('init');
                node.myEmitter.removeAllListeners('connected');
                node.myEmitter.removeAllListeners('task');
                node.myEmitter.removeAllListeners('error');
                node.myEmitter.removeAllListeners('disconnected');
            }
            var errmsg = {topic: "rfid"};
            try {
                if (node.op === "continuous read") {
                    RFID.stopReadSync();
                }
                //RFID.destroySync();
            } catch (ex) {
                errmsg.payload = "Error while stop reader: ";
                log(errmsg, 1, node);
            }
            if (typeof gpio !== 'undefined') {
                gpio.destroy(function () {
                    log("Disable GPIO17 and reader closed", 3, node);
                    done();
                });
            } else {
                log("Reader closed", 3, node);
                done();
            }
        });
    }
    RED.nodes.registerType("rfid-reader", ReaderNode);
    function RfidNode(n) {
        RED.nodes.createNode(this, n);
        this.reader = n.reader;
        this.ReaderConfig = RED.nodes.getNode(this.reader);
        if (this.ReaderConfig) {
            var node = this;
            this.port = this.ReaderConfig.port;
            this.region = this.ReaderConfig.region;
            this.power = this.ReaderConfig.power;
            node.ReaderConfig.register(node, function (callback) {});
            this.on('input', function (msg) {
                if (node.ReaderConfig.state === node.ReaderConfig.StateEnum.CONNECTED ||
                        node.ReaderConfig.state === node.ReaderConfig.StateEnum.TASK) {
                    if (typeof msg.payload === "string") {
                        if (msg.payload.search("read") !== -1) {
                            var split = msg.payload.split(":");
                            msg.argument = "";
                            if (typeof split[0] !== 'undefined') {
                                msg.payload = split[0];
                            }
                            if (typeof split[1] !== 'undefined') {
                                msg.argument = split[1];
                            }
                        }
                        if (node.ReaderConfig.tasks.search(msg.payload) >= 0) { // if payload holds a valid task
                            node.ReaderConfig.myEmitter.emit('task', node, msg);
                        } else {
                            msg.payload = "Invalid operation: " + msg.payload;
                            node.send(msg);
                        }
                    } else {
                        msg.payload = "msg.payload isn't a string: " + msg.payload;
                        node.send(msg);
                    }
                } else {
                    if (!node.ReaderConfig.connected) {
                        msg.payload = msg.payload + " failed: reader not available";
                        node.send(msg);
                        /////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                    }
                }
            });
            this.on('close', function (done) {
                node.ReaderConfig.deregister(node, done);
            });
        } else {
            this.status({fill: "grey", shape: "dot", text: "config missing"});
            this.log("Missing rfid read config");
        }
    }
    RED.nodes.registerType("rfid", RfidNode);

    function RfidGpi(n) {
        RED.nodes.createNode(this, n);
        this.reader = n.reader;
        this.ReaderConfig = RED.nodes.getNode(this.reader);
        if (this.ReaderConfig) {
            var node = this;
            node.ReaderConfig.register(node);
            if (typeof gpio !== 'undefined') {
                node.status({fill: "blue", shape: "dot", text: " "});
            } else {
                node.status({fill: "grey", shape: "dot", text: "no gpio found "});
                this.log("no gpio found");
            }
            this.on('close', function (done) {
                node.ReaderConfig.deregister(node, done);
            });
        } else {
            this.status({fill: "grey", shape: "dot", text: "no gpio found"});
            this.log("no gpio found");
        }
    }
    RED.nodes.registerType("rfid gpi", RfidGpi);

    function RfidGpo(n) {
        RED.nodes.createNode(this, n);
        this.reader = n.reader;
        this.ReaderConfig = RED.nodes.getNode(this.reader);
        if (this.ReaderConfig) {
            var node = this;
            node.ReaderConfig.register(node);
            if (typeof gpio !== 'undefined') {
                this.on('input', function (msg) {
                    if (msg.payload === 1 || msg.payload === 0) {
                        if (msg.payload === 1) {
                            msg.payload === true;
                        } else {
                            msg.payload === false;
                        }
                        gpio.write(16, msg.payload, function (err) {
                            if (err)
                                log(err, 1, node);
                        });
                        node.status({fill: "blue", shape: "dot", text: msg.payload});
                    }
                });
            } else {
                node.status({fill: "grey", shape: "dot", text: " no gpio found "});
            }
            this.on('close', function (done) {
                node.ReaderConfig.deregister(node, done);
            });
        } else {
            this.status({fill: "grey", shape: "dot", text: "no gpio found"});
            this.log("no gpio found");
        }
    }
    RED.nodes.registerType("rfid gpo", RfidGpo);

    /**
     * @description return numeric Region Code
     * @param {anyVal} region - Region code from config node
     * @returns	a number for each region AU=7 EU=5 IN=2 JP=3 KR=6 NA=1 NZ=8 CN=4
     */
    function getregion(region) {
        var regionNum = null;
        switch (region) {
            case "AU":
                regionNum = 7;
                break;
            case "CN":
                regionNum = 4;
                break;
            case "EU":
                regionNum = 5;
                break;
            case "IN":
                regionNum = 2;
                break;
            case "JP":
                regionNum = 3;
                break;
            case "KR":
                regionNum = 6;
                break;
            case "NA":
                regionNum = 1;
                break;
            case "NZ":
                regionNum = 8;
                break;
            default:
                regionNum = null;
        }
        return regionNum;
    }

    /**
     * @description outputfunction to log depending on the var logLevel
     * @param {} text : log text
     * @param {} level : 1: error, 2: warning, 3: info
     * @param {} node : node which logs
     */
    function log(text, level, node) {
        if (logLevel >= level) {
            node.log(text);
        }
    }

};
