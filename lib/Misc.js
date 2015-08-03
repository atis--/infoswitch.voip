
//
// check if argument value is a positive integer
//
exports.isPositiveInt = function (v) {
    return isFinite(v) && Math.floor(v) === v && v > 0;
}

//
// Extract user address from Yate message (e.g., from `user.auth`). Returns
// empty string if address not extractable.
//
exports.extractAddress = function (msg) {
    return (msg.address || '').split(':', 1)[0] || msg.ip_host || '';
}
