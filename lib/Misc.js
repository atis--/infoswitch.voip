
//
// check if argument value is a positive integer
//
exports.isPositiveInt = function (v) {
    return isFinite(v) && Math.floor(v) === v && v > 0;
}