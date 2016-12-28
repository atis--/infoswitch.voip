'use strict';

const util = require('util');
const { EventEmitter } = require('events');
const Codes = require('./Codes');
const assert = console.assert;

//
// set parameters for `call.route` or `call.execute` message so it forks
//
// see description of Yate callfork module:
//   http://yate.null.ro/pmwiki/index.php?n=Main.Callfork
//
// each route looks like so:
// {
//     fullroute: (optional) <protocol/called@host>
//     protocol:  (optional) `sip` or `h323`
//     host:      called host
//     caller:    caller number
//     called:    called number
//     formats:   (optional) comma separated list of formats, e.g., 'g729,g723'
//     line:      (optional) ensures only registered routes, see Yate's modules/ysipchan.cpp
// }
//
function fork(routes, caller, called) {
    assert(routes instanceof Array && routes.length > 0, 'invalid/missing routes');
    assert(called, 'missing called number');

    // fork params
    var fp = {
        $retvalue: 'fork',  // route to callfork module
        'fork.stop': 'busy' // callfork stops on any target being busy
    };

    // add route parameters
    for (var index = 1; index <= routes.length; index++) {
        // make sure route contains destination host
        var r = routes[index - 1];
        var host = r.host;
        assert(host, 'missing host in route');

        // let route override caller & called numbers
        var caller_out = r.caller || caller || '';
        var called_out = r.called || called;

        // prepend `sip:` to called number for SIP protocol
        var proto = r.protocol ? r.protocol.toLowerCase() : 'sip';
        var called_full = (proto == 'sip' ? 'sip:' : '') + called_out;

        // Insert group separator target. Having routes in separate groups
        // ensures that each route is tried sequentially, not simultaneously.
        if (index > 1) {
            if (r.forward_timeout) {
                // call forwarding (drop current route group after timeout)
                // XXX: add 3 seconds to allow for pre-ring time
                fp['callto.' + index] = '|drop='+(r.forward_timeout + 3000);
            } else {
                fp['callto.' + index] = '|';
            }
            index++;
        }

        // append `callto` target to forked route string
        var prefix = 'callto.'+index;
        fp[prefix] = r.fullroute || `${proto}/${called_full}@${host}`;
        fp[prefix + '.caller'] = caller_out;
        fp[prefix + '.callername'] = caller_out;
        fp[prefix + '.domain'] = host;
        fp[prefix + '.called'] = called_out;
        if (r.formats)
            fp[prefix + '.formats'] = r.formats;
        if (r.line)
            fp[prefix + '.line'] = r.line;
    }
    return fp;
}

//
// extract disconnect sip code & text from chan.hangup message
//
var extract_cause = (function () {
    var text2code = Codes.sipResponseToSipCode;
    var code2text = Codes.sipCodeToSipResponse;
    return function (chan_hangup) {
        // extract code & text reason
        var code_sip = chan_hangup.cause_sip;
        var status = chan_hangup.status;
        var reason_sip = chan_hangup.reason || chan_hangup.reason_sip;

        // map Yate's short 'hangup' reason to 'Request Terminated'
        if (reason_sip == 'hangup')
            reason_sip = 'Request Terminated';

        // try to get the best code & reason text (kinda hackish but works)
        if (status && text2code[status]) {
            code_sip = text2code[status];
            reason_sip = status;
        } else if (reason_sip && text2code[reason_sip]) {
            code_sip = text2code[reason_sip];
        } else if (code_sip && code2text[code_sip]) {
            reason_sip = code2text[code_sip];
        }

        return {
            code: code_sip || 487,
            text: reason_sip || 'Request Terminated'
        };
    }
})();

