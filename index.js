
var YateChannel = require('./lib/YateChannel');

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
// Yate external control module
//
exports.YateExt = require('./lib/Yate');

//
// FreeSWITCH external control module
//
//exports.FSExt = require('./lib/FreeSWITCH');
