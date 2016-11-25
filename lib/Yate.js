'use strict';

//
// This module implements communication with Yate telephony engine via the
// external module interface.
//
// Yate message format:
//     http://yate.null.ro/docs/extmodule.html
//

const net = require('net');
const util = require('util');
const carrier = require('carrier');
const { EventEmitter } = require('events');
const { extractIP, makeLineID } = require('./Utils');
const YateChannel = require('./YateChannel');
const assert = console.assert;

//
// installed message command handlers:
//     message name -> priority
//
const install_list = {
    'call.route': 10,
    'user.auth': 10,
    'user.register': 10
};

//
// watched messages
//
const watch_list = {
    'call.execute': true,
    'user.login': true,
    'user.unregister': true,
    'user.notify': true,
    'chan.connected': true,
    'chan.hangup': true,
    'chan.notify': true,
    'chan.dtmf': true
};

//
// copy props from <o2> into <o1> if they're not `undefined`; return <o1>
//
function extend_defined(o1, o2) {
    for (var k in o2) {
        if (typeof o2[k] != 'undefined')
            o1[k] = o2[k];
    }
    return o1;
}

//
// ExtModule protocol escape
//
function escape(str) {
    const buf = new Buffer(str.toString(), 'ascii');
    let result = '';
    for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c < 32 || c == 58 /* : */) {
            result += '%';
            result += String.fromCharCode(c + 64);
        } else if (c == 37) { /* % */
            result += '%%';
        } else {
            result += String.fromCharCode(c);
        }
    }
    return result;
}

//
// ExtModule protocol unescape
//
function unescape(str) {
    const buf = new Buffer(str, 'ascii');
    let result = '';
    for (let i = 0; i < buf.length; i++) {
        let c = buf[i];
        if (c == 37) {  /* % */
            c = buf[++i];
            result += ((c != 37) ? String.fromCharCode(c - 64) : '%');
        } else {
            result += String.fromCharCode(c);
        }
    }
    return result;
}

//
// Split string into parts. If limit is given, keeps the tail unlike the built-
// in String.prototype.split() function.
//
function splitString(s, delim, limit) {
    // use built-in .split() if there's no limit
    if (!limit)
        return s.split(delim);

    const result = [];
    while (--limit) {
        const index = s.indexOf(delim);
        if (index < 0)
            break;
        result.push(s.substring(0, index));
        s = s.substring(index + delim.length);
    }
    result.push(s);
    return result;
}

//
// create unique message command id
//
const makeId = (function () {
    let next = 0;
    const prefix = process.title+'<'+process.pid+'>_';
    return function () {
        return prefix+(next++);
    }
})();

//
// make a function that calls the argument function after event loop completes
//
const defer = function (fn) {
    return function (arg1, arg2) {
        process.nextTick(function () {
            fn(arg1, arg2);
        });
    }
}

//
// decode message command
//
function decode_message(parts) {
    // extract standard message parameters (prefix with '$')
    const msg = {
        $name: parts[3],
        $type: parts[0],
        $id: parts[1],
        $retvalue: unescape(parts[4])
    };

    // set $time for incoming messages or $processed for outgoing
    if (msg.$type == '%%>message')
        msg.$time = +parts[2];
    else
        msg.$processed = (parts[2] == 'true');

    // parse extra message parameters (store without any prefix)
    for (let i = 5; i < parts.length; i++) {
        const p = splitString(parts[i], '=', 2);
        msg[ unescape(p[0]) ] = unescape(p[1]);
    }

    // remove 'handlers' key because it's just too much noise
    delete msg.handlers;
    return msg;
}

//
// decode install command
//
function decode_install(parts) {
    if (parts[0] == '%%<install') {
        return {
            type: '%%<install',
            priority: +parts[1],
            name: parts[2],
            success: (parts[3] == 'true')
        };
    }
    if (parts[0] == '%%>install') {
        return {
            type: '%%>install',
            priority: +parts[1],
            name: parts[2]
        };
    }
    throw new Error('invalid install command');
}

//
// decode watch command
//
function decode_watch(parts) {
    if (parts[0] == '%%>watch') {
        return {
            type: '%%>watch',
            name: parts[1]
        };
    }
    if (parts[0] == '%%<watch') {
        return {
            type: '%%<watch',
            name: parts[1],
            success: (parts[2] == 'true')
        };
    }
    throw new Error('invalid watch command');
}