var Channel = exports.Channel = (function () {
    //
    // inherits from EventEmitter and emits these events:
    //      bind
    //      fork
    //      peer
    //      dtmf
    //      timeout
    //      end
    //      error
    //
    function Channel(cfg) {
        assert(this instanceof Channel, 'please use the `new` operator');
        assert(typeof cfg == 'object', 'invalid channel config');
        assert(cfg.pbx, 'missing PBX instance');
        assert(cfg.chan, 'missing channel');

        // init base
        EventEmitter.call(this);

        // copy parameters
        this.pbx = cfg.pbx;
        this.chan = cfg.chan;
        this.call_route = cfg.call_route;

        // state variables
        this.routed = false;
        this.terminated = false;

        // timeout timer
        this.timer = null;

        // pass errors on to pbx
        this.on('error', function (err) {
            this.pbx.emit('error', err);
        });

        // emit `dtmf` event when DTMF is received on channel
        this.pbx.onChannelEvent(this.chan, 'onDTMF', function (text) {
            this.emit('dtmf', text);
        }.bind(this));

        // wait for channel hangup
        this.pbx.onChannelEvent(this.chan, 'onHangup', function (chan_hangup) {
            this._doTerminate(extract_cause(chan_hangup));
        }.bind(this));
    }
    util.inherits(Channel, EventEmitter);

    //
    // Proxies for EventEmitter's on() and once() methods -- make sure that
    // event handlers are not registered after channel destruction. Call `end`
    // event handlers immediately.
    //
    Channel.prototype.onsafe = function (ev, handler) {
        // simple proxy if channel not terminated
        if (!this.terminated) {
            EventEmitter.prototype.on.apply(this, arguments);
            return;
        }

        // special case for `end` event: invoke handler immediately (async)
        if (ev == 'end') {
            process.nextTick(function () {
                handler(this.getDisconnectCause());
            }.bind(this));
            return;
        }

        // emit error
        this.pbx.emit('error', new Error(`Event "${ev}" bind attempt on terminated channel "${this.chan}"`));
    }
    Channel.prototype.oncesafe = function (ev, handler) {
        // simple proxy if channel not terminated
        if (!this.terminated) {
            EventEmitter.prototype.once.apply(this, arguments);
            return;
        }

        // special case for `end` event: invoke handler immediately (async)
        if (ev == 'end') {
            process.nextTick(function () {
                handler(this.getDisconnectCause());
            }.bind(this));
            return;
        }

        // emit error
        this.pbx.emit('error', new Error(`Event "${ev}" bind attempt on terminated channel "${this.chan}"`));
    }

    //
    // return true if channel is bound and not terminated
    //
    Channel.prototype.isLive = function (op) {
        if (this.terminated) {
            this.pbx.emit('error', new Error(`"${op}" on terminated channel ignored`));
            return false;
        }
        return true;
    }

    //
    // internal method for actually terminating the channel -- the channel is
    //     1) marked as `terminated`
    //     2) timeout function is cleared
    //     3) `end` event is emitted and all listeners removed
    //
    Channel.prototype._doTerminate = function (cause) {
        if (this.terminated)
            return;

        // save cause
        if (!this.saved_cause)
            this.saved_cause = cause;

        // timeout timer no longer necessary
        clearTimeout(this.timer);

        // mark as terminated and set disconnect time
        this.terminated = true;
        this.disconnectTime = Date.now();

        // emit 'end' event & remove all listeners
        this.emit('end', this.getDisconnectCause());
        this.removeAllListeners();
    }

    //
    // get/set peer channel (another Channel instance)
    //
    Channel.prototype.getPeer = function () {
        return this.peer;
    }
    Channel.prototype.setPeer = function (peer) {
        assert(peer instanceof Channel, peer);

        this.peer = peer;
        peer.peer = this;
    }

    //
    // channel is terminated after <timeout> seconds
    //
    Channel.prototype.setTimeout = function (timeout) {
        assert(isFinite(timeout) && timeout >= 0, 'invalid timeout');
        if (!this.isLive('setTimeout'))
            return;

        // clear previous timeout
        clearTimeout(this.timer);

        // set timeout (drop channel when reached)
        this.timer = setTimeout(function () {
            if (!this.isLive('force drop'))
                return;
            this.emit('timeout', { chan: this.chan, timeout: timeout });
            this.pbx.chanDrop(this.chan, 'Payment Required');
        }.bind(this), timeout);
    }

    //
    // forcibly terminate the channel
    //
    Channel.prototype.terminate = function (cause) {
        if (this.terminated)
            return;

        cause = cause || { code: 487, text: 'Request Terminated' };
        this._doTerminate(cause);

        // if we're still in routing state, then we have to reply to the
        // call.route message (`false` means not handled)
        if (!this.routed && this.call_route) {
            this.routed = true;
            this.pbx.routeCall(this.call_route, false);
        }

        // drop channel
        this.pbx.chanDrop(this.chan, cause.text);
    }

    //
    // channel duration in milliseconds (will return 0 before channel
    // termination)
    //
    Channel.prototype.getDuration = function () {
        if (!this.connectTime || !this.disconnectTime)
            return 0;
        return this.disconnectTime - this.connectTime;
    }

    //
    // Sometimes a "good" disconnect cause is not available for a channel. This
    // function tries to get it from the peer channel or sets a successful cause
    // if duration is nonzero.
    //
    Channel.prototype.getDisconnectCause = function () {
        var cause = this.saved_cause;
        if (!cause)
            return null;    // disonnect cause should have been available

        // force 200/OK cause for non-zero duration
        if (this.getDuration() > 0)
            return { code: 200, text: 'Normal call clearing' };

        // if cause code is a generic 'Request Terminated', then try to acquire
        // cause from peer
        if (cause.code == 487 && this.peer && this.peer.saved_cause)
            return this.peer.saved_cause;

        // keep existing cause
        return cause;
    }

    //
    // get caller number
    //
    Channel.prototype.getCaller = function () {
        return this.call_route ? this.call_route.caller : undefined;
    }

    //
    // connect to a peer channel
    //
    Channel.prototype.connectToChannel = function (peer) {
        assert(peer instanceof Channel, peer);

        if (!this.isLive('connect'))
            return;
        if (!peer.isLive('connectPeer'))
            return;

        this.pbx.chanConnect(this.chan, peer.chan);
        this.setPeer(peer);
    }

    //
    // record audio
    //
    Channel.prototype.recordAudio = function (filename, peer_filename, maxlen_bytes) {
        if (!this.isLive('record'))
            return;
        this.pbx.chanRecord(this.chan, filename, peer_filename, maxlen_bytes);
    }

    //
    // check if channel is in routing mode
    //
    Channel.prototype.isRouting = function () {
        return this.isLive('isRouting') && this.call_route && !this.routed;
    }

    //
    // route channel to external destination
    //
    Channel.prototype.routeToDestination = function (dest) {
        // sanity checks
        if (!this.isLive('routeToDestination'))
            return;
        if (!this.call_route) {
            this.emit('error', new Error(`channel "${this.chan}" is not in routing mode`));
            return;
        }
        if (this.routed) {
            this.emit('error', new Error(`channel "${this.chan}" is already routed`));
            return;
        }

        // mark channel as routed
        this.routed = true;

        // timeouts
        var timeout = dest.timeout || this.pbx.callTimeout;
        var setupTimeout = dest.setupTimeout || this.pbx.callSetupTimeout;
        assert(isFinite(timeout) && timeout >= 0, 'invalid timeout');
        assert(isFinite(setupTimeout) && setupTimeout >= 0, 'invalid setup timeout');

        // Reply to call.route message with routes to destination. The timeout
        // is an upper bound because Yate includes setup time in it. We set a
        // more precise timeout below after peer connection.
        var called = dest.called || this.call_route.called;
        var fork_params = fork(dest.routes, dest.caller, called);
        this.pbx.routeCall(this.call_route, true, Object.assign(fork_params, {
            maxcall: setupTimeout,
            timeout: timeout + setupTimeout
        }));

        //
        // handle forks
        //
        this.pbx.onChannelEvent(this.chan, 'onExecuteFork', function (call_execute) {
            // get route
            var call = this;
            var slave_index = call_execute.id.split('/')[2];
            var route = dest.routes[slave_index - 1];

            // peer channel may be missing in case there's an error
            var sip_id = call_execute.peerid;
            if (!sip_id) {
                this.emit('error', new Error(`"${call.chan}" fork failed: ${call_execute.error}`));
                return;
            }

            // create new Channel instance for each fork
            var fork_channel = new Channel({
                chan: sip_id,
                pbx: call.pbx
            });

            // emit `fork`
            call.emit('fork', fork_channel, {
                route: route,
                time: Date.now()
            });

            // outgoing leg connects (success case)
            call.pbx.onChannelEvent(sip_id, 'onConnected', function (chan_connected) {
                if (chan_connected.peerid != call.chan)
                    return; // not yet connected to original channel

                // set as each other's peers, store connect timestamp
                call.setPeer(fork_channel);
                call.connectTime = fork_channel.connectTime = Date.now();

                // If the routed channel ("this" channel) is an IVR, then
                // generate silence tone as soon as peer connects. This is
                // necessary because if (for whatever crazy reason) the IVR
                // generates no sound, then call recording fails for the peer.
                if (this instanceof IVR)
                    this.pbx.chanTonegen(this.chan, 'silence');

                // Set channel timeout on peer channel. Originating channel may
                // be a "dumb" channel which later goes away when two calls are
                // connected, and then the timeout would have no effect.
                fork_channel.setTimeout(timeout);

                // emit `peer` events on both channels
                call.emit('peer', fork_channel, {
                    route: route,
                    time: call.connectTime
                });
                fork_channel.emit('peer', call, {
                    route: route,
                    time: call.connectTime
                });
            }.bind(this));

            call.pbx.onChannelEvent(sip_id, 'onHangup', function (chan_hangup) {
                // copy fork channel (outgoing route) disconnect cause to our
                // channel
                var cause = extract_cause(chan_hangup);
                call.saved_cause = cause;

                // Force call to stop in case of 'Busy Here' disconnect
                // cause. Shouldn't be necessary because of 'fork.stop=busy'
                // callfork param, but it has been known to not work sometimes.
                if (cause.code == '486')
                    call.terminate();
            });
        }.bind(this));
    }

    //
    // connect channel to IVR peer
    //
    Channel.prototype.routeToIVR = function (ivropt) {
        ivropt = ivropt || {};

        // sanity checks
        if (!this.isLive('routeToDestination'))
            return;
        if (!this.call_route) {
            this.emit('error', new Error(`channel "${this.chan}" is not in routing mode`));
            return;
        }
        if (this.routed) {
            this.emit('error', new Error(`channel "${this.chan}" is already routed`));
            return;
        }

        // timeout
        var timeout = ivropt.timeout || this.pbx.callTimeout;
        assert(isFinite(timeout) && timeout >= 0, 'invalid timeout');

        // reply with route to a new dumb channel & mark channel as routed
        this.pbx.routeCall(this.call_route, true, { $retvalue: 'dumb/' });
        this.routed = true;

        // catch `chan.connected` event (our channel connect to dumb channel)
        this.pbx.onChannelEvent(this.chan, 'onConnectedOnce', function (chan_connected) {
            // answer call (sends `call.answered` to Yate)
            var dumb_id = chan_connected.peerid;
            this.pbx.chanAnswer(dumb_id, this.chan);

            // create IVR channel
            var ivr = new IVR({
                chan: dumb_id,
                pbx: this.pbx
            });

            // set as each other's peers, store connect timestamp
            this.setPeer(ivr);
            ivr.connectTime = this.connectTime = Date.now();

            // set channel timeout
            this.setTimeout(timeout);

            // wait a short while before emitting `peer` event: othwerise the
            // beginning of first sound may end up being swallowed
            this.pbx.chanTonegen(dumb_id, 'silence');
            setTimeout(function () {
                // emit `peer` event on both channels
                ivr.emit('peer', this, {
                    time: this.connectTime
                });
                this.emit('peer', ivr, {
                    time: this.connectTime
                });
            }.bind(this), 1200);
        }.bind(this));
    }

    return Channel;
})();

