module.exports = function(RED) {
    "use strict";
    var serialAt = require("serial-at");

    function Rak811ConfigNode(n) {
        RED.nodes.createNode(this,n);
        this.host = n.host;
        this.port = n.port;

        var node = this;
        this.users = {};

        this.register = function(rak811Node){
            node.users[rak811Node.id] = rak811Node;
            if(Object,keys(node.users).length ===1){
                node.connect();
            }
        };

        this.deregister = function(rak811Node, done){
            delete node.users[rak811Node.id];
            if(node.closing){
                return done();
            }
            if(Object.keys(node.users).length === 0){
                if(node.port && node.port.connected){
                    return node.port.close();
                }
            }
        };

        this.connect = async function(){
            this.port = new serialAt('/dev/serial0');

            // Open Serial connection
            await this.port.open();

            this.log(await this.port.at('at+version'));
        }
    }
    RED.nodes.registerType("rak811-config",Rak811ConfigNode);
};