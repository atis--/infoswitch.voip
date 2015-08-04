
//
// SIP response codes extracted from
//     yate-5.4.0-1/libs/ysip/engine.cpp
//
var sipResponseToSipCode = {
    'Trying': 100,
    'Ringing': 180,
    'Call Is Being Forwarded': 181,
    'Queued': 182,
    'Session Progress': 183,
    'OK': 200,
    'Normal call clearing': 200,            // XXX extra
    'Accepted': 202,
    'Multiple Choices': 300,
    'Moved Permanently': 301,
    'Moved Temporarily': 302,
    'See Other': 303,
    'Use Proxy': 305,
    'Alternative Service': 380,
    'Bad Request': 400,
    'Unauthorized': 401,
    'Payment Required': 402,
    'Forbidden': 403,
    'Not Found': 404,                       // XXX extra
    'No route to call target': 404,
    'Method Not Allowed': 405,
    'Not Acceptable': 406,
    'Proxy Authentication Required': 407,
    'Request Timeout': 408,
    'Conflict': 409,
    'Gone': 410,
    'Length Required': 411,
    'Conditional Request Failed': 412,
    'Request Entity Too Large': 413,
    'Request-URI Too Long': 414,
    'Unsupported Media Type': 415,
    'Unsupported URI Scheme': 416,
    'Unknown Resource-Priority': 417,
    'Bad Extension': 420,
    'Extension Required': 421,
    'Session Timer Too Small': 422,
    'Interval Too Brief': 423,
    'Bad Location Information': 424,
    'Use Identity Header': 428,
    'Provide Referrer Identity': 429,
    'Flow Failed': 430,                                // RFC5626
    'Anonymity Disallowed': 433,
    'Bad Identity-Info': 436,
    'Unsupported Certificate': 437,
    'Invalid Identity Header': 438,
    'First Hop Lacks Outbound Support': 439,           // RFC5626
    'Max-Breadth Exceeded': 440,
    'Bad Info Package': 469,
    'Consent Needed': 470,
    'Temporarily Unavailable': 480,
    'Call/Transaction Does Not Exist': 481,
    'Loop Detected': 482,
    'Too Many Hops': 483,
    'Address Incomplete': 484,
    'Ambiguous': 485,
    'Busy Here': 486,
    'Request Terminated': 487,
    'Not Acceptable Here': 488,
    'Bad Event': 489,
    'Request Pending': 491,
    'Undecipherable': 493,
    'Security Agreement Required': 494,
    'Server Internal Error': 500,
    'Not Implemented': 501,
    'Bad Gateway': 502,
    'Service Unavailable': 503,
    'Server Time-out': 504,
    'Version Not Supported': 505,
    'Message Too Large': 513,
    'Response Cannot Be Sent Safely': 514,
    'Response requires congestion management': 515,
    'Proxying of request would induce fragmentation': 516,
    'Precondition Failure': 580,
    'Busy Everywhere': 600,
    'Decline': 603,
    'Does Not Exist Anywhere': 604,
    'Not Acceptable': 606
};

// invert mapping
var sipCodeToSipResponse = (function (obj) {
    var inv = {};
    for (var k in obj)
        inv[obj[k]] = k;
    return inv;
})(sipResponseToSipCode);

// H323 return codes
var H323 = {
    OK: 0,
    INVALID_ACCOUNT: 1,
    INVALID_PASSWORD: 2,
    ACCT_IN_USE: 3,
    ZERO_BALANCE: 4,
    EXPIRED: 5,
    CREDIT_LIMIT_EXCEEDED: 6,
    USER_DENY: 7,
    SERVICE_NOT_AVAILABLE: 8,
    DEST_NUMBER_BLOCKED: 9,
    RETRIES_EXCEEDED: 10,
    INVALID_RADIUS_ARGUMENT: 11,
    INSUFFICIENT_BALANCE: 12,
    TOLL_FREE_CALL: 13,
    INVALID_CARD_NUMBER: 14,
    INVALID_DEST_NUMBER: 21,
    UNKNOWN: 51,
};

var h323CodeToSipResponse = {};
h323CodeToSipResponse[H323.OK] = 'OK';
h323CodeToSipResponse[H323.INVALID_ACCOUNT] = 'Server Internal Error';
h323CodeToSipResponse[H323.INVALID_PASSWORD] = 'Forbidden';
h323CodeToSipResponse[H323.ACCT_IN_USE] = 'Forbidden';
h323CodeToSipResponse[H323.ZERO_BALANCE] = 'Payment Required';
h323CodeToSipResponse[H323.EXPIRED] = 'Forbidden';
h323CodeToSipResponse[H323.CREDIT_LIMIT_EXCEEDED] = 'Payment Required';
h323CodeToSipResponse[H323.USER_DENY] = 'Forbidden';
h323CodeToSipResponse[H323.SERVICE_NOT_AVAILABLE] = 'Service Unavailable';
h323CodeToSipResponse[H323.DEST_NUMBER_BLOCKED] = 'Temporarily Unavailable';
h323CodeToSipResponse[H323.RETRIES_EXCEEDED] = 'Server Time-out';
h323CodeToSipResponse[H323.INVALID_RADIUS_ARGUMENT] = 'Not Acceptable';
h323CodeToSipResponse[H323.INSUFFICIENT_BALANCE] = 'Payment Required';
h323CodeToSipResponse[H323.TOLL_FREE_CALL] = 'OK';
h323CodeToSipResponse[H323.INVALID_CARD_NUMBER] = 'Not Found';
h323CodeToSipResponse[H323.INVALID_DEST_NUMBER] = 'Not Found';
h323CodeToSipResponse[H323.UNKNOWN] = 'Forbidden';

module.exports = {
    sipResponseToSipCode: sipResponseToSipCode,
    sipCodeToSipResponse: sipCodeToSipResponse,
    H323: H323,
    h323CodeToSipResponse: h323CodeToSipResponse
};