var IVR = exports.IVR = (function () {
    //
    // IVR inherits from Channel and emits these additional events:
    //      queue-empty (queue becomes empty, also emitted when channel ends)
    //      play-next   (queued sound playback begins)
    //
    function IVR(cfg) {
        assert(this instanceof IVR, 'please use the `new` operator');

        // IVR sound queue
        this.queue = [];

        // clear queue on hangup
        cfg.pbx.onChannelEvent(cfg.chan, 'onHangup', function () {
            this.queue.splice(0, this.queue.length);
            this.emit('queue-empty');
        }.bind(this));

        // play next sound from queue when previous ends
        cfg.pbx.onChannelEvent(cfg.chan, 'onNotify', function () {
            // remove current sound
            this.queue.shift();

            // check if there are sounds to play
            if (this.queue.length == 0) {
                // play silence if queue becomes empty
                this.pbx.chanTonegen(this.chan, 'silence');
                this.emit('queue-empty');
            } else {
                this.playNext();             // play next sound
            }
        }.bind(this));

        // Channel (base class) initialization happens after IVR `onHangup`
        // handler is registered to make sure the IVR `onHangup` handler is not
        // cleared during Channel's own `onHangup` handler.
        Channel.call(this, cfg);
    }
    util.inherits(IVR, Channel);

    //
    // play next sound from queue (internal use)
    //
    IVR.prototype.playNext = function () {
        if (!this.isLive('play-next'))
            return;

        var skip = function () {
            this.queue.shift();
            this.emit('error', new Error('skip invalid sound'));
        }.bind(this);

        while (this.queue.length > 0) {
            // pick next sound to be played
            var next = this.queue[0];
            if (typeof next != 'object') {
                skip();
                continue;
            }

            // if file, attach wavefile module (play file!)
            if (next.path) {
                this.pbx.chanPlaywave(this.chan, next.path);
                return;
            }

            // if tone, attach tonegen module
            if (next.tone) {
                // attach tone generator
                this.pbx.chanTonegen(this.chan, next.tone);

                // validate timeout (skip to next sound if invalid)
                if (typeof next.ms != 'number' || next.ms <= 0) {
                    this.emit('error', new Error('invalid tone timeout'));
                    skip();
                    continue;
                }

                // run `chan.notify` handlers after timeout so we can proceed
                // with the next sound
                var tone_timer = setTimeout(function () {
                    if (this.isLive('tone-timer'))
                        this.pbx.triggerChannelEvent(this.chan, 'onNotify');
                }.bind(this), next.ms);

                // remove timer if the queue is cleared or call ends
                this.once('queue-empty', function () {
                    clearTimeout(tone_timer);
                });
                return;
            }

            // skip unrecognized sound
            skip();
        }
    }

    //
    // enqueue sound
    //
    // Sound file:
    //     { path: '/path/to/file' }
    //
    // Tone (with timeout):
    //     { tone: 'busy', ms: 500 }
    //
    IVR.prototype.enqueue = function (sound) {
        assert(typeof sound == 'object', 'invalid sound');

        if (!this.isLive('enqueue'))
            return;

        // save sound in queue for later playback
        this.queue.push(sound);

        // if this is the first queued sound and we don't have a peer yet, then
        // start playback only when remote end picks up
        if (this.queue.length == 1) {
            if (this.peer) {
                this.playNext();
            } else {
                this.once('peer', function () {
                    this.playNext();
                }.bind(this));
            }
        }
    }

    //
    // http://docs.yate.ro/wiki/Tonegen
    //
    // dial - ITU dial tone
    // busy - ITU busy tone
    // ring - ITU ring tone
    // specdial - typically used for secondary dialtones
    // congestion - no more channels available, network busy
    // outoforder - broken line (ITU, not three tones)
    // milliwatt - the stardard tone for test, 1mW @ 1kHz
    // silence - as the name says
    // noise - low level white noise, usable as comfort noise
    //
    IVR.prototype.playTone = function (tone, ms) {
        assert(tone, 'invalid tone');

        if (!this.isLive('playTone'))
            return;

        if (!ms) {
            // if timeout is not given, then we simply attach tonegen without
            // queueing the sound (infinite tone)
            this.pbx.chanTonegen(this.chan, tone);
        } else {
            // enqueue tone sound
            this.enqueue({ tone: tone, ms: ms });
        }
    }

    return IVR;
})();
