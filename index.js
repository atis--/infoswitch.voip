'use strict';

const YateChannel = require('./lib/YateChannel');

//
// determine if given value is a channel instance
//
exports.isChannel = function (channel) {
    return (channel instanceof YateChannel.Channel);
}

//
// determine if given value is an IVR channel instance
//
exports.isIVR = function (channel) {
    return (channel instanceof YateChannel.IVR);
}

//
// create trunk (line, carrier) ID
//
exports.makeLineID = require('./lib/Utils').makeLineID;

//
// Yate external control module
//
exports.YateExt = require('./lib/Yate');
