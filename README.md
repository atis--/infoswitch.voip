
# infoswitch.voip

## Install

Yate external control library.

    :::bash
    npm install --save infoswitch.voip


## Usage

Create Yate PBX instance (default config values are used in this example):

    :::js
    var YateExt = require('infoswitch.js').YateExt;

    var pbx = new YateExt({
        host: 'localhost',
        port: 7777,
        reconnectInterval: 5000,            // set to `null` to disable reconnect
        callTimeout: 2 * 60 * 60 * 1000,    // 2 hours
        callSetupTimeout: 70 * 1000,        // pick-up timeout
        allowUnregistered: false,
        authenticator: function (user, done) {
            // always authenticate after 3 seconds
            setTimeout(function () {
                done(true);
            }, 3000);

            // we could return a bluebird promise here as well
        },
        authenticateTimeout: 5000           // how long to wait for authenticator()
    });

Connect to Yate. If `reconnectInterval` is set, then we'll keep reconnecting
even after disconnect

    :::js
    pbx.connect();


### Events

The PBX instance emits a lot of different events. The `error` event is the most
important one

    :::js
    pbx.on('error', function (err) {
        console.log(err.stack);
    });

Call events

    :::js
    pbx.on('incoming-call', function (channel, info) {
        console.log('incoming call');
    });
    pbx.on('outgoing-call', function (ivr_channel, info) {
        console.log('outgoing call');
    });

Then there are events related to connection, carrier, and user status

    :::js
    pbx.on('connect', function (info) {
        console.log('connecting to Yate @ %s:%s ...', info.host, info.port);
    });
    pbx.on('connected', function () {
        console.log('connected to Yate!');
    });
    pbx.on('disconnected', function () {
        console.log('disconnected from Yate')
    });
    pbx.on('carrier-online', function (carrier) {
        console.log('carrier online', carrier);
    });
    pbx.on('carrier-offline', function (carrier) {
        console.log('carrier offline', carrier);
    });
    pbx.on('user-register', function (user) {
        console.log('user register', user);
    });
    pbx.on('user-unregister', function (user) {
        console.log('user unregister', user);
    });
    pbx.on('user-expired', function (user) {
        console.log('user expired', user);
    });

... and then some internal Yate-specific events

    :::js
    pbx.on('send-line', function (line) {
        console.log('send line', line);
    });
    pbx.on('recv-line', function (line) {
        console.log('receive line', line);
    });
    pbx.on('suppress-line', function (line) {
        console.log('failed to send line', line);
    });
    pbx.on('install-confirm', function (cmd) {
        console.log('install confirmation', cmd);
    });
    pbx.on('watch-confirm', function (cmd) {
        console.log('watch confirmation', cmd);
    });
    pbx.on('reply-unhandled', function (msg) {
        console.log('reply to unhandled message', msg);
    });


### Add carrier account

    :::js
    pbx.addCarrier({
        host: 'your.gateway.com',
        username: 'your username',
        password: 'your password'
    });


### Outgoing call

Make an outgoing call (do this after `connected` or else it'll fail)

    :::js
    // make an outgoing call
    var destination = {
        called: '31999999999',
        routes: [
            {
                host: 'your.gateway1.com:8888',
                caller: '555555',
                formats: 'g729,g723'
            },
            {
                host: 'your.gateway2.com:8888',
                caller: '6666666',
                called: '00031999999999'
            }
        ]
    };
    pbx.makeCall(destination, function (err, ivr_channel) {
        if (!err)
            console.log('outgoing call started');
    });


## Channels

(TBD)