//
// encode message command in ExtModule protocol format
//
function encode_message(msg) {
    // Answer message:
    //     %%<message:<id>:<processed>:[<name>]:<retvalue>[:<key>=<value>...]
    // Request message:
    //     %%>message:<id>:<time>:<name>:<retvalue>[:<key>=<value>...]

    // add missing attributes (name must be present)
    assert(msg.$name, 'invalid message name');
    if (!msg.$type)
        msg.$type = '%%>message';
    if (!msg.$id)
        msg.$id = makeId();
    if (!msg.$retvalue)
        msg.$retvalue = '';

    let s = msg.$type+':'+msg.$id;

    // reply messages have the `$processed` boolean attribute set
    if (typeof msg.$processed != 'undefined') {
        s += ':'+(msg.$processed ? 'true' : 'false');
    } else {
        s += ':'+(msg.$time || Math.floor(Date.now() / 1000));
    }
    s += ':'+msg.$name+':'+escape(msg.$retvalue);

    // Append extra message parameters. Skip undefined/null values.
    for (const k in msg) {
        const v = msg[k];
        if (k[0] != '$' && v !== undefined && v !== null)
            s += ':' + (escape(k) + '=' + escape(v));
    }
    return s;
}

//
// encode install command in ExtModule protocol format
//
function encode_install(cmd) {
    // Install commands:
    //     %%>install:[<priority>]:<name>[:<filter-name>[:<filter-value>]]
    //     %%<install:<priority>:<name>:<success>
    if (cmd.type == '%%>install') {
        return '%%>install:' + (cmd.priority || '') + ':' + cmd.name;
    }
    if (cmd.type == '%%<install') {
        return '%%<install:' + (cmd.priority || 100) + ':' + cmd.name + ':' +
                               (cmd.success ? 'true': 'false');
    }
    throw new Error('invalid install command');
}

//
// encode watch command
//
function encode_watch(cmd) {
    // Watch commands:
    //     %%>watch:<name>
    //     %%<watch:<name>:<success>
    assert(cmd.name, 'invalid watch command');
    if (cmd.type == '%%>watch') {
        return '%%>watch:' + cmd.name;
    }
    if (cmd.type == '%%<watch') {
        assert(typeof cmd.success == 'boolean', 'invalid watch command');
        return '%%<watch:' + cmd.name + ':' + (cmd.success ? 'true' : 'false');
    }
    throw new Error('invalid watch command');
}

