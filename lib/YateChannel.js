
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var Misc = require('./Misc');
var Codes = require('./Codes');
var fmt = util.format;
var assert = console.assert;

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
//     line:      (optional) XXX ensures only registered clients... maybe
// }
//
function fork(routes) {
    assert(routes instanceof Array && routes.length > 0, 'invalid/missing routes');

    // fork params
    var fp = {
        $retvalue: 'fork',  // route to callfork module
        'fork.stop': 'busy' // callfork stops on any target being busy
    };

    // add route parameters
    for (var index = 1; index <= routes.length; index++) {
        // make sure route contains required parameters
        var r = routes[index - 1];
        assert(r.host && r.called && r.caller, 'missing required parameters from route');

        // prepend `sip:` to called number for SIP protocol
        var proto = r.protocol ? r.protocol.toLowerCase() : 'sip';
        var calledfull = (proto == 'sip' ? 'sip:' : '') + r.called;

        // Insert group separator target. Having routes in separate groups
        // ensures that each route is tried sequentially, not simultaneously.
        if (index > 1) {
            fp['callto.' + index] = '|';
            index++;
        }

        // append `callto` target to forked route string
        var prefix = 'callto.'+index;
        fp[prefix] = r.fullroute || fmt('%s/%s@%s', proto, calledfull, r.host);
        fp[prefix + '.caller'] = r.caller;
        fp[prefix + '.callername'] = r.caller;
        fp[prefix + '.domain'] = r.host;
        fp[prefix + '.called'] = r.called;
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
    //      set-timeout
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

        // wait for channel hangup
        this.pbx.onChannelEvent(this.chan, 'onHangup', function (chan_hangup) {
            this._doTerminate(extract_cause(chan_hangup));
        }.bind(this));
    }
    util.inherits(Channel, EventEmitter);

    //
    // return true if channel is bound and not terminated
    //
    Channel.prototype.isLive = function (op) {
        if (this.terminated) {
            this.emit('error', new Error(fmt('`%s` on terminated channel ignored', op)));
            return false;
        }
        return true;
    }

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
        this.emit('end', this.saved_cause);
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
        assert(!this.peer, 'channel already has a peer');
        assert(!peer.peer, 'peer already has a peer');

        this.peer = peer;
        peer.peer = this;
    }

    //
    // channel is terminated after <timeout> seconds
    //
    Channel.prototype.setTimeout = function (timeout) {
        assert(Math.floor(timeout) === timeout && timeout > 0, 'invalid timeout');

        if (!this.isLive('setTimeout'))
            return;

        // clear previous timeout
        clearTimeout(this.timer);

        // set timeout (drop channel when reached)
        this.emit('set-timeout', { chan: this.chan, timeout: timeout });
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

        this._doTerminate(cause);

        // if we're still in routing state, then we have to reply to the
        // call.route message (`false` means not handled)
        if (!this.routed && this.call_route) {
            this.routed = true;
            Yate.reply(this.call_route, false);
        }

        // drop channel
        this.pbx.chanDrop(this.chan, cause.text);
    }

    //
    // channel duration in milliseconds
    //
    Channel.prototype.getDuration = function () {
        if (!this.connectTime || !this.disconnectTime)
            return 0;
        return this.disconnectTime - this.connectTime;
    }

    //
    // connect to a peer channel
    //
    Channel.prototype.connect = function (peer) {
        assert(peer instanceof Channel, peer);

        if (!this.isLive('connect'))
            return;
        if (!peer.isLive('connectPeer'))
            return;

        Log.trace('connect two calls %s <-> %s', this.chan, peer.chan);
        this.pbx.chanConnect(this.chan, peer.chan);
        this.setPeer(peer);
    }

    Channel.prototype.routeToDestination = function (dest) {
        assert(dest.routes instanceof Array && dest.routes.length > 0, 'missing routes');

        // sanity checks
        if (!this.isLive('routeToDestination'))
            return;
        if (!this.call_route) {
            this.emit('error', new Error(fmt('channel %s is not in routing mode', this.chan)));
            return;
        }
        if (this.routed) {
            this.emit('error', new Error(fmt('channel %s is already routed', this.chan)));
            return;
        }

        // mark channel as routed
        this.routed = true;

        // timeouts
        var timeout = dest.timeout || this.pbx.callTimeout;
        var setupTimeout = dest.setupTimeout || this.pbx.callSetupTimeout;
        assert(Misc.isPositiveInt(timeout), 'invalid timeout');
        assert(Misc.isPositiveInt(setupTimeout), 'invalid setup timeout');

        // Reply to call.route message with routes to destination. The timeout
        // is an upper bound because Yate includes setup time in it. We set a
        // more precise timeout below after peer connection.
        this.pbx.reply(this.call_route, true, util._extend(fork(dest.routes), {
            maxcall: setupTimeout,
            timeout: timeout + setupTimeout
        }));

        //
        // handle forks
        //
        this.pbx.onChannelEvent(this.chan, 'onExecuteFork', function (call_execute) {
            // get route
            var call = this;
            var sip_id = call_execute.peerid;
            var slave_index = call_execute.id.split('/')[2];
            var route = dest.routes[slave_index - 1];

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

                // emit `peer` events on both channels
                call.emit('peer', fork_channel, {
                    route: route,
                    time: call.connectTime
                });
                fork_channel.emit('peer', call, {
                    route: route,
                    time: call.connectTime
                });

                // set timeout
                call.setTimeout(timeout);
            });
            call.pbx.onChannelEvent(sip_id, 'onHangup', function (chan_hangup) {
                // Force call to stop in case of 'Busy Here' disconnect
                // cause. Shouldn't be necesary because of 'fork.stop=busy'
                // callfork param, but we have to be certain.
                var cause = extract_cause(chan_hangup);
                if (cause.code == '486')
                    call.terminate(cause);
            });
        }.bind(this));
    }
    Channel.prototype.routeToIVR = function (ivrOptions) {
        assert(this.call_route instanceof Yate.MessageCmd, 'call.route message not available');
        assert(!this.routed, 'call already routed');

        if (!this.isLive('routeToIVR'))
            return;

        // Reply with route to a new dumb channel.
        Yate.reply(this.call_route, true, { $retvalue: 'dumb/' });
        this.routed = true;

        // create IVR
        var user = this.user || { language: 'en', currency: 'USD' };
        var ivr = new IVR(_.assign({
            language: user.language,
            currency: user.currency
        }, ivrOptions));

        // set IVR peer
        ivr.setPeer(this);
        
        YateChan.onConnectedOnce(this.chan, function (chan_connected) {
            // answer call (sends `call.answered` to Yate) and bind IVR
            var chanIVR = chan_connected.peerid;
            this.pbx.chanAnswer(chanIVR, this.chan);
            ivr.bindToChannel(chanIVR);

            // wait a short while before giving control to user's onPeer
            // handler: othwerise the beginning of first sound may end up being
            // swallowed
            this.pbx.chanTonegen(chanIVR, 'silence');
            setTimeout(function () {
                ivr.emit('peer');
            }, 1200);
        }.bind(this));

        return ivr;
    }

    return Channel;
})();

