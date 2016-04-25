
//
// Extract IP address from Yate message (e.g., from `user.auth`). Returns empty
// string if address not extractable.
//
exports.extractIP = function (msg) {
    return (msg.address || '').split(':', 1)[0] || msg.ip_host || '';
}
