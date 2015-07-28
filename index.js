
var YateChannel = require('./lib/YateChannel').Channel;

//
// determine if given value is a channel instance
//
exports.isChannel = function (channel) {
    return (channel instanceof YateChannel);
}

//
// Yate external control module
//
exports.YateExt = require('./lib/Yate');

//
// FreeSWITCH external control module
//
//exports.FSExt = require('./lib/FreeSWITCH');