module.exports = (function () {
    //
    // Yate connection class (inherits from EventEmitter).
    //
    // Top-level events:
    //      error
    //      connect
    //      connected
    //      disconnected
    //
    //      carrier-online
    //      carrier-offline
    //
    //      incoming-call
    //      outgoing-call
    //
    //      user-register
    //      user-unregister
    //      user-expired
    //
    // Low-level events:
    //      send-line
    //      recv-line
    //      suppress-line
    //      install-confirm
    //      watch-confirm
    //      reply-unhandled
    //
    // All handled Yate extmodule messages are emitted as events too
    // (`user.auth`, `chan.connect`, etc).
    //
    // Set `authenticator` function to accept local users.
    //
    function YateExt(cfg) {
        if (!(this instanceof YateExt))
            return new YateExt(cfg);

        // validate port number
        assert(Math.floor(cfg.port) === cfg.port && cfg.port > 0, 'invalid port number');

        // init base
        EventEmitter.call(this);

        // copy parameters
        this.host = cfg.host || 'localhost';
        this.port = +cfg.port;
        this.reconnectInterval = ('reconnectInterval' in cfg) ? cfg.reconnectInterval : 5000;
        this.authenticator = cfg.authenticator;                 // client authenticator function
        this.authenticateTimeout = cfg.authenticateTimeout || 5000;
        this.callTimeout = cfg.callTimeout || 7200000;          // default 2 hours
        this.callSetupTimeout = cfg.callSetupTimeout || 70000;  // default 70 seconds
        this.allowUnregistered = cfg.allowUnregistered;         // allow calls from unregistered users

        // if `rtpForward` is true-ish, then RTP is forwarded if possible: media
        // goes directly between endpoints to save bandwidth & processing time
        this.rtpForward = ('rtpForward' in cfg) ? cfg.rtpForward : true;

        // users & carriers
        this.users = {};     // username -> user
        this.carriers = {};  // line_id -> trunk

        // initiated outgoing calls
        this._outgoing_calls = {};

        // internal variables
        this._reconnect_timer = null;    // used for reconnects
        this._socket = null;             // communication socket
        this._init_complete = false;     // true if connection setup is complete

        //
        // Channel name + event to handler function mapping. E.g.:
        //     'dumb/1_onHangup' => handler
        //
        this._chan_handlers = {};

        // install message handlers
        this._install_message_handlers();

        // re-register with carriers after reconnect
        this.on('connected', () => {
            this.setCarriers(this.carriers);
        });
    }
    util.inherits(YateExt, EventEmitter);

    //
    // return persistent references (for memory leak checking)
    //
    YateExt.prototype.getRefs = function () {
        return {
            users: this.users,
            carriers: this.carriers,
            outgoing_calls: this._outgoing_calls,
            chan_handlers: this._chan_handlers
        };
    }

    //
    // Register with carriers. Argument must be an array with elements being
    // objects like this:
    //     { host, port, username, password, auth_name, auth_domain }
    //
    YateExt.prototype.setCarriers = function (user_trunks) {
        assert(user_trunks && typeof user_trunks == 'object');

        // convert user trunks to array if given in object form
        if (!Array.isArray(user_trunks)) {
            const tmp = user_trunks;
            user_trunks = [];

            for (const account in tmp)
                user_trunks.push(tmp[account]);
        }

        // register with supplied carriers
        const new_carriers = {};
        const old_carriers = this.carriers;
        for (let i = 0; i < user_trunks.length; i++) {
            // ignore invalid values
            const user_trunk = user_trunks[i];
            if (!user_trunk || typeof user_trunk != 'object')
                continue;

            // destructure
            const { host, port, username,
                    password, auth_name, auth_domain } = user_trunk;

            // host must be present
            if (!host)
                continue;

            // make full host address and line id
            const addr = `${host}${port ? ':'+port : ''}`;
            const account = makeLineID(user_trunk);

            // save the new carrier
            const new_trunk = new_carriers[account] = Object
                .assign({}, old_carriers[account], user_trunk, { account });

            // submit "user.login" message for carriers that Yate does not know
            // about yet
            if (this._init_complete && !new_trunk.active) {
                this.dispatch({
                    $name: 'user.login',
                    account,
                    username,
                    protocol: 'sip',
                    password,
                    number: username,
                    authname: auth_name || username,
                    domain: auth_domain || host,
                    registrar: addr,
                    outbound: addr,
                });
            }
        }

        // de-register from carriers that are no longer necessary
        if (this._init_complete) {
            for (const account in old_carriers) {
                if (!new_carriers[account]) {
                    this.dispatch({
                        $name: 'user.login',
                        account,
                        protocol: 'sip',
                        operation: 'logout'
                    });
                }
            }
        }

        // save the carriers
        this.carriers = new_carriers;
    }

    //
    // set function that authenticates or denies authentication to user
    //
    YateExt.prototype.setAuthenticator = function (callback) {
        assert(typeof callback == 'function', 'invalid callback');
        this.authenticator = callback;
    }

    //
    // make sure existing connection is killed and reconnect stopped
    //
    YateExt.prototype._kill_socket = function () {
        // clear pending reconnect
        clearTimeout(this._reconnect_timer);

        if (this._socket) {
            // disable reconnect-on-close
            this._socket.removeAllListeners('close');

            // destroy socket
            this._socket.destroy();
            this._socket = null;
        }
    }

    //
    // Connect to Yate instance using connection parameters from constructor.
    // Keeps reconnecting if `reconnectInterval` is set.
    //
    YateExt.prototype.connect = function () {
        const connect_fn = () => {
            // end previous connection
            this._kill_socket();

            // connect to Yate
            this.emit('connect', { host: this.host, port: this.port });
            const socket = this._socket = net.connect(this.port, this.host);

            socket.on('connect', () => {
                // send '%%>connect' as the first command (required for external
                // socket clients, not for scripts started by Yate itself)
                this._cmd_send('%%>connect:global', true);

                // Send "uninstall" command before "install" (has been shown to
                // eliminate some reconnection problems). Same thing for
                // "unwatch" and "watch" below.
                for (const name in install_list)
                    this._cmd_send(`%%>uninstall:${name}`, true);
                for (const name in watch_list)
                    this._cmd_send(`%%>unwatch:${name}`, true);
                for (const name in install_list)
                    this.install(name, install_list[name]);
                for (const name in watch_list)
                    this.watch(name);

                // Count down number of installs/watches. Emit "connected" event
                // when all handlers have been installed (init complete).
                let total = Object.keys(install_list).length +
                            Object.keys(watch_list).length;
                const install_or_watch = () => {
                    if (socket != this._socket) {
                        // cleanup after reconnect
                        this.removeListener('install-confirm', install_or_watch);
                        this.removeListener('watch-confirm', install_or_watch);
                    } else if (--total == 0) {
                        this._init_complete = true;
                        this.emit('connected', { host: this.host, port: this.port });
                    }
                }
                this.on('install-confirm', install_or_watch);
                this.on('watch-confirm', install_or_watch);

                // cleanup after disconnect
                this.once('disconnected', function () {
                    this.removeListener('install-confirm', install_or_watch);
                    this.removeListener('watch-confirm', install_or_watch);

                    // mark all trunks as inactive
                    const carriers = this.carriers;
                    for (const account in carriers)
                        carriers[account].active = false;
                });
            });

            // catch socket close event
            socket.once('close', () => {
                // emit Yate disconnect event
                this._init_complete = false;
                this.emit('disconnected');

                // try reconnecting after a while
                if (this.reconnectInterval > 0)
                    this._reconnect_timer = setTimeout(connect_fn, this.reconnectInterval);
            });

            // catch errors
            socket.on('error', err => {
                this.emit('error', err);
            });

            // read Yate commands as lines from the socket & process them
            carrier.carry(socket, this._process_line.bind(this), 'ascii', '\n');
        }

        connect_fn();
    }

    //
    // Destroy YateExt instance (free any resources associated with it). Using
    // the instance after destruction will produce errors.
    //
    YateExt.prototype.destroy = function () {
        // kill socket
        this._kill_socket();

        // kill self
        this._init_complete = false;
        this.emit('disconnected');

        // release stored references
        delete this.users;
        delete this.carriers;
        delete this._outgoing_calls;
        delete this._chan_handlers;
    }

    //
    // return true if instance is connected to Yate and initialized; false
    // otherwise
    //
    YateExt.prototype.ready = function () {
        return this._socket && this._init_complete;
    }

    //
    // get locally registered user route or null if missing/expired
    //
    YateExt.prototype.getLocalRoute = function (caller, called) {
        assert(called, 'empty `called` number');

        // get local user
        var user = this.users[called];
        if (!user)
            return null;

        // check expiry
        if (new Date((user.$time + +user.expires) * 1000) < new Date()) {
            // delete user, emit event
            delete this.users[called];
            this.emit('user-expired', user);
            return null;
        }

        // remove ';rinstance' or other params from user location
        var fullroute = (user.data || '').split(';')[0];

        return {
            caller: caller,
            called: called,
            host: user.ip_host,
            fullroute: fullroute
        };
    }

    //
    // make outgoing call to <destination>:
    // {
    //     caller:       (optional) caller number
    //     called:       called number (the original pre-routing number)
    //     routes:       array of routes, see YateChannel.fork() for route format
    //     timeout:      (optional) max call duration (ms)
    //     setupTimeout: (optional) wait time before pickup (ms)
    // }
    //
    YateExt.prototype.makeCall = function (destination, callback) {
        assert(typeof destination == 'object', 'invalid destination');
        assert(destination.called, 'missing called number');
        assert(destination.routes instanceof Array && destination.routes.length > 0, 'missing routes');
        assert(this.ready(), 'pbx instance not ready');

        // timeouts
        var timeout = destination.timeout || this.callTimeout;
        var setupTimeout = destination.setupTimeout || this.callSetupTimeout;
        assert(isFinite(timeout) && timeout >= 0, 'invalid timeout');
        assert(isFinite(setupTimeout) && setupTimeout >= 0, 'invalid setup timeout');

        // dispatch `call.execute` to initiate call
        var tmp_id = makeId();
        this.dispatch({
            $name: 'call.execute',
            callto: 'dumb/',
            target: destination.called,
            callername: tmp_id,
            timeout: timeout + setupTimeout,
            maxcall: setupTimeout
        });

        // save user's callback in destination object
        destination._callback = callback;

        // save destination (looked up in `call.route` handler)
        this._outgoing_calls[ tmp_id ] = destination;

        // timeout after 5 seconds if `call.route` not received from Yate
        setTimeout(function () {
            if (this._outgoing_calls[ tmp_id ]) {
                // discard reference
                delete this._outgoing_calls[ tmp_id ];

                // emit error + call user's callback with error
                this.emit('error', new Error('outgoing call init timeout'));
                if (callback)
                    callback(new Error('outgoing call init timeout'));
            }
        }.bind(this), 5000);
    }

    //
    // Create a reply message (%%<message) and dispatch it. A `$processed`
    // attribute is added and the `$time` value is removed. Extra (non-standard)
    // parameters are removed from the message because only new or overwritten
    // params are required.
    //
    YateExt.prototype.reply = function (msg, processed, new_params) {
        assert(msg.$type == '%%>message', 'invalid message type');
        assert(typeof processed == 'boolean', 'invalid argument');

        new_params = new_params || {};

        // leave only special attributes (those starting with `$`)
        var reply_msg = {};
        for (var k in msg) {
            if (k[0] == '$')
                reply_msg[k] = msg[k];
        }

        // set new params
        for (var k in new_params)
            reply_msg[k] = new_params[k];

        // remove $time, add $processed, reverse message direction
        delete reply_msg.$time;
        reply_msg.$processed = processed;
        reply_msg.$type = '%%<message';

        // Encode and send to Yate.
        this.dispatch(reply_msg);
    }

    //
    // set some `call.route` specific params & reply to it
    //
    YateExt.prototype.routeCall = function (call_route, result, params) {
        // turn on RTP forwarding unless disabled
        params = params || {};
        if (result && this.rtpForward && call_route.rtp_forward == 'possible')
            params.rtp_forward = 'yes';

        // reply to call.route
        this.reply(call_route, result, params);
    }

    //
    // send `install` command to Yate
    //
    YateExt.prototype.install = function (msg_name, priority) {
        assert(msg_name, 'invalid message name');
        this._cmd_send(encode_install({
            type: '%%>install',
            name: msg_name,
            priority: (typeof priority != 'undefined') ? priority : 100
        }), true);
    }

    //
    // send `watch` command to Yate
    //
    YateExt.prototype.watch = function (msg_name) {
        assert(msg_name, 'invalid message name');
        this._cmd_send(encode_watch({
            type: '%%>watch',
            name: msg_name
        }), true);
    }

    //
    // send message command to Yate
    //
    YateExt.prototype.dispatch = function (msg) {
        assert(typeof msg == 'object', 'invalid message');
        this._cmd_send(encode_message(msg));
    }

    //
    // send line to Yate
    //
    YateExt.prototype._cmd_send = function (encoded_line, force_before_init) {
        assert(encoded_line, 'invalid line');

        // write command string to socket
        if (this._socket && (this._init_complete || force_before_init)) {
            this.emit('send-line', encoded_line);
            this._socket.write(encoded_line+'\n');
        } else {
            this.emit('suppress-line', encoded_line);
        }
    }

    //
    // send `call.drop` to Yate
    //
    YateExt.prototype.chanDrop = function (chan, reason) {
        assert(chan, 'invalid channel name');

        this.dispatch({
            $name: 'call.drop',
            id: chan,
            reason: reason || 'unspecified reason'
        });
    }

    //
    // send `call.answered` message (<chan> answers to <peer_chan>)
    //
    YateExt.prototype.chanAnswer = function (chan, peer_chan) {
        assert(chan && peer_chan, 'invalid channel(s)');

        this.dispatch({
            $name: 'call.answered',
            id: chan,
            targetid: peer_chan
        });
    }

    //
    // Send `chan.connect` to connect <chan> to <peer_chan>.
    //
    YateExt.prototype.chanConnect = function (chan, peer_chan) {
        assert(chan && peer_chan, 'invalid channel(s)');

        this.dispatch({
            $name: 'chan.connect',
            id: chan,
            targetid: peer_chan
        });
    }

    //
    // Attach tonegen module to <chan>. More info:
    //    http://yate.null.ro/pmwiki/index.php?n=Main.Tonegen
    //
    YateExt.prototype.chanTonegen = function (chan, tone) {
        assert(chan, 'invalid channel');
        assert(tone, 'invalid tone name');

        this.dispatch({
            $name: 'chan.masquerade',
            id: chan,
            message: 'chan.attach',
            source: 'tone/'+tone
        });
    }

    //
    // Record audio from channel. More info:
    //     http://docs.yate.ro/wiki/Chan.record
    //     http://yate.null.ro/archive/?action=show_msg&actionargs%5B%5D=71&actionargs%5B%5D=51
    //
    // The filenames should be absolute.
    //
    YateExt.prototype.chanRecord = function (chan, file_legA, file_legB, maxlen_bytes) {
        assert(chan, 'invalid channel');
        assert(file_legA || file_legB, 'missing record filenames');

        var cfg = {
            $name: 'chan.masquerade',
            id: chan,
            message: 'chan.record'
        };
        if (file_legA) {
            assert(file_legA[0] == '/', 'invalid filename (not absolute)');
            cfg.call = 'wave/record/'+file_legA;
        }
        if (file_legB) {
            assert(file_legB[0] == '/', 'invalid filename (not absolute)');
            cfg.peer = 'wave/record/'+file_legB;
        }
        if (maxlen_bytes)
            cfg.maxlen = maxlen_bytes;

        this.dispatch(cfg);
    }

    //
    // Attach wavefile module to <chan>. More info:
    //    http://docs.yate.ro/wiki/Wavefile
    // The filename argument should be an absolute path.
    //
    YateExt.prototype.chanPlaywave = function (chan, filename) {
        assert(chan, 'invalid channel');
        assert(filename && filename[0] == '/', 'invalid filename');

        this.dispatch({
            $name: 'chan.masquerade',
            id: chan,
            message: 'chan.attach',
            source: 'wave/play/' + filename,
            notify: chan
        });
    }

    //
    // set channel event handler
    //
    YateExt.prototype.onChannelEvent = function (chan, event, cb) {
        assert(chan, 'invalid channel');
        assert(event, 'invalid event');
        assert(typeof cb == 'function', 'invalid callback');

        event = chan+'_'+event;
        var list = this._chan_handlers[event];
        if (!list)
            list = this._chan_handlers[event] = [ cb ];
        else
            list.push(cb);

        // return binding so it can be later removed
        return [cb, event];
    }

    //
    // trigger channel event
    //
    YateExt.prototype.triggerChannelEvent = function (chan, event, arg1) {
        assert(chan, 'invalid channel');
        assert(event, 'invalid event');

        this._runHandlers(chan, event, arg1);
    }

    //
    // unset channel event handler
    //
    /*YateExt.prototype._unset_chanevent_handler = function (binding) {
        assert(binding instanceof Array && binding.length == 2, binding);

        var event = binding[1];
        var list = this._chan_handlers[event];
        if (list) {
            var index = list.indexOf(binding[0]);
            if (index != -1)
                list.splice(index, 1);
            if (list.length == 0)
                delete this._chan_handlers[event];
        }
    }*/

    //
    // install message handlers
    //
    YateExt.prototype._install_message_handlers = function () {
        //
        // channel events
        //
        this.on('chan.connected', function (chan_connected) {
            var id = chan_connected.id;
            var peerid = chan_connected.peerid;

            if (peerid) {
                if (peerid.substr(0, 5) == 'fork/') {
                    var split = peerid.split('/');
                    if (split.length == 3) {
                        var master = 'fork/' + split[1];
                        this._runHandlers(master, 'onSlaveConnected', chan_connected, +split[2]);
                    }
                }
                this._runHandlers(peerid, 'onConnectedAsPeer', chan_connected);
                this._runHandlers(peerid, 'onConnectedAsPeerOnce', chan_connected);
                delete this._chan_handlers[peerid + '_onConnectedAsPeerOnce'];
            }
            this._runHandlers(id, 'onConnected', chan_connected);
            this._runHandlers(id, 'onConnectedOnce', chan_connected);
            delete this._chan_handlers[id + '_onConnectedOnce'];
        });
        this.on('chan.hangup', function (chan_hangup) {
            var id = chan_hangup.id;
            this._runHandlers(id, 'onHangup', chan_hangup);

            // no more events after hangup
            this._clearChanHandlers(id);
        });
        this.on('chan.notify', function (chan_notify) {
            this._runHandlers(chan_notify.targetid, 'onNotify', chan_notify);
        });
        this.on('chan.dtmf', function (chan_dtmf) {
            this._runHandlers(chan_dtmf.id, 'onDTMF', chan_dtmf.text);
        });
        this.on('call.execute', function (call_execute) {
            if (call_execute.id)
                this._runHandlers(call_execute.id, 'onExecute', call_execute);

            var fork_origid = call_execute['fork.origid'];
            if (fork_origid)
                this._runHandlers(fork_origid, 'onExecuteFork', call_execute);
        });

        //
        // carrier status
        //
        this.on('user.notify', function (user_notify) {
            // emit "carrier-online" or "carrier-offline" events
            const { account, registered, reason } = user_notify;
            if (registered === 'true')
                this.emit('carrier-online', { account });
            else
                this.emit('carrier-offline', { account, reason });
        });
        this.on('user.login', function (user_login) {
            // update trunk status
            const { account, operation, $processed } = user_login;
            const trunk = this.carriers[account];
            if ($processed && trunk)
                trunk.active = (operation != 'logout');
        });

        //
        // handle user authentication & registration
        //
        this.on('user.auth', function (user_auth) {
            // Allow/deny functions. Note the extra reply params that disable
            // auth message handling by `register` and `regfile` Yate modules
            var allow = function () {
                this.reply(user_auth, true, {
                    auth_register: false,
                    auth_regfile: false
                });
            }.bind(this);
            var deny = function (err) {
                this.reply(user_auth, false, {
                    auth_register: false,
                    auth_regfile: false
                });
                if (err)
                    this.emit('error', err);
            }.bind(this);

            // OK immediately if allowing unregistered
            if (this.allowUnregistered)
                return allow();

            // deny if user did not supply an authenticator function
            if (!this.authenticator)
                return deny(new Error('missing user authenticator function'));

            // if authorizing a call, allow it if user registered & not expired
            var username = user_auth.username || user_auth.number || user_auth.caller;
            if (user_auth.newcall == 'true') {
                var user = this.users[username];
                if (user) {
                    // check expiry
                    if (new Date((user.$time + +user.expires) * 1000) >= new Date())
                        return allow();

                    // remove user, emit event, deny auth
                    delete this.users[username];
                    this.emit('user-expired', user);
                    return deny(new Error('user expired'));
                }
            }

            // extract params for authentication (basic or digest)
            var digest = extend_defined({}, {
                username: username,
                password: user_auth.password,
                uri: user_auth.uri,
                realm: user_auth.realm,
                nonce: user_auth.nonce,
                method: user_auth.method,
                algorithm: user_auth.algorithm || 'md5',
                response: user_auth.response,
                address: extractIP(user_auth)
            });

            var timer, promise;
            try {
                promise = this.authenticator(digest, defer(function (result) {
                    if (typeof promise == 'object' && promise.then) {
                        this.emit('error', new Error('promise & callback at the same time'));
                        return;
                    }

                    // reply to user.auth if we haven't timeouted yet
                    if (timer) {
                        clearTimeout(timer);
                        timer = null;

                        // check authenticator return value
                        if (result === true)
                            allow();
                        else
                            deny();
                    }
                }.bind(this)));
            } catch (err) {
                // reject on error
                return deny(err);
            }

            // check if we have a promise (bluebird API)
            if (typeof promise == 'object' && promise.then) {
                assert(promise.bind, 'expected bluebird promise API');

                // expect auth result via promise
                promise
                .bind(this)
                .then(function (result) {
                    // check authenticator return value
                    if (result === true)
                        allow();
                    else
                        deny();
                })
                .timeout(this.authenticateTimeout, 'authentication timeout')
                .catch(function (err) {
                    // reject on error
                    deny(err);
                });
            } else {
                // timeout for callback case
                timer = setTimeout(function () {
                    timer = null;
                    deny(new Error('authentication timeout'));
                }.bind(this), this.authenticateTimeout);
            }
        });

        this.on('user.register', function (user_register) {
            // store the whole `user.register` message as local user entry
            this.users[user_register.username] = user_register;
            this.emit('user-register', user_register);
            this.reply(user_register, true);
        });
        this.on('user.unregister', function (user_unregister) {
            // discard user entry
            var username = user_unregister.username;
            var user = this.users[username];
            if (user) {
                delete this.users[username];
                this.emit('user-unregister', user);
            }
        });

        // handle call routing request from Yate
        this.on('call.route', function (call_route) {
            // determine if routing outgoing call
            if (call_route.caller == 'dumb/' && call_route.callername) {
                // this is an outgoing call... get destination object & remove
                // from list
                var tmp_id = call_route.callername;
                var destination = this._outgoing_calls[ tmp_id ];

                // fail routing if outgoing call not found (timeout?)
                if (!destination) {
                    this.reply(call_route, false);
                    throw new Error('outgoing call handler not defined');
                }
                delete this._outgoing_calls[ tmp_id ];  // remove saved ref

                // create IVR channel
                var ivr = new YateChannel.IVR({
                    pbx: this,
                    chan: call_route.id,
                    call_route: call_route
                });

                // route IVR to destination (make the call)
                ivr.routeToDestination(destination);

                // emit outgoing call event
                this.emit('outgoing-call', ivr, destination);

                // execute user's callback with IVR channel
                var cb = destination._callback;
                if (cb) {
                    delete destination._callback;   // remove tmp reference
                    cb(null, ivr, destination);
                }
                return;
            }

            // reject if empty called number
            if (!call_route.called) {
                this.reply(call_route, false);
                throw new Error('empty called number for incoming call');
            }

            // create channel for incoming leg
            var channel = new YateChannel.Channel({
                pbx: this,
                chan: call_route.id,
                call_route: call_route
            });

            // emit `incoming-call` event
            var handled = this.emit('incoming-call', channel, {
                caller:  call_route.caller || '',
                called:  call_route.called,
                billId: call_route.billid,
                callerHost: extractIP(call_route)
            });

            // if the `incoming-call` event was not handled, terminate channel
            // and emit error
            if (!handled) {
                channel.terminate();
                this.emit('error', new Error('incoming call event not handled'));
            }
        });
    }

    //
    // remove all event handlers registered for a channel
    //
    YateExt.prototype._clearChanHandlers = function (chan) {
        assert(chan, 'invalid channel');

        chan += '_';
        var chan_handlers = this._chan_handlers;
        delete chan_handlers[chan + 'onSlaveConnected'];
        delete chan_handlers[chan + 'onExecuteFork'];
        delete chan_handlers[chan + 'onHangup'];
        delete chan_handlers[chan + 'onConnected'];
        delete chan_handlers[chan + 'onConnectedOnce'];
        delete chan_handlers[chan + 'onConnectedAsPeer'];
        delete chan_handlers[chan + 'onConnectedAsPeerOnce'];
        delete chan_handlers[chan + 'onNotify'];
        delete chan_handlers[chan + 'onDTMF'];
        delete chan_handlers[chan + 'onExecute'];
    }

    //
    // execute event handler
    //
    YateExt.prototype._runHandlers = function (chan, event, msg, arg1) {
        assert(chan, 'invalid channel');
        assert(event, 'invalid event');

        var list = this._chan_handlers[chan+'_'+event];
        if (list) {
            for (var i = 0; i < list.length; i++) {
                try {
                    list[i](msg, arg1);
                } catch (err) {
                    this.emit('error', err);
                }
            }
        }
    }

    //
    // process received message
    //
    YateExt.prototype._handle_message = function (msg) {
        const name = msg.$name;

        if (msg.$type == '%%<message') {
            // emit message event
            if (watch_list[name])
                this.emit(name, msg);
            return;
        }
        if (msg.$type == '%%>message') {
            // emit message event
            const handled = this.emit(name, msg);

            // unhandled messages are sent back with processed=false.
            if (!handled && install_list[name]) {
                this.emit('reply-unhandled', msg);
                this.reply(msg, false);
            }
            return;
        }
        throw new Error('invalid message type');
    }

    YateExt.prototype._process_line = function (line) {
        try {
            this.emit('recv-line', line);

            // split command into parts
            const parts = line.split(':');
            if (parts.length < 2 || parts[0].substr(0, 2) != '%%') {
                this.emit('error', new Error('invalid line'));
                return;
            }

            // handle the command
            const type = parts[0];
            if (type == '%%>message' || type == '%%<message') {
                // handle message after event loop processing so as to give
                // callers time to register message handlers
                this._handle_message(decode_message(parts));
            } else if (type == '%%<install') {
                const cmd = decode_install(parts);
                if (cmd.success)
                    this.emit('install-confirm', cmd);
                else
                    this.emit('error', new Error('install failed'));
            } else if (type == '%%<watch') {
                const cmd = decode_watch(parts);
                if (cmd.success)
                    this.emit('watch-confirm', cmd);
                else
                    this.emit('error', new Error('watch failed'));
            } else if (type == '%%<unwatch' || type == '%%<uninstall') {
                // nothing
            } else {
                this.emit('error', new Error('unrecognized command'));
            }
        } catch (err) {
            this.emit('error', err);
        }
    }

    return YateExt;
})();