var IVR = exports.IVR = (function () {
    //
    // IVR inherits from Channel and emits these additional events:
    //      queue-empty
    //      play-next
    //      dtmf
    //
    function IVR(cfg) {
        assert(this instanceof IVR, 'please use the `new` operator');

        Channel.call(this, cfg);

        // IVR-specific private vars
        this.language = cfg.language || 'en';
        this.currency = cfg.currency || 'EUR';
        this.queue = [];

        // clear queue on hangup
        this.pbx.onChannelEvent(this.chan, 'onHangup', function () {
            this.queue.splice(0, this.queue.length);
            this.emit('queue-empty');
        }.bind(this));

        // play next sound from queue when previous ends
        this.pbx.onChannelEvent(this.chan, 'onNotify', function () {
            // remove current sound
            this.queue.shift();

            // check if there are sounds to play
            if (this.queue.length == 0)
                this.emit('queue-empty');    // nothing remains
            else
                this.playNext();             // play next sound
        }.bind(this));

        // collect DTMFs
        this.pbx.onChannelEvent(this.chan, 'onDTMF', function (text) {
            this.emit('dtmf', text);
        }.bind(this));
    }
    util.inherits(IVR, Channel);

    IVR.prototype.playNext = function () {
        if (!this.isLive('play-next'))
            return;

        while (this.queue.length > 0) {
            var next = this.queue[0];

            // if file, attach wavefile module (play file!)
            if (next instanceof Types.File) {
                YateChan.playwave(this.chan, next.path);
                return;
            }

            // if tone, attach tonegen module
            if (next instanceof IVR.Tone) {
                // attach tone generator
                YateChan.tonegen(this.chan, next.name);

                // Timeout must be set! Trigger 'chan.notify' handlers once the
                // timeout is reached.
                assert(_.isFinite(next.ms) && next.ms > 0, next.ms);
                var tone_timer = setTimeout(function () {
                    if (this.isLive('playShortTone'))
                        YateChan.Notify(this.chan, null);
                }.bind(this), next.ms);

                // remove timeout if the queue is cleared
                this.once('queue-empty', function () {
                    clearTimeout(tone_timer);
                });
                return;
            }

            // remove invalid item
            this.queue.shift();
            Log.warn({ next: next }, 'cannot play unknown sound type');
        }
    }
    IVR.prototype.enqueue = function (sound) {
        assert(_.isObject(sound), sound);

        Log.trace({ sound: sound }, 'enqueue sound');
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
                });
            }
        }
    }
    IVR.prototype.playFile = function (file) {
        assert(file instanceof Types.File, file);
        this.enqueue(file);
    }
    IVR.prototype.playTone = function (tone, ms) {
        assert(_.isString(tone) && tone, 'invalid tone name');

        if (!ms) {
            // if timeout is not given, then we simply attach tonegen without
            // queueing the sound (IVR must be bound to channel)
            if (this.isLive('playTone'))
                YateChan.tonegen(this.chan);
        } else {
            // enqueue tone sound
            this.enqueue(new IVR.Tone(tone, ms));
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
    IVR.Tone = (function () {
        function Tone(name, ms) {
            if (!(this instanceof Tone))
                return new Tone(name, ms);

            assert(_.isString(name) && name, 'invalid tone name');
            assert(_.isFinite(ms) && ms > 0, 'invalid timeout');

            this.name = name;
            this.ms = ms;
        }
        return Tone;
    })();

    return IVR;
})();
