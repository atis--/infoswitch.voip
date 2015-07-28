//
// This module implements communication with Yate telephony engine via the
// external module interface.
//
// Yate message format:
//     http://yate.null.ro/docs/extmodule.html
//

var net = require('net');
var util = require('util');
var carrier = require('carrier');
var EventEmitter = require('events').EventEmitter;
var Misc = require('./Misc');
var YateChannel = require('./YateChannel');
var assert = console.assert;

//
// installed message command handlers:
//     message name -> priority
//
var install_list = {
    'call.route': 10,
    'user.auth': 10,
    'user.register': 10
};

//
// watched messages
//
var watch_list = {
    'call.execute': true,
    'user.unregister': true,
    'user.notify': true,
    'chan.connected': true,
    'chan.hangup': true,
    'chan.notify': true,
    'chan.dtmf': true
};

//
// ExtModule protocol escape
//
function escape(str) {
    var buf = new Buffer(str.toString(), 'ascii');
    var result = '';
    for (var i = 0; i < buf.length; i++) {
        var c = buf[i];
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
    var buf = new Buffer(str, 'ascii');
    var result = '';
    for (var i = 0; i < buf.length; i++) {
        var c = buf[i];
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

    var result = [];
    while (--limit) {
        var index = s.indexOf(delim);
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
var makeId = (function () {
    var next = 0;
    var prefix = process.title+'<'+process.pid+'>_';
    return function () {
        return prefix+(next++);
    }
})();

//
// make a function that calls the argument function after event loop completes
//
var defer = function (fn) {
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
    var msg = {
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
    for (var i = 5; i < parts.length; i++) {
        var p = splitString(parts[i], '=', 2);
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

    var s = msg.$type+':'+msg.$id;

    // reply messages have the `$processed` boolean attribute set
    if (typeof msg.$processed != 'undefined') {
        s += ':'+(msg.$processed ? 'true' : 'false');
    } else {
        s += ':'+(msg.$time || Math.floor(Date.now() / 1000));
    }
    s += ':'+msg.$name+':'+escape(msg.$retvalue);

    // Append extra message parameters.
    for (var k in msg) {
        var v = msg[k];
        if (k[0] != '$')
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
    //      connect
    //      connected
    //      disconnected
    //      carrier-online
    //      carrier-offline
    //      user-register
    //      user-unregister
    //  (!) error
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
        this.onIncomingCall = cfg.onIncomingCall;               // incoming call handler
        this.onOutgoingCall = cfg.onOutgoingCall;               // outgoing call handler
        this.callTimeout = cfg.callTimeout || 7200000;          // default 2 hours
        this.callSetupTimeout = cfg.callSetupTimeout || 70000;  // default 70 seconds
        this.allowUnregistered = cfg.allowUnregistered;         // allow calls from unregistered users

        // users & carriers
        this.users = {};     // username -> user
        this.carriers = {};  // username@host -> carrier

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
        this.on('connected', function () {
            for (var account in this.carriers)
                this.addCarrier(this.carriers[ account ]);
        }.bind(this));
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
    // register with carrier
    //
    YateExt.prototype.addCarrier = function (carrier) {
        assert(typeof carrier == 'object', 'invalid argument');
        assert(carrier.host, 'missing carrier host');

        // carrier is uniquely identified by username@host string
        var host = carrier.host;
        var username = carrier.username;
        var account = (username ? username+'@' : '') + host;

        // add to (or replace in) carrier list
        this.carriers[account] = util._extend({}, carrier);

        // submit `user.login` request to Yate
        if (this._init_complete) {
            this.dispatch({
                $name: 'user.login',
                account: account,
                username: username,
                password: carrier.password,
                domain: host,
                enabled: 'yes',
                protocol: carrier.protocol || 'sip',
                authname: username,
                number: username,
                registrar: host,
                outbound: host
            });
        }
    }

    //
    // set function that authenticates or denies authentication to user
    //
    YateExt.prototype.setAuthenticator = function (callback) {
        assert(typeof callback == 'function', 'invalid callback');
        this.authenticator = callback;
    }

    //
    // Connect to Yate instance using connection parameters from constructor.
    // Keeps reconnecting if `reconnectInterval` is set.
    //
    YateExt.prototype.connect = function () {
        var self = this;
        var connect_fn = function () {
            // clear pending reconnect
            clearTimeout(self._reconnect_timer);

            // end previous connection
            if (self._socket) {
                // disable reconnect for previous socket
                self._socket.removeAllListeners('close');

                // destroy socket
                self._socket.destroy();
                self._socket = null;
            }

            // connect to Yate
            self.emit('connect', { host: self.host, port: self.port });
            var socket = self._socket = net.connect(self.port, self.host);

            socket.on('connect', function () {
                // send '%%>connect' as the first command (required for external
                // socket clients, not for scripts started by Yate itself)
                self._cmd_send('%%>connect:global', true);

                // Send `uninstall` command before `install` (has been shown to
                // eliminate some reconnection problems). Same thing for
                // `unwatch` and `watch` below.
                for (var name in install_list)
                    self._cmd_send('%%>uninstall:'+name, true);
                for (var name in watch_list)
                    self._cmd_send('%%>unwatch:'+name, true);
                for (var name in install_list)
                    self.install(name, install_list[name]);
                for (var name in watch_list)
                    self.watch(name);

                // Count down number of installs/watches. Emit `connected` event
                // when all handlers have been installed (init complete).
                var total = Object.keys(install_list).length +
                            Object.keys(watch_list).length;
                function install_or_watch() {
                    if (socket != self._socket) {
                        // cleanup after reconnect
                        self.removeListener('install-confirm', install_or_watch);
                        self.removeListener('watch-confirm', install_or_watch);
                    } else if (--total == 0) {
                        self._init_complete = true;
                        self.emit('connected', { host: self.host, port: self.port });
                    }
                }
                self.on('install-confirm', install_or_watch);
                self.on('watch-confirm', install_or_watch);

                // cleanup after disconnect
                self.once('disconnected', function () {
                    self.removeListener('install-confirm', install_or_watch);
                    self.removeListener('watch-confirm', install_or_watch);
                });
            });

            // catch socket close event
            socket.once('close', function () {
                // emit Yate disconnect event
                self._init_complete = false;
                self.emit('disconnected');

                // try reconnecting after a while
                if (self.reconnectInterval > 0)
                    self._reconnect_timer = setTimeout(connect_fn,
                                                       self.reconnectInterval);
            });

            // catch errors
            socket.on('error', function (err) {
                self.emit('error', err);
            });

            // read Yate commands as lines from the socket & process them
            carrier.carry(socket, self._process_line.bind(self), 'ascii', '\n');
        }

        connect_fn();
    }

    //
    // Destroy YateExt instance (free any resources associated with it). Using
    // the instance after destruction will produce errors.
    //
    YateExt.prototype.destroy = function () {
        // kill socket
        this._socket.removeAllListeners();
        this._socket.destroy();
        this._socket = null;

        // kill self
        this._init_complete = false;
        this.emit('disconnected');
        this.removeAllListeners();

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
    // make outgoing call to destination:
    // {
    //     user:         (optional) IVR options (`language`, `currency`)
    //     called:       called number (the original pre-routing number)
    //     routes:       array of routes, see fork() above for entry format
    //     timeout:      (optional) max call duration (ms)
    //     setupTimeout: (optional) wait time before pickup (ms)
    // }
    //
    YateExt.prototype.makeCall = function (dest) {
        assert(typeof dest == 'object', 'invalid destination');
        assert(dest.called, 'missing called number');
        assert(dest.routes instanceof Array && dest.routes.length > 0, 'missing routes');
        assert(this.ready(), 'pbx instance not ready');

        // timeouts
        var timeout = dest.timeout || this.callTimeout;
        var setupTimeout = dest.setupTimeout || this.callSetupTimeout;
        assert(Misc.isPositiveInt(timeout), 'invalid timeout');
        assert(Misc.isPositiveInt(setupTimeout), 'invalid setup timeout');

        // dispatch `call.execute` to initiate call
        var tmp_id = makeId();
        this.dispatch({
            $name: 'call.execute',
            callto: 'dumb/',
            target: dest.called,
            callername: tmp_id,
            timeout: timeout + setupTimeout,
            maxcall: setupTimeout
        });

        // save destination (looked up in `call.route` handler)
        this._outgoing_calls[ tmp_id ] = dest;

        // timeout after 5 seconds if `call.route` not received from Yate
        setTimeout(function () {
            if (this._outgoing_calls[ tmp_id ]) {
                delete this._outgoing_calls[ tmp_id ];
                this.emit('error', new Error('outgoing call init timeout'));
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
            message: "chan.attach",
            source: "tone/" + tone
        });
    }

    //
    // Attach wavefile module to <chan>. More info:
    //    http://yate.null.ro/pmwiki/index.php?n=Main.Wavefile
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
            // extract params
            var account = user_notify.account || '';
            var registered = user_notify.registered || '';
            var reason = user_notify.reason || '';

            // emit `carrier-online` or `carrier-offline` events
            if (registered === 'true') {
                this.emit('carrier-online', { account: account });
            } else {
                this.emit('carrier-offline', {
                    account: account,
                    reason: reason
                });
            }
        });

        // extra reply params disable auth message handling by `register` and
        // `regfile` Yate modules
        var exclusive_auth = {
            auth_register: false,
            auth_regfile: false
        };

        //
        // handle user authentication & registration
        //
        this.on('user.auth', function (user_auth) {
            // OK immediately if allowing unregistered
            if (this.allowUnregistered) {
                this.reply(user_auth, true, exclusive_auth);
                return;
            }

            // user must have supplied an authenticator function
            if (!this.authenticator) {
                this.reply(user_auth, false, exclusive_auth);
                throw new Error('missing user authenticator function');
            }

            // if authorizing a call, allow it if user registered & not expired
            var username = user_auth.username || user_auth.number || user_auth.caller;
            if (user_auth.newcall == 'true') {
                var user = this.users[username];
                if (user) {
                    // check expiry
                    if (new Date((user.$time + +user.expires) * 1000) >= new Date())
                        this.reply(user_auth, true, exclusive_auth);
                }
            }

            // extract params for authentication (basic or digest)
            var digest = {
                username: username,
                password: user_auth.password,
                uri: user_auth.uri,
                realm: user_auth.realm,
                nonce: user_auth.nonce,
                method: user_auth.method,
                algorithm: user_auth.algorithm || 'md5'
            };

            var timer, promise;
            promise = this.authenticator(digest, defer(function (result) {
                if (typeof promise == 'object' && promise.then) {
                    this.emit('error', new Error('promise & callback at the same time'));
                    return;
                }

                // reply to user.auth if we haven't timeouted yet
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                    this.reply(user_auth, result === true, exclusive_auth);
                }
            }.bind(this)));

            // check if we have a promise (bluebird API)
            if (typeof promise == 'object' && promise.then) {
                assert(promise.bind, 'expected bluebird promise API');

                // expect auth result via promise
                promise
                .bind(this)
                .then(function (result) {
                    this.reply(user_auth, result === true, exclusive_auth);
                })
                .timeout(this.authenticateTimeout, 'authentication timeout')
                .catch(function (err) {
                    this.emit('error', err);
                    this.reply(user_auth, false, exclusive_auth);
                });
            } else {
                // timeout for callback case
                timer = setTimeout(function () {
                    timer = null;
                    this.emit('error', new Error('authentication timeout'));
                    this.reply(user_auth, false, exclusive_auth);
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
                var dest = this._outgoing_calls[ tmp_id ];

                // fail routing if outgoing call not found (timeout?)
                if (!dest) {
                    this.reply(call_route, false);
                    throw new Error('outgoing call handler not defined');
                }
                delete this._outgoing_calls[ tmp_id ];  // remove saved ref

                // check if user handles outgoing calls
                if (!this.onOutgoingCall) {
                    this.reply(call_route, false);
                    throw new Error('outgoing call handler not defined');
                }

                // create IVR channel
                var user = dest.user || {};
                var ivr = new YateChannel.IVR({
                    pbx: this,
                    chan: call_route.id,
                    call_route: call_route,
                    language: user.language,
                    currency: user.currency
                });

                // route IVR to destination (make the call)
                ivr.routeToDestination(dest);

                // execute outgoing call handler with IVR channel as argument
                this.onOutgoingCall(ivr, dest);
                return;
            }

            // this is an incoming call... check if user handles incoming calls
            if (!this.onIncomingCall) {
                this.reply(call_route, false);
                throw new Error('incoming call handler not defined');
            }

            // create channel for incoming leg
            var channel = new YateChannel.Channel({
                pbx: this,
                chan: call_route.id,
                call_route: call_route
            });

            // execute incoming call handler with incoming channel as argument
            this.onIncomingCall(channel, {
                called: call_route.called
            });
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
        var name = msg.$name;
        console.log('handle message', msg);

        if (msg.$type == '%%<message') {
            // emit message event
            if (watch_list[name])
                this.emit(name, msg);
            return;
        }
        if (msg.$type == '%%>message') {
            // emit message event
            var handled = this.emit(name, msg);

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
            var parts = line.split(':');
            if (parts.length < 2 || parts[0].substr(0, 2) != '%%') {
                this.emit('error', new Error('invalid line'));
                return;
            }

            // handle the command
            var type = parts[0];
            if (type == '%%>message' || type == '%%<message') {
                // handle message after event loop processing so as to give
                // callers time to register message handlers
                this._handle_message(decode_message(parts));
            } else if (type == '%%<install') {
                var cmd = decode_install(parts);
                if (cmd.success)
                    this.emit('install-confirm', cmd);
                else
                    this.emit('error', new Error('install failed'));
            } else if (type == '%%<watch') {
                var cmd = decode_watch(parts);
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
