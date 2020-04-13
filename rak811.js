module.exports = function(RED){
    function Rak811Node(config){
        RED.nodes.createNode(this, config);
        var node = this;
        node.on('input', function(msg, send, done){
            send = send || function() { node.send.apply(node,arguments) };

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
            }

            
            send(msg);

            if(done){
                done();
            }

            
        });

    }
    RED.nodes.registerType("rak811", Rak811Node);
};