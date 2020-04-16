module.exports = function (RED) {
    "use strict";
    const SerialPort = require("serialport");
    const Readline = SerialPort.parsers.Readline;

    const SERIAL_PORT = '/dev/serial0';

    const RESPONSE_OK = "OK";
    const RESPONSE_ERROR = "ERROR";
    const RESPONSE_EVENT = "at+recv=";
    const CMD_AT = "at+";
    const NEWLINE = "\r\n";

    const MODE_LORAWAN = 0
    const MODE_LORAP2P = 1

    const EVTC_RECV_DATA = 0;
    const EVTC_TX_CONFIRMED = 1;
    const EVTC_TX_UNCONFIRMED = 2;
    const EVTC_JOINED_SUCCESS = 3;
    const EVTC_JOINED_FAILED = 4;
    const EVTC_TX_TIMEOUT = 5;
    const EVTC_RX2_TIMEOUT = 6;
    const EVTC_DOWNLINK_REPEATED = 7;
    const EVTC_WAKE_UP = 8;
    const EVTC_P2PTX_COMPLETE = 9;
    const EVTC_UNKOWN = 100;

    const EVT_SUCCESS = [
        EVTC_RECV_DATA,
        EVTC_TX_CONFIRMED,
        EVTC_TX_UNCONFIRMED,
        EVTC_JOINED_SUCCESS,
        EVTC_DOWNLINK_REPEATED,
        EVTC_WAKE_UP,
        EVTC_P2PTX_COMPLETE
    ];

    const EVT_FAILURE = [
        EVTC_JOINED_FAILED,
        EVTC_TX_TIMEOUT,
        EVTC_RX2_TIMEOUT,
        EVTC_UNKOWN
    ]

    const EVT_MESSAGES = {};
    EVT_MESSAGES[EVTC_RECV_DATA] = "Received data";
    EVT_MESSAGES[EVTC_TX_CONFIRMED] = "Tx confirmed";
    EVT_MESSAGES[EVTC_TX_UNCONFIRMED] = "Tx unconfirmed";
    EVT_MESSAGES[EVTC_JOINED_SUCCESS] = "Join succeded";
    EVT_MESSAGES[EVTC_JOINED_FAILED] = "Join failed";
    EVT_MESSAGES[EVTC_TX_TIMEOUT] = "Tx timeout";
    EVT_MESSAGES[EVTC_RX2_TIMEOUT] = "Rx2 timeout";
    EVT_MESSAGES[EVTC_DOWNLINK_REPEATED] = "Downlink repeated";
    EVT_MESSAGES[EVTC_WAKE_UP] = "Wake up";
    EVT_MESSAGES[EVTC_P2PTX_COMPLETE] = "P2P tx complete";
    EVT_MESSAGES[EVTC_UNKOWN] = "Unknown";


    const ERR_ARG = -1;
    const ERR_ARG_NOT_FIND = -2;
    const ERR_JOIN_ABP = -3;
    const ERR_JOIN_OTAA = -4;
    const ERR_NOT_JOIN = -5;
    const ERR_MAC_BUSY = -6;
    const ERR_TX = -7;
    const ERR_INTER = -8;
    const ERR_WR_CFG = -11;
    const ERR_RD_CFG = -12;
    const ERR_TX_LEN_LIMITE = -13;
    const ERR_UNKNOWN = -20;

    const ERROR_MESSAGES = {};
    ERROR_MESSAGES[ERR_ARG] = "Invalid Argument";
    ERROR_MESSAGES[ERR_ARG_NOT_FIND] = "Argument not found";
    ERROR_MESSAGES[ERR_JOIN_ABP] = "ABP join error";
    ERROR_MESSAGES[ERR_JOIN_OTAA] = "OTAA join error";
    ERROR_MESSAGES[ERR_NOT_JOIN] = "Not joined";
    ERROR_MESSAGES[ERR_MAC_BUSY] = "MAC busy";
    ERROR_MESSAGES[ERR_TX] = "Transmit error";
    ERROR_MESSAGES[ERR_INTER] = "Inter error";
    ERROR_MESSAGES[ERR_WR_CFG] = "Write configuration error";
    ERROR_MESSAGES[ERR_RD_CFG] = "Read configuration Error";
    ERROR_MESSAGES[ERR_TX_LEN_LIMITE] = "Transmit len limit error";
    ERROR_MESSAGES[ERR_UNKNOWN] = "Unknown error";



    const QUEUE_POLL_TIMEOUT = 1000; // Half a second

    function Rak811ConfigNode(n) {
        RED.nodes.createNode(this, n);

        this.mode = n.mode
        this.band = n.band
        this.conMode = n.conMode;
        this.appEUI = n.appEUI;
        this.appKey = n.appKey;
        this.appsKey = n.appsKey;
        this.devAddr = n.devAddr;
        this.nwksKey = n.nwksKey;

        var node = this;

        // We need to Queue commands so that we don't flood the controller
        this.commandQueue = [];
        this.currentCommand = null;
        this.commandInProgress = false;


        // Config Node State
        this.connected = false;

        // This is effectively the list of nodes that are using this config instance
        this.users = {};

        // Serial Port Definition
        this.port = new SerialPort(SERIAL_PORT, {
            baudRate: 115200,
            autoOpen: false,
        });
        this.portParser = this.port.pipe(new Readline({
            delimiter: '\r\n'
        }));

        // Process incoming data
        this.portParser.on('data', function (message) {
            //node.log("Incoming data from port: " + message);

            // OK Response
            if (message.startsWith(RESPONSE_OK)) {
                message = message.substring(RESPONSE_OK.length)
                if (node.currentCommand && node.currentCommand.hasOwnProperty('callback')) {
                    var resp = {
                        success: true,
                        result: message
                    }
                    node.currentCommand.callback(resp, () => {
                        node.currentCommand = null;
                        node.commandInProgress = false;
                    });
                }

                // ERROR Response
            } else if (message.startsWith(RESPONSE_ERROR)) {
                message = message.substring(RESPONSE_ERROR.length);
                var errorCode = parseFloat(message);
                message = `Error ${errorCode} - ${ERROR_MESSAGES[errorCode]}`
                node.warn("RAK811 returned an error" + message);
                if (node.currentCommand && node.currentCommand.hasOwnProperty('type')) {
                    if (node.currentCommand && node.currentCommand.hasOwnProperty('callback')) {
                        var resp = {
                            success: false,
                            result: message
                        }
                        node.currentCommand.callback(resp, () => {
                            node.currentCommand = null;
                            node.commandInProgress = false;
                        });

                    }

                }

            } else if (message.startsWith(RESPONSE_EVENT)) {
                message = message.substring(RESPONSE_EVENT.length)
                var msgParts = message.split(",");
                var eventCode = parseInt(msgParts.shift());
                var evtMsg = EVT_MESSAGES[eventCode];

                if (eventCode === EVTC_RECV_DATA) {
                    // Downlink Message, pass to out node

                    var port = parseInt(msgParts.shift());
                    var rssi, snr = 0;
                    if (msgParts.length > 2) {
                        rssi = parseInt(msgParts.shift());
                        snr = parseInt(msgParts.shift());
                    }
                    var len = parseInt(msgParts.shift());
                    var data = '';
                    if (len > 0) {
                        data = msgParts.shift();
                    }


                    for (var id in node.users) {
                        if (node.users.hasOwnProperty(id)) {
                            if (node.users[id].type === "rak811Out") {
                                node.users[id].pushDownlink({
                                    port: port,
                                    rssi: rssi,
                                    snr: snr,
                                    len: len,
                                    data: data
                                });
                            }
                        }
                    }

                } else if (EVT_SUCCESS.includes(eventCode)) {
                    // Success Event
                    node.updateAllNodes({
                        fill: "green",
                        shape: "dot",
                        text: evtMsg
                    })
                } else {
                    // Failure Event
                    node.updateAllNodes({
                        fill: "yellow",
                        shape: "ring",
                        text: evtMsg
                    })
                }
            }
            // Now schedule the next Queue Poll
            setTimeout(node.pollQueue, QUEUE_POLL_TIMEOUT);
        })

        this.updateAllNodes = function (status) {
            for (var id in node.users) {
                if (node.users.hasOwnProperty(id)) {
                    node.users[id].status(status);
                }
            }
        }


        this.port.on('open', function () {
            node.connected = true;
            for (var id in node.users) {
                if (node.users.hasOwnProperty(id)) {
                    node.log("Setting Node to connected: " + id)
                    node.users[id].status({
                        fill: "green",
                        shape: "dot",
                        text: "Connected"
                    });
                }

            }
        });

        this.port.on('close', function () {
            node.connected = false;
            for (var id in node.users) {
                if (node.users.hasOwnProperty(id)) {
                    node.log("Setting Node to disconnected: " + id);
                    node.users[id].status({
                        fill: "red",
                        shape: "ring",
                        text: "Disconnected"
                    })
                }
            }
        });


        // Application level commands

        this.transmitPayload = function (payload, sendingNode) {
            var type = 0;
            var port = 1;

            const sendMessageCommand = `send=${type},${port},${payload}`;
            node.log("Attempting to Queue a command: " + sendMessageCommand)
            node.queueCommand(sendMessageCommand, "command", (result, complete) => {
                // Here we want to unpack the result and update the status of the sending node accordingly.
                // TODO - Update Status
                node.log("Recieved completed transmit command" + result.result)
                complete();
            })

        };




        // Register new nodes
        this.register = async function (rak811Node) {
            node.users[rak811Node.id] = rak811Node;
            if (Object.keys(node.users).length === 1) {
                await this.port.open(function (err) {
                    if (err) {
                        node.warn("Failed to open port to RAK811: " + err.message)
                        node.connected = false
                    } else {
                        node.queueCommand("get_config=dev_eui", "command", (result, complete) => {
                            if (result.success === true) {
                                node.defaultDeviceEUI = result.result;
                                node.log("RAK811 Device EUI: " + result.result);
                                n.devEui = result.result;
                                complete();
                            }
                        });

                        // Get config and write to device

                        if (n.mode === "lorawan") {

                            // Send mode
                            const mode_config = `mode=${MODE_LORAWAN}`
                            node.queueCommand(mode_config, "command", (result, complete) => {
                                if (result.success === true) {
                                    node.updateAllNodes({
                                        fill: "yellow",
                                        shape: "dot",
                                        text: "Mode Set."
                                    });
                                } else {
                                    node.updateAllNodes({
                                        fill: "red",
                                        shape: "ring",
                                        text: `Failed to set Mode: ${result.result}`
                                    });
                                }
                                complete();
                            });

                            // Send Band
                            const band_config = `band=${n.band}`
                            node.queueCommand(band_config, "command", (result, complete) => {
                                if (result.success === true) {
                                    node.updateAllNodes({
                                        fill: "yellow",
                                        shape: "dot",
                                        text: "Band Set."
                                    });
                                } else {
                                    node.updateAllNodes({
                                        fill: "red",
                                        shape: "ring",
                                        text: `Failed to set Band: ${result.result}`
                                    });
                                }
                                complete();
                            });

                            // Send conMode
                            if (n.conMode === "OTAA") {
                                // Set APP_EUI & APP_KEY
                                const otaa_config = `set_config=app_eui:${n.appEUI}&app_key:${n.appKey}`
                                node.queueCommand(otaa_config, "command", (result, complete) => {
                                    if (result.success === true) {
                                        node.updateAllNodes({
                                            fill: "yellow",
                                            shape: "dot",
                                            text: "OTAA Config Set."
                                        });
                                    } else {
                                        node.updateAllNodes({
                                            fill: "red",
                                            shape: "ring",
                                            text: "Failed to set OTAA Config: " + result.result
                                        });
                                    }
                                    complete();
                                });

                                const otaa_join = 'join=otaa';
                                node.queueCommand(otaa_join, "command", (result, complete) => {
                                    if (result.success === true) {
                                        node.updateAllNodes({
                                            fill: "yellow",
                                            shape: "dot",
                                            text: "Join request sent."
                                        });
                                    } else {
                                        node.updateAllNodes({
                                            fill: "red",
                                            shape: "ring",
                                            text: "Failed to join OTAA " + result.result
                                        });

                                    }
                                    complete();
                                });


                            } else {
                                // ABP
                                // Set Dev_addr
                                // Set apps_key
                                // Set nwks_key
                            }

                        }


                        // Only poll the Queue once we're connected.
                        node.pollQueue();
                    }
                });
                this.log("Connected? : " + this.connected)

                // Lets try queueing a command
                /*
                this.queueCommand("version", "command", (result, complete)=>{
                    if(result.success === true){
                        this.log("Version: " + result.result);
                        complete();
                    }
                });
                this.queueCommand("get_config=app_eui", "command", (result, complete)=>{
                    if(result.success === true){
                        this.log("APP EUI: " + result.result);
                        complete();
                    }
                });
                */

            }
        };

        // De-Register nodes that are deleted
        this.deregister = function (rak811Node, done) {
            delete node.users[rak811Node.id];
            node.log("Deregistering Node: " + rak811Node.id);
            if (node.closing) {
                return done();
            }
            if (Object.keys(node.users).length === 0) {
                if (this.port) {
                    this.port.close();
                    this.connected = false;
                    done();
                }
            }
        };

        this.queueCommand = function (command, type, callback) {
            /*
            Queues a command to be sent to the RAK811 Serial AT command processor
            expects a command (Missing the 'at+' and the '\r\n') and a callback that
            expects a single result object that will look like this:
            {
                success: true | false,
                result: "Any data that is returned by the command"
            }
            as well as a referece to a callback that will signal that the command is completed.
            */
            //node.log("Queueing command: " + command + " " + type)
            this.commandQueue.unshift({
                command: command,
                type: type,
                callback: callback
            });

        }

        // Timer to poll Queue and execute commands

        this.pollQueue = function () {
            //node.log("Polling Queue for new messages: Queue length: " + node.commandQueue.length);
            if (node.commandInProgress != null && node.commandInProgress === false && node.commandQueue.length > 0) {

                // Get a command and run it
                var commandToRun = node.commandQueue.pop();

                // Mark it as the currently running command
                node.currentCommand = commandToRun;
                node.commandInProgress = true;

                // Send the command
                var toSend = CMD_AT + commandToRun.command + NEWLINE;
                //node.log("Sending command to RAK811: " + CMD_AT + commandToRun.command)
                node.port.write(toSend, function (err) {
                    if (err) {
                        node.log('Error on Serial write: ', err.message);
                        commandToRun.callback({
                            success: false,
                            result: err.message
                        }, () => {
                            node.currentCommand = null;
                            node.commandInProgress = false;
                        });

                    }
                });
            } else {
                // Now schedule the next Queue Poll
                setTimeout(node.pollQueue, QUEUE_POLL_TIMEOUT);
            }
        }






    }


    function Rak811Node(n) {
        RED.nodes.createNode(this, n);
        this.config = n.config;
        this.configConn = RED.nodes.getNode(this.config);
        var node = this;

        if (this.configConn) {
            this.status({
                fill: "red",
                shape: "ring",
                text: "Disconnected"
            });

            this.on('input', function (msg, send, done) {
                send = send || function () {
                    node.send.apply(node, arguments)
                };
                /*
                if(!Buffer.isBuffer(msg.payload)){
                    if(typeof msg.payload === "string"){
                        msg.payload = Buffer.from(msg.payload, 'utf8');
                    } else if(typeof msg.payload === "number"){
                        // TODO - Convert number to a buffer
                    } else if(typeof msg.payload === "boolean"){
                        if(msg.payload == true){
                            msg.payload = Buffer.from([1]);
                        } else {
                            msg.payload = Buffer.from([1]);
                        }
                    }
                }*/


                this.configConn.transmitPayload(msg.payload, node)

                if (done) {
                    done();
                }

            });

            if (this.configConn.connected) {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "Connected"
                })
            }

            node.configConn.register(node);
            this.on('close', function (done) {
                node.configConn.deregister(node, done);
            })
        } else {
            this.error("RAK811 Node missing config");
        }
    }


    function Rak811OutNode(n) {
        RED.nodes.createNode(this, n);
        this.config = n.config;
        this.configConn = RED.nodes.getNode(this.config);
        var node = this;

        if (this.configConn) {
            this.status({
                fill: "red",
                shape: "ring",
                text: "Disconnected"
            });

            this.pushDownlink = function(message){
                //send = send || function() { node.send.apply(node,arguments) };
                var msg = {};
                msg.payload = message;
                this.send(msg);

            }
            


            if (this.configConn.connected) {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "Connected"
                })
            }

            node.configConn.register(node);

            this.on('close', function (done) {
                node.configConn.deregister(node, done);
            })
        } else {
            this.error("RAK811 Node missing config");
        }
    }



    // Register all of the Nodes with Node-RED
    RED.nodes.registerType("rak811-config", Rak811ConfigNode);
    RED.nodes.registerType("rak811", Rak811Node);
    RED.nodes.registerType("rak811Out", Rak811OutNode);
};